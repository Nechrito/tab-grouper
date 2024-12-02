// Cached group mappings and colors to reduce storage access
let cachedGroupMappings = null;
let cachedGroupColors = null;

// Optimized color generation with better distribution
const COLOR_PALETTE = ["blue", "green", "purple", "red", "orange", "yellow", "pink", "cyan", "grey"];
const colorCache = new Map();

// Memoized domain extraction to reduce repeated parsing
const domainCache = new Map();

// Logging function for debugging (only when needed)
function logBrowserCapabilities() {
    if (process.env.NODE_ENV === "development") {
        console.log("Browser Capabilities:");
        console.log("chrome object exists:", typeof chrome !== "undefined");
        console.log("chrome.tabs exists:", typeof chrome.tabs !== "undefined");
        console.log("chrome.tabGroups exists:", typeof chrome.tabGroups !== "undefined");
    }
}

function getDomain(url) {
    if (domainCache.has(url)) return Promise.resolve(domainCache.get(url));

    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.replace(/^www\./, "");
        const domain = hostname.includes(".") ? hostname.split(".").slice(-2).join(".") : hostname;

        domainCache.set(url, domain);
        return Promise.resolve(domain);
    } catch (error) {
        console.error("Error extracting domain:", error);
        return Promise.resolve(null);
    }
}

// Cached group mappings to reduce storage access
async function getGroupMappings() {
    if (cachedGroupMappings) return cachedGroupMappings;

    return new Promise((resolve) => {
        chrome.storage.sync.get(["groupMappings"], (result) => {
            cachedGroupMappings = result.groupMappings;

            if (!cachedGroupMappings) {
                cachedGroupMappings = {};
            }

            resolve(cachedGroupMappings);
        });
    });
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

// Optimized grouping function with reduced complexity
async function groupTabsByDomain() {
    try {
        const groupMappings = await getGroupMappings();
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const domainGroups = new Map();

        // Parallel domain extraction and group identification
        const groupTasks = tabs
            .filter((tab) => tab.url && !tab.pinned && tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
            .map(async (tab) => {
                const domain = await getDomain(tab.url);
                if (!domain) return null;

                const trimmedDomain = domain.replace(/(\.com|\.se|\.net|\.org|\.io|\.dev)$/, "");
                const groupName = groupMappings[domain] || trimmedDomain;
                return { groupName, tabId: tab.id };
            });

        const groupResults = await Promise.all(groupTasks);

        // Organize tabs into groups
        groupResults
            .filter((result) => result !== null)
            .forEach((result) => {
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
        console.error("Error grouping tabs:", error);
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
        debouncedGroupTabsByDomain();
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
