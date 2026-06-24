import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileFinderApi, GrepOptions, HealthCheck, InitOptions, SearchOptions } from "@ff-labs/fff-node";

interface FinderState {
  root: string;
  finder: FileFinderApi;
  error?: string;
  readyPromise?: Promise<void>;
}

type FffModule = typeof import("@ff-labs/fff-node");

export class IndexManager implements vscode.Disposable {
  private readonly instances = new Map<string, FinderState>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;
  private modulePromise?: Promise<FffModule>;
  private lastRoot?: string;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    this.statusBar.command = "fffSearch.showHealth";
    this.statusBar.text = "FFF idle";
    this.statusBar.tooltip = "FFF Search";
    this.statusBar.show();
    this.output = vscode.window.createOutputChannel("FFF Search");
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.instances.values()) {
      state.finder.destroy();
    }
    this.instances.clear();
    this.statusBar.dispose();
    this.output.dispose();
  }

  warmupActiveRoot(): void {
    if (!this.config<boolean>("warmupOnStartup")) {
      return;
    }
    void this.ensureFinder(0).catch((error) => this.setError(error));
  }

  async ensureFinder(waitTimeoutMs?: number): Promise<FinderState> {
    const root = this.activeRoot();
    if (!root) {
      throw new Error("Open a folder to use FFF Search.");
    }

    this.assertRootAllowed(root);
    this.lastRoot = root;

    let state = this.instances.get(root);
    if (!state || state.finder.isDestroyed) {
      state = await this.createFinder(root);
      this.instances.set(root, state);
    }

    const timeout = waitTimeoutMs ?? this.config<number>("firstUseScanTimeoutMs");
    if (timeout > 0) {
      this.setIndexing(root);
      const result = await state.finder.waitForIndexReady(timeout);
      if (!result.ok) {
        state.error = result.error;
        this.setError(result.error, root);
      } else {
        this.updateStatus(root, state);
      }
    } else {
      this.updateStatus(root, state);
    }

    return state;
  }

  async fileSearch(query: string, options: SearchOptions = {}) {
    const state = await this.ensureFinder();
    const result = state.finder.fileSearch(query, options);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return { root: state.root, result: result.value };
  }

  async grep(query: string, options: GrepOptions = {}) {
    const state = await this.ensureFinder();
    const result = state.finder.grep(query, options);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return { root: state.root, result: result.value };
  }

  async rescan(): Promise<void> {
    const state = await this.ensureFinder(0);
    const result = state.finder.scanFiles();
    if (!result.ok) {
      throw new Error(result.error);
    }
    this.setIndexing(state.root);
  }

  async restartIndex(): Promise<void> {
    const root = this.activeRoot();
    if (!root) {
      throw new Error("Open a folder to use FFF Search.");
    }
    const existing = this.instances.get(root);
    if (existing) {
      existing.finder.destroy();
      this.instances.delete(root);
    }
    await this.ensureFinder(this.config<number>("firstUseScanTimeoutMs"));
  }

  async health(): Promise<{ root?: string; health?: HealthCheck; error?: string }> {
    try {
      const state = await this.ensureFinder(0);
      const result = state.finder.healthCheck(state.root);
      if (!result.ok) {
        return { root: state.root, error: result.error };
      }
      return { root: state.root, health: result.value };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  rootForDisplay(): string | undefined {
    return this.lastRoot ?? this.activeRoot();
  }

  currentFileRelativeToRoot(root: string): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return undefined;
    }
    return path.relative(root, editor.document.uri.fsPath).replace(/\\/g, "/");
  }

  async openFile(relativePath: string, options?: { side?: boolean; line?: number; col?: number; selectLength?: number }): Promise<void> {
    const root = this.rootForDisplay();
    if (!root) {
      throw new Error("No active FFF root.");
    }
    const uri = vscode.Uri.file(path.join(root, relativePath));
    const document = await vscode.workspace.openTextDocument(uri);
    const selection = typeof options?.line === "number"
      ? this.selection(document, options.line, options.col ?? 0, options.selectLength ?? 0)
      : undefined;
    await vscode.window.showTextDocument(document, {
      viewColumn: options?.side ? vscode.ViewColumn.Beside : undefined,
      preview: false,
      selection,
    });
  }

  async copyRelativePath(relativePath: string, withLocation?: { line: number; col?: number }): Promise<void> {
    const suffix = withLocation ? `:${withLocation.line}${typeof withLocation.col === "number" ? `:${withLocation.col + 1}` : ""}` : "";
    await vscode.env.clipboard.writeText(`${relativePath}${suffix}`);
  }

  private selection(document: vscode.TextDocument, oneBasedLine: number, zeroBasedByteCol: number, length: number): vscode.Range {
    const lineIndex = Math.max(0, Math.min(document.lineCount - 1, oneBasedLine - 1));
    const line = document.lineAt(lineIndex);
    const startChar = Math.max(0, Math.min(line.text.length, zeroBasedByteCol));
    const endChar = Math.max(startChar, Math.min(line.text.length, startChar + length));
    return new vscode.Range(lineIndex, startChar, lineIndex, endChar);
  }

  private async createFinder(root: string): Promise<FinderState> {
    this.setIndexing(root);
    const mod = await this.loadModule();
    const dbDir = this.dbDir(root);
    fs.mkdirSync(dbDir, { recursive: true });

    const options: InitOptions = {
      basePath: root,
      frecencyDbPath: path.join(dbDir, "frecency"),
      historyDbPath: path.join(dbDir, "history"),
      disableContentIndexing: !this.config<boolean>("enableContentIndexing"),
      disableWatch: false,
      aiMode: false,
      enableFsRootScanning: this.config<boolean>("enableFsRootScanning"),
      enableHomeDirScanning: this.config<boolean>("enableHomeDirScanning"),
    };

    const created = mod.FileFinder.create(options);
    if (!created.ok) {
      this.setError(created.error, root);
      throw new Error(created.error);
    }

    const state: FinderState = { root, finder: created.value };
    state.readyPromise = created.value.waitForIndexReady(60_000).then((result) => {
      if (this.disposed || created.value.isDestroyed) {
        return;
      }
      if (!result.ok) {
        state.error = result.error;
        this.setError(result.error, root);
      } else {
        this.updateStatus(root, state);
      }
    });
    return state;
  }

  private async loadModule(): Promise<FffModule> {
    this.modulePromise ??= import("@ff-labs/fff-node");
    return this.modulePromise;
  }

  private activeRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      return undefined;
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri?.scheme === "file") {
      const folder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }

    const lastRoot = this.lastRoot;
    if (lastRoot && folders.some((folder) => samePath(folder.uri.fsPath, lastRoot))) {
      return lastRoot;
    }

    return folders[0].uri.fsPath;
  }

  private assertRootAllowed(root: string): void {
    const normalized = path.resolve(root);
    if (!this.config<boolean>("enableFsRootScanning") && samePath(normalized, path.parse(normalized).root)) {
      throw new Error("FFF refused to index a filesystem root. Enable fffSearch.enableFsRootScanning to override.");
    }
    if (!this.config<boolean>("enableHomeDirScanning") && samePath(normalized, os.homedir())) {
      throw new Error("FFF refused to index the home directory. Enable fffSearch.enableHomeDirScanning to override.");
    }
  }

  private dbDir(root: string): string {
    const safe = Buffer.from(path.resolve(root)).toString("base64url");
    return path.join(this.context.globalStorageUri.fsPath, safe);
  }

  private updateStatus(root: string, state: FinderState): void {
    const progress = state.finder.getScanProgress();
    if (progress.ok && progress.value.isScanning) {
      this.setIndexing(root, progress.value.scannedFilesCount);
      return;
    }
    this.statusBar.text = "FFF ready";
    this.statusBar.tooltip = `FFF ready\nRoot: ${root}`;
  }

  private setIndexing(root: string, scanned?: number): void {
    this.statusBar.text = "FFF indexing";
    this.statusBar.tooltip = `FFF indexing${typeof scanned === "number" ? ` (${scanned} files)` : ""}\nRoot: ${root}`;
  }

  private setError(error: unknown, root?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.statusBar.text = "FFF error";
    this.statusBar.tooltip = `FFF error: ${message}${root ? `\nRoot: ${root}` : ""}`;
    this.output.appendLine(`[error] ${message}`);
  }

  private config<T>(key: string): T {
    return vscode.workspace.getConfiguration("fffSearch").get<T>(key) as T;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
