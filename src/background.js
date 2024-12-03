// Cached group mappings and colors to reduce storage access
let cachedGroupMappings = null;
let cachedGroupColors = null;

// Debug mode flag to enable verbose logging
let DEBUG_MODE = true;

// Initialize debug mode from storage
chrome.storage.sync.get(['debugMode'], (result) => {
    DEBUG_MODE = result.debugMode || false;
});

// Color palette for group colors
const COLOR_PALETTE = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

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

// Improved caching with TTL
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

// Replace existing caches
const domainCache = new Cache(30000); // 30 second TTL
const colorCache = new Cache(60000);   // 1 minute TTL

// Memoized domain extraction to reduce repeated parsing
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
    const startTime = performance.now();
    try {
        // Get all tabs in current window
        const tabs = await chrome.tabs.query({ currentWindow: true });
        
        // Filter ungrouped tabs first
        const ungroupedTabs = tabs.filter(
            tab => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
        );

        if (ungroupedTabs.length === 0) return;

        // Bulk move operation
        await chrome.tabs.move(
            ungroupedTabs.map(tab => tab.id),
            { index: -1 }
        );

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

// Optimized group tabs function
async function groupTabsByDomain() {
    const startTime = performance.now();

    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        if (tabs.length <= 1) return;

        const [groupMappings, existingGroups] = await Promise.all([
            getGroupMappings(),
            chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
        ]);

        // Batch process tabs
        const batchSize = 5;
        const ungroupedTabs = tabs.filter(tab => 
            tab.url && !tab.pinned && 
            tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
        );

        for (let i = 0; i < ungroupedTabs.length; i += batchSize) {
            const batch = ungroupedTabs.slice(i, i + batchSize);
            await tabOperationQueue.enqueue(async () => {
                const domainPromises = batch.map(tab => getDomain(tab.url));
                const domains = await Promise.all(domainPromises);
                
                const groupOperations = new Map();
                
                batch.forEach((tab, index) => {
                    const domain = domains[index];
                    if (!domain) return;
                    
                    const groupName = groupMappings[domain] || 
                        domain.replace(/(\.com|\.se|\.net|\.org|\.io|\.dev)$/, "");
                    
                    if (!groupOperations.has(groupName)) {
                        groupOperations.set(groupName, []);
                    }
                    groupOperations.get(groupName).push(tab.id);
                });

                // Execute group operations
                for (const [groupName, tabIds] of groupOperations) {
                    if (tabIds.length >= 2) {
                        const color = await generateColor(groupName);
                        const title = groupName.length > 15 ? 
                            abbreviate(groupName) : groupName;

                        const group = await chrome.tabs.group({ tabIds });
                        await chrome.tabGroups.update(group, { color, title });
                    }
                }
            });
        }

        if (DEBUG_MODE) {
            const duration = performance.now() - startTime;
            console.debug(`Grouped tabs in ${duration.toFixed(2)}ms`);
        }

    } catch (error) {
        console.error("Tab grouping error:", error);
    }
}

// Rate limiting utility
const rateLimiter = {
    lastCall: 0,
    minInterval: 200,
    queue: [],
    
    async execute(fn) {
        const now = Date.now();
        if (now - this.lastCall < this.minInterval) {
            await new Promise(resolve => 
                setTimeout(resolve, this.minInterval - (now - this.lastCall))
            );
        }
        this.lastCall = Date.now();
        return fn();
    }
};

function abbreviate(groupName) {
    const words = groupName
        .trim()
        .split(/[^a-zA-Z0-9]/)
        .filter(Boolean);
    return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : groupName.slice(0, 5).toUpperCase();
}

// Debounced tab grouping to reduce unnecessary calls
const delay = 500;
const debouncedGroupTabsByDomain = debounce(groupTabsByDomain, delay);

// Consolidated event listeners with error handling and rate limiting
const EventHandler = {
    // Track active listeners for cleanup
    activeListeners: new Set(),

    // Handle tab updates
    async handleTabUpdate(tabId, changeInfo, tab) {
        if (changeInfo.status !== "complete") return;
        
        try {
            await rateLimiter.execute(async () => {
                await checkAndUngroupTab(tab);
                await debouncedGroupTabsByDomain();
            });
        } catch (error) {
            console.error('Tab update handling failed:', error);
        }
    },

    // Handle extension messages
    async handleMessage(request, sender, sendResponse) {
        try {
            switch(request.action) {
                case "groupTabs":
                    await rateLimiter.execute(() => debouncedGroupTabsByDomain());
                    break;
                case "ungroupTabs":
                    await rateLimiter.execute(() => ungroupAllTabs());
                    break;
            }
        } catch (error) {
            console.error('Message handling failed:', error);
        }
    },

    // Handle tab removal
    async handleTabRemoval() {
        try {
            await new Promise(resolve => setTimeout(resolve, 150));
            await rateLimiter.execute(() => removeEmptyGroups());
        } catch (error) {
            console.error('Tab removal handling failed:', error);
        }
    },

    // Handle storage changes
    async handleStorageChange(changes, namespace) {
        if (namespace !== "sync") return;
        if (!changes.groupMappings && !changes.groupColors) return;

        try {
            await rateLimiter.execute(async () => {
                await debouncedGroupTabsByDomain();
                await updateExistingGroups();
            });
        } catch (error) {
            console.error('Storage change handling failed:', error);
        }
    },

    // Initialize all event listeners
    init() {
        // Tab update listener
        const updateListener = (...args) => this.handleTabUpdate(...args);
        chrome.tabs.onUpdated.addListener(updateListener);
        this.activeListeners.add({ type: 'tabs.onUpdated', fn: updateListener });

        // Message listener
        const messageListener = (...args) => this.handleMessage(...args);
        chrome.runtime.onMessage.addListener(messageListener);
        this.activeListeners.add({ type: 'runtime.onMessage', fn: messageListener });

        // Tab removal listener
        const removalListener = () => this.handleTabRemoval();
        chrome.tabs.onRemoved.addListener(removalListener);
        this.activeListeners.add({ type: 'tabs.onRemoved', fn: removalListener });

        // Storage change listener
        const storageListener = (...args) => this.handleStorageChange(...args);
        chrome.storage.onChanged.addListener(storageListener);
        this.activeListeners.add({ type: 'storage.onChanged', fn: storageListener });

        // Initial grouping
        if (DEBUG_MODE) console.debug('Initializing event listeners');
        debouncedGroupTabsByDomain();
    },

    // Cleanup method
    cleanup() {
        for (const listener of this.activeListeners) {
            switch (listener.type) {
                case 'tabs.onUpdated':
                    chrome.tabs.onUpdated.removeListener(listener.fn);
                    break;
                case 'runtime.onMessage':
                    chrome.runtime.onMessage.removeListener(listener.fn);
                    break;
                case 'tabs.onRemoved':
                    chrome.tabs.onRemoved.removeListener(listener.fn);
                    break;
                case 'storage.onChanged':
                    chrome.storage.onChanged.removeListener(listener.fn);
                    break;
            }
        }
        this.activeListeners.clear();
    }
};

// Initialize event listeners
chrome.runtime.onInstalled.addListener(() => {
    EventHandler.init();
});

// Optional: Cleanup on extension unload
chrome.runtime.onSuspend.addListener(() => {
    EventHandler.cleanup();
});
