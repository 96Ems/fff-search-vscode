# FFF Search Extension

Fast file and text search for VS Code powered by [`@ff-labs/fff-node`](https://www.npmjs.com/package/@ff-labs/fff-node).

## Commands

- `FFF: Find File`
- `FFF: Find File to Side`
- `FFF: Search Text`
- `FFF: Rescan`
- `FFF: Restart Index`
- `FFF: Show Health`

The extension indexes the active workspace folder. In multi-root workspaces it uses the folder containing the active file; if none matches, it reuses the last selected folder and then falls back to the first workspace folder.
