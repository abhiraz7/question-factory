// EDITORIAL INTELLIGENCE — Phase 5 (statistical state).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, section 5 ("Statistical
// engine") and section 6 ("no fake randomness").
//
// Small, separately-testable, pure statistical functions. No I/O, no
// network, no Math.random() anywhere in this file. Each function is a
// standard, named statistical technique applied narrowly — not a bespoke
// "vibe score". Recency-weighted frequency is NOT reimplemented here: it
// already exists as weightedCounts()/topByWeight() in editorial-
// intelligence.mjs (Phase 1) and is re-exported from here for convenience
// so callers can import every statistical signal from one place.
//
// This module does not know about content-memory's JSON shape, exam names,
// or genome fields — topic-state.mjs (Phase 6) is what wires these generic
// functions to real record fields. Keeping that wiring out of this file is
// what makes each function here independently unit-testable with plain
// numbers/arrays.

export { weightedCounts, topByWeight, filterMatching, fieldFillRate } from './editorial-intelligence.mjs';

// -------------------- frequency / probability distributions --------------------

/**
 * Plain frequency count over a flat list of items (no recency weighting —
 * use weightedCounts() from editorial-intelligence.mjs when recency should
 * matter). Returns a Map so callers can choose to sort/filter without this
 * function imposing an order.
 *
 * @param {Array<string>} items
 * @returns {Map<string, number>}
 */
export function frequencyDistribution(items) {
  const counts = new Map();
  for (const raw of (Array.isArray(items) ? items : [])) {
    const item = String(raw || '').trim();
    if (!item) continue;
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return counts;
}

/**
 * Normalizes any Map/object of non-negative counts into a probability
 * distribution (values sum to 1). An empty input returns an empty Map
 * (never divides by zero, never fabricates a uniform distribution over
 * nothing).
 *
 * @param {Map<string, number>|Record<string, number>} counts
 * @returns {Map<string, number>}
 */
export function toProbabilityDistribution(counts) {
  const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts || {});
  const total = entries.reduce((sum, [, v]) => sum + (Number(v) || 0), 0);
  const dist = new Map();
  if (total <= 0) return dist;
  for (const [k, v] of entries) dist.set(k, (Number(v) || 0) / total);
  return dist;
}

// -------------------- EWMA --------------------

/**
 * Exponentially weighted moving average over a numeric series given
 * oldest-first (the usual time-series convention; callers passing
 * most-recent-first data, like content-memory arrays, must reverse first).
 * alpha is the standard EWMA smoothing factor: higher alpha weighs recent
 * observations more heavily. Returns both the final smoothed value and the
 * full smoothed series (useful for later trend/structural-drift checks).
 *
 * seed defaults to the first observation (standard EWMA initialization) so
 * a short series doesn't get dragged toward an arbitrary external prior.
 *
 * @param {Array<number>} series oldest-first
 * @param {number} [alpha=0.3]
 * @returns {{value: number, series: number[]}}
 */
export function ewma(series, alpha = 0.3) {
  const nums = (Array.isArray(series) ? series : []).map(Number).filter(Number.isFinite);
  if (!nums.length) return { value: 0, series: [] };
  const out = [nums[0]];
  for (let i = 1; i < nums.length; i++) {
    out.push(alpha * nums[i] + (1 - alpha) * out[i - 1]);
  }
  return { value: out[out.length - 1], series: out };
}

// -------------------- entropy --------------------

/**
 * Shannon entropy in bits over a probability distribution (or raw counts —
 * normalized internally). Zero-probability entries are skipped (0*log(0)
 * convention). Returns 0 for an empty or single-category distribution
 * (no uncertainty to measure) rather than NaN.
 *
 * @param {Map<string, number>|Record<string, number>} dist counts or probabilities
 * @returns {number} entropy in bits, >= 0
 */
export function shannonEntropy(dist) {
  const probs = toProbabilityDistribution(dist instanceof Map ? dist : new Map(Object.entries(dist || {})));
  // toProbabilityDistribution already normalizes raw counts; if dist was
  // already probabilities summing to ~1 this is a (harmless) no-op renorm.
  let h = 0;
  for (const p of probs.values()) {
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Entropy normalized to [0, 1] by dividing by the maximum possible entropy
 * for the number of distinct categories observed (log2(n)). This is what
 * "is the recent editorial system becoming structurally repetitive" (spec
 * section 5) actually needs: a 0..1 repetitiveness-inverse score comparable
 * across topics with different numbers of possible structures, not a raw
 * bit count that means something different for 3 categories vs 12.
 * Returns 0 when there are 0 or 1 distinct categories (nothing to spread
 * across — maximally "repetitive" by construction, not undefined).
 *
 * @param {Map<string, number>|Record<string, number>} dist
 * @returns {number} 0 (fully repetitive / no variety) .. 1 (maximally spread)
 */
export function normalizedEntropy(dist) {
  const entries = dist instanceof Map ? [...dist.keys()] : Object.keys(dist || {});
  const n = entries.filter(k => (dist instanceof Map ? dist.get(k) : dist[k]) > 0).length;
  if (n <= 1) return 0;
  return shannonEntropy(dist) / Math.log2(n);
}

// -------------------- Jensen-Shannon divergence --------------------

function klTerm(p, q) {
  if (p <= 0) return 0; // 0 * log(0/q) := 0, standard convention
  if (q <= 0) return Infinity; // p has support q doesn't — handled by caller via the mixture
  return p * Math.log2(p / q);
}

/**
 * Jensen-Shannon divergence between two distributions — the spec's
 * explicit choice over raw (asymmetric, potentially infinite) KL
 * divergence, because JSD is symmetric and bounded in [0, 1] bit, which
 * makes it safe to use directly as a 0..1-ish "how different is recent
 * content from historical content" signal without extra normalization
 * gymnastics. Distributions may cover different key sets (e.g. recent
 * concepts are a subset of all historical concepts) — missing keys are
 * treated as probability 0, which JSD handles cleanly via the mixture
 * distribution M = (P+Q)/2 (unlike raw KL, which would diverge to
 * Infinity on a zero-probability support mismatch).
 *
 * @param {Map<string, number>|Record<string, number>} distA counts or probabilities
 * @param {Map<string, number>|Record<string, number>} distB counts or probabilities
 * @returns {number} 0 (identical) .. 1 (maximally different), in bits
 */
export function jensenShannonDivergence(distA, distB) {
  const p = toProbabilityDistribution(distA);
  const q = toProbabilityDistribution(distB);
  if (!p.size && !q.size) return 0;
  if (!p.size || !q.size) return 1; // one side has literally nothing to compare — maximal divergence, not 0/undefined
  const keys = new Set([...p.keys(), ...q.keys()]);
  let kl_pm = 0;
  let kl_qm = 0;
  for (const k of keys) {
    const pv = p.get(k) || 0;
    const qv = q.get(k) || 0;
    const mv = (pv + qv) / 2;
    kl_pm += klTerm(pv, mv);
    kl_qm += klTerm(qv, mv);
  }
  return (kl_pm + kl_qm) / 2;
}

// -------------------- Bayesian updating: Beta-Bernoulli --------------------

/**
 * Beta-Bernoulli posterior update over a binary "was this concept/
 * structure used" signal, per spec section 5's explicit suggestion. Starts
 * from a prior (alpha, beta — "pseudo-counts" of prior successes/failures;
 * (1,1) is the uniform/uninformative default), updates with observed
 * successes/failures, and returns a posterior mean (point estimate of the
 * underlying probability) plus a variance (how much to trust that mean —
 * shrinks as more observations accumulate). This is deliberately the
 * textbook-simplest conjugate-prior update, not a custom scheme: spec
 * section 5 asks for something "explainable", and Beta-Bernoulli is the
 * standard choice for exactly a repeated-binary-observation signal.
 *
 * @param {{alpha?: number, beta?: number}} prior
 * @param {number} successes count of positive observations
 * @param {number} failures count of negative observations
 * @returns {{alpha: number, beta: number, mean: number, variance: number}}
 */
export function betaBernoulliUpdate(prior = {}, successes = 0, failures = 0) {
  const a0 = Number.isFinite(prior.alpha) && prior.alpha > 0 ? prior.alpha : 1;
  const b0 = Number.isFinite(prior.beta) && prior.beta > 0 ? prior.beta : 1;
  const s = Math.max(0, Number(successes) || 0);
  const f = Math.max(0, Number(failures) || 0);
  const alpha = a0 + s;
  const beta = b0 + f;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  return { alpha, beta, mean, variance };
}

// -------------------- coverage probability --------------------

/**
 * Estimates, for each item in a list of "important concepts" (typically
 * Phase 4's evidence.provenance / chapter concepts), the probability it has
 * already been sufficiently covered by content-memory history — via a
 * Beta-Bernoulli update per concept: successes = number of historical
 * records whose concepts_taught actually mentions it (exact or substring
 * match, case-insensitive, since content-memory concepts_taught is often
 * section-heading text rather than a clean controlled vocabulary — see
 * editorial-intelligence.mjs's header note on derived records), failures =
 * every other matching record (did NOT mention it). A concept mentioned in
 * 0 of N records gets a low posterior mean that still isn't a hard 0 (Beta
 * prior (1,1) keeps it at 1/(2+N) rather than claiming certainty from
 * silence) — this is the honesty rule from spec section 6 applied to
 * coverage: "probably not covered" is expressed as a low number, never as a
 * fabricated hard 0 or 1.
 *
 * @param {Array<string>} importantConcepts
 * @param {Array<{concepts_taught?: string[]}>} historicalRecords
 * @returns {Array<{concept: string, coverageProbability: number, observations: number}>}
 */
export function coverageProbability(importantConcepts, historicalRecords) {
  const records = Array.isArray(historicalRecords) ? historicalRecords : [];
  const n = records.length;
  const haystacks = records.map(r =>
    (Array.isArray(r && r.concepts_taught) ? r.concepts_taught : []).join(' | ').toLowerCase()
  );
  return (Array.isArray(importantConcepts) ? importantConcepts : [])
    .map(raw => String(raw || '').trim())
    .filter(Boolean)
    .map(concept => {
      const needle = concept.toLowerCase();
      const successes = haystacks.filter(h => needle && h.includes(needle)).length;
      const { mean } = betaBernoulliUpdate({ alpha: 1, beta: 1 }, successes, n - successes);
      return { concept, coverageProbability: Math.round(mean * 100) / 100, observations: n };
    });
}

// -------------------- exploration / exploitation --------------------

/**
 * Deterministic exploration/exploitation selection over a set of candidate
 * structures/flavours, per spec section 5 ("do not always select the most
 * obvious/high-frequency structure... reserve controlled room for useful
 * alternatives") and section 6 ("no fake randomness" — variation must be
 * justified, never randomized for its own sake).
 *
 * Uses the UCB1 formula (the standard deterministic bandit-selection
 * algorithm): totalScore = exploitScore + explorationWeight *
 * sqrt(ln(totalTrials + e) / (timesUsed + 1)). This is the same family of
 * idea as flavour-engine.mjs's repetition penalty (recent/frequent use
 * lowers a candidate's effective score) but inverted into a principled
 * bonus-for-under-exploration term instead of an ad hoc subtraction, and
 * entirely free of Math.random() or hashing — ties are broken by candidate
 * id (stable lexical order), so identical input always produces identical
 * output.
 *
 * exploitScore for each candidate should already encode how well it fits
 * the topic/subject on its own merits (e.g. a statistically-justified fit
 * score, NOT raw frequency — raw frequency belongs in timesUsed, the thing
 * this function deliberately discounts).
 *
 * @param {Array<{id:string, exploitScore:number, timesUsed?:number}>} candidates
 * @param {{totalTrials?: number, explorationWeight?: number}} [options]
 * @returns {{selected: string|null, ranked: Array<{id:string, exploitScore:number, timesUsed:number, explorationBonus:number, totalScore:number}>}}
 */
export function selectWithExploration(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { selected: null, ranked: [] };
  const explorationWeight = Number.isFinite(options.explorationWeight) ? options.explorationWeight : 1;
  const totalTrials = Number.isFinite(options.totalTrials)
    ? options.totalTrials
    : list.reduce((sum, c) => sum + (Number(c.timesUsed) || 0), 0);

  const ranked = list
    .map(c => {
      const timesUsed = Math.max(0, Number(c.timesUsed) || 0);
      const exploitScore = Number.isFinite(c.exploitScore) ? c.exploitScore : 0;
      const explorationBonus = explorationWeight * Math.sqrt(Math.log(totalTrials + Math.E) / (timesUsed + 1));
      return { id: String(c.id), exploitScore, timesUsed, explorationBonus, totalScore: exploitScore + explorationBonus };
    })
    .sort((a, b) => b.totalScore - a.totalScore || a.id.localeCompare(b.id));

  return { selected: ranked[0].id, ranked };
}
