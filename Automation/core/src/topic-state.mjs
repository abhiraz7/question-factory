// EDITORIAL INTELLIGENCE — Phase 6 (topic state).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, section 4 ("Topic
// state") and section 7 ("Do not create a parallel historical database
// unless the existing schema genuinely cannot support the required
// state.").
//
// Assembles ONE coherent topic-state object for a {topic, subject, exam}
// by calling into Phase 1 (editorial-intelligence.mjs), Phase 4
// (rag-evidence.mjs) and Phase 5 (editorial-statistics.mjs). This file
// contains no new historical storage and no new statistical formulas of
// its own — it is wiring: content-memory records in, Phase 1/4/5 functions
// applied, one object out. The only I/O in this module is the one Phase 4
// already does (a local, key-free BM25 lookup via rag-evidence.mjs) —
// everything else here is pure given its inputs.
//
// Honesty rule (carried over from Phase 1/3/4): several spec-listed topic-
// state fields (learner_signals, difficulty, similarity) have NO wired data
// source yet — no Search Console integration, no PYQ/difficulty dataset, no
// pre-publish article body to run similarity-check.mjs against. Those
// fields are returned with `dataAvailable: false` rather than a silently
// empty `{}` or, worse, a fabricated number — a human/caller should be able
// to tell "no signal exists yet" apart from "signal exists and is zero".

import { buildEditorialSignature, filterMatching } from './editorial-intelligence.mjs';
import { gatherEvidence } from './rag-evidence.mjs';
import {
  frequencyDistribution,
  jensenShannonDivergence,
  normalizedEntropy,
  ewma,
  betaBernoulliUpdate,
  coverageProbability,
} from './editorial-statistics.mjs';

// Mirrors editorial-intelligence.mjs's RECENT_WINDOW (not exported from
// there — it is that module's own Phase-1 tuning constant). Kept equal so
// "recent" means the same thing everywhere in the engine; if Phase 1 ever
// changes its window, this should be revisited alongside it.
const RECENT_WINDOW = 10;

// Below this posterior coverage probability, a concept is treated as a
// genuine coverage gap worth surfacing. 0.35 sits below the (1,1)-prior
// midpoint of 0.5, so a concept needs actual negative evidence (several
// historical records that could have mentioned it but didn't) to be
// flagged, not merely "slightly less than certain".
const COVERAGE_GAP_THRESHOLD = 0.35;

function conceptLabel(provenanceEntry) {
  return String(provenanceEntry.chapterTitle || provenanceEntry.chapter || '').trim();
}

/**
 * @param {{topic?:string, subject?:string, exam?:string}} ctx
 * @param {Array<Object>} recentMemory content-memory records, most-recent-
 *   first, same shape/convention as editorial-intelligence.mjs and
 *   flavour-engine.mjs take (caller loads these from Automation/content-
 *   memory/*.json — this module does not read the filesystem itself).
 * @param {{evidenceTopK?: number}} [options]
 * @returns {Promise<Object>} the topic state (spec section 4 shape)
 */
export async function buildTopicState(ctx = {}, recentMemory = [], options = {}) {
  const topic = String(ctx.topic || '');
  const subject = String(ctx.subject || '');
  const exam = String(ctx.exam || '');

  const allMatching = filterMatching(recentMemory, ctx);
  const recentMatching = allMatching.slice(0, RECENT_WINDOW);
  const historicalMatching = allMatching.slice(RECENT_WINDOW);

  const editorialSignature = buildEditorialSignature(ctx, recentMemory);
  const evidence = await gatherEvidence(ctx, { topK: options.evidenceTopK });

  // ---------- coverage ----------
  const importantConcepts = evidence.provenance.map(conceptLabel).filter(Boolean);
  const coverageItems = coverageProbability(importantConcepts, allMatching);
  const coverageGaps = coverageItems
    .filter(item => item.coverageProbability < COVERAGE_GAP_THRESHOLD)
    .map(item => item.concept);
  const averageCoverage = coverageItems.length
    ? Math.round((coverageItems.reduce((s, i) => s + i.coverageProbability, 0) / coverageItems.length) * 100) / 100
    : 0;
  const coverage = {
    items: coverageItems,
    gaps: coverageGaps,
    averageCoverage,
    dataAvailable: coverageItems.length > 0,
  };

  // ---------- field-fill posteriors ----------
  // Beta-Bernoulli posterior (prior (1,1), the uninformative default) on
  // "does a historical record for this exam+subject actually carry usable
  // signal in this field" — one posterior per list-valued content-memory
  // field. This is the honest way to turn "0 of 39 records have a non-empty
  // misconceptions_used" into a number (a LOW posterior mean, not a
  // fabricated 0 or a silently-skipped signal) and is shared raw material
  // for several Phase 7 genome values (example_density,
  // misconception_depth, question_integration) so those don't each
  // reimplement the same fill-rate-to-posterior logic.
  function fillPosterior(field) {
    const successes = allMatching.filter(r => Array.isArray(r[field]) && r[field].length > 0).length;
    const posterior = betaBernoulliUpdate({ alpha: 1, beta: 1 }, successes, allMatching.length - successes);
    return { mean: Math.round(posterior.mean * 100) / 100, observations: allMatching.length };
  }
  const fillPosteriors = {
    concepts_taught: fillPosterior('concepts_taught'),
    examples_used: fillPosterior('examples_used'),
    misconceptions_used: fillPosterior('misconceptions_used'),
    question_types: fillPosterior('question_types'),
  };

  // ---------- misconceptions ----------
  const misconceptions = {
    underused: editorialSignature.underusedMisconceptions,
    historicalFillRate: fillPosteriors.misconceptions_used,
  };

  // ---------- recent_structures ----------
  const recentShapeItems = recentMatching.flatMap(r => Array.isArray(r.article_shape) ? r.article_shape : []);
  const historicalShapeItems = historicalMatching.flatMap(r => Array.isArray(r.article_shape) ? r.article_shape : []);
  const recentShapeDist = frequencyDistribution(recentShapeItems);
  const historicalShapeDist = frequencyDistribution(historicalShapeItems);
  const structuralDivergence = (recentShapeDist.size || historicalShapeDist.size)
    ? jensenShannonDivergence(recentShapeDist, historicalShapeDist)
    : null;
  const structuralRepetitiveness = recentShapeDist.size ? 1 - normalizedEntropy(recentShapeDist) : null;

  // oldest-first section-count series for EWMA (allMatching is most-recent-first).
  const sectionCountSeries = allMatching
    .slice()
    .reverse()
    .map(r => (Array.isArray(r.article_shape) ? r.article_shape.length : null))
    .filter(n => Number.isFinite(n));
  const sectionCountEwma = sectionCountSeries.length ? ewma(sectionCountSeries, 0.3) : null;

  const recent_structures = {
    recentShapeDistribution: Object.fromEntries(recentShapeDist),
    structuralDivergenceFromHistory: structuralDivergence, // 0..1, null if no data at all yet
    structuralRepetitiveness, // 0..1 (1 = very repetitive), null if no recent data
    sectionCountEwma: sectionCountEwma ? Math.round(sectionCountEwma.value * 100) / 100 : null,
    sampleSize: allMatching.length,
  };

  // ---------- learner_signals / difficulty / similarity: no data source wired yet ----------
  const learner_signals = { dataAvailable: false, note: 'Search Console integration not wired (spec section 11) — no learner-intent signal exists yet.' };
  const difficulty = { dataAvailable: false, note: 'No PYQ/difficulty dataset is wired into this engine yet.' };
  const similarity = { dataAvailable: false, note: 'similarity-check.mjs compares published HTML bodies; nothing exists pre-publish for this topic yet. See Automation/content-memory/README.md.' };

  // ---------- confidence ----------
  const sampleSizeFactor = Math.min(1, allMatching.length / RECENT_WINDOW);
  const confidence = {
    editorialSignature: editorialSignature.confidence,
    evidence: evidence.sourceConfidence,
    sampleSize: Math.round(sampleSizeFactor * 100) / 100,
    overall: Math.round(((editorialSignature.confidence + evidence.sourceConfidence + sampleSizeFactor) / 3) * 100) / 100,
  };

  return {
    topic,
    subject,
    exam,
    coverage,
    evidence,
    learner_signals,
    difficulty,
    misconceptions,
    recent_structures,
    similarity,
    confidence,
    fillPosteriors, // additive: shared raw material for Phase 7's genome values
    editorialSignature, // additive: raw Phase-1 output, kept for traceability/debugging
    last_updated: new Date().toISOString(),
  };
}
