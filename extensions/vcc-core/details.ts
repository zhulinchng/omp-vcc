// @ts-nocheck
import type { CompactionReason } from "./types";

export interface PiVccCompactionDetails {
  compactor: "pi-vcc" | "omp-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
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
