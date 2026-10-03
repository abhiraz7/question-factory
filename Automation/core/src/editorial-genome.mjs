// EDITORIAL INTELLIGENCE — Phase 7 (editorial genome).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, section 3 ("Editorial
// genome... These are educational decisions, not prose instructions.") and
// section 6 ("no fake randomness... every genome value must be
// statistically/evidentially justified").
//
// Turns a Phase 6 topic state into the genome shape from spec section 3:
// opening, concept_order, example_density, comparison_need, table_need,
// classroom_examples, misconception_depth, revision_density,
// question_integration, analogy_use, section_count.
//
// JUDGMENT CALLS A HUMAN SHOULD REVIEW (flagged here, not hidden):
// content-memory has no labeled "these two concepts are commonly confused"
// signal and no Search-Console/PYQ difficulty signal, so a few values below
// are *inferential proxies* built from signals that genuinely do exist
// (structural repetitiveness, evidence source diversity, field-fill
// posteriors) rather than the ideal direct signal the spec's own example
// describes. Each such proxy is called out in its function's comment with
// the word "PROXY". They are still real statistics, never randomness or a
// hardcoded constant chosen "for variety" — but the mapping from proxy to
// meaning is a design choice, not a measurement, and is worth a second look.
//
// Every function here takes the already-computed topic state (Phase 6) —
// this module does no content-memory parsing, no RAG calls, and no new
// statistics of its own; it only maps existing signals to genome values.

const PEDAGOGY_SUBJECT_HINT = /cdp|pedagog/i; // same narrow spirit as flavour-engine.mjs's subject affinity hints — used ONLY to scale a magnitude (classroom_examples), never to pick a flavour/structure itself, so this does not duplicate or compete with flavour-engine.mjs's job (spec section 8).

function isPedagogySubject(subject) {
  return PEDAGOGY_SUBJECT_HINT.test(String(subject || ''));
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * opening + concept_order are decided together because concept_order is
 * simply "the sequence that follows from whichever opening is justified" —
 * keeping them in one function makes that dependency explicit instead of
 * recomputing the same condition twice.
 *
 * - 'misconception': there is a SPECIFIC, named, overdue misconception
 *   (topicState.misconceptions.underused is non-empty) — concrete evidence
 *   a correction-first opening has real work to do.
 * - 'problem': no overdue misconception, but Phase 6's coverage layer (RAG
 *   evidence cross-referenced against history) found real unaddressed
 *   concepts (topicState.coverage.gaps non-empty) — motivate the gap with
 *   a problem before closing it.
 * - 'concept': neither signal fired (most common case on today's sparse
 *   content-memory data — see editorial-intelligence.mjs's header). This
 *   is an honest DEFAULT for "no overriding signal", not a random pick.
 */
function decideOpeningAndOrder(topicState) {
  const hasUnderusedMisconception = (topicState.misconceptions?.underused?.length || 0) > 0;
  const hasCoverageGap = (topicState.coverage?.gaps?.length || 0) > 0;

  if (hasUnderusedMisconception) {
    return { opening: 'misconception', concept_order: 'misconception_to_rule', reason: 'underused misconception present in history' };
  }
  if (hasCoverageGap) {
    return { opening: 'problem', concept_order: 'problem_to_concept', reason: 'evidence-backed coverage gap present' };
  }
  return { opening: 'concept', concept_order: 'definition_to_application', reason: 'no overriding misconception/coverage-gap signal — foundational default' };
}

/**
 * example_density: direct reuse of Phase 6's Beta-Bernoulli posterior on
 * "does history for this exam+subject actually carry examples_used" — no
 * new math, just read the number topic-state.mjs already computed.
 */
function decideExampleDensity(topicState) {
  return topicState.fillPosteriors?.examples_used?.mean ?? 0;
}

/**
 * comparison_need — PROXY. No labeled "commonly confused pair" data exists
 * (spec's own example assumes one). Built from two real signals instead:
 *   - structural repetitiveness (1 - normalized entropy of recent
 *     article_shape terms): if the SAME small cluster of structural
 *     elements keeps recurring for this exam+subject rather than spreading
 *     out, that cluster is plausibly a tightly related concept-group —
 *     exactly the situation where contrasting members of the group earns
 *     its keep.
 *   - evidence source diversity (distinct NCERT chapters retrieved): more
 *     distinct chapters backing one topic suggests more than one
 *     sub-concept is in play, which is also when a comparison structure is
 *     more likely to be useful than a single linear explanation.
 * Weighted 60/40 toward repetitiveness because it is a direct historical
 * signal about THIS exam+subject, while evidence diversity is a weaker,
 * corpus-dependent proxy (and can be systematically 0 for English-phrased
 * topics against the current Hindi-only NCERT corpus — see this session's
 * progress report for that finding).
 */
function decideComparisonNeed(topicState) {
  const repetitiveness = topicState.recent_structures?.structuralRepetitiveness;
  const repetitivenessScore = typeof repetitiveness === 'number' ? repetitiveness : 0;
  const provenanceCount = topicState.evidence?.provenance?.length || 0;
  const diversityScore = Math.min(1, provenanceCount / 3);
  return round2(clamp01(0.6 * repetitivenessScore + 0.4 * diversityScore));
}

/**
 * table_need — PROXY. Source diversity (distinct chapters/books Phase 4's
 * validated evidence actually found) as a stand-in for "does this topic
 * have multiple parallel sub-items worth tabulating". Capped at 5 distinct
 * sources = full table_need, since that is already DEFAULT_TOP_K worth of
 * distinct evidence in rag-evidence.mjs.
 */
function decideTableNeed(topicState) {
  const provenanceCount = topicState.evidence?.provenance?.length || 0;
  return round2(Math.min(1, provenanceCount / 5));
}

/**
 * classroom_examples — integer count, scaled by example_density (the real
 * historical signal for "does this exam+subject lean on examples at all")
 * and a small subject-category multiplier: CDP/Pedagogy topics are where a
 * classroom scenario is pedagogically native (also flavour-engine.mjs's own
 * 'classroom-situation' flavour targets exactly this subject group — this
 * mirrors that established judgment, not a new invention), so they get a
 * higher ceiling (5) than other subjects (2).
 */
function decideClassroomExamples(exampleDensity, subject) {
  const ceiling = isPedagogySubject(subject) ? 5 : 2;
  return Math.round(clamp01(exampleDensity) * ceiling);
}

/**
 * misconception_depth: Phase 6's fill posterior for misconceptions_used,
 * boosted by a flat +0.2 (capped at 1) when a SPECIFIC underused
 * misconception was actually named (topicState.misconceptions.underused) —
 * concrete, actionable content is worth more than the bare frequency stat
 * alone. The +0.2 constant is a deliberate, modest, documented nudge, not a
 * fitted value — flagged here as a judgment call since there is no data yet
 * to calibrate its exact size against outcomes.
 */
function decideMisconceptionDepth(topicState) {
  const base = topicState.fillPosteriors?.misconceptions_used?.mean ?? 0;
  const hasNamed = (topicState.misconceptions?.underused?.length || 0) > 0;
  return round2(clamp01(base + (hasNamed ? 0.2 : 0)));
}

/**
 * revision_density: sampleSize confidence (how much history exists at all
 * for this exam+subject) times average coverage (how much of the
 * evidence-backed concept set has already been taught). A brand-new
 * exam+subject with thin history, or a topic where evidence shows most
 * concepts are still gaps, both correctly produce LOW revision_density —
 * revision only makes sense once there is an established base to revise.
 */
function decideRevisionDensity(topicState) {
  const sampleSize = topicState.confidence?.sampleSize ?? 0;
  const avgCoverage = topicState.coverage?.averageCoverage ?? 0;
  return round2(clamp01(sampleSize * avgCoverage));
}

/**
 * question_integration: direct reuse of Phase 6's fill posterior for
 * question_types — same pattern as example_density.
 */
function decideQuestionIntegration(topicState) {
  return topicState.fillPosteriors?.question_types?.mean ?? 0;
}

/**
 * analogy_use — PROXY, explicitly dampened (x0.8). Analogies are a narrower
 * tool than "uses examples" or "corrects misconceptions" generally, but
 * tend to co-occur with both (an analogy is often HOW a misconception gets
 * corrected or a concept gets exemplified), so this is modeled as a damped
 * average of the two rather than an independent signal — there is no
 * direct historical field recording analogy use in content-memory today
 * (see Automation/content-memory/README.md's schema), so this is the most
 * honest derivation available, not a measurement of analogy use itself.
 */
function decideAnalogyUse(exampleDensity, misconceptionDepth) {
  return round2(clamp01(((exampleDensity + misconceptionDepth) / 2) * 0.8));
}

/**
 * section_count: rounded EWMA of historical article_shape length for this
 * exam+subject (recency-weighted structural "how long has this exam/
 * subject's articles typically been" signal). Falls back to the spec's own
 * illustrative baseline (7) ONLY when there is zero history to compute
 * from — an explicitly labeled fallback, never silently invented data.
 */
function decideSectionCount(topicState) {
  const ewmaValue = topicState.recent_structures?.sectionCountEwma;
  if (typeof ewmaValue === 'number' && Number.isFinite(ewmaValue)) {
    return Math.max(1, Math.round(ewmaValue));
  }
  return 7; // spec section 3's own illustrative baseline, used only as a no-history fallback
}

/**
 * Computes the full genome plus a parallel rationale object (same keys,
 * human-readable justification strings + the raw numbers that drove each
 * decision) so a reviewer can check "why" without re-deriving it by hand.
 * The rationale is NOT part of the genome shape itself (spec section 3
 * lists exactly the 11 genome fields) — callers that only want the genome
 * should use buildEditorialGenome(); this is the explain-everything variant
 * used by the test/smoke scripts and the progress report.
 *
 * @param {Object} topicState output of buildTopicState() (Phase 6)
 * @returns {{genome: Object, rationale: Object}}
 */
export function buildEditorialGenomeWithRationale(topicState = {}) {
  const { opening, concept_order, reason: openingReason } = decideOpeningAndOrder(topicState);
  const example_density = round2(clamp01(decideExampleDensity(topicState)));
  const comparison_need = decideComparisonNeed(topicState);
  const table_need = decideTableNeed(topicState);
  const classroom_examples = decideClassroomExamples(example_density, topicState.subject);
  const misconception_depth = decideMisconceptionDepth(topicState);
  const revision_density = decideRevisionDensity(topicState);
  const question_integration = round2(clamp01(decideQuestionIntegration(topicState)));
  const analogy_use = decideAnalogyUse(example_density, misconception_depth);
  const section_count = decideSectionCount(topicState);

  const genome = {
    opening,
    concept_order,
    example_density,
    comparison_need,
    table_need,
    classroom_examples,
    misconception_depth,
    revision_density,
    question_integration,
    analogy_use,
    section_count,
  };

  const rationale = {
    opening: openingReason,
    concept_order: `follows from opening (${opening})`,
    example_density: `Beta-Bernoulli posterior on examples_used fill rate (mean=${example_density}, observations=${topicState.fillPosteriors?.examples_used?.observations ?? 0})`,
    comparison_need: `PROXY: 0.6×structural repetitiveness + 0.4×evidence source diversity`,
    table_need: `PROXY: distinct evidence sources / 5 (provenance count=${topicState.evidence?.provenance?.length ?? 0})`,
    classroom_examples: `example_density × subject ceiling (${isPedagogySubject(topicState.subject) ? 5 : 2}, pedagogy-subject=${isPedagogySubject(topicState.subject)})`,
    misconception_depth: `Beta-Bernoulli posterior on misconceptions_used fill rate, +0.2 if a specific underused misconception was named (named=${(topicState.misconceptions?.underused?.length || 0) > 0})`,
    revision_density: `sampleSize confidence (${topicState.confidence?.sampleSize ?? 0}) × average coverage (${topicState.coverage?.averageCoverage ?? 0})`,
    question_integration: `Beta-Bernoulli posterior on question_types fill rate (observations=${topicState.fillPosteriors?.question_types?.observations ?? 0})`,
    analogy_use: `PROXY: damped (×0.8) average of example_density and misconception_depth — no direct analogy signal exists in content-memory`,
    section_count: typeof topicState.recent_structures?.sectionCountEwma === 'number'
      ? `EWMA of historical article_shape length (${topicState.recent_structures.sectionCountEwma})`
      : 'no history — spec section 3 illustrative baseline fallback',
  };

  return { genome, rationale };
}

/**
 * @param {Object} topicState output of buildTopicState() (Phase 6)
 * @returns {Object} the genome shape from spec section 3 (exactly 11 fields)
 */
export function buildEditorialGenome(topicState = {}) {
  return buildEditorialGenomeWithRationale(topicState).genome;
}
