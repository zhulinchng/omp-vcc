// @ts-nocheck
import { describe, it, expect } from "bun:test";
import {
  sigmoid,
  clampProbability,
  tfPrior,
  normPrior,
  compositePrior,
  posterior,
  scoreToProbability,
  estimateLikelihoodParams,
} from "../extensions/vcc-core/core/bayesian-probability";

// Port fidelity for the Bayesian BM25 score→probability transform
// (Jeong 2026a, Eqs. 20/22/25/26/27). Expected values below are computed by
// hand from those equations — not copied from the implementation — so a
// transcription error in the port fails here. Upstream reference:
// bayesian-bm25-js/src/probability.ts (pure functions only; no classes,
// fitting, fusion, or base-rate path ported).

describe("bayesian-probability port fidelity", () => {
  it("sigmoid is exact at 0 and stable on both branches", () => {
    expect(sigmoid(0)).toBe(0.5);
    // e^-2.25 ≈ 0.1054 → 1/1.1054 ≈ 0.9047
    expect(sigmoid(2.25)).toBeCloseTo(0.9047, 3);
    // No overflow/underflow to NaN at extremes (stable branch each side).
    expect(sigmoid(100)).toBe(1);
    expect(sigmoid(-100)).toBeGreaterThan(0);
    expect(sigmoid(-100)).toBeLessThan(1e-10);
  });

  it("clampProbability pins to [1e-10, 1-1e-10]", () => {
    expect(clampProbability(0)).toBe(1e-10);
    expect(clampProbability(1)).toBe(1 - 1e-10);
    expect(clampProbability(-5)).toBe(1e-10);
    expect(clampProbability(2)).toBe(1 - 1e-10);
    expect(clampProbability(0.3)).toBe(0.3);
  });

  it("tfPrior follows 0.2 + 0.7*min(1, tf/10) (Eq. 25)", () => {
    expect(tfPrior(0)).toBe(0.2);
    expect(tfPrior(1)).toBeCloseTo(0.27, 12);
    expect(tfPrior(5)).toBeCloseTo(0.55, 12);
    expect(tfPrior(10)).toBeCloseTo(0.9, 12);
    expect(tfPrior(50)).toBeCloseTo(0.9, 12); // saturates
  });

  it("normPrior peaks at half average length (Eq. 26)", () => {
    expect(normPrior(0.5)).toBeCloseTo(0.9, 12);
    expect(normPrior(1)).toBe(0.3);
    expect(normPrior(0)).toBe(0.3);
    // |0.25-0.5|*2 = 0.5 → 0.3 + 0.6*(1-0.5) = 0.6
    expect(normPrior(0.25)).toBeCloseTo(0.6, 12);
    expect(normPrior(2)).toBe(0.3); // extreme lengths bottom out
  });

  it("compositePrior weights 0.7 tf + 0.3 norm, clamped to [0.1, 0.9] (Eq. 27)", () => {
    // 0.7*0.27 + 0.3*0.3 = 0.189 + 0.09 = 0.279
    expect(compositePrior(1, 1)).toBeCloseTo(0.279, 12);
    // 0.7*0.2 + 0.3*0.3 = 0.14 + 0.09 = 0.23
    expect(compositePrior(0, 10)).toBeCloseTo(0.23, 12);
    // Upper clamp binds: 0.7*0.9 + 0.3*0.9 = 0.9
    expect(compositePrior(1e9, 0.5)).toBeCloseTo(0.9, 12);
  });

  it("posterior equals the prior at likelihood 0.5 (Eq. 22)", () => {
    // 0.5*0.279 / (0.5*0.279 + 0.5*0.721) = 0.279 — so a top likelihood of
    // exactly 0.5 does NOT imply posterior >= 0.5; the gate's keep-first
    // rule (not the calibration) is the non-empty guarantee.
    expect(posterior(0.5, 0.279)).toBeCloseTo(0.279, 12);
  });

  it("posterior is monotone in likelihood and stays in (0, 1)", () => {
    // P(0.9, 0.4) = 0.36/0.42 ≈ 0.857 > P(0.2, 0.4) = 0.08/0.56 ≈ 0.143
    expect(posterior(0.9, 0.4)).toBeCloseTo(0.8571, 3);
    expect(posterior(0.2, 0.4)).toBeCloseTo(0.1429, 3);
    expect(posterior(1, 0.9)).toBe(1 - 1e-10); // clamped, never exactly 1
    expect(posterior(0, 0.1)).toBe(1e-10); // clamped, never exactly 0
  });

  it("scoreToProbability composes likelihood → prior → posterior", () => {
    // score=0, alpha=1, beta=0 → L = sigmoid(0) = 0.5;
    // prior = compositePrior(1, 1) = 0.279; posterior(0.5, 0.279) = 0.279.
    expect(scoreToProbability(0, 1, 1, 1, 0)).toBeCloseTo(0.279, 12);
  });

  it("a higher BM25 score yields a higher probability, all else equal", () => {
    // The gate's core premise: probability tracks score, so thresholding
    // probability trims the low-score tail.
    const lo = scoreToProbability(1, 2, 1, 1, 0);
    const hi = scoreToProbability(3, 2, 1, 1, 0);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
  });
});

describe("estimateLikelihoodParams", () => {
  it("estimates beta=median, alpha=1/std (mirrors scorer auto-estimation)", () => {
    // mean 2.5, var 1.25, std ≈ 1.1180 → alpha ≈ 0.8944
    const p = estimateLikelihoodParams([1, 2, 3, 4])!;
    expect(p.beta).toBeCloseTo(2.5, 10);
    expect(p.alpha).toBeCloseTo(0.8944, 4);
    // Odd count: exact middle. Zeros never enter the spread.
    expect(estimateLikelihoodParams([3, 1, 2])!.beta).toBe(2);
    expect(estimateLikelihoodParams([0, 0, 4])!).toEqual({ alpha: 1, beta: 4 });
  });

  it("returns null with no positive scores, alpha=1 on zero spread", () => {
    expect(estimateLikelihoodParams([])).toBeNull();
    expect(estimateLikelihoodParams([0, 0])).toBeNull();
    expect(estimateLikelihoodParams([5])).toEqual({ alpha: 1, beta: 5 });
  });
});
