# Tab Grouper Chrome Extension

## Overview

Tab Grouper is a Chrome extension that automatically groups browser tabs by domain, helping you organize your browsing experience more efficiently.

## Features

- Automatically group tabs by domain
- Custom domain to group mappings
- Color-coded tab groups
- Easy-to-use popup interface for managing tab groups

## Screenshots

![Tab Grouper Screenshot](/path/to/tab-grouper-screenshot.png)

## Demo

![Tab Grouper Demo](/path/to/tab-grouper-demo.gif)

## Installation

### From Source

1. Clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (top right toggle)
4. Click "Load unpacked" and select the extension directory

## Usage

### Automatic Grouping

- The extension automatically groups tabs with the same domain when you open or update tabs
- Ungrouped tabs are moved to the start of the tab list

### Customizing Groups

1. Click the Tab Grouper extension icon
2. Use the "Add New Group Mapping" section to:
   - Enter a domain (e.g., github.com)
   - Enter a custom group name
   - Optionally select a color

### Buttons

- **Group Tabs**: Manually trigger tab grouping
- **Ungroup Tabs**: Remove all current tab groups

## Permissions

This extension requires the following Chrome permissions:

- `tabs`: To access and manage browser tabs
- `storage`: To save custom group mappings
- `tabGroups`: To create and manage tab groups

## Development

### Prerequisites

- Node.js
- Chrome Browser

### Local Development

1. Clone the repository
2. Open Chrome's extension management page
3. Enable "Developer mode"
4. Load the extension directory

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[Insert License - e.g., MIT]

## Author

[Your GitHub Username]
