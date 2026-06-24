import * as path from "node:path";
import * as vscode from "vscode";
import type { GrepMode } from "@ff-labs/fff-node";
import { IndexManager } from "./indexManager.js";
import { buildEffectiveQuery, displayQueryTerms, parseTextQuery } from "./query.js";
import { FileResultDto, TextGroupDto, TextMatchDto, toTextMatchDto } from "./types.js";

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pendingTextQuery?: string;
  private generation = 0;

  constructor(private readonly manager: IndexManager) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
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
      }
    } catch (error) {
      this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async searchFiles(message: { [key: string]: unknown }): Promise<void> {
    const myGeneration = ++this.generation;
    const query = buildEffectiveQuery(String(message.query ?? ""), filters(message));
    this.post({ type: "filesLoading" });
    const { result } = await this.manager.fileSearch(query, {
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
    this.post({ type: "filesResult", files, terms, totalMatched: result.totalMatched });
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
    let { result } = await this.manager.grep(parsed.query, options);
    let usedMode = parsed.mode;
    if (result.items.length === 0 && parsed.fuzzyFallback && parsed.mode !== "fuzzy") {
      const fallback = await this.manager.grep(parsed.query, { ...options, mode: "fuzzy" });
      result = fallback.result;
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
    });
  }

  private postState(): void {
    this.post({ type: "state", root: this.manager.rootForDisplay() });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { padding: 0 10px 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .root { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 8px 0 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tabs { display: flex; gap: 4px; margin-bottom: 8px; }
    .toolbar { display: flex; gap: 4px; margin: 6px 0; }
    button, input, select { font: inherit; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 4px 8px; cursor: pointer; }
    button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    input, select { width: 100%; box-sizing: border-box; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 5px 7px; margin-bottom: 6px; }
    .row { display: flex; gap: 6px; align-items: center; }
    .row > * { flex: 1; }
    label { display: flex; gap: 6px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 4px 0; }
    label input { width: auto; margin: 0; }
    .advanced { border-top: 1px solid var(--vscode-sideBarSectionHeader-border); margin: 8px 0; padding-top: 8px; }
    .status { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 8px 0; }
    .item, .fileGroup { border-radius: 4px; padding: 5px 6px; margin: 2px 0; }
    .item:hover, .match:hover, .fileHeader:hover { background: var(--vscode-list-hoverBackground); }
    .path { color: var(--vscode-foreground); word-break: break-all; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
    mark { color: var(--vscode-editor-findMatchForeground); background: var(--vscode-editor-findMatchHighlightBackground); padding: 0; }
    .fileHeader { display: flex; justify-content: space-between; gap: 8px; cursor: pointer; padding: 5px 6px; border-radius: 4px; }
    .chevron { color: var(--vscode-descriptionForeground); display: inline-block; width: 14px; }
    .matches { margin-left: 8px; border-left: 1px solid var(--vscode-sideBarSectionHeader-border); }
    .fileGroup.collapsed .matches { display: none; }
    .match { padding: 4px 6px; cursor: pointer; }
    .line { color: var(--vscode-descriptionForeground); }
    .actions { display: inline-flex; gap: 4px; margin-left: 6px; }
    .linkButton { border: 0; padding: 0 2px; color: var(--vscode-textLink-foreground); background: transparent; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="root" id="root">No root</div>
  <div class="tabs">
    <button id="filesTab" class="active">Files</button>
    <button id="textTab">Text</button>
  </div>
  <section id="filesPane">
    <input id="fileQuery" placeholder="Find file: button *.ts !test/ git:modified" />
    ${filtersHtml("file")}
    <div class="status" id="fileStatus">Type to search files.</div>
    <div id="fileResults"></div>
  </section>
  <section id="textPane" class="hidden">
    <input id="textQuery" placeholder="Search text: vddpa power, vddpa_*, re:foo.*bar" />
    <div class="row">
      <select id="mode">
        <option value="auto">Auto</option>
        <option value="plain">Plain</option>
        <option value="regex">Regex</option>
        <option value="fuzzy">Fuzzy</option>
      </select>
      <select id="caseMode">
        <option value="smart">Smart case</option>
        <option value="sensitive">Case sensitive</option>
      </select>
    </div>
    <label><input id="fuzzyFallback" type="checkbox" checked /> Typo fallback</label>
    ${filtersHtml("text")}
    <div class="toolbar">
      <button id="collapseAll" title="Collapse all file groups">Collapse all</button>
      <button id="expandAll" title="Expand all file groups">Expand all</button>
    </div>
    <div class="status" id="textStatus">Type to search text.</div>
    <div id="textResults"></div>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let activeTab = 'files';
    let timer;
    const $ = (id) => document.getElementById(id);

    $('filesTab').addEventListener('click', () => switchTab('files'));
    $('textTab').addEventListener('click', () => switchTab('text'));
    $('collapseAll').addEventListener('click', () => setAllGroupsCollapsed(true));
    $('expandAll').addEventListener('click', () => setAllGroupsCollapsed(false));
    for (const id of ['fileQuery','fileInclude','fileExclude','fileModified','fileCurrentDir','fileFileType']) $(id).addEventListener('input', schedule);
    for (const id of ['textQuery','textInclude','textExclude','textModified','textCurrentDir','textFileType','mode','caseMode','fuzzyFallback']) $(id).addEventListener('input', schedule);

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') $('root').textContent = msg.root || 'No active root';
      if (msg.type === 'setTextQuery') { switchTab('text'); $('textQuery').value = msg.query; schedule(); }
      if (msg.type === 'filesLoading') $('fileStatus').textContent = 'Searching files...';
      if (msg.type === 'textLoading') $('textStatus').textContent = 'Searching text (' + msg.mode + ')...';
      if (msg.type === 'filesResult') renderFiles(msg);
      if (msg.type === 'textResult') renderText(msg);
      if (msg.type === 'error') { $('fileStatus').textContent = msg.message; $('textStatus').textContent = msg.message; }
    });
    vscode.postMessage({ type: 'ready' });

    function switchTab(tab) {
      activeTab = tab;
      $('filesTab').classList.toggle('active', tab === 'files');
      $('textTab').classList.toggle('active', tab === 'text');
      $('filesPane').classList.toggle('hidden', tab !== 'files');
      $('textPane').classList.toggle('hidden', tab !== 'text');
      schedule();
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(search, 150); }
    function search() {
      if (activeTab === 'files') {
        vscode.postMessage({ type: 'searchFiles', query: $('fileQuery').value, ...readFilters('file') });
      } else {
        vscode.postMessage({ type: 'searchText', query: $('textQuery').value, mode: $('mode').value, caseMode: $('caseMode').value, fuzzyFallback: $('fuzzyFallback').checked, ...readFilters('text') });
      }
    }
    function readFilters(prefix) {
      return { include: $(prefix + 'Include').value, exclude: $(prefix + 'Exclude').value, modified: $(prefix + 'Modified').checked, currentDir: $(prefix + 'CurrentDir').value, fileType: $(prefix + 'FileType').value };
    }
    function renderFiles(msg) {
      $('fileStatus').textContent = msg.files.length + ' shown' + (msg.totalMatched ? ' of ' + msg.totalMatched : '');
      $('fileResults').innerHTML = msg.files.map((file) => '<div class="item"><div class="path">' + highlight(file.relativePath, msg.terms) + '</div><div class="meta">' + escapeHtml(file.gitStatus || '') + actions(file.relativePath) + '</div></div>').join('');
      bindActions($('fileResults'));
    }
    function renderText(msg) {
      const regex = msg.regexError ? ' · regex fallback: ' + msg.regexError : '';
      $('textStatus').textContent = msg.totalMatched + ' matches · ' + msg.mode + regex;
      $('textResults').innerHTML = msg.groups.map(renderGroup).join('');
      bindActions($('textResults'));
    }
    function renderGroup(group) {
      return '<div class="fileGroup"><div class="fileHeader" data-toggle><span class="path"><span class="chevron">▾</span>' + escapeHtml(group.relativePath) + '</span><span class="meta">' + group.matches.length + actions(group.relativePath) + '</span></div><div class="matches">' + group.matches.map(renderMatch).join('') + '</div></div>';
    }
    function renderMatch(match) {
      return '<div class="match" data-open="' + attr(match.relativePath) + '" data-line="' + match.lineNumber + '" data-col="' + match.col + '" data-len="' + firstLen(match) + '"><span class="line">' + match.lineNumber + ':' + (match.col + 1) + '</span> ' + highlightRanges(match.lineContent, match.matchRanges) + actions(match.relativePath, match.lineNumber, match.col, firstLen(match)) + '</div>';
    }
    function actions(path, line, col, len) {
      const attrs = ' data-path="' + attr(path) + '"' + (line ? ' data-line="' + line + '" data-col="' + col + '" data-len="' + len + '"' : '');
      return '<span class="actions"><button class="linkButton side"' + attrs + '>side</button><button class="linkButton copy"' + attrs + '>copy</button></span>';
    }
    function bindActions(root) {
      root.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('click', (event) => {
        if (event.target.tagName === 'BUTTON') return;
        const group = el.closest('.fileGroup');
        group.classList.toggle('collapsed');
        const chevron = group.querySelector('.chevron');
        if (chevron) chevron.textContent = group.classList.contains('collapsed') ? '▸' : '▾';
      }));
      root.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (event) => {
        if (event.target.tagName === 'BUTTON') return;
        vscode.postMessage({ type: 'open', relativePath: el.dataset.open, lineNumber: num(el.dataset.line), col: num(el.dataset.col), selectLength: num(el.dataset.len) });
      }));
      root.querySelectorAll('.side').forEach((el) => el.addEventListener('click', () => vscode.postMessage({ type: 'openSide', relativePath: el.dataset.path, lineNumber: num(el.dataset.line), col: num(el.dataset.col), selectLength: num(el.dataset.len) })));
      root.querySelectorAll('.copy').forEach((el) => el.addEventListener('click', () => vscode.postMessage({ type: 'copy', relativePath: el.dataset.path, lineNumber: num(el.dataset.line), col: num(el.dataset.col) })));
    }
    function setAllGroupsCollapsed(collapsed) {
      document.querySelectorAll('.fileGroup').forEach((group) => {
        group.classList.toggle('collapsed', collapsed);
        const chevron = group.querySelector('.chevron');
        if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
      });
    }
    function firstLen(match) { return match.matchRanges && match.matchRanges[0] ? match.matchRanges[0][1] - match.matchRanges[0][0] : 0; }
    function highlight(value, terms) {
      let out = escapeHtml(value);
      for (const term of terms || []) out = out.replace(new RegExp(escapeRegExp(escapeHtml(term)), 'ig'), (m) => '<mark>' + m + '</mark>');
      return out;
    }
    function highlightRanges(value, ranges) {
      if (!ranges || !ranges.length) return escapeHtml(value);
      let out = '', last = 0;
      for (const [start, end] of ranges) { out += escapeHtml(value.slice(last, start)) + '<mark>' + escapeHtml(value.slice(start, end)) + '</mark>'; last = end; }
      return out + escapeHtml(value.slice(last));
    }
    function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
    function attr(value) { return escapeHtml(value); }
    function escapeRegExp(value) { return value.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); }
    function num(value) { return value === undefined || value === '' ? undefined : Number(value); }
  </script>
</body>
</html>`;
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

function filtersHtml(prefix: string): string {
  const id = (name: string) => `${prefix}${name}`;
  return `<div class="advanced">
    <div class="row">
      <input id="${id("Include")}" placeholder="Include: *.c, *.h" />
      <input id="${id("Exclude")}" placeholder="Exclude: build/; generated/" />
    </div>
    <div class="row">
      <input id="${id("CurrentDir")}" placeholder="Current dir scope: src/foo/" />
      <select id="${id("FileType")}">
        <option value="">Any type</option>
        <option value="*.ts">TS</option>
        <option value="*.{ts,tsx}">TS/TSX</option>
        <option value="c-cpp">C/C++</option>
        <option value="*.rs">Rust</option>
        <option value="*.py">Python</option>
      </select>
    </div>
    <label><input id="${id("Modified")}" type="checkbox" /> git:modified</label>
  </div>`;
}

function config<T>(key: string): T {
  return vscode.workspace.getConfiguration("fffSearch").get<T>(key) as T;
}
