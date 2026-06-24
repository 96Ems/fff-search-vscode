import * as vscode from "vscode";
import type { GrepMode } from "@ff-labs/fff-node";
import { IndexManager } from "./indexManager.js";
import { parseTextQuery } from "./query.js";

interface FilePickItem extends vscode.QuickPickItem {
  relativePath: string;
}

interface TextPickItem extends vscode.QuickPickItem {
  relativePath: string;
  lineNumber: number;
  col: number;
  matchLength: number;
  sourceQuery: string;
}

const openSideButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("split-horizontal"),
  tooltip: "Open to Side",
};

const copyPathButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("copy"),
  tooltip: "Copy Relative Path",
};

const showSidebarButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("list-tree"),
  tooltip: "Show in FFF Sidebar",
};

export async function showFileQuickPick(manager: IndexManager, side = false): Promise<void> {
  const quickPick = vscode.window.createQuickPick<FilePickItem>();
  quickPick.placeholder = "Find file in active folder";
  quickPick.matchOnDescription = true;
  quickPick.busy = true;
  quickPick.show();

  let generation = 0;
  let debounce: NodeJS.Timeout | undefined;

  const runSearch = async () => {
    const myGeneration = ++generation;
    const query = quickPick.value.trim();
    quickPick.busy = true;
    try {
      const pageSize = config<number>("maxQuickFileResults");
      const displayRoot = manager.rootForDisplay();
      const { result } = await manager.fileSearch(query, {
        pageSize,
        currentFile: displayRoot ? manager.currentFileRelativeToRoot(displayRoot) : undefined,
      });
      if (myGeneration !== generation) {
        return;
      }
      quickPick.items = result.items.map((item): FilePickItem => ({
        label: item.fileName,
        description: item.relativePath === item.fileName ? undefined : item.relativePath,
        detail: item.gitStatus !== "clean" ? item.gitStatus : undefined,
        relativePath: item.relativePath,
        buttons: [openSideButton, copyPathButton],
      }));
    } catch (error) {
      quickPick.items = [{ label: "FFF search failed", detail: message(error), relativePath: "" }];
    } finally {
      if (myGeneration === generation) {
        quickPick.busy = false;
      }
    }
  };

  const schedule = () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(runSearch, 150);
  };

  quickPick.onDidChangeValue(schedule);
  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected?.relativePath) {
      return;
    }
    quickPick.hide();
    await manager.openFile(selected.relativePath, { side });
  });
  quickPick.onDidTriggerItemButton(async (event) => {
    if (!event.item.relativePath) {
      return;
    }
    if (event.button === openSideButton) {
      quickPick.hide();
      await manager.openFile(event.item.relativePath, { side: true });
      return;
    }
    if (event.button === copyPathButton) {
      await manager.copyRelativePath(event.item.relativePath);
    }
  });
  quickPick.onDidHide(() => {
    if (debounce) {
      clearTimeout(debounce);
    }
    quickPick.dispose();
  });

  await runSearch();
}

export async function showTextQuickPick(manager: IndexManager, showInSidebar: (query: string) => Promise<void>): Promise<void> {
  const quickPick = vscode.window.createQuickPick<TextPickItem>();
  quickPick.placeholder = "Search text in active folder (re:, fz:, pl: supported)";
  quickPick.matchOnDescription = true;
  quickPick.busy = false;
  quickPick.show();

  let generation = 0;
  let debounce: NodeJS.Timeout | undefined;

  const runSearch = async () => {
    const myGeneration = ++generation;
    const rawQuery = quickPick.value;
    const parsed = parseTextQuery(rawQuery);
    if (!parsed.query) {
      quickPick.items = [];
      return;
    }

    quickPick.busy = true;
    try {
      const result = await grepWithFallback(manager, parsed.query, parsed.mode, parsed.smartCase, parsed.fuzzyFallback, config<number>("maxQuickTextResults"));
      if (myGeneration !== generation) {
        return;
      }
      quickPick.items = result.items.map((item): TextPickItem => ({
        label: `${item.fileName}:${item.lineNumber}:${item.col + 1}  ${compactLine(item.lineContent, item.col)}`,
        description: dirName(item.relativePath),
        detail: item.relativePath,
        alwaysShow: true,
        relativePath: item.relativePath,
        lineNumber: item.lineNumber,
        col: item.col,
        matchLength: item.matchRanges[0] ? item.matchRanges[0][1] - item.matchRanges[0][0] : 0,
        sourceQuery: rawQuery,
        buttons: [openSideButton, showSidebarButton, copyPathButton],
      }));
    } catch (error) {
      quickPick.items = [{ label: "FFF text search failed", detail: message(error), alwaysShow: true, relativePath: "", lineNumber: 1, col: 0, matchLength: 0, sourceQuery: rawQuery }];
    } finally {
      if (myGeneration === generation) {
        quickPick.busy = false;
      }
    }
  };

  const schedule = () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(runSearch, 150);
  };

  quickPick.onDidChangeValue(schedule);
  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected?.relativePath) {
      return;
    }
    quickPick.hide();
    await manager.openFile(selected.relativePath, {
      line: selected.lineNumber,
      col: selected.col,
      selectLength: selected.matchLength,
    });
  });
  quickPick.onDidTriggerItemButton(async (event) => {
    const item = event.item;
    if (!item.relativePath) {
      return;
    }
    if (event.button === openSideButton) {
      quickPick.hide();
      await manager.openFile(item.relativePath, {
        side: true,
        line: item.lineNumber,
        col: item.col,
        selectLength: item.matchLength,
      });
      return;
    }
    if (event.button === showSidebarButton) {
      quickPick.hide();
      await showInSidebar(item.sourceQuery);
      return;
    }
    if (event.button === copyPathButton) {
      await manager.copyRelativePath(item.relativePath, { line: item.lineNumber, col: item.col });
    }
  });
  quickPick.onDidHide(() => {
    if (debounce) {
      clearTimeout(debounce);
    }
    quickPick.dispose();
  });
}

async function grepWithFallback(manager: IndexManager, query: string, mode: GrepMode, smartCase: boolean, fuzzyFallback: boolean, pageSize: number) {
  const options = {
    mode,
    smartCase,
    pageSize,
    maxMatchesPerFile: config<number>("maxMatchesPerFile"),
    timeBudgetMs: 300,
  };
  const { result } = await manager.grep(query, options);
  if (result.items.length === 0 && fuzzyFallback && mode !== "fuzzy") {
    const fallback = await manager.grep(query, { ...options, mode: "fuzzy" });
    return fallback.result;
  }
  return result;
}

function config<T>(key: string): T {
  return vscode.workspace.getConfiguration("fffSearch").get<T>(key) as T;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactLine(value: string, col = 0): string {
  const line = value.trim().replace(/\s+/g, " ");
  if (line.length <= 140) {
    return line;
  }

  const start = Math.max(0, Math.min(line.length - 120, col - 50));
  const end = Math.min(line.length, start + 120);
  return `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`;
}

function dirName(relativePath: string): string | undefined {
  const index = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  return index > 0 ? relativePath.slice(0, index) : undefined;
}
