document.addEventListener("DOMContentLoaded", () => {
    const groupTabsBtn = document.getElementById("groupTabs");
    const ungroupTabsBtn = document.getElementById("ungroupTabs");
    const domainInput = document.getElementById("domainInput");
    const groupNameInput = document.getElementById("groupNameInput");
    const colorInput = document.getElementById("colorInput");
    const addMappingBtn = document.getElementById("addMapping");
    const currentMappings = document.getElementById("currentMappings");
    const mappingsList = document.getElementById("mappingsList");
    const removeMappingBtn = document.getElementById("removeMapping");

    // Enhanced color palette with color codes
    const COLOR_PALETTE = [
        { name: "Blue", value: "blue", hex: "#3B82F6" },
        { name: "Green", value: "green", hex: "#10B981" },
        { name: "Purple", value: "purple", hex: "#8B5CF6" },
        { name: "Red", value: "red", hex: "#EF4444" },
        { name: "Orange", value: "orange", hex: "#F97316" },
        { name: "Yellow", value: "yellow", hex: "#EAB308" },
        { name: "Pink", value: "pink", hex: "#EC4899" },
        { name: "Cyan", value: "cyan", hex: "#06B6D4" },
        { name: "Grey", value: "grey", hex: "#6B7280" },
    ];

    // Populate color select with color preview
    COLOR_PALETTE.forEach((color) => {
        const option = document.createElement("option");
        option.value = color.value;
        option.textContent = `${color.name}`;
        option.style.backgroundColor = color.hex;
        option.style.color = "white";
        colorInput.appendChild(option);
    });

    // Group tabs button
    groupTabsBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "groupTabs" });
    });

    // Ungroup tabs button
    ungroupTabsBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "ungroupTabs" });
    });

    // Cleanup function for mapping display
    function cleanupMappingText(text) {
        return text
            .normalize("NFC")
            .replace(/[^\w\s.:-]/g, "")
            .trim();
    }

    // Refresh mappings list
    function refreshMappings() {
        chrome.storage.sync.get(["groupMappings", "groupColors"], (result) => {
            const mappings = result.groupMappings || {};
            const colors = result.groupColors || {};

            // Clear existing mappings
            mappingsList.innerHTML = "";
            currentMappings.innerHTML = "";

            for (const [domain, group] of Object.entries(mappings)) {
                // Create mapping item for visual list
                const mappingItem = document.createElement("div");
                mappingItem.classList.add("mapping-item");
                mappingItem.dataset.domain = domain;

                // Domain span
                const domainSpan = document.createElement("span");
                domainSpan.classList.add("mapping-item-domain");
                domainSpan.textContent = cleanupMappingText(domain);

                // Group span
                const groupSpan = document.createElement("span");
                groupSpan.classList.add("mapping-item-group");
                groupSpan.textContent = cleanupMappingText(group);

                // Color indicator
                const colorSpan = document.createElement("span");
                colorSpan.classList.add("mapping-item-color");
                const groupColor = colors[group];
                if (groupColor) {
                    const colorInfo = COLOR_PALETTE.find((c) => c.value === groupColor);
                    if (colorInfo) {
                        colorSpan.style.backgroundColor = colorInfo.hex;
                    }
                }

                // Add to mapping item
                mappingItem.appendChild(domainSpan);
                mappingItem.appendChild(groupSpan);
                mappingItem.appendChild(colorSpan);

                // Add click event for selection
                mappingItem.addEventListener("click", (e) => {
                    mappingItem.classList.toggle("selected");

                    // Sync with hidden select for removal
                    const option = Array.from(currentMappings.options).find((opt) => opt.value === domain);
                    if (option) {
                        option.selected = mappingItem.classList.contains("selected");
                    }
                });

                // Add to mappings list
                mappingsList.appendChild(mappingItem);

                // Sync with hidden select for removal
                const option = document.createElement("option");
                option.value = domain;
                option.textContent = `${cleanupMappingText(domain)} -> ${cleanupMappingText(group)}`;
                currentMappings.appendChild(option);
            }
        });
    }
    // Add new mapping
    addMappingBtn.addEventListener("click", () => {
        const domain = domainInput.value.trim();
        const groupName = groupNameInput.value.trim();
        let color = colorInput.value.trim();
        // If no color is selected, default to grey
        if (!color) {
            color = "grey";
        }

        if (domain && groupName) {
            chrome.storage.sync.get(["groupMappings", "groupColors"], (result) => {
                const mappings = result.groupMappings || {};
                const colors = result.groupColors || {};

                // Cleanup domain and group name before saving
                const cleanDomain = domain.replace(/[^\w\s.-]/g, "").trim();
                const cleanGroupName = groupName.replace(/[^\w\s:-]/g, "").trim();

                mappings[cleanDomain] = cleanGroupName;

                // Only set color if a color is selected
                if (color) {
                    colors[cleanGroupName] = color;
                }

                chrome.storage.sync.set(
                    {
                        groupMappings: mappings,
                        groupColors: colors,
                    },
                    () => {
                        refreshMappings();
                        domainInput.value = "";
                        groupNameInput.value = "";
                        colorInput.selectedIndex = 0;
                    }
                );
            });
        }
    });

    // Remove mapping
    removeMappingBtn.addEventListener("click", () => {
        const selectedOptions = Array.from(currentMappings.selectedOptions);

        if (selectedOptions.length > 0) {
            chrome.storage.sync.get(["groupMappings", "groupColors"], (result) => {
                const mappings = result.groupMappings || {};
                const colors = result.groupColors || {};

                selectedOptions.forEach((option) => {
                    const selectedDomain = option.value;
                    const groupName = mappings[selectedDomain];

                    // Remove domain mapping
                    delete mappings[selectedDomain];

                    // Optionally remove color mapping if no other domains use this group name
                    const isColorUsedElsewhere = Object.values(mappings).includes(groupName);
                    if (!isColorUsedElsewhere) {
                        delete colors[groupName];
                    }
                });

                chrome.storage.sync.set(
                    {
                        groupMappings: mappings,
                        groupColors: colors,
                    },
                    refreshMappings
                );
            });
        }
    });

    // Initial refresh
    refreshMappings();
});

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateMappings") {
        refreshMappings();
    }
});