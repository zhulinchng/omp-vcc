// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { normalizeRecallScope, normalizeRecallMode, parseRecallMode, parseRecallScope } from "../extensions/vcc-core/core/recall-scope";

describe("normalizeRecallScope", () => {
  it("defaults to active lineage", () => {
    expect(normalizeRecallScope()).toBe("lineage");
    expect(normalizeRecallScope("lineage")).toBe("lineage");
    expect(normalizeRecallScope("unknown")).toBe("lineage");
    expect(normalizeRecallScope(123)).toBe("lineage");
  });

  it("accepts all scope", () => {
    expect(normalizeRecallScope("all")).toBe("all");
    expect(normalizeRecallScope("ALL")).toBe("all");
  });
});

describe("parseRecallScope", () => {
  it("removes scope token from command text", () => {
    expect(parseRecallScope("license scope:all page:2")).toEqual({
      scope: "all",
      text: "license page:2",
    });
  });

  it("defaults to lineage when no scope token is present", () => {
    expect(parseRecallScope("license page:2")).toEqual({
      scope: "lineage",
      text: "license page:2",
    });
  });
});

describe("repeated selector tokens", () => {
  it("strips every scope selector, not just the first", () => {
    expect(parseRecallScope("auth scope:all scope:all")).toEqual({ scope: "all", text: "auth" });
  });

  it("strips every mode selector, not just the first", () => {
    expect(parseRecallMode("auth mode:file mode:file")).toEqual({ mode: "file", text: "auth" });
  });
});

// `active` is advertised in the vcc_recall `scope` enum and mapped to
// `lineage`, but the command parser only stripped `lineage|all` — so the token
// stayed in the query text and `/vcc-recall auth scope:active` searched for
// the literal string "auth scope:active".
describe("scope:active aliases the active lineage", () => {
  it("parses and strips the active alias", () => {
    expect(parseRecallScope("auth scope:active")).toEqual({ scope: "lineage", text: "auth" });
  });

  it("parses it case-insensitively and strips every occurrence", () => {
    expect(parseRecallScope("auth scope:ACTIVE scope:active")).toEqual({ scope: "lineage", text: "auth" });
  });

  it("leaves an unknown scope token in the query text", () => {
    expect(parseRecallScope("auth scope:branch")).toEqual({ scope: "lineage", text: "auth scope:branch" });
  });
});
