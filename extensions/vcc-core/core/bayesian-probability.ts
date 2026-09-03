// @ts-nocheck
//
// Minimal port of the Bayesian probability transform from Cognica's
// `bayesian-bm25-js` (Apache-2.0), itself the reference implementation of
// Jeong 2026a "Bayesian BM25: A Probabilistic Framework for Hybrid Text and
// Vector Search" (DOI 10.5281/zenodo.18414940).
//
// Only the score→probability pipeline is ported: sigmoid likelihood (Eq. 20),
// term-frequency prior (Eq. 25), document-length prior (Eq. 26), composite
// prior (Eq. 27), and the Bayesian posterior without base-rate correction
// (Eq. 22). Deliberately NOT ported: the BM25 scorer itself (this repo keeps
// its own BM25-lite), parameter fitting, online updates, multi-signal fusion,
// vector calibration, and WAND bounds — none has a consumer here. If a ported
// formula ever contradicts the paper, the paper wins.
//
// Converts unbounded BM25 scores into calibrated P(relevance) in [0,1] so a
// single ABSOLUTE cutoff behaves consistently across sessions of different
// sizes — the relative-floor heuristic this replaces existed only because raw
// BM25 magnitudes are not comparable across corpora.

/** Clamp floor/ceiling for probabilities (upstream EPSILON). */
const EPSILON = 1e-10;

/** Clamp `p` into [EPSILON, 1 - EPSILON]. */
export const clampProbability = (p: number): number =>
  Math.max(EPSILON, Math.min(1.0 - EPSILON, p));

/** Numerically stable sigmoid (upstream branch: avoids exp overflow). */
export const sigmoid = (x: number): number => {
  if (x >= 0) return 1.0 / (1.0 + Math.exp(-x));
  const expX = Math.exp(x);
  return expX / (1.0 + expX);
};

/** Sigmoid likelihood of relevance given a BM25 score (Eq. 20):
 *  sigma(alpha * (score - beta)). */
export const scoreLikelihood = (score: number, alpha: number, beta: number): number =>
  sigmoid(alpha * (score - beta));

/** Term-frequency prior (Eq. 25): 0.2 + 0.7 * min(1, tf / 10). */
export const tfPrior = (tf: number): number =>
  0.2 + 0.7 * Math.min(1.0, tf / 10.0);

/** Document-length normalisation prior (Eq. 26): peaks at half the average
 *  document length, decaying for very short or very long documents. */
export const normPrior = (docLenRatio: number): number =>
  0.3 + 0.6 * (1.0 - Math.min(1.0, Math.abs(docLenRatio - 0.5) * 2.0));

/** Composite prior (Eq. 27): clamp(0.7 * P_tf + 0.3 * P_norm, 0.1, 0.9).
 *  Note the bounds are plain 0.1/0.9, not `clampProbability`. */
export const compositePrior = (tf: number, docLenRatio: number): number =>
  Math.max(0.1, Math.min(0.9, 0.7 * tfPrior(tf) + 0.3 * normPrior(docLenRatio)));

/** Bayesian posterior without base-rate correction (Eq. 22, first step):
 *  L*p / (L*p + (1-L)*(1-p)). Base rate stays null: its estimators need
 *  pseudo-query sampling over a corpus with relevance labels, which a live
 *  recall query cannot provide. */
export const posterior = (likelihood: number, prior: number): number => {
  const numerator = likelihood * prior;
  return clampProbability(numerator / (numerator + (1.0 - likelihood) * (1.0 - prior)));
};

/** Full pipeline: BM25 score -> calibrated P(relevance).
 *
 *  Likelihood from the score, composite prior from tf and doc-length ratio,
 *  combined by the Bayesian posterior. This is a per-document aggregate
 *  transform (total score, total tf), an approximation of per-term posterior
 *  fusion — sufficient for a noise gate, not a ranking signal. */
export const scoreToProbability = (
  score: number,
  tf: number,
  docLenRatio: number,
  alpha: number,
  beta: number,
): number =>
  posterior(scoreLikelihood(score, alpha, beta), compositePrior(tf, docLenRatio));

/** Estimate sigmoid midpoint/shift from the query's own nonzero BM25 scores:
 *  beta = median, alpha = 1/std (std = 0 -> alpha = 1.0). Mirrors
 *  `BayesianBM25Scorer._estimateParameters` without its seeded pseudo-query
 *  sampling step — deterministic, one O(n log n) pass over scores already
 *  computed. Returns null when there is nothing to calibrate. */
export const estimateLikelihoodParams = (scores: number[]): { alpha: number; beta: number } | null => {
  const nonzero = scores.filter((s) => s > 0);
  if (nonzero.length === 0) return null;
  const sorted = [...nonzero].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const beta = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const mean = nonzero.reduce((a, b) => a + b, 0) / nonzero.length;
  const variance = nonzero.reduce((a, b) => a + (b - mean) ** 2, 0) / nonzero.length;
  const std = Math.sqrt(variance);
  return { alpha: std > 0 ? 1.0 / std : 1.0, beta };
};
