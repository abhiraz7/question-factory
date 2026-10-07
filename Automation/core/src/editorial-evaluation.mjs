// EDITORIAL INTELLIGENCE — Evaluation layer (the missing "VALIDATION" box in
// EDITORIAL_INTELLIGENCE_ENGINE.md's §2 architecture diagram).
//
// Content-memory records WHAT a published article covered. Nothing in this
// repo previously scored whether that coverage was any good, or whether it
// quietly repeated a prior article at the sentence level — a gap confirmed
// directly: three diagnostic test runs (same topic/exam/flavour, meant to
// test the variety engine) reproduced four aside-card sentences byte-for-
// byte identical, a repetition class concepts_taught/examples_used/
// misconceptions_used cannot see.
//
// This module is pure scoring glue over ALREADY-BUILT, ALREADY-TESTED
// primitives — it does not reimplement statistics:
//   - overlap scores:        plain Jaccard over content-memory array fields
//   - cardSentenceRepetition: extractCardSentences() (editorial-intelligence.mjs, Phase 1)
//   - structuralSimilarity:  frequencyDistribution/jensenShannonDivergence (editorial-statistics.mjs, Phase 5)
//   - lexicalSimilarity:     findClosestArticles() (similarity-check.mjs) — n-gram Jaccard
//     on stripped HTML text. Named "lexical", not "semantic" — no embedding
//     model is in scope (confirmed decision: no new paid infra), so this is
//     an honest proxy, not a claim of deep semantic understanding.
//   - qualityScore:          validateBundle() (validate-output.mjs) structural
//     checks + a few additive heuristics (word-count range, ad-slot count,
//     link counts, AI-cliché words) — confirmed free-heuristic-only, no
//     LLM-judge call.
//   - coverageScore:         coverageProbability() (editorial-statistics.mjs)
//     when evidence/provenance is available, else null (dataAvailable:false,
//     same honesty convention topic-state.mjs already uses).
//
// Usage as a library: import { evaluateCandidate } from './editorial-evaluation.mjs'.
// Usage as a CLI (wired into pub-note.yml/pub-lpost.yml, see those files):
//   node editorial-evaluation.mjs --extract-cards <bundle.json>
//     -> prints a JSON array of card sentences found in bundle.bodyHtml,
//        for the publish workflow to fold into the content-memory record as
//        card_sentences_used (this is the one piece of Node-only glue that
//        can't live in editorial-intelligence.mjs itself, which must stay
//        100% browser-safe/no process.argv for its own browser mirror).

import { extractCardSentences } from './editorial-intelligence.mjs';
import { frequencyDistribution, jensenShannonDivergence, coverageProbability } from './editorial-statistics.mjs';
import { findClosestArticles } from './similarity-check.mjs';
import { validateBundle } from './validate-output.mjs';

// -------------------- overlap scores (plain Jaccard over array fields) --------------------

function normalizeSet(arr) {
  return new Set((Array.isArray(arr) ? arr : []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean));
}

/** @returns {number} 0..1, 0 when either side is empty (nothing to overlap on, not "identical") */
export function jaccardOverlap(arrA, arrB) {
  const a = normalizeSet(arrA), b = normalizeSet(arrB);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Highest pairwise overlap against any one historical record, per field — a
 *  single near-duplicate match matters more than an average across many
 *  unrelated records. */
function maxOverlapAgainstHistory(field, candidateArr, historicalRecords) {
  let max = 0;
  for (const r of historicalRecords) {
    const overlap = jaccardOverlap(candidateArr, r && r[field]);
    if (overlap > max) max = overlap;
  }
  return Math.round(max * 1000) / 1000;
}

/**
 * @param {object} candidate content-memory-shaped record (concepts_taught,
 *   examples_used, misconceptions_used, question_types, card_sentences_used)
 * @param {Array<object>} historicalRecords same shape, most-recent-first or
 *   any order — this scores max-overlap, order doesn't matter here
 */
export function scoreOverlaps(candidate, historicalRecords = []) {
  return {
    conceptOverlap: maxOverlapAgainstHistory('concepts_taught', candidate.concepts_taught, historicalRecords),
    exampleOverlap: maxOverlapAgainstHistory('examples_used', candidate.examples_used, historicalRecords),
    misconceptionOverlap: maxOverlapAgainstHistory('misconceptions_used', candidate.misconceptions_used, historicalRecords),
    questionTypeOverlap: maxOverlapAgainstHistory('question_types', candidate.question_types, historicalRecords),
    cardSentenceOverlap: maxOverlapAgainstHistory('card_sentences_used', candidate.card_sentences_used, historicalRecords),
  };
}

// -------------------- card-sentence repetition (exact-match, not just Jaccard) --------------------

/**
 * Jaccard already catches SOME of this via cardSentenceOverlap above, but a
 * publisher wants the literal list of repeated sentences to react to, not
 * just a ratio — this returns the actual overlapping strings.
 * @param {string} candidateBodyHtml
 * @param {Array<{bodyHtml?: string, card_sentences_used?: string[]}>} historicalItems
 *   either raw bodies (will be extracted here) or already-extracted arrays
 */
export function findRepeatedCardSentences(candidateBodyHtml, historicalItems = []) {
  const candidateSentences = extractCardSentences(candidateBodyHtml);
  if (!candidateSentences.length) return [];
  const historicalSet = new Set();
  for (const item of historicalItems) {
    const sentences = Array.isArray(item.card_sentences_used) ? item.card_sentences_used : extractCardSentences(item.bodyHtml);
    for (const s of sentences) historicalSet.add(s);
  }
  return candidateSentences.filter(s => historicalSet.has(s));
}

// -------------------- structural (article-shape) similarity --------------------

/**
 * Reuses Phase 5/6's exact JSD-over-shape-distribution approach
 * (topic-state.mjs's recent_structures) rather than reimplementing it —
 * this just exposes it as a standalone candidate-vs-history score.
 * @returns {{divergence: number|null, repetitiveness: number}} divergence is
 *   0 (identical shape distribution) .. 1 (completely different), null if
 *   there's no historical shape data at all to compare against yet.
 */
export function scoreStructuralSimilarity(candidateShape, historicalRecords = []) {
  const candidateDist = frequencyDistribution(Array.isArray(candidateShape) ? candidateShape : []);
  const historicalShapes = historicalRecords.flatMap(r => Array.isArray(r.article_shape) ? r.article_shape : []);
  const historicalDist = frequencyDistribution(historicalShapes);
  if (!historicalDist.size) return { divergence: null, repetitiveness: 0 };
  const divergence = Math.round(jensenShannonDivergence(candidateDist, historicalDist) * 1000) / 1000;
  return { divergence, repetitiveness: Math.round((1 - divergence) * 1000) / 1000 };
}

// -------------------- lexical ("semantic-proxy") similarity --------------------

/**
 * Thin wrapper over similarity-check.mjs's existing n-gram Jaccard —
 * deliberately named "lexical", not "semantic": true semantic similarity
 * needs an embedding model, which is out of scope (no new paid infra,
 * confirmed decision). Applied PRE-publish here (candidate vs. historical
 * bodies), unlike similarity-check.mjs's own CLI which only ever runs
 * POST-publish as a warning.
 * @param {string} candidateBodyHtml
 * @param {Array<{slug:string, bodyHtml:string}>} historicalBodies
 */
export function scoreLexicalSimilarity(candidateBodyHtml, historicalBodies = []) {
  const closest = findClosestArticles(candidateBodyHtml, historicalBodies, 5);
  return { closest, maxSimilarity: closest.length ? closest[0].similarity : 0 };
}

// -------------------- quality (free heuristic composite) --------------------

const AI_CLICHE_WORDS = [
  'delve', 'tapestry', 'crucial role', 'pivotal role', 'holistic', 'seamless',
  'comprehensive guide', 'game-changer', 'unlock', 'it is important to note',
  'furthermore', 'moreover',
];
const AD_SLOT_TARGET = 3;
const WORD_COUNT_RANGE = [3000, 5000]; // Master Prompt's own Stage-1 target — descriptive, not a hard quota there, but worth surfacing as a score input here

function plainWordCount(bodyHtml) {
  const text = String(bodyHtml || '').replace(/<[^>]+>/g, ' ');
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function countAdSlots(bodyHtml) {
  return (String(bodyHtml || '').match(/id="ad-slot-\d+"/g) || []).length;
}

function countLinks(bodyHtml) {
  const hrefs = [...String(bodyHtml || '').matchAll(/<a\b[^>]*href="([^"]*)"/gi)].map(m => m[1]);
  const internal = hrefs.filter(h => h.startsWith('#') === false && !/^https?:\/\//i.test(h) || /examnotespdf\.in/i.test(h)).length;
  const external = hrefs.filter(h => /^https?:\/\//i.test(h) && !/examnotespdf\.in/i.test(h)).length;
  return { internal, external, total: hrefs.length };
}

function countCliches(bodyHtml) {
  const text = String(bodyHtml || '').replace(/<[^>]+>/g, ' ').toLowerCase();
  return AI_CLICHE_WORDS.filter(w => text.includes(w)).length;
}

/**
 * Free, deterministic, no-API quality composite (0..1). Confirmed scope:
 * compliance/structural quality, NOT a judgment of pedagogical soundness —
 * an opt-in LLM-judge pass could be layered on later without reshaping this
 * function's output contract (it would just become one more input alongside
 * this score, not a replacement for it).
 * @param {{seo:object, bodyHtml:string, publisherNotes?:string, contentMemory?:object}} bundle
 */
export function scoreQuality(bundle) {
  const structural = validateBundle(bundle);
  const bodyHtml = bundle.bodyHtml || '';
  const wordCount = plainWordCount(bodyHtml);
  const adSlots = countAdSlots(bodyHtml);
  const links = countLinks(bodyHtml);
  const clicheCount = countCliches(bodyHtml);

  const penalties = [];
  // Structural errors are the heaviest penalty — these are the repo's own
  // existing hard-fail conditions (broken HTML, fabricated-looking markers).
  penalties.push(Math.min(1, structural.errors.length * 0.25));
  penalties.push(Math.min(0.3, structural.warnings.length * 0.03));
  if (wordCount < WORD_COUNT_RANGE[0] || wordCount > WORD_COUNT_RANGE[1] * 1.3) penalties.push(0.1);
  if (adSlots !== AD_SLOT_TARGET) penalties.push(0.1);
  if (clicheCount > 0) penalties.push(Math.min(0.2, clicheCount * 0.05));

  const totalPenalty = Math.min(1, penalties.reduce((s, p) => s + p, 0));
  const score = Math.round((1 - totalPenalty) * 1000) / 1000;

  return {
    score,
    wordCount, adSlots, links, clicheCount,
    structuralErrors: structural.errors.length,
    structuralWarnings: structural.warnings.length,
    structuralPass: structural.pass,
    detail: { errors: structural.errors, warnings: structural.warnings },
  };
}

// -------------------- coverage (pass-through, honest about missing evidence) --------------------

/**
 * @param {string[]} importantConcepts from RAG provenance, if available this run
 * @param {Array<object>} historicalRecords
 * @returns {{dataAvailable:boolean, averageCoverage?:number, gaps?:string[]}}
 */
export function scoreCoverage(importantConcepts, historicalRecords = []) {
  if (!Array.isArray(importantConcepts) || !importantConcepts.length) {
    return { dataAvailable: false, note: 'No RAG/evidence provenance supplied this run — same honesty convention as topic-state.mjs.' };
  }
  const items = coverageProbability(importantConcepts, historicalRecords);
  const gaps = items.filter(i => i.coverageProbability < 0.35).map(i => i.concept);
  const averageCoverage = items.length ? Math.round((items.reduce((s, i) => s + i.coverageProbability, 0) / items.length) * 100) / 100 : 0;
  return { dataAvailable: true, items, gaps, averageCoverage };
}

// -------------------- novelty (derived — no new math) --------------------

/** @returns {number} 1 - weighted average of the overlap/repetition signals (higher = more novel) */
export function scoreNovelty({ conceptOverlap = 0, exampleOverlap = 0, misconceptionOverlap = 0, questionTypeOverlap = 0, cardSentenceOverlap = 0, lexicalSimilarity = 0 }) {
  const weighted = (conceptOverlap * 0.25) + (exampleOverlap * 0.2) + (misconceptionOverlap * 0.15)
    + (questionTypeOverlap * 0.1) + (cardSentenceOverlap * 0.15) + (lexicalSimilarity * 0.15);
  return Math.round((1 - Math.min(1, weighted)) * 1000) / 1000;
}

// -------------------- quality drift (simple trend over a run sequence) --------------------

/**
 * Slope of a short series via simple linear regression — positive = quality
 * improving run-over-run, negative = drifting down. Deliberately not a
 * fancier time-series model: a batch of ~10 runs doesn't justify one, and
 * the spec's own §6 rule ("no fake sophistication") applies here too.
 * @param {number[]} scores in run order (oldest first)
 */
export function qualityDrift(scores = []) {
  const n = scores.length;
  if (n < 2) return { slope: 0, dataAvailable: false };
  const xs = scores.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = scores.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (scores[i] - meanY); den += (xs[i] - meanX) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  return { slope: Math.round(slope * 1000) / 1000, dataAvailable: true };
}

// -------------------- composite: one candidate scored end-to-end --------------------

/**
 * @param {object} candidate a bundle shaped like pending-notes/*.json: {seo,
 *   bodyHtml, publisherNotes, contentMemory: {concepts_taught, examples_used,
 *   misconceptions_used, question_types, article_shape, card_sentences_used}}
 * @param {object} [context]
 * @param {Array<object>} [context.historicalRecords] content-memory-shaped records (metadata only)
 * @param {Array<{slug:string, bodyHtml:string}>} [context.historicalBodies] for lexical similarity
 * @param {string[]} [context.importantConcepts] RAG provenance concept labels, if available
 */
export function evaluateCandidate(candidate, context = {}) {
  const cm = candidate.contentMemory || {};
  const historicalRecords = context.historicalRecords || [];
  const historicalBodies = context.historicalBodies || [];

  const overlaps = scoreOverlaps(cm, historicalRecords);
  const repeatedCardSentences = findRepeatedCardSentences(candidate.bodyHtml, historicalRecords);
  const structural = scoreStructuralSimilarity(cm.article_shape, historicalRecords);
  const lexical = scoreLexicalSimilarity(candidate.bodyHtml, historicalBodies);
  const quality = scoreQuality(candidate);
  const coverage = scoreCoverage(context.importantConcepts, historicalRecords);
  const novelty = scoreNovelty({ ...overlaps, lexicalSimilarity: lexical.maxSimilarity });

  return {
    overlaps,
    repeatedCardSentences,
    structuralSimilarity: structural,
    lexicalSimilarity: lexical,
    quality,
    coverage,
    novelty,
  };
}

// -------------------- CLI: --extract-cards, for pub-note.yml/pub-lpost.yml --------------------

async function main() {
  const [, , cmd, file] = process.argv;
  if (cmd === '--extract-cards' && file) {
    const { readFile } = await import('node:fs/promises');
    const bundle = JSON.parse(await readFile(file, 'utf8'));
    console.log(JSON.stringify(extractCardSentences(bundle.bodyHtml || '')));
    return;
  }
  console.error('Usage: node editorial-evaluation.mjs --extract-cards <bundle.json>');
  process.exitCode = 2;
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
