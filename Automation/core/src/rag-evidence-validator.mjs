// EDITORIAL INTELLIGENCE — Phase 3 (RAG ingestion validator).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, sections 3 ("Evidence
// layer") and 12 ("RAG relationship").
//
// Pure, deterministic, no I/O, no network. Validates the SHAPE and basic
// quality of one retrieval hit as returned by
// Automation/ncert-knowledge-base/retrieve.mjs's retrieve() — BEFORE any
// such result is allowed to influence an editorial decision (Phase 4 and
// up). Written defensively/skeptically by design: retrieval results are
// assumed malformed until proven otherwise, because:
//
//   1. retrieve.mjs reads a generated index.json that could in principle be
//      stale, partially rebuilt, or (per PROJECT-KNOWLEDGE.md section 4.3)
//      contain leftover un-decoded Kruti-Dev legacy-font text if a future
//      corpus rebuild regresses the decode step — the exact historical bug
//      that corrupted this corpus once before ("esa", "gSa", "osQ", "fd",
//      "dks", "gS" appearing as whole words is the known signature; see
//      Automation/core/src/verify_corpus.py, which runs the same check at
//      corpus-build time over whole chapters — this module runs the same
//      kind of check over much shorter retrieval snippets).
//   2. a caller could hand this validator anything (a hand-built object in
//      a test, a future alternate retrieval backend) — the shape must be
//      checked, not assumed.

// Same signature tokens verify_corpus.py flags, as whole words only (so we
// never flag a legitimate Hindi/English word that merely contains one of
// these letter sequences as a substring).
const KRUTI_DEV_SIGNATURE = /\b(esa|gSa|osQ|fd|dks|gS)\b/g;

const MIN_TEXT_CHARS = 20; // shorter than this isn't a usable evidence snippet
const MIN_SCORE = 0; // retrieve.mjs already filters score > 0, but don't assume

/**
 * Kruti-Dev signature density, scaled to short retrieval snippets rather
 * than whole chapters. verify_corpus.py uses a flat "hits >= 3" threshold
 * because it checks whole chapters (hundreds/thousands of words); a RAG
 * snippet can be a single short paragraph, so a flat threshold of 3 would
 * almost never fire. Scaling the threshold to word count keeps the same
 * underlying sensitivity (roughly: more than ~1 signature hit per 50 words
 * is suspicious) while staying meaningful on short text.
 *
 * @param {string} text
 * @returns {{hits: number, suspicious: boolean}}
 */
function krutiDevCheck(text) {
  const hits = (text.match(KRUTI_DEV_SIGNATURE) || []).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length || 1;
  const threshold = Math.max(2, Math.floor(wordCount / 50));
  return { hits, suspicious: hits >= threshold && hits > 0 };
}

/**
 * Validates one retrieval hit from retrieve.mjs's result array:
 * { id, subject, book, chapter, chapterTitle, text, score }.
 *
 * @param {Object} hit
 * @returns {{valid: boolean, reasons: string[], hit: Object}} reasons is
 *   always [] when valid is true; hit is the original input, unmodified
 *   (this function never rewrites/cleans evidence, only judges it — a
 *   rejected hit must simply be dropped by the caller, never "fixed" in
 *   place, since a fixed-up corrupted snippet could still be wrong).
 */
export function validateRetrievalHit(hit) {
  const reasons = [];

  if (!hit || typeof hit !== 'object') {
    return { valid: false, reasons: ['NOT_AN_OBJECT'], hit };
  }

  const text = typeof hit.text === 'string' ? hit.text.trim() : '';
  if (!text) reasons.push('EMPTY_TEXT');
  else if (text.length < MIN_TEXT_CHARS) reasons.push('TEXT_TOO_SHORT');

  if (!hit.subject || typeof hit.subject !== 'string' || !hit.subject.trim()) {
    reasons.push('MISSING_SUBJECT');
  }

  // Either a chapter id or a human chapterTitle must be present — retrieve()
  // always sets both from the index, but a hand-built/malformed hit might not.
  const hasChapterIdentity = Boolean(
    (hit.chapterTitle && String(hit.chapterTitle).trim()) ||
    (hit.chapter && String(hit.chapter).trim())
  );
  if (!hasChapterIdentity) reasons.push('MISSING_CHAPTER_IDENTITY');

  if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) {
    reasons.push('SCORE_NOT_A_NUMBER');
  } else if (hit.score <= MIN_SCORE) {
    reasons.push('SCORE_NOT_POSITIVE');
  }

  // Defensive: corpus text should be plain text (verify_corpus.py's pipeline
  // strips markup before writing by-subject/*.txt), so literal tag-looking
  // fragments suggest an extraction regression upstream, not real content.
  if (text && /<\/?[a-z][a-z0-9]*[^>]*>/i.test(text)) {
    reasons.push('LOOKS_LIKE_MARKUP');
  }

  if (text) {
    const { hits, suspicious } = krutiDevCheck(text);
    if (suspicious) reasons.push(`POSSIBLE_KRUTI_DEV_ARTIFACT(${hits})`);
  }

  return { valid: reasons.length === 0, reasons, hit };
}

/**
 * Validates a whole retrieve()-style result array, splitting it into clean
 * evidence and rejected-with-reasons. Never throws on malformed input (an
 * empty/non-array input simply yields zero valid/zero invalid) — a RAG
 * ingestion validator that itself crashes on bad input defeats its purpose.
 *
 * @param {Array<Object>} hits
 * @returns {{
 *   valid: Array<Object>,
 *   invalid: Array<{hit: Object, reasons: string[]}>,
 *   validCount: number,
 *   invalidCount: number,
 *   allValid: boolean
 * }}
 */
export function validateRetrievalResults(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const valid = [];
  const invalid = [];
  for (const hit of list) {
    const result = validateRetrievalHit(hit);
    if (result.valid) valid.push(hit);
    else invalid.push({ hit, reasons: result.reasons });
  }
  return {
    valid,
    invalid,
    validCount: valid.length,
    invalidCount: invalid.length,
    allValid: list.length > 0 && invalid.length === 0,
  };
}
