// FFF Search sidebar webview script (terminal-polish UI).
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const MODES = ["auto", "plain", "regex", "fuzzy"];
  const FILTER_KEYS = ["Include", "Exclude", "CurrentDir", "FileType", "Modified"];
  const SVG_SIDE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H3L2 2v11l1 1h11l1-1V2l-1-1zM8 13H3V2h5v11zm6 0H9V2h5v11z"/></svg>';
  const SVG_COPY = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4V2.5L5.5 1h7L14 2.5v8L12.5 12H11v1.5L9.5 15h-7L1 13.5v-8L2.5 4H4zm1 0h4.5L11 5.5V11h1.5l.5-.5v-8l-.5-.5h-7l-.5.5V4zM2 5.5v8l.5.5h7l.5-.5v-8L9.5 5h-7l-.5.5z"/></svg>';

  const defaults = {
    tab: "files",
    fileQuery: "",
    textQuery: "",
    mode: "auto",
    caseMode: "smart",
    fuzzyFallback: true,
    fileInclude: "", fileExclude: "", fileCurrentDir: "", fileFileType: "", fileModified: false,
    textInclude: "", textExclude: "", textCurrentDir: "", textFileType: "", textModified: false,
  };
  const state = Object.assign({}, defaults, vscode.getState() || {});

  let timer;
  let retryTimer;
  let toastTimer;
  let selIndex = -1;

  // --- Restore persisted UI state ------------------------------------------
  $("fileQuery").value = state.fileQuery;
  $("textQuery").value = state.textQuery;
  for (const prefix of ["file", "text"]) {
    for (const key of FILTER_KEYS) {
      const el = $(prefix + key);
      if (el.type === "checkbox") el.checked = state[prefix + key];
      else el.value = state[prefix + key];
    }
  }

  // --- Event wiring ---------------------------------------------------------
  $("filesTab").addEventListener("click", () => switchTab("files"));
  $("textTab").addEventListener("click", () => switchTab("text"));
  $("collapseAll").addEventListener("click", () => setAllGroupsCollapsed(true));
  $("expandAll").addEventListener("click", () => setAllGroupsCollapsed(false));

  $("modeTok").addEventListener("click", () => {
    state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
    onControlsChanged();
  });
  $("caseTok").addEventListener("click", () => {
    state.caseMode = state.caseMode === "smart" ? "sensitive" : "smart";
    onControlsChanged();
  });
  $("fallbackTok").addEventListener("click", () => {
    state.fuzzyFallback = !state.fuzzyFallback;
    onControlsChanged();
  });

  for (const button of document.querySelectorAll("[data-clear]")) {
    button.addEventListener("click", () => {
      const input = $(button.dataset.clear);
      input.value = "";
      input.focus();
      onControlsChanged();
    });
  }

  const inputIds = ["fileQuery", "textQuery"]
    .concat(["file", "text"].flatMap((prefix) => FILTER_KEYS.map((key) => prefix + key)));
  for (const id of inputIds) {
    $(id).addEventListener("input", onControlsChanged);
  }

  for (const id of ["fileQuery", "textQuery"]) {
    $(id).addEventListener("keydown", onQueryKeydown);
  }

  document.addEventListener("keydown", onGlobalKeydown);

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "state") $("root").textContent = msg.root || "no active root";
    if (msg.type === "setTextQuery") {
      switchTab("text");
      $("textQuery").value = msg.query;
      onControlsChanged();
    }
    if (msg.type === "filesLoading") setLoading("file", "searching files\u2026");
    if (msg.type === "textLoading") setLoading("text", "searching text (" + msg.mode + ")\u2026");
    if (msg.type === "filesResult") renderFiles(msg);
    if (msg.type === "textResult") renderText(msg);
    if (msg.type === "copied") toast("path copied to clipboard");
    if (msg.type === "error") {
      $("fileStatus").textContent = msg.message;
      $("textStatus").textContent = msg.message;
      $("fileResults").classList.remove("busy");
      $("textResults").classList.remove("busy");
    }
  });

  // --- Boot -----------------------------------------------------------------
  applyTab();
  renderToks();
  renderStatusToks();
  vscode.postMessage({ type: "ready" });
  if (currentQuery()) schedule();

  function onControlsChanged() {
    saveState();
    renderToks();
    renderStatusToks();
    schedule();
  }

  // --- Tabs -----------------------------------------------------------------
  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    saveState();
    applyTab();
    schedule();
  }

  function applyTab() {
    const isFiles = state.tab === "files";
    $("filesTab").classList.toggle("active", isFiles);
    $("textTab").classList.toggle("active", !isFiles);
    $("filesPane").classList.toggle("hidden", !isFiles);
    $("textPane").classList.toggle("hidden", isFiles);
    clearSelection();
  }

  function currentQuery() {
    return state.tab === "files" ? $("fileQuery").value : $("textQuery").value;
  }

  // --- Search dispatch ------------------------------------------------------
  function schedule() {
    clearTimeout(timer);
    clearTimeout(retryTimer);
    timer = setTimeout(search, 150);
  }

  /** While the index is warming up, poll for fresh results automatically. */
  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(search, 1000);
  }

  function search() {
    if (state.tab === "files") {
      vscode.postMessage({ type: "searchFiles", query: $("fileQuery").value, ...readFilters("file") });
    } else {
      vscode.postMessage({
        type: "searchText",
        query: $("textQuery").value,
        mode: state.mode,
        caseMode: state.caseMode,
        fuzzyFallback: state.fuzzyFallback,
        ...readFilters("text"),
      });
    }
  }

  function readFilters(prefix) {
    return {
      include: $(prefix + "Include").value,
      exclude: $(prefix + "Exclude").value,
      modified: $(prefix + "Modified").checked,
      currentDir: $(prefix + "CurrentDir").value,
      fileType: $(prefix + "FileType").value,
    };
  }

  function saveState() {
    state.fileQuery = $("fileQuery").value;
    state.textQuery = $("textQuery").value;
    for (const prefix of ["file", "text"]) {
      for (const key of FILTER_KEYS) {
        const el = $(prefix + key);
        state[prefix + key] = el.type === "checkbox" ? el.checked : el.value;
      }
    }
    vscode.setState(state);
  }

  // --- Tokens ---------------------------------------------------------------
  function renderToks() {
    for (const prefix of ["file", "text"]) {
      const toks = [];
      for (const value of splitTokens($(prefix + "Include").value)) {
        toks.push(tok("include", value, prefix + "Include", value));
      }
      for (const value of splitTokens($(prefix + "Exclude").value)) {
        toks.push(tok("exclude", "!" + value, prefix + "Exclude", value));
      }
      const scope = $(prefix + "CurrentDir").value.trim();
      if (scope) toks.push(tok("scope", "@" + scope, prefix + "CurrentDir", scope));
      const fileType = $(prefix + "FileType").value;
      if (fileType) toks.push(tok("type", fileType === "c-cpp" ? "c/c++" : fileType, prefix + "FileType", fileType));
      if ($(prefix + "Modified").checked) toks.push(tok("git", "git:modified", prefix + "Modified", "git:modified"));
      toks.push('<button class="tok add" title="edit filters">+ filter</button>');
      $(prefix + "Toks").innerHTML = toks.join("");
    }
  }

  function tok(kind, label, key, value) {
    return '<span class="tok ' + kind + '" data-key="' + attr(key) + '" data-value="' + attr(value) + '" title="click to edit">'
      + '<span class="tok-label">' + escapeHtml(label) + '</span>'
      + '<button class="tok-x" title="remove this filter">\u00D7</button>'
      + '</span>';
  }

  function splitTokens(value) {
    return String(value || "").split(/[\s,;]+/).map((token) => token.trim()).filter(Boolean);
  }

  function removeTok(tokEl) {
    const key = tokEl.dataset.key;
    const value = tokEl.dataset.value;
    const input = $(key);
    if (!input) return;
    if (input.type === "checkbox") {
      input.checked = false;
    } else if (key.endsWith("Include") || key.endsWith("Exclude")) {
      input.value = splitTokens(input.value)
        .filter((token) => token !== value)
        .join(key.endsWith("Include") ? ", " : "; ");
    } else {
      input.value = "";
    }
    toast("removed: " + value);
    onControlsChanged();
  }

  for (const id of ["fileToks", "textToks"]) {
    $(id).addEventListener("click", (event) => {
      const prefix = id === "fileToks" ? "file" : "text";
      const x = event.target.closest(".tok-x");
      if (x) {
        removeTok(x.closest(".tok"));
        return;
      }
      const add = event.target.closest(".tok.add");
      if (add) {
        $(prefix + "Advanced").open = true;
        return;
      }
      const el = event.target.closest(".tok");
      if (el) {
        $(prefix + "Advanced").open = true;
        const target = $(el.dataset.key);
        if (target && target.focus) target.focus();
      }
    });
  }

  function renderStatusToks() {
    const alt = MODES.filter((mode) => mode !== state.mode).join("\u00B7");
    $("modeTok").innerHTML = 'mode:<b>' + escapeHtml(state.mode) + '</b> <span class="alt">(' + escapeHtml(alt) + ')</span>';
    $("caseTok").textContent = "smart-case";
    $("caseTok").className = "stok " + (state.caseMode === "smart" ? "on" : "off");
    $("fallbackTok").textContent = "typo-fallback";
    $("fallbackTok").className = "stok " + (state.fuzzyFallback ? "on" : "off");
  }

  // --- Rendering ------------------------------------------------------------
  function setLoading(prefix, text) {
    $(prefix + "Status").textContent = text;
    $(prefix + "Results").classList.add("busy");
  }

  function renderFiles(msg) {
    $("fileResults").classList.remove("busy");
    if (msg.indexing) scheduleRetry();
    const indexing = msg.indexing ? ' \u00B7 <span class="indexing">indexing\u2026</span>' : "";
    $("fileStatus").innerHTML = (msg.files.length
      ? '<span class="nums">' + msg.files.length + "/" + (msg.totalMatched || msg.files.length) + "</span>"
      : "no results") + indexing;
    if (!msg.files.length) {
      $("fileResults").innerHTML = $("fileQuery").value
        ? '<div class="empty">no files match \u2014 fewer terms, or relax filters</div>'
        : "";
      clearSelection();
      return;
    }
    $("fileResults").innerHTML = msg.files.map((file) => {
      const parts = splitPath(file.relativePath);
      return '<div class="row" data-nav data-open="' + attr(file.relativePath) + '" title="' + attr(file.relativePath) + '">'
        + '<span class="ptr">\u276F</span>'
        + gitGutter(file.gitStatus)
        + fileTypeDot(parts.name)
        + '<span class="pathline"><span class="filepart">' + highlight(parts.name, msg.terms) + '</span>'
        + '<span class="dirpart">' + shortenDir(parts.dir, msg.terms) + '</span></span>'
        + rowActions(file.relativePath)
        + '</div>';
    }).join("");
    bindActions($("fileResults"));
    clearSelection();
  }

  function renderText(msg) {
    $("textResults").classList.remove("busy");
    const regex = msg.regexError ? " \u00B7 regex fallback: " + escapeHtml(msg.regexError) : "";
    const indexing = msg.indexing ? ' \u00B7 <span class="indexing">indexing\u2026</span>' : "";
    if (msg.indexing) scheduleRetry();
    $("textStatus").innerHTML = (msg.totalMatched
      ? '<span class="nums">' + msg.totalMatched + '</span> matches \u00B7 <span class="nums">' + msg.groups.length + '</span> files \u00B7 ' + escapeHtml(msg.mode)
      : "no matches \u00B7 " + escapeHtml(msg.mode)) + regex + indexing;
    if (!msg.groups.length) {
      $("textResults").innerHTML = !$("textQuery").value
        ? ""
        : msg.indexing
          ? '<div class="empty">index warming up \u2014 results will appear automatically</div>'
          : '<div class="empty">no matches \u2014 try mode:fuzzy, or relax filters</div>';
      clearSelection();
      return;
    }
    $("textResults").innerHTML = msg.groups.map(renderGroup).join("");
    bindActions($("textResults"));
    clearSelection();
  }

  function renderGroup(group) {
    const parts = splitPath(group.relativePath);
    return '<div class="fgroup">'
      + '<div class="fhead" data-toggle title="' + attr(group.relativePath) + '">'
      + '<span class="tri"></span>'
      + fileTypeDot(parts.name)
      + '<span class="fname">' + escapeHtml(parts.name) + '</span>'
      + '<span class="fdir">' + escapeHtml(parts.dir) + '</span>'
      + '<span class="badge">' + group.matches.length + '</span>'
      + rowActions(group.relativePath)
      + '</div>'
      + group.matches.map(renderMatch).join("")
      + '</div>';
  }

  function renderMatch(match) {
    return '<div class="mrow" data-nav data-open="' + attr(match.relativePath) + '" data-line="' + match.lineNumber
      + '" data-col="' + match.col + '" data-len="' + firstLen(match) + '">'
      + '<span class="ptr">\u276F</span>'
      + '<span class="loc">' + match.lineNumber + ":" + (match.col + 1) + '</span>'
      + '<span class="bar">\u2502</span>'
      + '<span class="code">' + highlightRanges(match.lineContent, match.matchRanges) + '</span>'
      + rowActions(match.relativePath, match.lineNumber, match.col, firstLen(match))
      + '</div>';
  }

  function rowActions(path, line, col, len) {
    const attrs = ' data-path="' + attr(path) + '"'
      + (line ? ' data-line="' + line + '" data-col="' + col + '" data-len="' + len + '"' : "");
    const dir = splitPath(path).dir;
    const filterButtons = dir
      ? '<button class="ra finc" title="Include this folder: ' + attr(dir) + '" data-dir="' + attr(dir) + '">+</button>'
        + '<button class="ra fexc" title="Exclude this folder: ' + attr(dir) + '" data-dir="' + attr(dir) + '">!</button>'
      : "";
    return '<span class="rowacts">'
      + filterButtons
      + '<button class="ra side" title="Open to the side (Ctrl+Enter)"' + attrs + '>' + SVG_SIDE + '</button>'
      + '<button class="ra copy" title="Copy relative path"' + attrs + '>' + SVG_COPY + '</button>'
      + '</span>';
  }

  function bindActions(root) {
    if (root.dataset.bound) return;
    root.dataset.bound = "1";
    root.addEventListener("click", onResultsClick);
  }

  function onResultsClick(event) {
    const target = event.target;
    const finc = target.closest(".finc");
    if (finc) { openPop("Include", finc.dataset.dir, finc); return; }
    const fexc = target.closest(".fexc");
    if (fexc) { openPop("Exclude", fexc.dataset.dir, fexc); return; }
    const side = target.closest(".side");
    if (side) {
      vscode.postMessage({
        type: "openSide",
        relativePath: side.dataset.path,
        lineNumber: num(side.dataset.line),
        col: num(side.dataset.col),
        selectLength: num(side.dataset.len),
      });
      return;
    }
    const copy = target.closest(".copy");
    if (copy) {
      vscode.postMessage({
        type: "copy",
        relativePath: copy.dataset.path,
        lineNumber: num(copy.dataset.line),
        col: num(copy.dataset.col),
      });
      return;
    }
    const toggle = target.closest("[data-toggle]");
    if (toggle) {
      toggle.closest(".fgroup").classList.toggle("collapsed");
      return;
    }
    const open = target.closest("[data-open]");
    if (open) openElement(open, event.ctrlKey);
  }

  // --- Folder depth popover ---------------------------------------------------
  let popKind = "Exclude";

  function openPop(kind, dir, anchor) {
    try {
      const pop = $("pop");
      const segments = String(dir || "").split("/").filter(Boolean);
      if (!segments.length) return;
      popKind = kind;
      const isInclude = kind === "Include";
      const items = segments.map((_, i) => {
        const prefix = segments.slice(0, i + 1).join("/") + "/";
        const parent = i === 0 ? "" : segments.slice(0, i).join("/") + "/";
        const exact = i === segments.length - 1 ? ' <span class="pexact">exact</span>' : "";
        return '<button class="pop-item" data-p="' + attr(prefix) + '">'
          + '<span class="pdim">' + escapeHtml(parent) + '</span>'
          + '<span class="pbright">' + escapeHtml(segments[i]) + '/</span>' + exact
          + '</button>';
      });
      pop.innerHTML = '<div class="pop-head ' + (isInclude ? "inc" : "exc") + '">'
        + (isInclude ? "+ include folder\u2026" : "! exclude folder\u2026") + '</div>'
        + items.join("");
      pop.classList.remove("hidden");

      const rect = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const width = Math.min(300, vw - 16);
      pop.style.width = width + "px";
      pop.style.left = Math.max(8, Math.min(rect.right - width, vw - width - 8)) + "px";
      pop.style.top = "0px";
      const height = pop.offsetHeight;
      let top = rect.bottom + 4;
      if (top + height > vh - 8) top = Math.max(8, rect.top - height - 4);
      pop.style.top = top + "px";
    } catch (error) {
      toast("popover error: " + (error && error.message ? error.message : error));
    }
  }

  function closePop() {
    $("pop").classList.add("hidden");
  }

  $("pop").addEventListener("click", (event) => {
    const item = event.target.closest(".pop-item");
    if (item) {
      addToFilter(popKind, item.dataset.p);
      closePop();
    }
  });

  document.addEventListener("mousedown", (event) => {
    if ($("pop").classList.contains("hidden")) return;
    if (event.target.closest("#pop") || event.target.closest(".finc") || event.target.closest(".fexc")) return;
    closePop();
  });

  function addToFilter(key, dir) {
    if (!dir) return;
    const prefix = state.tab === "files" ? "file" : "text";
    const input = $(prefix + key);
    const tokens = input.value.split(/[\s,;]+/).filter(Boolean);
    if (tokens.includes(dir)) {
      toast("already in " + key.toLowerCase() + ": " + dir);
      return;
    }
    input.value = tokens.concat(dir).join(key === "Include" ? ", " : "; ");
    toast((key === "Include" ? "+ include: " : "! exclude: ") + dir);
    onControlsChanged();
  }

  function openElement(el, side) {
    vscode.postMessage({
      type: side ? "openSide" : "open",
      relativePath: el.dataset.open,
      lineNumber: num(el.dataset.line),
      col: num(el.dataset.col),
      selectLength: num(el.dataset.len),
    });
  }

  // --- Groups collapse ------------------------------------------------------
  function setAllGroupsCollapsed(collapsed) {
    document.querySelectorAll(".fgroup").forEach((group) => group.classList.toggle("collapsed", collapsed));
    clearSelection();
  }

  // --- Keyboard navigation ---------------------------------------------------
  function navEls() {
    const pane = state.tab === "files" ? $("fileResults") : $("textResults");
    return [...pane.querySelectorAll("[data-nav]")].filter((el) => el.offsetParent !== null);
  }

  function clearSelection() {
    selIndex = -1;
    document.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
  }

  function select(index) {
    const els = navEls();
    document.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
    if (!els.length || index < 0) {
      selIndex = -1;
      return;
    }
    selIndex = Math.min(els.length - 1, index);
    const el = els[selIndex];
    el.classList.add("selected");
    el.scrollIntoView({ block: "nearest" });
  }

  function onQueryKeydown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      select(selIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      select(selIndex - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const els = navEls();
      const el = els[selIndex] || els[0];
      if (el) openElement(el, event.ctrlKey);
    }
  }

  function focusActiveSearch() {
    const input = state.tab === "files" ? $("fileQuery") : $("textQuery");
    input.focus();
    input.select();
  }

  function onGlobalKeydown(event) {
    const tag = document.activeElement.tagName;
    if (event.key === "/" && tag !== "INPUT" && tag !== "SELECT") {
      event.preventDefault();
      focusActiveSearch();
    }
    if (event.ctrlKey && event.key === "1") { event.preventDefault(); switchTab("files"); focusActiveSearch(); }
    if (event.ctrlKey && event.key === "2") { event.preventDefault(); switchTab("text"); focusActiveSearch(); }
    if (event.ctrlKey && event.key === "ArrowLeft") { event.preventDefault(); setAllGroupsCollapsed(true); }
    if (event.ctrlKey && event.key === "ArrowRight") { event.preventDefault(); setAllGroupsCollapsed(false); }
    if (event.key === "Escape") {
      if (!$("pop").classList.contains("hidden")) {
        closePop();
        return;
      }
      if (tag === "INPUT" && document.activeElement.value) {
        document.activeElement.value = "";
        onControlsChanged();
      }
    }
  }

  // --- Toast -------------------------------------------------------------------
  function toast(message) {
    const el = $("toast");
    clearTimeout(toastTimer);
    el.textContent = message;
    el.classList.add("show");
    toastTimer = setTimeout(() => el.classList.remove("show"), 1400);
  }

  // --- Path display -----------------------------------------------------------
  function splitPath(relativePath) {
    const normalized = String(relativePath).replace(/\\/g, "/");
    const index = normalized.lastIndexOf("/");
    if (index === -1) return { dir: "", name: normalized };
    return { dir: normalized.slice(0, index + 1), name: normalized.slice(index + 1) };
  }

  function shortenDir(dir, terms) {
    const segments = dir.split("/").filter(Boolean);
    if (!segments.length) return "";
    const seg = (value, hot) => (hot ? '<span class="hot">' : "") + highlight(value, terms) + (hot ? "</span>" : "");
    if (segments.length > 5) {
      return seg(segments[0]) + "/" + seg(segments[1], true) + '/<span class="ell">\u2026</span>/'
        + seg(segments[segments.length - 2]) + "/" + seg(segments[segments.length - 1]) + "/";
    }
    return segments.map((value) => seg(value)).join("/") + "/";
  }

  function fileTypeDot(name) {
    const ext = (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1) : "").toLowerCase();
    let kind = "x";
    if (["c", "cc", "cpp", "cxx"].includes(ext)) kind = "c";
    else if (["h", "hh", "hpp", "hxx"].includes(ext)) kind = "h";
    else if (ext === "py") kind = "py";
    return '<span class="ftd ' + kind + '"></span>';
  }

  function gitGutter(status) {
    const value = String(status || "").toLowerCase();
    const letters = { modified: "M", untracked: "U", added: "A", deleted: "D", renamed: "R", conflicted: "C", staged: "A" };
    let letter = "";
    if (value && value !== "clean" && value !== "unmodified" && value !== "ignored" && value !== "unknown") {
      letter = letters[value] || value[0].toUpperCase();
    }
    if (!letter) return '<span class="gitm"></span>';
    return '<span class="gitm ' + letter.toLowerCase() + '" title="' + attr(value) + '">' + letter + '</span>';
  }

  // --- Utilities -----------------------------------------------------------------
  function firstLen(match) {
    return match.matchRanges && match.matchRanges[0] ? match.matchRanges[0][1] - match.matchRanges[0][0] : 0;
  }

  function highlight(value, terms) {
    let out = escapeHtml(value);
    for (const term of terms || []) {
      out = out.replace(new RegExp(escapeRegExp(escapeHtml(term)), "ig"), (m) => "<mark>" + m + "</mark>");
    }
    return out;
  }

  function highlightRanges(value, ranges) {
    if (!ranges || !ranges.length) return escapeHtml(value);
    let out = "";
    let last = 0;
    for (const [start, end] of ranges) {
      out += escapeHtml(value.slice(last, start)) + "<mark>" + escapeHtml(value.slice(start, end)) + "</mark>";
      last = end;
    }
    return out + escapeHtml(value.slice(last));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  }

  function attr(value) {
    return escapeHtml(value);
  }

  function escapeRegExp(value) {
    return value.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
  }

  function num(value) {
    return value === undefined || value === "" ? undefined : Number(value);
  }
})();
