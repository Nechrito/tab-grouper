
// Request queue implementation
class OperationQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    async enqueue(operation) {
        this.queue.push(operation);
        if (!this.processing) {
            await this.processQueue();
        }
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) return;
        
        this.processing = true;
        while (this.queue.length > 0) {
            const operation = this.queue.shift();
            try {
                await operation();
            } catch (error) {
                console.error('Queue operation failed:', error);
            }
        }
        this.processing = false;
    }
}

const tabOperationQueue = new OperationQueue();

class Cache {
    constructor(ttl = 5000) { 
        this.store = new Map();
        this.ttl = ttl;
    }

    set(key, value) {
        const expiresAt = Date.now() + this.ttl;
        this.store.set(key, { value, expiresAt });
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    clear() {
        this.store.clear();
    }
}

// Cached group mappings and colors to reduce storage access
let cachedGroupColors = null;

// Color palette for group colors
const COLOR_PALETTE = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

// Replace existing caches
const domainCache = new Cache(60000); // 1 minute 
const colorCache = new Cache(60000); // 1 minute

// Debug mode flag to enable verbose logging
let DEBUG_MODE = false;

// Initialize debug mode from storage
chrome.storage.sync.get(['debugMode'], (result) => {
    DEBUG_MODE = result.debugMode || false;
});


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
    return await StorageManager.get("groupMappings");
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
    if (colorCache.get(groupName)) {
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
        // Skip if tab isn't in a group
        if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;

        // Get both domains in parallel
        const [currentDomain, group] = await Promise.all([
            getDomain(tab.url),
            chrome.tabGroups.get(tab.groupId)
        ]);

        if (!currentDomain || !group) return;

        // More precise domain matching
        const groupDomain = group.title.toLowerCase();
        const normalizedCurrentDomain = currentDomain
            .replace(/(\.com|\.se|\.net|\.org|\.io|\.dev)$/, "")
            .toLowerCase();

        // Only ungroup if domains definitely don't match
        if (groupDomain !== normalizedCurrentDomain && 
            !groupDomain.includes(normalizedCurrentDomain) && 
            !normalizedCurrentDomain.includes(groupDomain)) {
            await chrome.tabs.ungroup(tab.id);
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
    const startTime = performance.now();

    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });

        const [groupMappings, existingGroups] = await Promise.all([
            getGroupMappings(),
            chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
        ]);

        // Group tabs by domain first
        const tabsByDomain = new Map();
        for (const tab of tabs) {
            if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE || !tab.url) continue;
            
            const domain = await getDomain(tab.url);
            if (!domain) continue;

            const groupName = groupMappings[domain] || 
                domain.replace(/(\.com|\.se|\.net|\.org|\.io|\.dev)$/, "");
            
            if (!tabsByDomain.has(groupName)) {
                tabsByDomain.set(groupName, []);
            }
            tabsByDomain.get(groupName).push(tab.id);
        }

        // Process each domain group
        for (const [groupName, tabIds] of tabsByDomain) {
            // Always group if more than one tab, regardless of batch
            if (tabIds.length >= 2) {
                const color = await generateColor(groupName);
                const title = groupName.length > 15 ? abbreviate(groupName) : groupName;

                const existingGroup = existingGroups.find(group => group.title === groupName);
                
                if (existingGroup) {
                    // Add tabs to existing group
                    await chrome.tabs.group({ groupId: existingGroup.id, tabIds });
                } else {
                    // Create new group
                    const newGroup = await chrome.tabs.group({ tabIds });
                    await chrome.tabGroups.update(newGroup, { title, color });
                }
            }
        }

        if (DEBUG_MODE) {
            const duration = performance.now() - startTime;
            console.debug(`Grouped tabs in ${duration.toFixed(2)}ms`);
        }

    } catch (error) {
        console.error("Tab grouping error:", error);
    }
}

function abbreviate(groupName) {
    const words = groupName
        .trim()
        .split(/[^a-zA-Z0-9]/)
        .filter(Boolean);
    return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : groupName.slice(0, 5).toUpperCase();
}

// Debounced tab grouping to reduce unnecessary calls
const debouncedGroupTabsByDomain = debounce(groupTabsByDomain, 500);

// When a tab is fully loaded, check if it should be grouped
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") {
        debouncedGroupTabsByDomain();
    }
});


// Listen for tab updates to trigger grouping
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        // Add to queue after grouping operations
        tabOperationQueue.enqueue(async () => {
            // Small delay to ensure grouping completes first
            await new Promise(resolve => setTimeout(resolve, 50));
            await checkAndUngroupTab(tab);
        });
    }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    // Add to queue after grouping operations
    tabOperationQueue.enqueue(async () => {
        // Small delay to ensure grouping completes first
        await new Promise(resolve => setTimeout(resolve, 50));
        await removeEmptyGroups();
    });
});

chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "groupTabs") {
        debouncedGroupTabsByDomain();
    }
    if (request.action === "ungroupTabs") {
        ungroupAllTabs();
    }
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
