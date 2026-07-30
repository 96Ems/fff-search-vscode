import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import type { GrepOptions, GrepResult, HealthCheck, InitOptions, ScanProgress, SearchOptions, SearchResult } from "@ff-labs/fff-node";

interface FinderState {
  root: string;
  client: FinderClient;
  error?: string;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Message-passing client for the finder worker thread. All native FFF calls
 * run in the worker so slow queries never block the extension host.
 */
class FinderClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private seq = 0;
  disposed = false;

  constructor(workerUrl: URL) {
    this.worker = new Worker(workerUrl);
    this.worker.on("message", (message: WorkerResponse) => {
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id);
      if (message.ok) {
        entry.resolve(message.value);
      } else {
        entry.reject(new Error(message.error ?? "FFF worker error"));
      }
    });
    this.worker.on("error", (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
    this.worker.on("exit", () => {
      this.disposed = true;
      this.failAll(new Error("FFF worker exited."));
    });
  }

  call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("FFF worker is disposed."));
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, op, args });
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.call("destroy").catch(() => undefined).finally(() => void this.worker.terminate());
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}

export class IndexManager implements vscode.Disposable {
  private readonly instances = new Map<string, FinderState>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;
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
      state.client.dispose();
    }
    this.instances.clear();
    this.statusBar.dispose();
    this.output.dispose();
  }

  warmupActiveRoot(): void {
    if (!this.config<boolean>("warmupOnStartup")) {
      return;
    }
    void this.ensureFinder().catch((error) => this.setError(error));
  }

  async ensureFinder(): Promise<FinderState> {
    const root = this.activeRoot();
    if (!root) {
      throw new Error("Open a folder to use FFF Search.");
    }

    this.assertRootAllowed(root);
    this.lastRoot = root;

    let state = this.instances.get(root);
    if (!state || state.client.disposed) {
      state = await this.createFinder(root);
      this.instances.set(root, state);
    }
    return state;
  }

  async fileSearch(query: string, options: SearchOptions = {}) {
    const { state, indexing } = await this.searchState();
    try {
      const result = await state.client.call<SearchResult>("fileSearch", { query, options });
      return { root: state.root, result, indexing };
    } catch (error) {
      if (indexing) {
        const empty: SearchResult = { items: [], scores: [], totalMatched: 0, totalFiles: 0 };
        return { root: state.root, result: empty, indexing: true };
      }
      throw error;
    }
  }

  async grep(query: string, options: GrepOptions = {}) {
    const { state, indexing } = await this.searchState();
    try {
      const result = await state.client.call<GrepResult>("grep", { query, options });
      return { root: state.root, result, indexing };
    } catch (error) {
      if (indexing) {
        const empty: GrepResult = { items: [], totalMatched: 0, totalFilesSearched: 0, totalFiles: 0, filteredFileCount: 0, nextCursor: null };
        return { root: state.root, result: empty, indexing: true };
      }
      throw error;
    }
  }

  async rescan(): Promise<void> {
    const state = await this.ensureFinder();
    await state.client.call("scanFiles");
    this.setIndexing(state.root);
  }

  async restartIndex(): Promise<void> {
    const root = this.activeRoot();
    if (!root) {
      throw new Error("Open a folder to use FFF Search.");
    }
    const existing = this.instances.get(root);
    if (existing) {
      existing.client.dispose();
      this.instances.delete(root);
    }
    await this.ensureFinder();
  }

  async health(): Promise<{ root?: string; health?: HealthCheck; error?: string }> {
    try {
      const state = await this.ensureFinder();
      const health = await state.client.call<HealthCheck>("health", { testPath: state.root });
      return { root: state.root, health };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  rootForDisplay(): string | undefined {
    return this.activeRoot() ?? this.lastRoot;
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

  /**
   * Resolve a finder for interactive searches. Never waits for the index:
   * queries run immediately against whatever index exists and the `indexing`
   * flag tells callers that results may still be partial.
   */
  private async searchState(): Promise<{ state: FinderState; indexing: boolean }> {
    const state = await this.ensureFinder();
    let indexing = false;
    try {
      const progress = await state.client.call<ScanProgress>("progress");
      indexing = progress.isScanning || !progress.isWarmupComplete;
      if (indexing) {
        this.setIndexing(state.root, progress.scannedFilesCount);
      } else {
        this.setReady(state.root);
      }
    } catch {
      // Progress is best-effort; searches proceed regardless.
    }
    return { state, indexing };
  }

  private async createFinder(root: string): Promise<FinderState> {
    this.setIndexing(root);
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

    const client = new FinderClient(new URL("./finderWorker.js", import.meta.url));
    const state: FinderState = { root, client };
    try {
      await client.call("init", { options: options as unknown as Record<string, unknown> });
    } catch (error) {
      client.dispose();
      this.setError(error, root);
      throw error;
    }

    void client.call<boolean>("waitForIndexReady", { timeoutMs: 600_000 })
      .then(() => {
        if (!this.disposed && !client.disposed) {
          this.setReady(root);
        }
      })
      .catch((error) => {
        if (!this.disposed && !client.disposed) {
          state.error = error instanceof Error ? error.message : String(error);
          this.setError(error, root);
        }
      });
    return state;
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

  private setReady(root: string): void {
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
