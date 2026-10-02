// @ts-nocheck
import type { Message } from "@oh-my-pi/pi-ai";

// "incomplete" is omp's length-truncated-turn recovery reason
// (runRecoveryCompactionWithRollback("incomplete", …)). Like "overflow" it is a
// recovery the host must own, so omp-vcc defers to it instead of cancelling.
export type CompactionReason = "manual" | "threshold" | "overflow" | "incomplete";

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "custom"; text: string; sourceIndex?: number }
  | { kind: "thinking"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; sourceIndex?: number }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number };
