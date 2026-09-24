// @ts-nocheck
import type { CompactionReason } from "./types";

import type { RetainedToolOutputProjection } from "./core/tool-output-budget";

export interface PiVccAppendCoverage {
  firstCoveredEntryId: string;
  lastCoveredEntryId: string;
  firstKeptEntryId: string;
  sourceMessageCount: number;
  includesLegacySummary?: boolean;
  rebasedFromCompactionId?: string;
}

export interface PiVccAppendSegment {
  sequence: number;
  summary: string;
  coverage: PiVccAppendCoverage;
  tokensBefore: number;
}

export interface PiVccAppendDetails {
  compactor: "omp-vcc";
  version: 3;
  summaryMode: "append";
  chainStart: boolean;
  segment: PiVccAppendSegment;
  trailingSummary: string;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  retainedToolOutputProjection?: RetainedToolOutputProjection;
  reason?: CompactionReason;
  willRetry?: boolean;
  savings?: PiVccCompactionDetails["savings"];
}

export interface PiVccCompactionDetails {
  compactor: "pi-vcc" | "omp-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  retainedToolOutputProjection?: RetainedToolOutputProjection;
  reason?: CompactionReason;
  willRetry?: boolean;
  savings?: {
    tokensBefore: number;
    summaryChars: number;
    summaryTokensEst: number;
    keptTokensEst: number;
    tokensAfterEst: number;
    tokensSavedEst: number;
    savedPercentEst: number;
  };
}
