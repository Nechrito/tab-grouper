const COLOR_PALETTE = [
    { name: "Grey", value: "grey", hex: "#D9DCE0" },
    { name: "Blue", value: "blue", hex: "#4FB8FE" },
    { name: "Red", value: "red", hex: "#FF767E" },
    { name: "Yellow", value: "yellow", hex: "#FFD142" },
    { name: "Green", value: "green", hex: "#00D18E" },
    { name: "Pink", value: "pink", hex: "#FF71CF" },
    { name: "Purple", value: "purple", hex: "#B73FE7" },
    { name: "Cyan", value: "cyan", hex: "#00E1EF" },
    { name: "Orange", value: "orange", hex: "#FFA161" },
];

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

    // Populate color select with color preview
    COLOR_PALETTE.forEach((color) => {
        const option = document.createElement("option");
        option.value = color.value;
        option.textContent = `${color.name}`;
        option.style.backgroundColor = color.hex;
        option.style.color = color.name === "Grey" ? "black" : "white";
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
                const cleanDomain = domain.replace(/[^\w\s.-]/g, "").trim(); // Allow dots for subdomains
                const cleanGroupName = groupName.replace(/[^\w\s:-]/g, "").trim(); // Allow colons for grouping by URL

                mappings[cleanDomain] = cleanGroupName;

                // Only set color if a color is selected
                if (color) {
                    colors[cleanGroupName] = color;
                }

                chrome.storage.sync.set(
                    // Save the mappings
                    {
                        groupMappings: mappings,
                        groupColors: colors,
                    },
                    () => {
                        // Refresh the mappings list and clear input fields
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

// Cleanup function for mapping display
function cleanupMappingText(text) {
    return text
        .normalize("NFC") // Normalize unicode characters
        .replace(/[^\w\s.:-]/g, "") // Remove special characters
        .trim(); // Trim whitespace
}

// Refresh mappings list
function refreshMappings() {
    const mappingsList = document.getElementById("mappingsList");
    const currentMappings = document.getElementById("currentMappings");

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
                const colorInfo = COLOR_PALETTE.find((color) => color.value === groupColor);
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

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateMappings") {
        refreshMappings();
    }
});
