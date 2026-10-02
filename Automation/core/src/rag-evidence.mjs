// EDITORIAL INTELLIGENCE — Phase 4 (connect RAG retrieval).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, section 12 ("RAG supplies
// evidence. Editorial Intelligence decides how that evidence should
// influence teaching.") and section 3's Evidence layer ("what sources
// exist, what concepts are supported, what evidence is available, source
// confidence/provenance").
//
// Combines Automation/ncert-knowledge-base/retrieve.mjs (local BM25, no
// network, no API key — see that file's README) with the Phase 3 validator
// (rag-evidence-validator.mjs) to produce one clean "evidence" result for a
// {topic, subject, exam}. This module is consumed by later phases
// (topic-state.mjs) only — it is NOT wired into any live prompt-building
// code, per the task boundary.
//
// Honesty rule (spec section 6 / the Phase 1 header's data-quality note,
// generalized to evidence): if the corpus is missing, or nothing matches,
// or everything retrieved gets rejected by the validator, this module
// returns a genuinely empty/zero-confidence result. It never pads evidence
// to look more complete than what retrieve() actually found.

import { retrieve, hasCorpus } from '../../ncert-knowledge-base/retrieve.mjs';
import { validateRetrievalResults } from './rag-evidence-validator.mjs';

const DEFAULT_TOP_K = 8;

/**
 * Builds the query text handed to BM25 retrieval. Deliberately simple
 * (topic + subject) — retrieve.mjs's tokenizer already lowercases/strips,
 * and BM25 itself handles term weighting; there is no evidence a cleverer
 * query-expansion step here would improve recall enough to justify the
 * complexity, so this stays a plain concatenation.
 */
function buildQueryText(ctx) {
  const topic = String(ctx.topic || '').trim();
  const subject = String(ctx.subject || '').trim();
  return [topic, subject].filter(Boolean).join(' ');
}

/**
 * Deduplicated, order-preserving list of chapter identities across a set of
 * validated hits — used both as a lightweight "concepts/sources supported"
 * signal and as a source-diversity input for Phase 7's table_need.
 */
function distinctChapters(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = `${h.book || ''}::${h.chapter || h.chapterTitle || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ book: h.book || null, chapter: h.chapter || null, chapterTitle: h.chapterTitle || null });
  }
  return out;
}

/**
 * Source confidence: how much this evidence set is actually worth trusting.
 * Built from two real, observable quantities only (never invented):
 *   - fill: how many of the requested topK slots came back with a VALID
 *     hit (0 if the corpus is empty or nothing matched at all)
 *   - cleanliness: what fraction of everything retrieve() returned actually
 *     survived validation (a low cleanliness means the corpus/index itself
 *     may have a quality problem worth human attention, not just "less
 *     evidence" — see rag-evidence-validator.mjs's header)
 * Both are already bounded in [0, 1], so their product is too. A simple
 * product (rather than e.g. a weighted sum) was chosen so that either
 * factor being zero correctly drives confidence to zero — partial evidence
 * that is mostly corrupted should not read as "medium confidence".
 */
function computeSourceConfidence(validCount, totalCount, topK) {
  if (totalCount === 0) return 0;
  const fill = Math.min(1, validCount / topK);
  const cleanliness = validCount / totalCount;
  return Math.round(fill * cleanliness * 100) / 100;
}

/**
 * @param {{topic?:string, subject?:string, exam?:string}} ctx
 * @param {{topK?: number}} [options]
 * @returns {Promise<{
 *   queryText: string,
 *   corpusAvailable: boolean,
 *   hits: Array<{id:string, subject:string, book:string, chapter:string, chapterTitle:string, text:string, score:number}>,
 *   rejectedCount: number,
 *   rejectionReasons: string[],
 *   provenance: Array<{book:string|null, chapter:string|null, chapterTitle:string|null}>,
 *   sourceConfidence: number
 * }>}
 */
export async function gatherEvidence(ctx = {}, options = {}) {
  const topK = Number.isFinite(options.topK) && options.topK > 0 ? options.topK : DEFAULT_TOP_K;

  if (!hasCorpus()) {
    return {
      queryText: buildQueryText(ctx),
      corpusAvailable: false,
      hits: [],
      rejectedCount: 0,
      rejectionReasons: [],
      provenance: [],
      sourceConfidence: 0,
    };
  }

  const queryText = buildQueryText(ctx);
  const filter = ctx.subject ? { subject: ctx.subject } : undefined;
  const raw = await retrieve(queryText, filter, topK);
  const { valid, invalid } = validateRetrievalResults(raw);

  const rejectionReasons = [...new Set(invalid.flatMap(r => r.reasons))];

  return {
    queryText,
    corpusAvailable: true,
    hits: valid,
    rejectedCount: invalid.length,
    rejectionReasons,
    provenance: distinctChapters(valid),
    sourceConfidence: computeSourceConfidence(valid.length, raw.length, topK),
  };
}
