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
    :root { --border: var(--vscode-sideBarSectionHeader-border, #333); --soft: color-mix(in srgb, var(--vscode-sideBar-background) 78%, var(--vscode-foreground) 22%); --chip: color-mix(in srgb, var(--vscode-button-secondaryBackground) 70%, transparent); }
    * { box-sizing: border-box; }
    body { padding: 0 0 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    .root { display: flex; gap: 7px; align-items: center; min-height: 30px; padding: 7px 10px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--border); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .root::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-testing-iconPassed, #89d185); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconPassed, #89d185) 18%, transparent); flex: 0 0 auto; }
    .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px; }
    .tabs button { height: 28px; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 6px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .tabs button.active { border-color: color-mix(in srgb, var(--vscode-focusBorder) 58%, transparent); background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent); color: var(--vscode-foreground); }
    .search-box { padding: 0 8px 8px; }
    .query-wrap { display: grid; grid-template-columns: 1fr auto; align-items: center; border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 6px; background: var(--vscode-input-background); }
    .query-wrap:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent); }
    input, select { width: 100%; min-width: 0; border: 0; outline: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    .query-wrap input { height: 32px; padding: 0 9px; background: transparent; }
    .kbd { margin-right: 7px; padding: 1px 5px 2px; border: 1px solid var(--border); border-radius: 4px; color: var(--vscode-descriptionForeground); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; }
    .mode-row { display: flex; gap: 5px; padding-top: 7px; overflow-x: auto; }
    .chip { border: 1px solid var(--border); border-radius: 999px; background: var(--chip); color: var(--vscode-descriptionForeground); padding: 3px 8px 4px; font-size: 11px; white-space: nowrap; }
    .chip.active { border-color: color-mix(in srgb, var(--vscode-focusBorder) 48%, transparent); background: color-mix(in srgb, var(--vscode-focusBorder) 14%, transparent); color: var(--vscode-foreground); }
    .advanced { margin: 0 8px 8px; border: 1px solid var(--border); border-radius: 6px; background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-foreground) 12%); }
    .advanced summary { display: flex; justify-content: space-between; gap: 8px; padding: 7px 8px; color: var(--vscode-descriptionForeground); cursor: pointer; list-style: none; font-size: 11px; }
    .advanced summary::-webkit-details-marker { display: none; }
    .advanced-body { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 0 8px 8px; }
    .advanced input, .advanced select { height: 28px; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 5px; padding: 0 8px; }
    .check { display: flex; gap: 6px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .check input { width: auto; height: auto; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 31px; padding: 6px 10px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); color: var(--vscode-descriptionForeground); font-size: 11px; }
    .toolbar-actions { display: flex; gap: 3px; }
    .ghost, .linkButton { border: 0; border-radius: 4px; background: transparent; color: var(--vscode-textLink-foreground); padding: 1px 4px; font-size: 11px; }
    .ghost:hover, .linkButton:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .results { padding: 6px 0 10px; }
    .status { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 0 10px; }
    .item, .fileGroup { margin: 0 6px 4px; border-radius: 6px; }
    .item { display: grid; gap: 2px; padding: 5px 7px; cursor: pointer; }
    .item:hover, .match:hover, .fileHeader:hover { background: var(--vscode-list-hoverBackground); }
    .path { color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
    mark { color: var(--vscode-editor-findMatchForeground); background: var(--vscode-editor-findMatchHighlightBackground); border-radius: 2px; padding: 0 1px; }
    .fileHeader { display: grid; grid-template-columns: 18px 1fr auto; align-items: center; gap: 5px; min-height: 30px; padding: 0 6px; border-radius: 6px; cursor: pointer; }
    .chevron { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .matches { margin-left: 20px; border-left: 1px solid var(--border); }
    .fileGroup.collapsed .matches { display: none; }
    .match { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; gap: 7px; align-items: start; padding: 4px 6px 5px 8px; border-radius: 0 5px 5px 0; cursor: pointer; }
    .line { color: var(--vscode-descriptionForeground); text-align: right; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
    .lineText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
    .actions { display: inline-flex; gap: 2px; opacity: 0; }
    .item:hover .actions, .match:hover .actions, .fileHeader:hover .actions { opacity: 1; }
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
    <div class="search-box"><div class="query-wrap"><input id="fileQuery" placeholder="Find file: button *.ts !test/ git:modified" /><span class="kbd">Enter</span></div><div class="mode-row"><span class="chip active">Fuzzy path</span><span class="chip">Constraints</span></div></div>
    ${filtersHtml("file")}
    <div class="status" id="fileStatus">Type to search files.</div>
    <div class="results" id="fileResults"></div>
  </section>
  <section id="textPane" class="hidden">
    <div class="search-box"><div class="query-wrap"><input id="textQuery" placeholder="Search text: vddpa power, vddpa_*, re:foo.*bar" /><span class="kbd">Ctrl Enter</span></div><div class="mode-row" id="textChips"></div></div>
    <details class="advanced" open>
      <summary>Search mode</summary>
      <div class="advanced-body">
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
        <label class="check"><input id="fuzzyFallback" type="checkbox" checked /> Typo fallback</label>
      </div>
    </details>
    ${filtersHtml("text")}
    <div class="toolbar">
      <span id="textStatus">Type to search text.</span>
      <span class="toolbar-actions"><button class="ghost" id="collapseAll" title="Collapse all (Ctrl+Left)">Collapse all</button><button class="ghost" id="expandAll" title="Expand all (Ctrl+Right)">Expand all</button></span>
    </div>
    <div class="results" id="textResults"></div>
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
    for (const id of ['textQuery','textInclude','textExclude','textModified','textCurrentDir','textFileType','mode','caseMode','fuzzyFallback']) $(id).addEventListener('input', () => { updateChips(); schedule(); });
    updateChips();

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
      $('fileResults').innerHTML = msg.files.map((file) => '<div class="item" data-open="' + attr(file.relativePath) + '"><div class="path">' + highlight(file.relativePath, msg.terms) + '</div><div class="meta">' + escapeHtml(file.gitStatus || '') + actions(file.relativePath) + '</div></div>').join('');
      bindActions($('fileResults'));
    }
    function renderText(msg) {
      const regex = msg.regexError ? ' · regex fallback: ' + msg.regexError : '';
      $('textStatus').textContent = msg.totalMatched + ' matches · ' + msg.mode + regex;
      $('textResults').innerHTML = msg.groups.map(renderGroup).join('');
      bindActions($('textResults'));
    }
    function renderGroup(group) {
      return '<div class="fileGroup"><div class="fileHeader" data-toggle><span class="chevron">▾</span><span class="path">' + escapeHtml(group.relativePath) + '</span><span class="meta">' + group.matches.length + actions(group.relativePath) + '</span></div><div class="matches">' + group.matches.map(renderMatch).join('') + '</div></div>';
    }
    function renderMatch(match) {
      return '<div class="match" data-open="' + attr(match.relativePath) + '" data-line="' + match.lineNumber + '" data-col="' + match.col + '" data-len="' + firstLen(match) + '"><span class="line">' + match.lineNumber + ':' + (match.col + 1) + '</span><span class="lineText">' + highlightRanges(match.lineContent, match.matchRanges) + '</span>' + actions(match.relativePath, match.lineNumber, match.col, firstLen(match)) + '</div>';
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
    function focusActiveSearch() {
      const input = activeTab === 'files' ? $('fileQuery') : $('textQuery');
      input.focus();
      input.select();
    }
    function updateChips() {
      const mode = $('mode').value;
      const caseMode = $('caseMode').value === 'smart' ? 'Smart case' : 'Case sensitive';
      const fallback = $('fuzzyFallback').checked ? 'Typo fallback' : 'No fallback';
      const include = $('textInclude').value.trim();
      const fileType = $('textFileType').value;
      const filters = include || fileType ? '<span class="chip">' + escapeHtml([include, fileType].filter(Boolean).join(', ')) + '</span>' : '';
      $('textChips').innerHTML = '<span class="chip active">' + escapeHtml(mode === 'auto' ? 'Auto mode' : mode) + '</span><span class="chip">' + caseMode + '</span><span class="chip">' + fallback + '</span>' + filters;
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
        event.preventDefault();
        focusActiveSearch();
      }
      if (event.ctrlKey && event.key === '1') { event.preventDefault(); switchTab('files'); focusActiveSearch(); }
      if (event.ctrlKey && event.key === '2') { event.preventDefault(); switchTab('text'); focusActiveSearch(); }
      if (event.ctrlKey && event.key === 'ArrowLeft') { event.preventDefault(); setAllGroupsCollapsed(true); }
      if (event.ctrlKey && event.key === 'ArrowRight') { event.preventDefault(); setAllGroupsCollapsed(false); }
      if (event.key === 'Escape' && document.activeElement.tagName === 'INPUT') {
        document.activeElement.value = '';
        updateChips();
        schedule();
      }
    });
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
  return `<details class="advanced">
    <summary><span>Filters</span><span>include, exclude, type, git</span></summary>
    <div class="advanced-body">
      <input id="${id("Include")}" placeholder="Include: *.c, *.h" />
      <input id="${id("Exclude")}" placeholder="Exclude: build/; generated/" />
      <input id="${id("CurrentDir")}" placeholder="Current dir scope: src/foo/" />
      <select id="${id("FileType")}">
        <option value="">Any type</option>
        <option value="*.ts">TS</option>
        <option value="*.{ts,tsx}">TS/TSX</option>
        <option value="c-cpp">C/C++</option>
        <option value="*.rs">Rust</option>
        <option value="*.py">Python</option>
      </select>
      <label class="check"><input id="${id("Modified")}" type="checkbox" /> git:modified</label>
    </div>
  </details>`;
}

function config<T>(key: string): T {
  return vscode.workspace.getConfiguration("fffSearch").get<T>(key) as T;
}
