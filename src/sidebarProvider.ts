import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { GrepMode } from "@ff-labs/fff-node";
import { IndexManager } from "./indexManager.js";
import { buildEffectiveQuery, displayQueryTerms, parseTextQuery } from "./query.js";
import { FileResultDto, TextGroupDto, TextMatchDto, toTextMatchDto } from "./types.js";

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pendingTextQuery?: string;
  private generation = 0;

  constructor(
    private readonly manager: IndexManager,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    try {
      view.webview.html = this.html(view.webview);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      view.webview.html = `<!DOCTYPE html><html><body><p>FFF Search failed to load its UI:</p><pre>${message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))}</pre></body></html>`;
      void vscode.window.showErrorMessage(`FFF Search sidebar failed to load: ${message}`);
      return;
    }
    view.webview.onDidReceiveMessage((message) => void this.handleMessage(message));
    this.postState();
    if (this.pendingTextQuery) {
      this.post({ type: "setTextQuery", query: this.pendingTextQuery });
      this.pendingTextQuery = undefined;
    }
  }

  async showTextQuery(query: string): Promise<void> {
    this.pendingTextQuery = query;
    await vscode.commands.executeCommand("fffSearch.sidebar.focus");
    if (this.view) {
      this.post({ type: "setTextQuery", query });
      this.pendingTextQuery = undefined;
    }
  }

  refreshRoot(): void {
    this.postState();
  }

  private async handleMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
    try {
      if (message.type === "ready") {
        this.postState();
        return;
      }
      if (message.type === "searchFiles") {
        await this.searchFiles(message);
        return;
      }
      if (message.type === "searchText") {
        await this.searchText(message);
        return;
      }
      if (message.type === "open") {
        await this.manager.openFile(String(message.relativePath), locationOptions(message));
        return;
      }
      if (message.type === "openSide") {
        await this.manager.openFile(String(message.relativePath), { ...locationOptions(message), side: true });
        return;
      }
      if (message.type === "copy") {
        const line = typeof message.lineNumber === "number" ? message.lineNumber : undefined;
        const col = typeof message.col === "number" ? message.col : undefined;
        await this.manager.copyRelativePath(String(message.relativePath), line ? { line, col } : undefined);
        this.post({ type: "copied" });
      }
    } catch (error) {
      this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async searchFiles(message: { [key: string]: unknown }): Promise<void> {
    const myGeneration = ++this.generation;
    const query = buildEffectiveQuery(String(message.query ?? ""), filters(message));
    this.post({ type: "filesLoading" });
    const { result, indexing } = await this.manager.fileSearch(query, {
      pageSize: config<number>("maxSidebarFileResults"),
    });
    if (myGeneration !== this.generation) {
      return;
    }
    const terms = displayQueryTerms(query);
    const files: FileResultDto[] = result.items.map((item) => ({
      relativePath: item.relativePath,
      fileName: item.fileName,
      gitStatus: item.gitStatus,
      size: item.size,
    }));
    this.postState();
    this.post({ type: "filesResult", files, terms, totalMatched: result.totalMatched, indexing });
  }

  private async searchText(message: { [key: string]: unknown }): Promise<void> {
    const myGeneration = ++this.generation;
    const effectiveQuery = buildEffectiveQuery(String(message.query ?? ""), filters(message));
    const parsed = parseTextQuery(effectiveQuery, {
      mode: mode(message.mode),
      caseMode: message.caseMode === "sensitive" ? "sensitive" : "smart",
      fuzzyFallback: message.fuzzyFallback !== false,
    });

    if (!parsed.query) {
      this.post({ type: "textResult", groups: [], mode: parsed.mode, totalMatched: 0 });
      return;
    }

    this.post({ type: "textLoading", mode: parsed.mode });
    const options = {
      mode: parsed.mode,
      smartCase: parsed.smartCase,
      pageSize: config<number>("maxSidebarTextResults"),
      maxMatchesPerFile: config<number>("maxMatchesPerFile"),
      timeBudgetMs: 300,
    };
    let { result, indexing } = await this.manager.grep(parsed.query, options);
    let usedMode = parsed.mode;
    if (result.items.length === 0 && parsed.fuzzyFallback && parsed.mode !== "fuzzy" && !indexing) {
      const fallback = await this.manager.grep(parsed.query, { ...options, mode: "fuzzy" });
      result = fallback.result;
      indexing = fallback.indexing;
      usedMode = "fuzzy";
    }
    if (myGeneration !== this.generation) {
      return;
    }
    this.postState();
    this.post({
      type: "textResult",
      groups: groupMatches(result.items.map(toTextMatchDto)),
      mode: usedMode,
      totalMatched: result.totalMatched,
      regexError: result.regexFallbackError,
      indexing,
    });
  }

  private postState(): void {
    this.post({ type: "state", root: this.manager.rootForDisplay() });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media", "sidebar");
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "sidebar.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "sidebar.js"));
    const template = fs.readFileSync(vscode.Uri.joinPath(mediaRoot, "sidebar.html").fsPath, "utf8");
    return template
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{cssUri}}", cssUri.toString())
      .replaceAll("{{jsUri}}", jsUri.toString());
  }
}

function filters(message: { [key: string]: unknown }) {
  return {
    include: stringValue(message.include),
    exclude: stringValue(message.exclude),
    modified: message.modified === true,
    currentDir: stringValue(message.currentDir),
    fileType: fileTypeGlob(stringValue(message.fileType)),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mode(value: unknown): "auto" | GrepMode {
  return value === "plain" || value === "regex" || value === "fuzzy" ? value : "auto";
}

function fileTypeGlob(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value !== "c-cpp") {
    return value;
  }
  return "*.{c,cc,cpp,cxx,h,hh,hpp,hxx}";
}

function groupMatches(matches: TextMatchDto[]): TextGroupDto[] {
  const map = new Map<string, TextGroupDto>();
  for (const match of matches) {
    let group = map.get(match.relativePath);
    if (!group) {
      group = { relativePath: match.relativePath, fileName: match.fileName, gitStatus: match.gitStatus, matches: [] };
      map.set(match.relativePath, group);
    }
    group.matches.push(match);
  }
  return [...map.values()];
}

function locationOptions(message: { [key: string]: unknown }) {
  return {
    line: typeof message.lineNumber === "number" ? message.lineNumber : undefined,
    col: typeof message.col === "number" ? message.col : undefined,
    selectLength: typeof message.selectLength === "number" ? message.selectLength : undefined,
  };
}

function config<T>(key: string): T {
  return vscode.workspace.getConfiguration("fffSearch").get<T>(key) as T;
}
