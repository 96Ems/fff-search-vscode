import * as vscode from "vscode";
import { IndexManager } from "./indexManager.js";
import { showFileQuickPick, showTextQuickPick } from "./quickPick.js";
import { SidebarProvider } from "./sidebarProvider.js";

export function activate(context: vscode.ExtensionContext): void {
  const manager = new IndexManager(context);
  const sidebar = new SidebarProvider(manager, context.extensionUri);

  context.subscriptions.push(
    manager,
    vscode.window.registerWebviewViewProvider("fffSearch.sidebar", sidebar),
    vscode.window.onDidChangeActiveTextEditor(() => sidebar.refreshRoot()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sidebar.refreshRoot()),
    vscode.commands.registerCommand("fffSearch.findFile", () => showFileQuickPick(manager)),
    vscode.commands.registerCommand("fffSearch.findFileToSide", () => showFileQuickPick(manager, true)),
    vscode.commands.registerCommand("fffSearch.searchText", () => showTextQuickPick(manager, (query) => sidebar.showTextQuery(query))),
    vscode.commands.registerCommand("fffSearch.rescan", async () => {
      await withErrorMessage("FFF rescan failed", async () => {
        await manager.rescan();
        void vscode.window.showInformationMessage("FFF rescan started.");
      });
    }),
    vscode.commands.registerCommand("fffSearch.restartIndex", async () => {
      await withErrorMessage("FFF restart failed", async () => {
        await manager.restartIndex();
        void vscode.window.showInformationMessage("FFF index restarted.");
      });
    }),
    vscode.commands.registerCommand("fffSearch.showHealth", async () => {
      const health = await manager.health();
      if (health.error) {
        void vscode.window.showErrorMessage(`FFF: ${health.error}`);
        return;
      }
      const picker = health.health?.filePicker;
      const git = health.health?.git;
      const lines = [
        `Root: ${health.root ?? picker?.basePath ?? "unknown"}`,
        `Initialized: ${picker?.initialized ?? false}`,
        `Indexing: ${picker?.isScanning ?? false}`,
        `Indexed files: ${picker?.indexedFiles ?? "unknown"}`,
        `Git repo: ${git?.repositoryFound ?? false}`,
        `Git available: ${git?.available ?? false}`,
        `Git workdir: ${git?.workdir ?? "unknown"}`,
        `Git error: ${git?.error ?? "none"}`,
      ];
      void vscode.window.showInformationMessage(lines.join(" | "));
    }),
  );

  manager.warmupActiveRoot();
}

export function deactivate(): void {}

async function withErrorMessage(prefix: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    void vscode.window.showErrorMessage(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
