import type { GrepMatch, GrepMode } from "@ff-labs/fff-node";

export type CaseMode = "smart" | "sensitive";
export type SearchMode = "auto" | GrepMode;

export interface ParsedTextQuery {
  query: string;
  mode: GrepMode;
  requestedMode: SearchMode;
  smartCase: boolean;
  fuzzyFallback: boolean;
}

export interface FileResultDto {
  relativePath: string;
  fileName: string;
  gitStatus: string;
  size: number;
}

export interface TextMatchDto {
  relativePath: string;
  fileName: string;
  gitStatus: string;
  lineNumber: number;
  col: number;
  lineContent: string;
  matchRanges: [number, number][];
  fuzzyScore?: number;
  totalFrecencyScore: number;
}

export interface TextGroupDto {
  relativePath: string;
  fileName: string;
  gitStatus: string;
  matches: TextMatchDto[];
}

export function toTextMatchDto(match: GrepMatch): TextMatchDto {
  return {
    relativePath: match.relativePath,
    fileName: match.fileName,
    gitStatus: match.gitStatus,
    lineNumber: match.lineNumber,
    col: match.col,
    lineContent: match.lineContent,
    matchRanges: match.matchRanges,
    fuzzyScore: match.fuzzyScore,
    totalFrecencyScore: match.totalFrecencyScore,
  };
}
