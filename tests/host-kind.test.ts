// @ts-nocheck
// resolveHostKind/getHostKind: omp and pi expose incompatible ctx.compact
// shapes, so the factory branches the /omp-vcc + /pi-vcc call form on host
// kind (string+await on omp, {customInstructions,onComplete,onError} on pi).
// @oh-my-pi is omp-exclusive; host-free defaults to omp (legacy form).
import { describe, expect, test, afterEach } from "bun:test";
import { resolveHostKind, getHostKind, __setHostKindForTests, resolveCompactForm } from "../extensions/vcc-core/hook";

afterEach(() => {
  __setHostKindForTests(null);
});

describe("resolveHostKind", () => {
  test("@earendil-works scope wins (pi)", () => {
    expect(resolveHostKind((id) => { if (id === "@earendil-works/pi-coding-agent") return { compact: () => {} }; throw new Error("miss"); })).toBe("pi");
  });

  test("@oh-my-pi scope alone resolves omp", () => {
    expect(resolveHostKind((id) => { if (id === "@oh-my-pi/pi-coding-agent") return { compact: () => {} }; throw new Error("miss"); })).toBe("omp");
  });

  test("unresolvable host defaults to omp (legacy string form)", () => {
    expect(resolveHostKind(() => { throw new Error("miss"); })).toBe("omp");
  });

  test("loader returning falsy does not win", () => {
    expect(resolveHostKind((id) => (id === "@earendil-works/pi-coding-agent" ? undefined : { compact: () => {} }))).toBe("omp");
  });
});

describe("getHostKind seam", () => {
  test("defaults to the detected host (omp when host-free)", () => {
    expect(getHostKind()).toBe("omp");
  });

  test("override sticks until reset", () => {
    __setHostKindForTests("pi");
    expect(getHostKind()).toBe("pi");
    __setHostKindForTests(null);
    expect(getHostKind()).toBe("omp");
  });
});

describe("resolveCompactForm", () => {
  const miss = () => { throw new Error("miss"); };
  const hit = () => ({});

  test("explicit override wins over everything", () => {
    __setHostKindForTests("pi");
    try {
      expect(resolveCompactForm(hit, () => ["prompt"])).toBe("object");
    } finally {
      __setHostKindForTests(null);
    }
    __setHostKindForTests("omp");
    try {
      expect(resolveCompactForm(hit, () => "prompt")).toBe("string");
    } finally {
      __setHostKindForTests(null);
    }
  });

  test("string system prompt means pi object form", () => {
    expect(resolveCompactForm(miss, () => "prompt")).toBe("object");
  });

  test("array system prompt means omp string form", () => {
    expect(resolveCompactForm(miss, () => ["prompt"])).toBe("string");
  });

  test("throwing getter falls through to module scope", () => {
    expect(resolveCompactForm((id) => { if (id === "@earendil-works/pi-coding-agent") return hit(); throw new Error("miss"); }, () => { throw new Error("no prompt"); })).toBe("object");
  });

  test("host-free with no prompt getter keeps the legacy omp default", () => {
    expect(resolveCompactForm(miss)).toBe("string");
    expect(resolveCompactForm(miss, () => undefined)).toBe("string");
  });
});
