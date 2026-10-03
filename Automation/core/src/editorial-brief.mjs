// EDITORIAL INTELLIGENCE — Phase 8 (editorial brief).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, section 10 ("Editorial
// brief... The brief should not prescribe prose.").
//
// Converts a Phase 6 topic state + Phase 7 genome into the compact brief
// shape (teach, emphasize, clarify, useEvidence, avoidRepeating,
// pedagogicalShape, confidence), plus a render function that turns the
// brief into a small prompt-text block — same spirit as flavour-engine.mjs's
// buildFlavourPromptBlock(): a compact, human/AI-readable block that states
// DECISIONS, never wording/sentences/tone. This module does no new
// statistics — every list here is a direct read of a Phase 6/7 field,
// capped and relabeled for brief-readability only.
//
// NOT wired into any live prompt-building code (notes-factory/index.html,
// long-post-factory/index.html, update-factory, or any MASTER-PROMPT-*.md)
// per this task's boundaries — this is a standalone module a human can wire
// in later once reviewed.

import { buildEditorialGenome } from './editorial-genome.mjs';

const TOP_N = 5; // mirrors editorial-intelligence.mjs's cap — keeps the brief "small" per spec section 10
const EVIDENCE_EXCERPT_CHARS = 160; // enough for a human/AI to recognize the source, far short of reproducing it
const MAX_EVIDENCE_ITEMS = 3; // useEvidence is a pointer to sources, not a mini-corpus dump

function truncate(text, max) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(0, max).trim() + '…' : s;
}

/**
 * @param {Object} topicState output of buildTopicState() (Phase 6)
 * @param {Object} [genome] output of buildEditorialGenome() (Phase 7) — if
 *   omitted, this function computes it from topicState itself (so callers
 *   that only have a topic state can still get a full brief in one call).
 * @returns {{
 *   teach: string[],
 *   emphasize: string[],
 *   clarify: string[],
 *   useEvidence: Array<{source:string, excerpt:string, score:number}>,
 *   avoidRepeating: string[],
 *   pedagogicalShape: Object,
 *   confidence: number
 * }}
 */
export function buildEditorialBrief(topicState = {}, genome = null) {
  const pedagogicalShape = genome || buildEditorialGenome(topicState);

  const teach = (topicState.coverage?.items || [])
    .map(i => i.concept)
    .filter(Boolean)
    .slice(0, TOP_N);

  const clarify = (topicState.coverage?.gaps || []).slice(0, TOP_N);

  const emphasize = (topicState.misconceptions?.underused || []).slice(0, TOP_N);

  const avoidRepeating = [
    ...(topicState.editorialSignature?.avoidConcepts || []),
    ...(topicState.editorialSignature?.avoidExamples || []),
  ].slice(0, TOP_N);

  const useEvidence = (topicState.evidence?.hits || [])
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map(h => ({
      // chapterTitle already includes the book name (see
      // Automation/ncert-knowledge-base/build-index.mjs's doc shape), so
      // prepending h.book again would duplicate it — only fall back to
      // "book — chapter" when chapterTitle itself is missing.
      source: h.chapterTitle || [h.book, h.chapter].filter(Boolean).join(' — '),
      excerpt: truncate(h.text, EVIDENCE_EXCERPT_CHARS),
      score: Math.round((h.score || 0) * 100) / 100,
    }));

  return {
    teach,
    emphasize,
    clarify,
    useEvidence,
    avoidRepeating,
    pedagogicalShape,
    confidence: topicState.confidence?.overall ?? 0,
  };
}

/**
 * Renders a brief into a compact, model-facing text block. Mirrors
 * flavour-engine.mjs's buildFlavourPromptBlock() in spirit: states
 * decisions and numbers, never prose/wording/tone — the writer stays fully
 * free on HOW to teach any of this (spec section 10's explicit rule).
 * Sections with no content are omitted entirely rather than printed empty,
 * so a low-data topic produces a short, honest block instead of a padded
 * one with empty placeholders (spec section 6 applied to brief rendering).
 *
 * @param {Object} brief output of buildEditorialBrief()
 * @returns {string}
 */
export function buildEditorialBriefPromptBlock(brief) {
  const lines = [`EDITORIAL BRIEF (confidence: ${brief.confidence})`];

  if (brief.teach.length) lines.push(`Teach: ${brief.teach.join('; ')}`);
  if (brief.clarify.length) lines.push(`Clarify (evidence shows this is under-covered so far): ${brief.clarify.join('; ')}`);
  if (brief.emphasize.length) lines.push(`Emphasize (overdue misconception correction): ${brief.emphasize.join('; ')}`);
  if (brief.avoidRepeating.length) lines.push(`Avoid repeating (recently overused in this exam+subject): ${brief.avoidRepeating.join('; ')}`);
  if (brief.useEvidence.length) {
    lines.push('Evidence available:');
    for (const e of brief.useEvidence) lines.push(`  - [${e.source}] "${e.excerpt}"`);
  }

  const g = brief.pedagogicalShape || {};
  lines.push(
    `Pedagogical shape: opening=${g.opening}; concept_order=${g.concept_order}; ` +
    `example_density=${g.example_density}; comparison_need=${g.comparison_need}; table_need=${g.table_need}; ` +
    `classroom_examples=${g.classroom_examples}; misconception_depth=${g.misconception_depth}; ` +
    `revision_density=${g.revision_density}; question_integration=${g.question_integration}; ` +
    `analogy_use=${g.analogy_use}; section_count=${g.section_count}`
  );

  lines.push('This brief states editorial decisions only — wording, examples, sentence structure, transitions and tone remain the writer\'s free choice.');

  return lines.join('\n');
}
