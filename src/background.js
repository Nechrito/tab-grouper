// Cached group mappings and colors to reduce storage access
let cachedGroupMappings = null;
let cachedGroupColors = null;

// Optimized color generation with better distribution
const COLOR_PALETTE = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const colorCache = new Map();

// Memoized domain extraction to reduce repeated parsing
const domainCache = new Map();

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

// Replace existing storage calls with this utility
async function getGroupMappings() {
    return StorageManager.get("groupMappings");
}

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

async function generateColor(groupName) {
    const groupColors = await getGroupColors();

    // Check if a custom color is already defined for this group
    if (groupColors[groupName]) {
        return groupColors[groupName];
    }

    // If no custom color, use the existing generation method
    if (colorCache.has(groupName)) {
        return colorCache.get(groupName);
    }

    const hash = hashCode(groupName);
    const colorIndex = Math.abs(hash) % COLOR_PALETTE.length;
    const color = COLOR_PALETTE[colorIndex];

    colorCache.set(groupName, color);
    return color;
}

async function removeEmptyGroups() {
    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
        const groupMappings = await getGroupMappings();

        for (const group of groups) {
            // Count tabs in this specific group
            const tabsInGroup = tabs.filter((tab) => tab.groupId === group.id);

            // If group has fewer than 2 tabs, remove the group
            if (tabsInGroup.length < 2) {
                for (const tab of tabsInGroup) {
                    try {
                        // Ungroup the single remaining tab
                        await chrome.tabs.ungroup(tab.id);
                    } catch (ungroupError) {
                        console.error(`Error ungrouping tab ${tab.id}:`, ungroupError);
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error in removeEmptyGroups:", error);
    }
}

// Ungroup all tabs
async function ungroupAllTabs() {
    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });

        for (const group of groups) {
            const tabsInGroup = tabs.filter((tab) => tab.groupId === group.id);
            for (const tab of tabsInGroup) {
                await chrome.tabs.ungroup(tab.id);
            }
        }
    } catch (error) {
        console.error("Error ungrouping tabs:", error);
    }
}

// Move single tabs without a group to the end
async function moveSingleTabsToStart() {
    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });

        for (const tab of tabs) {
            if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
                await chrome.tabs.move(tab.id, { index: -1 });
            }
        }
    } catch (error) {
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
        const groupMappings = await getGroupMappings();
        const groupColors = await getGroupColors();
        const existingGroups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });

        for (const group of existingGroups) {
            const currentTitle = group.title.toLowerCase();

            // Find a matching mapping where the group title matches a domain or group name
            const matchingMapping = Object.entries(groupMappings).find(([domain, groupName]) => {
                const trimmedDomain = domain.replace(/(\.com|\.se|\.net|\.org|\.io|\.dev)$/, "").toLowerCase();
                return currentTitle === trimmedDomain || currentTitle === groupName.toLowerCase();
            });

            if (matchingMapping) {
                const [domain, groupName] = matchingMapping;

                // Determine the new title (abbreviated if long)
                const newTitle = groupName.length > 15 ? abbreviate(groupName) : groupName;

                // Get color for the group
                const color = await generateColor(groupName);

                // Update group title and color
                try {
                    await chrome.tabGroups.update(group.id, {
                        title: newTitle,
                        color: color,
                    });
                } catch (updateError) {
                    console.error(`Error updating group ${group.id}:`, updateError);
                }
            }
        }
    } catch (error) {
        console.error("Error updating existing groups:", error);
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

    await moveSingleTabsToStart();
}

// Existing utility functions (hashCode, abbreviate)
function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") {
        debouncedGroupTabsByDomain();
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") {
        await checkAndUngroupTab(tab);
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

// Update event listeners to use this function
chrome.tabs.onRemoved.addListener(() => {
    // Use a small delay to ensure tab removal is processed
    setTimeout(removeEmptyGroups, 100);
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
