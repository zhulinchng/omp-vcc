// @ts-nocheck
// resolveHostKind/getHostKind: omp and pi expose incompatible ctx.compact
// shapes, so the factory branches the /omp-vcc + /pi-vcc call form on host
// kind (string+await on omp, {customInstructions,onComplete,onError} on pi).
// Detection is module resolution: @earendil-works is pi-exclusive,
// @oh-my-pi is omp-exclusive; host-free defaults to omp (legacy form).
import { describe, expect, test, afterEach } from "bun:test";
import { resolveHostKind, getHostKind, __setHostKindForTests } from "../extensions/vcc-core/hook";

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
