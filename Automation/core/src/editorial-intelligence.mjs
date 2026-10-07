// EDITORIAL INTELLIGENCE — Phase 1 (pure statistical scorer).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, section 9.
//
// This is NOT an AI content generator and does not call an AI. It reads
// Automation/content-memory/ records (same shape flavour-engine.mjs already
// consumes — see that file and Automation/content-memory/README.md for the
// schema) and turns prior-article history into a small set of statistical
// signals: which concepts/examples have been leaned on recently for this
// exam+subject, and which misconceptions associated with this exam+subject
// haven't been revisited in a while. It does NOT decide flavour (that stays
// flavour-engine.mjs's job per spec section 8) and does NOT yet touch RAG,
// Search Console, or an editorial genome (spec sections 11/12/4 — later
// phases). Pure, deterministic, no I/O, no network, no randomness: same
// (ctx, recentMemory) in, same signature out, every time.
//
// Data-quality note (read before trusting the output): this module's first
// write assumed every record in Automation/content-memory/ had
// "derived": true (backfilled from HTML headings by
// backfill-content-memory.mjs, never a live model-reported Content Memory
// block), with misconceptions_used/examples_used always []. That's no
// longer the current state — as of the last audit, 26 of 65 records are
// live, model-reported data with real misconceptions_used/examples_used/
// question_types populated, and that fraction only grows as more notes
// publish. The code was written to generalize correctly either way (nothing
// here special-cases `derived`), so this doesn't need a fix — just don't
// trust this comment's old "all thin/derived" framing; check
// fieldFillRate()'s actual output for current data richness instead.
// `confidence` is built to reflect that honestly rather than overstate it
// (see buildEditorialSignature's data-richness note below).

const RECENT_WINDOW = 10; // how many recent same-exam/subject records count toward "recent" weighting — wider than flavour-engine's 5 since this scores multiple list-valued signals (concepts/examples/misconceptions), not one categorical pick
const OVERUSE_MIN_WEIGHT = 2; // an item needs at least this much recency-weighted count before it's worth flagging as "avoid" — filters out one-off mentions
export const TOP_N = 5; // cap each output list so the eventual prompt block stays small (spec section 10: "small editorial brief")

function normalizeItem(s) {
  return String(s || '').trim();
}

// Matches the note templates' own aside-card shape (Teacher Tip / Exam
// Point / Exam Trap / Mistake / Summary / etc. — every sample across this
// pipeline uses a `border-left:Npx solid COLOR` div as the card wrapper; a
// Table of Contents div uses a plain `border:1px solid` instead, so it never
// matches here even though it shares the same background/padding styling).
// Deliberately non-greedy / no nested-div handling: every real card sample
// seen so far is a flat `<div>...<p>...</p></div>` with no div nesting
// inside it — if that ever changes, this needs a real HTML parser instead.
const CARD_DIV_RE = /<div\b[^>]*style="[^"]*border-left:\s*\d+px\s+solid[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
const CARD_P_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;

function stripTagsForCard(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pulls the actual sentence text out of every aside/callout card in a note's
 * body HTML — found because three diagnostic test runs (same topic/exam/
 * flavour) reproduced several of these card sentences byte-for-byte
 * identical, a repetition class nothing in content-memory's existing
 * concepts_taught/examples_used/misconceptions_used fields can see (those
 * track WHICH ideas were covered, not the exact phrasing of generic advice
 * cards). Pure string/regex work, zero DOM APIs, so this stays safe to run
 * both in Node (editorial-evaluation.mjs, publish workflows) and, if ever
 * needed, in the browser mirror of this file.
 * @param {string} bodyHtml
 * @returns {string[]} de-duplicated (within this one article) card sentences
 */
export function extractCardSentences(bodyHtml) {
  const html = String(bodyHtml || '');
  const sentences = [];
  CARD_DIV_RE.lastIndex = 0;
  let divMatch;
  while ((divMatch = CARD_DIV_RE.exec(html))) {
    const inner = divMatch[1];
    CARD_P_RE.lastIndex = 0;
    let pMatch;
    while ((pMatch = CARD_P_RE.exec(inner))) {
      const text = stripTagsForCard(pMatch[1]);
      if (text) sentences.push(text);
    }
  }
  return [...new Set(sentences)];
}

/**
 * Same loose-match filtering flavour-engine.mjs uses: a record missing
 * either exam or subject still counts as a match on that field (so older/
 * sparser records aren't excluded outright), but a record that actively
 * disagrees on a field it DOES have is excluded. recentMemory is assumed
 * most-recent-first, same convention as flavour-engine.mjs's recentMemory
 * param.
 */
export function filterMatching(recentMemory, ctx) {
  const exam = String(ctx.exam || '');
  const subject = String(ctx.subject || '');
  return (Array.isArray(recentMemory) ? recentMemory : [])
    .filter(r => r && (!exam || !r.exam || r.exam === exam) && (!subject || !r.subject || r.subject === subject));
}

/**
 * Recency-weighted frequency count over one list-valued field (e.g.
 * concepts_taught) across a set of records already in most-recent-first
 * order. Weight decays linearly with position — record 0 (most recent)
 * weighs `records.length`, the last one weighs 1 — matching the same
 * "most-recent-use penalized hardest" shape flavour-engine.mjs's
 * scoreFlavour() already uses for its repetition penalty, so the two
 * engines reason about recency the same way.
 */
export function weightedCounts(records, field) {
  const counts = new Map();
  records.forEach((record, idx) => {
    const weight = records.length - idx;
    const items = Array.isArray(record[field]) ? record[field] : [];
    for (const raw of items) {
      const item = normalizeItem(raw);
      if (!item) continue;
      counts.set(item, (counts.get(item) || 0) + weight);
    }
  });
  return counts;
}

export function topByWeight(counts, { minWeight = 0, limit = TOP_N } = {}) {
  return [...counts.entries()]
    .filter(([, weight]) => weight >= minWeight)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([item]) => item);
}

/**
 * Misconceptions that appear somewhere in this exam+subject's full
 * matching history but carry the LOWEST recency weight (i.e. taught before,
 * but not in the recent window) — the inverse ranking direction from
 * avoidConcepts/avoidExamples. A misconception never used at all for this
 * exam+subject can't appear here (nothing to surface it from) — that gap
 * is a RAG/evidence-layer job (spec section 12), not this function's.
 */
function leastRecentlyUsed(allMatching, recentMatching, field, limit) {
  const historical = weightedCounts(allMatching, field);
  if (!historical.size) return [];
  const recentSet = new Set(weightedCounts(recentMatching, field).keys());
  return [...historical.entries()]
    .filter(([item]) => !recentSet.has(item))
    .sort((a, b) => a[1] - b[1]) // lowest historical weight first — longest overdue
    .slice(0, limit)
    .map(([item]) => item);
}

/**
 * Fraction of records that actually carry usable signal in a given field
 * (non-empty array). Used only to temper `confidence` — a pile of records
 * with empty misconceptions_used/examples_used shouldn't produce the same
 * confidence as a pile where those fields are actually populated, even if
 * the record COUNT is identical.
 */
export function fieldFillRate(records, field) {
  if (!records.length) return 0;
  const filled = records.filter(r => Array.isArray(r[field]) && r[field].length > 0).length;
  return filled / records.length;
}

/**
 * @param {{topic?:string, subject?:string, exam?:string}} ctx
 * @param {Array<Object>} recentMemory content-memory records (the same
 *   array shape/ordering flavour-engine.mjs's selectFlavour() takes —
 *   most-recent-first, loosely filtered by caller or left for this function
 *   to filter itself via filterMatching()), per the schema in
 *   Automation/content-memory/README.md.
 * @returns {{
 *   avoidConcepts: string[],
 *   avoidExamples: string[],
 *   avoidCardSentences: string[],
 *   underusedMisconceptions: string[],
 *   coverageGaps: string[],
 *   recommendedStructures: string[],
 *   confidence: number
 * }}
 */
export function buildEditorialSignature(ctx = {}, recentMemory = []) {
  const allMatching = filterMatching(recentMemory, ctx);
  const recentMatching = allMatching.slice(0, RECENT_WINDOW);

  const avoidConcepts = topByWeight(
    weightedCounts(recentMatching, 'concepts_taught'),
    { minWeight: OVERUSE_MIN_WEIGHT }
  );
  const avoidExamples = topByWeight(
    weightedCounts(recentMatching, 'examples_used'),
    { minWeight: OVERUSE_MIN_WEIGHT }
  );
  // card_sentences_used is populated server-side at publish time (see
  // editorial-evaluation.mjs's extractCardSentences CLI mode, wired into
  // pub-note.yml/pub-lpost.yml) — reuses the exact same generic
  // weightedCounts/topByWeight machinery as concepts/examples above, so this
  // needed zero new scoring logic, only a new field name.
  const avoidCardSentences = topByWeight(
    weightedCounts(recentMatching, 'card_sentences_used'),
    { minWeight: OVERUSE_MIN_WEIGHT }
  );
  const underusedMisconceptions = leastRecentlyUsed(
    allMatching, recentMatching, 'misconceptions_used', TOP_N
  );

  // Both deliberately empty for Phase 1, not stubbed-out placeholders of
  // convenience: coverageGaps needs an evidence/RAG layer to know what
  // SHOULD be covered (spec section 12 — Phase 3/4, not built yet);
  // recommendedStructures is the editorial genome (spec section 4/section
  // 7 "Phase 7"), and structure/flavour selection stays flavour-engine.mjs's
  // job per spec section 8 until that later phase explicitly hands it over.
  const coverageGaps = [];
  const recommendedStructures = [];

  const sampleSizeFactor = Math.min(1, recentMatching.length / RECENT_WINDOW);
  const dataRichness = recentMatching.length
    ? (
        fieldFillRate(recentMatching, 'concepts_taught') +
        fieldFillRate(recentMatching, 'misconceptions_used') +
        fieldFillRate(recentMatching, 'examples_used')
      ) / 3
    : 0;
  const confidence = Math.round(sampleSizeFactor * dataRichness * 100) / 100;

  return { avoidConcepts, avoidExamples, avoidCardSentences, underusedMisconceptions, coverageGaps, recommendedStructures, confidence };
}
