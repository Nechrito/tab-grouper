// Cached group mappings and colors to reduce storage access
let cachedGroupMappings = null;
let cachedGroupColors = null;

// Debug mode flag to enable verbose logging
let DEBUG_MODE = false;

// Initialize debug mode from storage
chrome.storage.sync.get(['debugMode'], (result) => {
    DEBUG_MODE = result.debugMode || false;
});

// Color palette for group colors
const COLOR_PALETTE = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const colorCache = new Map();

// Memoized domain extraction to reduce repeated parsing
const domainCache = new Map();

// Extract domain from URL and cache the result
async function getDomain(url) {
    if (!url) return null;

    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.replace(/^www\./, "");
        const domain = hostname.includes(".") ? hostname.split(".").slice(-2).join(".") : hostname;

        // Validate domain before caching
        if (domain) {
            domainCache.set(url, domain);
            return domain;
        }
        return null;
    } catch (error) {
        console.warn(`Domain extraction failed for URL: ${url}`, error);
        return null;
    }
}

// Add a centralized storage management utility
const StorageManager = {
    async get(key, defaultValue = {}) {
        return new Promise((resolve) => {
            chrome.storage.sync.get([key], (result) => {
                resolve(result[key] || defaultValue);
            });
        });
    },

    async set(key, value) {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.set({ [key]: value }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    },
};

// Get group mappings from storage with caching
async function getGroupMappings() {
    return StorageManager.get("groupMappings");
}

// Get group colors from storage with caching
async function getGroupColors() {
    if (cachedGroupColors) return cachedGroupColors;

    return new Promise((resolve) => {
        chrome.storage.sync.get(["groupColors"], (result) => {
            cachedGroupColors = result.groupColors;
            // if no colors are stored, initialize with empty object
            if (!cachedGroupColors) {
                cachedGroupColors = {};
            }

            resolve(cachedGroupColors);
        });
    });
}

// Debounce function to prevent multiple rapid calls
function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}

// Hash code generation for color selection
function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

// Generate a color for a group based on the group name
async function generateColor(groupName) {
    const groupColors = await getGroupColors();

    // If there's already a color mapping, use it
    if (groupColors[groupName]) {
        return groupColors[groupName];
    }

    // Only use hash-based color if no color is explicitly set
    if (colorCache.has(groupName)) {
        return colorCache.get(groupName);
    }

    // Generate hash-based color only for new groups without explicit color
    const hash = hashCode(groupName);
    const color = COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];

    // Only cache the color, don't save to storage
    // This allows popup.js to override with explicit color choices
    colorCache.set(groupName, color);

    return color;
}

// Remove empty groups after tab removal
async function removeEmptyGroups() {
    try {
        // Get all data in parallel
        const [tabs, groups] = await Promise.all([
            chrome.tabs.query({ currentWindow: true }),
            chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
        ]);

        // Create map of group IDs to tab counts for faster lookup
        const groupCounts = tabs.reduce((acc, tab) => {
            if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
                acc[tab.groupId] = (acc[tab.groupId] || 0) + 1;
            }
            return acc;
        }, {});

        // Find groups with less than 2 tabs
        const groupsToUngroup = groups.filter(group => 
            (groupCounts[group.id] || 0) < 2
        );

        // Bulk ungroup operation for efficiency
        if (groupsToUngroup.length) {
            const tabsToUngroup = tabs.filter(tab => 
                groupsToUngroup.some(group => group.id === tab.groupId)
            ).map(tab => tab.id);

            if (tabsToUngroup.length) {
                await chrome.tabs.ungroup(tabsToUngroup);
            }
        }
    } catch (error) {
        console.error("Error in removeEmptyGroups:", error.message);
        throw error; // Re-throw to allow caller to handle
    }
}

// Ungroup all tabs in the current window
async function ungroupAllTabs() {
    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
   
        // Ungroup all tabs in the current window
        await Promise.all(tabs.map(tab => chrome.tabs.ungroup(tab.id)));
    } catch (error) {
        console.error("Error ungrouping tabs:", error);
    }
}

async function moveSingleTabs() {
    
    if (DEBUG_MODE) console.debug("Moving single tabs...");

    const startTime = performance.now();
    try {
        // Get all tabs in current window
        const tabs = await chrome.tabs.query({ currentWindow: true });
        
        // Filter ungrouped tabs first
        const ungroupedTabs = tabs.filter(
            tab => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
        );

        if (ungroupedTabs.length === 0) return;

        const index = tabs.length - 1;

        for (const tab of ungroupedTabs) {
            try {
                await chrome.tabs.move(tab.id, { index });
            } catch (moveError) {
                console.error(`Error moving tab ${tab.id}:`, moveError);
            }
        }

        if (DEBUG_MODE) {
            const duration = performance.now() - startTime;
            console.debug(`Moved ${ungroupedTabs.length} tabs in ${duration.toFixed(2)}ms`);
        }
    }
    catch (error) {
        console.error("Error moving single tabs:", error);
    }
}

async function checkAndUngroupTab(tab) {
    try {
        // Check if the tab is in a group
        if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
            // Get the domain of the current URL
            const currentDomain = await getDomain(tab.url);

            // Get the current group
            const group = await chrome.tabGroups.get(tab.groupId);

            // Check if the current domain matches the group title
            const groupDomain = group.title.toLowerCase();
            const normalizedCurrentDomain = currentDomain.replace(/(\.com|\.se|\.net|\.org|\.io|\.dev)$/, "").toLowerCase();

            // If domains don't match, ungroup the tab
            if (groupDomain !== normalizedCurrentDomain) {
                try {
                    await chrome.tabs.ungroup(tab.id);
                } catch (ungroupError) {
                    // Error ungrouping tab: Error: Tabs cannot be edited right now (user may be dragging a tab).
                    console.error(`Error ungrouping tab ${tab.id}:`, ungroupError);
                }
            }
        }
    } catch (error) {
        console.error("Error checking tab group:", error);
    }
}

// Update existing groups' titles and colors based on new mappings
async function updateExistingGroups() {
    try {
        // Fetch all data in parallel
        const [groupMappings, groupColors, existingGroups] = await Promise.all([
            getGroupMappings(),
            getGroupColors(),
            chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
        ]);

        // Cache domain pattern for reuse
        const domainPattern = /(\.com|\.se|\.net|\.org|\.io|\.dev)$/;
        
        // Prepare batch updates
        const updates = existingGroups.map(async (group) => {
            const currentTitle = group.title.toLowerCase();
            
            // Find matching mapping
            const matchingMapping = Object.entries(groupMappings).find(([domain, groupName]) => {
                const trimmedDomain = domain.replace(domainPattern, "").toLowerCase();
                return currentTitle === trimmedDomain || 
                       currentTitle === groupName.toLowerCase();
            });

            if (matchingMapping) {
                const [_, groupName] = matchingMapping;
                const newTitle = groupName.length > 15 ? abbreviate(groupName) : groupName;
                const color = await generateColor(groupName);

                return chrome.tabGroups.update(group.id, {
                    title: newTitle,
                    color: color
                }).catch(error => {
                    console.error(`Failed to update group ${group.id}:`, error);
                });
            }
        }).filter(Boolean); // Remove undefined values

        // Execute all updates in parallel
        await Promise.allSettled(updates);

    } catch (error) {
        console.error("Error updating existing groups:", error);
        throw error;
    }
}
async function groupTabsByDomain() {
    try {
        // Early return if no tabs exist
        const tabs = await chrome.tabs.query({ currentWindow: true });
        if (tabs.length <= 1) return;

        const groupMappings = await getGroupMappings();
        const domainGroups = new Map();

        const existingGroups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });

        // Use Promise.all with better error handling
        const groupTasks = tabs
            .filter((tab) => tab.url && !tab.pinned && tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
            .map(async (tab) => {
                try {
                    const domain = await getDomain(tab.url);
                    if (!domain) return null;

                    const trimmedDomain = domain.replace(/(\.com|\.se|\.net|\.org|\.io|\.dev)$/, "");
                    return {
                        groupName: groupMappings[domain] || trimmedDomain,
                        tabId: tab.id,
                        domain,
                    };
                } catch (error) {
                    console.warn(`Skipping tab grouping for ${tab.url}`, error);
                    return null;
                }
            });

        const groupResults = (await Promise.allSettled(groupTasks)).filter((result) => result.status === "fulfilled" && result.value !== null).map((result) => result.value);

        // First, check if any ungrouped tabs can be moved to existing groups
        for (const result of groupResults.filter((r) => r !== null)) {
            const existingGroup = existingGroups.find((group) => group.title.toLowerCase() === result.groupName.toLowerCase());

            if (existingGroup) {
                try {
                    await chrome.tabs.group({
                        tabIds: result.tabId,
                        groupId: existingGroup.id,
                    });
                    // Remove this tab from further processing
                    groupResults.splice(groupResults.indexOf(result), 1);
                } catch (moveError) {
                    console.error(`Error moving tab to existing group:`, moveError);
                }
            }
        }

        // Organize remaining ungrouped tabs into groups
        const remainingResults = groupResults.filter((result) => result !== null);
        remainingResults.forEach((result) => {
            if (!domainGroups.has(result.groupName)) {
                domainGroups.set(result.groupName, []);
            }
            domainGroups.get(result.groupName).push(result.tabId);
        });

        // Group tabs with more than one tab
        for (const [groupName, tabIds] of domainGroups.entries()) {
            if (tabIds.length >= 2) {
                const color = await generateColor(groupName);
                const title = groupName.length > 15 ? abbreviate(groupName) : groupName;

                const group = await chrome.tabs.group({ tabIds });

                await chrome.tabGroups.update(group, { color, title });
            }
        }
    } catch (error) {
        console.error("Comprehensive grouping error:", error);
    }

    // Move single tabs to the end after grouping is complete
    // setTimeout(moveSingleTabs, 100);
    moveSingleTabs();
}

function abbreviate(groupName) {
    const words = groupName
        .trim()
        .split(/[^a-zA-Z0-9]/)
        .filter(Boolean);
    return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : groupName.slice(0, 5).toUpperCase();
}

// Debounced tab grouping to reduce unnecessary calls
const debouncedGroupTabsByDomain = debounce(groupTabsByDomain, 300);


// Event Listeners with optimized handling
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") {
        debouncedGroupTabsByDomain();
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Ungroup tab if domain doesn't match group
    if (changeInfo.url) {
        checkAndUngroupTab(tab);
    }
});

chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "groupTabs") {
        debouncedGroupTabsByDomain();
    }
    if (request.action === "ungroupTabs") {
        ungroupAllTabs();
    }
});

const removeDelay = 100;

// Update event listeners to use this function
chrome.tabs.onRemoved.addListener(() => {
    // Use a small delay to ensure tab removal is processed
    
    setTimeout(removeEmptyGroups, removeDelay);
});

// Optional: Initial grouping when extension loads
chrome.runtime.onInstalled.addListener(debouncedGroupTabsByDomain);

// Listen for storage changes to trigger group updates
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "sync" && (changes.groupMappings || changes.groupColors)) {
        // Debounce to prevent multiple rapid calls
        debouncedGroupTabsByDomain();
        updateExistingGroups();
    }
});
