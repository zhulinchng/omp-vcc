// @ts-nocheck
import { describe, test, expect, afterEach } from "bun:test";
import * as fsSync from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { extractCommits, formatCommits } from "../extensions/vcc-core/extract/commits.ts";
import { migrateStalePluginEntries } from "../extensions/vcc-core/core/migrate-stale.ts";
import { collapseSkillLines, collapseSkillText } from "../extensions/vcc-core/core/skill-collapse.ts";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extensions/vcc-core/extract/preferences.ts";
import type { NormalizedBlock } from "../extensions/vcc-core/types.ts";

const bashCall = (command: string): NormalizedBlock => ({
  kind: "tool_call",
  name: "bash",
  args: { command },
});
const bashResult = (text: string): NormalizedBlock => ({
  kind: "tool_result",
  name: "bash",
  text,
});

describe("extractCommits quoting + pairing gaps", () => {
  test("double-quoted -m pairs with bracket-form hash", () => {
    const blocks = [bashCall('git commit -m "fix login bug"'), bashResult("[main abc1234] fix login bug")];
    expect(extractCommits(blocks)).toEqual([{ hash: "abc1234", message: "fix login bug" }]);
  });

  test("single-quoted -m pairs with range-form hash (takes second)", () => {
    const blocks = [bashCall("git commit -m 'add feature'"), bashResult("abc1234..def5678")];
    expect(extractCommits(blocks)).toEqual([{ hash: "def5678", message: "add feature" }]);
  });

  test("$'...' quoting pairs with plain hex hash", () => {
    const blocks = [bashCall("git commit -m $'fix it'"), bashResult("committed deadbee")];
    expect(extractCommits(blocks)).toEqual([{ hash: "deadbee", message: "fix it" }]);
  });

  test("commit with no hash anywhere is still extracted with undefined hash", () => {
    const blocks = [bashCall('git commit -m "docs touchup"'), bashResult("done")];
    expect(extractCommits(blocks)).toEqual([{ hash: undefined, message: "docs touchup" }]);
  });

  test("skips non-bash tool calls, non-commit bash, -m-less commits, empty messages", () => {
    const cases: NormalizedBlock[][] = [
      [{ kind: "tool_call", name: "exec", args: { command: 'git commit -m "x"' } }],
      [bashCall("git push origin main")],
      [bashCall("git commit --amend --no-edit")],
      [bashCall('git commit -m ""')],
      [bashCall('git commit -m "   "')],
    ];
    for (const blocks of cases) expect(extractCommits(blocks)).toEqual([]);
  });

  test("unescapes escaped quotes in the message", () => {
    const blocks = [bashCall('git commit -m "say \\"hi\\""')];
    expect(extractCommits(blocks)).toEqual([{ hash: undefined, message: 'say "hi"' }]);
  });

  test("dedups by message+hash; same message with different hash is kept", () => {
    const dup: NormalizedBlock[] = [
      bashCall('git commit -m "same"'),
      bashResult("[main abc1234] same"),
      bashCall('git commit -m "same"'),
      bashResult("[main abc1234] same"),
    ];
    expect(extractCommits(dup)).toHaveLength(1);
    const rehash: NormalizedBlock[] = [
      bashCall('git commit -m "same"'),
      bashResult("[main abc1234] same"),
      bashCall('git commit -m "same"'),
      bashResult("[main def5678] same"),
    ];
    expect(extractCommits(rehash)).toHaveLength(2);
  });

  test("lookahead window is i+1..i+2: hash three blocks later is not paired", () => {
    const blocks: NormalizedBlock[] = [
      bashCall('git commit -m "late"'),
      { kind: "assistant", text: "working" },
      { kind: "assistant", text: "still working" },
      bashResult("[main abc1234] late"),
    ];
    expect(extractCommits(blocks)).toEqual([{ hash: undefined, message: "late" }]);
  });

  test("non-tool_result blocks between call and result are skipped over", () => {
    const blocks: NormalizedBlock[] = [
      bashCall('git commit -m "gap"'),
      { kind: "assistant", text: "noise" },
      bashResult("[main abc1234] gap"),
    ];
    expect(extractCommits(blocks)).toEqual([{ hash: "abc1234", message: "gap" }]);
  });
});

describe("formatCommits gaps", () => {
  test("hash prefix vs bare message; limit keeps the most recent", () => {
    expect(formatCommits([{ hash: "abc1234", message: "one" }, { message: "two" }])).toEqual([
      "abc1234: one",
      "two",
    ]);
    const three = [
      { hash: "a1b2c3d", message: "old" },
      { hash: "e4f5a6b", message: "mid" },
      { hash: "c7d8e9f", message: "new" },
    ];
    expect(formatCommits(three, 2)).toEqual(["e4f5a6b: mid", "c7d8e9f: new"]);
  });
});

describe("migrateStalePluginEntries gaps", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fsSync.rmSync(h, { recursive: true, force: true });
  });

  const mkHome = (): { home: string; pluginsDir: string; nm: string } => {
    const home = fsSync.mkdtempSync(join(os.tmpdir(), "vcc-migrate-"));
    homes.push(home);
    const pluginsDir = join(home, ".omp", "plugins");
    const nm = join(pluginsDir, "node_modules");
    fsSync.mkdirSync(nm, { recursive: true });
    return { home, pluginsDir, nm };
  };
  const writeLock = (pluginsDir: string, lock: unknown): string => {
    const p = join(pluginsDir, "omp-plugins.lock.json");
    fsSync.writeFileSync(p, typeof lock === "string" ? lock : JSON.stringify(lock));
    return p;
  };
  const linkTarget = (
    nm: string,
    home: string,
    name: string,
    pkgName: string | null,
  ): void => {
    if (name.includes("/")) fsSync.mkdirSync(join(nm, name.split("/")[0]!), { recursive: true });
    const target = join(home, `tgt-${name.replace("/", "-")}`);
    fsSync.mkdirSync(target, { recursive: true });
    if (pkgName !== null) fsSync.writeFileSync(join(target, "package.json"), JSON.stringify({ name: pkgName }));
    fsSync.symlinkSync(target, join(nm, name));
  };
  const lstatOk = (p: string): boolean => {
    try {
      fsSync.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  test("missing lock file returns no-lock", () => {
    const { home } = mkHome();
    expect(migrateStalePluginEntries(home)).toBe("no-lock");
  });

  test("invalid-JSON lock returns no-lock", () => {
    const { home, pluginsDir } = mkHome();
    writeLock(pluginsDir, "{not json");
    expect(migrateStalePluginEntries(home)).toBe("no-lock");
  });

  test("lock without omp-vcc keys returns no-stale", () => {
    const { home, pluginsDir } = mkHome();
    writeLock(pluginsDir, { plugins: { other: {} } });
    expect(migrateStalePluginEntries(home)).toBe("no-stale");
  });

  test("historic symlink + lock/settings entries are removed and lock rewritten", () => {
    const { home, pluginsDir, nm } = mkHome();
    const lockPath = writeLock(pluginsDir, {
      plugins: { "@zhu/omp-vcc": { v: 1 } },
      settings: { "@zhu/omp-vcc": { x: 1 } },
    });
    // Stale historic link name whose target carries the current package name
    // (the rename-leftover shape the migration targets).
    linkTarget(nm, home, "@zhu/omp-vcc", "omp-vcc");
    const out = migrateStalePluginEntries(home);
    expect(out).toBe("migrated locks:@zhu/omp-vcc links:@zhu/omp-vcc");
    expect(lstatOk(join(nm, "@zhu/omp-vcc"))).toBe(false);
    const rewritten = JSON.parse(fsSync.readFileSync(lockPath, "utf8"));
    expect(rewritten.plugins).toEqual({});
    expect(rewritten.settings ?? {}).toEqual({});
    // The emptied scope dir is removed (rmSync recursive).
    expect(lstatOk(join(nm, "@zhu"))).toBe(false);
  });

  test("package.json dependencies entry protects the link and lock", () => {
    const { home, pluginsDir, nm } = mkHome();
    writeLock(pluginsDir, { plugins: { "@zhu/omp-vcc": { v: 1 } } });
    fsSync.writeFileSync(join(pluginsDir, "package.json"), JSON.stringify({ dependencies: { "@zhu/omp-vcc": "1.0.0" } }));
    linkTarget(nm, home, "@zhu/omp-vcc", "omp-vcc");
    expect(migrateStalePluginEntries(home)).toBe("no-stale");
    expect(lstatOk(join(nm, "@zhu/omp-vcc"))).toBe(true);
  });

  test("duplicate realpaths keep the self-named link", () => {
    const { home, pluginsDir, nm } = mkHome();
    writeLock(pluginsDir, { plugins: { "@zhu/omp-vcc": { v: 1 }, "omp-vcc": { v: 1 } } });
    const target = join(home, "shared");
    fsSync.mkdirSync(target, { recursive: true });
    fsSync.writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@zhu/omp-vcc" }));
    fsSync.mkdirSync(join(nm, "@zhu"), { recursive: true });
    fsSync.symlinkSync(target, join(nm, "@zhu/omp-vcc"));
    fsSync.symlinkSync(target, join(nm, "omp-vcc"));
    const out = migrateStalePluginEntries(home);
    expect(out).toContain("migrated");
    expect(lstatOk(join(nm, "@zhu/omp-vcc"))).toBe(true);
    expect(lstatOk(join(nm, "omp-vcc"))).toBe(false);
    const rewritten = JSON.parse(fsSync.readFileSync(join(pluginsDir, "omp-plugins.lock.json"), "utf8"));
    expect(Object.keys(rewritten.plugins)).toEqual(["@zhu/omp-vcc"]);
  });

  test("orphan candidate symlink without lock entry is removed", () => {
    const { home, pluginsDir, nm } = mkHome();
    writeLock(pluginsDir, { plugins: {} });
    linkTarget(nm, home, "omp-vcc", "omp-vcc");
    expect(migrateStalePluginEntries(home)).toBe("migrated locks:none links:omp-vcc");
    expect(lstatOk(join(nm, "omp-vcc"))).toBe(false);
  });

  test("dangling symlink exercises the getReal catch and returns no-stale", () => {
    const { home, pluginsDir, nm } = mkHome();
    writeLock(pluginsDir, { plugins: { "@zhu/omp-vcc": { v: 1 } } });
    fsSync.mkdirSync(join(nm, "@zhu"), { recursive: true });
    fsSync.symlinkSync(join(home, "does-not-exist"), join(nm, "@zhu/omp-vcc"));
    expect(migrateStalePluginEntries(home)).toBe("no-stale");
    expect(lstatOk(join(nm, "@zhu/omp-vcc"))).toBe(true);
  });

  test("current-named link whose target names another package is left alone", () => {
    const { home, pluginsDir, nm } = mkHome();
    writeLock(pluginsDir, { plugins: { "omp-vcc": { v: 1 } } });
    linkTarget(nm, home, "omp-vcc", "foreign-fork");
    expect(migrateStalePluginEntries(home)).toBe("no-stale");
    expect(lstatOk(join(nm, "omp-vcc"))).toBe(true);
  });

  test("scoped duplicate loser is removed with its scope dir", () => {
    const { home, pluginsDir, nm } = mkHome();
    writeLock(pluginsDir, { plugins: { "@zhu/omp-vcc": { v: 1 }, "@old/omp-vcc": { v: 1 } } });
    const target = join(home, "shared-scoped");
    fsSync.mkdirSync(target, { recursive: true });
    fsSync.writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@zhu/omp-vcc" }));
    fsSync.mkdirSync(join(nm, "@zhu"), { recursive: true });
    fsSync.mkdirSync(join(nm, "@old"), { recursive: true });
    fsSync.symlinkSync(target, join(nm, "@zhu/omp-vcc"));
    fsSync.symlinkSync(target, join(nm, "@old/omp-vcc"));
    const out = migrateStalePluginEntries(home);
    expect(out).toContain("links:@old/omp-vcc");
    expect(lstatOk(join(nm, "@zhu/omp-vcc"))).toBe(true);
    expect(lstatOk(join(nm, "@old/omp-vcc"))).toBe(false);
    expect(lstatOk(join(nm, "@old"))).toBe(false);
    const rewritten = JSON.parse(fsSync.readFileSync(join(pluginsDir, "omp-plugins.lock.json"), "utf8"));
    expect(Object.keys(rewritten.plugins)).toEqual(["@zhu/omp-vcc"]);
  });

  test("scoped orphan candidate is removed with its scope dir", () => {
    const { home, pluginsDir, nm } = mkHome();
    writeLock(pluginsDir, { plugins: {} });
    linkTarget(nm, home, "@zhulinchng/omp-vcc", "omp-vcc");
    expect(migrateStalePluginEntries(home)).toBe("migrated locks:none links:@zhulinchng/omp-vcc");
    expect(lstatOk(join(nm, "@zhulinchng/omp-vcc"))).toBe(false);
    expect(lstatOk(join(nm, "@zhulinchng"))).toBe(false);
  });

  test("dedup loop removes the scoped loser when no package self-names", () => {
    const { home, pluginsDir, nm } = mkHome();
    writeLock(pluginsDir, { plugins: { "omp-vcc": { v: 1 }, "@old/omp-vcc": { v: 1 } } });
    // Shared target without a package.json: loop 1 cannot attribute either
    // link, so loop 2 keeps CURRENT and drops the scoped duplicate + scope dir.
    const target = join(home, "shared-nopkg");
    fsSync.mkdirSync(target, { recursive: true });
    fsSync.mkdirSync(join(nm, "@old"), { recursive: true });
    fsSync.symlinkSync(target, join(nm, "omp-vcc"));
    fsSync.symlinkSync(target, join(nm, "@old/omp-vcc"));
    const out = migrateStalePluginEntries(home);
    expect(out).toContain("links:@old/omp-vcc");
    expect(lstatOk(join(nm, "omp-vcc"))).toBe(true);
    expect(lstatOk(join(nm, "@old/omp-vcc"))).toBe(false);
    expect(lstatOk(join(nm, "@old"))).toBe(false);
  });
});

describe("collapseSkill gaps", () => {
  test("duplicate skill names collapse to one marker", () => {
    expect(
      collapseSkillLines([
        '<skill name="deploy">',
        "run it",
        "</skill>",
        '<skill name="deploy">',
        "again",
        "</skill>",
      ]),
    ).toEqual(["[skill: deploy]"]);
  });

  test("unclosed block drops trailing content", () => {
    expect(collapseSkillLines(["before", '<skill name="x">', "secret", "more"])).toEqual([
      "before",
      "[skill: x]",
    ]);
  });

  test("non-skill lines pass through untouched", () => {
    expect(collapseSkillLines(["hello", "world"])).toEqual(["hello", "world"]);
  });

  test("stray closing tag without opener passes through", () => {
    expect(collapseSkillLines(["</skill>", "ok"])).toEqual(["</skill>", "ok"]);
  });

  test("list-marker open/close forms match", () => {
    expect(collapseSkillLines(['- <skill name="lint">', "body", "- </skill>", "after"])).toEqual([
      "[skill: lint]",
      "after",
    ]);
  });

  test("collapseSkillText handles closed and unterminated blocks", () => {
    expect(collapseSkillText('start <skill name="a">hidden</skill> end')).toBe("start [skill: a] end");
    expect(collapseSkillText('start <skill name="a">hidden')).toBe("start [skill: a]");
  });
});

describe("extractPreferences + dedup gaps", () => {
  test("per-block cap keeps only the first preference line", () => {
    const blocks: NormalizedBlock[] = [{ kind: "user", text: "I prefer tabs\nI prefer spaces" }];
    expect(extractPreferences(blocks)).toEqual(["I prefer tabs"]);
  });

  test("total cap keeps the first 10 of 11 distinct preferences", () => {
    const blocks: NormalizedBlock[] = Array.from(
      { length: 11 },
      (_, i) => ({ kind: "user", text: `I prefer option${i}` }) as NormalizedBlock,
    );
    const prefs = extractPreferences(blocks);
    expect(prefs).toHaveLength(10);
    expect(prefs[9]).toBe("I prefer option9");
  });

  test("rejects questions, overlong lines, and tiny lines", () => {
    const q: NormalizedBlock[] = [{ kind: "user", text: "I prefer tabs?" }];
    expect(extractPreferences(q)).toEqual([]);
    const long: NormalizedBlock[] = [{ kind: "user", text: `I prefer ${"x".repeat(195)}` }];
    expect(extractPreferences(long)).toEqual([]);
    const tiny: NormalizedBlock[] = [{ kind: "user", text: "hey!" }];
    expect(extractPreferences(tiny)).toEqual([]);
  });

  test("ignores non-user blocks", () => {
    const blocks: NormalizedBlock[] = [{ kind: "thinking", text: "I prefer tabs" }];
    expect(extractPreferences(blocks)).toEqual([]);
  });

  test("dedups case-insensitively", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "I prefer tabs" },
      { kind: "user", text: "I PREFER TABS" },
    ];
    expect(extractPreferences(blocks)).toEqual(["I prefer tabs"]);
  });

  test("dedupPreferencesAgainstGoals removes overlap, keeps the rest", () => {
    expect(dedupPreferencesAgainstGoals(["  Ship dark mode  ", "I prefer tabs"], ["ship dark mode"])).toEqual([
      "I prefer tabs",
    ]);
  });
});
