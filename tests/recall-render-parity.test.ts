// @ts-nocheck
// A search hit prints `#N [role] <snippet>` and tells the model to use `#N`
// for the full text — so the ref MUST resolve to the text the search matched.
// fullText (search-entries.ts) indexes text + thinking + toolCall arguments,
// while renderMessage used to expose only text plus `name(path=…)`, and to
// render pythonExecution / fileMention rows as EMPTY `[assistant]` entries.
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAllMessages } from "../extensions/vcc-core/core/load-messages.ts";
import { searchEntriesDetailed } from "../extensions/vcc-core/core/search-entries.ts";
import { expandEntry } from "../extensions/vcc-core/core/drill-down.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

let dirCount = 0;
const makeSession = (entries: any[]) => {
  const dir = mkdtempSync(join(tmpdir(), `omp-vcc-parity-${dirCount++}-`));
  tmpDirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
};

describe("recall ref parity: #N resolves to what the search matched", () => {
  it("a hit that only exists in a Write argument is reproducible via #N:full", () => {
    const file = makeSession([
      { type: "message", id: "m0", message: { role: "user", content: "create the module" } },
      {
        type: "message",
        id: "m1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Writing the module." },
            { type: "toolCall", name: "write", arguments: { path: "src/mod.ts", content: "const v = 'PARITYWRITE';" } },
          ],
        },
      },
    ]);
    const loaded = loadAllMessages(file, false);
    const { hits } = searchEntriesDetailed(loaded.rendered, loaded.rawMessages, "PARITYWRITE");
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBe(1);
    expect(hits[0].snippet).toContain("PARITYWRITE");
    expect(expandEntry(file, hits[0].index, true)).toContain("PARITYWRITE");
  });

  it("a mixed thinking+text entry exposes its thinking in the full view", () => {
    const file = makeSession([
      {
        type: "message",
        id: "m0",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PARITYTHINK reasoning" },
            { type: "text", text: "visible answer" },
          ],
        },
      },
    ]);
    const loaded = loadAllMessages(file, false);
    const { hits } = searchEntriesDetailed(loaded.rendered, loaded.rawMessages, "PARITYTHINK");
    expect(hits).toHaveLength(1);
    const expanded = expandEntry(file, 0, true);
    expect(expanded).toContain("PARITYTHINK");
    expect(expanded).toContain("visible answer");
    // The compact (non-full) body stays unchanged.
    expect(loaded.rendered[0].summary).toBe("visible answer");
  });

  it("pythonExecution entries render as python and are searchable by output", () => {
    const file = makeSession([
      { type: "message", id: "m0", message: { role: "pythonExecution", code: "print(1)", output: "PARITYPYOUT" } },
    ]);
    const loaded = loadAllMessages(file, false);
    expect(loaded.rendered[0].role).toBe("python");
    expect(loaded.rendered[0].summary).toContain("PARITYPYOUT");
    const { hits } = searchEntriesDetailed(loaded.rendered, loaded.rawMessages, "PARITYPYOUT");
    expect(hits).toHaveLength(1);
    expect(expandEntry(file, 0, true)).toContain("PARITYPYOUT");
  });

  it("fileMention entries keep their role and are searchable by file content", () => {
    const file = makeSession([
      {
        type: "message",
        id: "m0",
        message: { role: "fileMention", files: [{ path: "docs/spec.md", content: "PARITYMENTION spec text" }] },
      },
    ]);
    const loaded = loadAllMessages(file, false);
    expect(loaded.rendered[0].role).toBe("file_mention");
    const { hits } = searchEntriesDetailed(loaded.rendered, loaded.rawMessages, "PARITYMENTION");
    expect(hits).toHaveLength(1);
    expect(expandEntry(file, 0, true)).toContain("PARITYMENTION");
  });

  it("an unrecognised role keeps its own label instead of masquerading as assistant", () => {
    const file = makeSession([
      { type: "message", id: "m0", message: { role: "developer", content: "harness instructions" } },
    ]);
    const loaded = loadAllMessages(file, false);
    expect(loaded.rendered[0].role).toBe("developer");
    expect(loaded.rendered[0].summary).toContain("harness instructions");
  });
});
