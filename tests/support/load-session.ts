// @ts-nocheck
import { readFileSync } from "node:fs";
import type { Message } from "@oh-my-pi/pi-ai";

export interface LoadedSession {
  messageCount: number;
  skippedCount: number;
  messages: Message[];
}

export const loadSessionMessages = (file: string): LoadedSession => {
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const messages: any[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) messages.push(entry.message);
      } catch {}
    }
    return { messageCount: messages.length, skippedCount: 0, messages };
  } catch {
    return { messageCount: 0, skippedCount: 0, messages: [] };
  }
};
