import type { CaseMode, ParsedTextQuery, SearchMode } from "./types.js";

export function parseTextQuery(raw: string, options?: {
  mode?: SearchMode;
  caseMode?: CaseMode;
  fuzzyFallback?: boolean;
}): ParsedTextQuery {
  let query = raw.trim();
  let requestedMode = options?.mode ?? "auto";

  const prefix = query.slice(0, 3).toLowerCase();
  if (prefix === "re:" || prefix === "fz:" || prefix === "pl:") {
    query = query.slice(3).trimStart();
    requestedMode = prefix === "re:" ? "regex" : prefix === "fz:" ? "fuzzy" : "plain";
  }

  const mode = requestedMode === "auto" ? detectMode(query) : requestedMode;
  return {
    query,
    mode,
    requestedMode,
    smartCase: (options?.caseMode ?? "smart") === "smart",
    fuzzyFallback: options?.fuzzyFallback ?? true,
  };
}

export function detectMode(query: string): "plain" | "regex" {
  const searchableTokens = query
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !isConstraintToken(token));

  return searchableTokens.some(hasStrongRegexSyntax) ? "regex" : "plain";
}

export function buildEffectiveQuery(query: string, filters?: {
  include?: string;
  exclude?: string;
  modified?: boolean;
  currentDir?: string;
  fileType?: string;
}): string {
  const parts = [query.trim()];
  if (filters?.currentDir) {
    parts.push(filters.currentDir.replace(/\\/g, "/").replace(/^\/+/, ""));
  }
  if (filters?.fileType) {
    parts.push(filters.fileType.trim());
  }
  if (filters?.include) {
    parts.push(...splitFilterTokens(filters.include));
  }
  if (filters?.exclude) {
    for (const token of splitFilterTokens(filters.exclude)) {
      parts.push(token.startsWith("!") ? token : `!${token}`);
    }
  }
  if (filters?.modified) {
    parts.push("git:modified");
  }
  return parts.filter(Boolean).join(" ").trim();
}

export function displayQueryTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !isConstraintToken(token) && !token.includes("*"))
    .map((token) => token.replace(/^(re|fz|pl):/i, ""))
    .filter((token) => token.length > 1);
}

function isConstraintToken(token: string): boolean {
  return token.startsWith("!")
    || token.startsWith("git:")
    || token.includes("/")
    || token.startsWith("*.")
    || token.startsWith("**/")
    || /^\*\.\{.*\}$/.test(token);
}

function hasStrongRegexSyntax(token: string): boolean {
  return token.includes(".*")
    || /\\[dDsSwWbB]/.test(token)
    || /[\[\]()|]/.test(token)
    || token.startsWith("^")
    || token.endsWith("$")
    || /[+?]/.test(token)
    || (/\*/.test(token) && !token.startsWith("*."));
}

function splitFilterTokens(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}
