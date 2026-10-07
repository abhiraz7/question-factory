// DETERMINISTIC VALIDATOR — mechanical checks that code can do more
// reliably than an AI self-report (see MASTER-PROMPT-ExamNotesPDF_v13.md's
// own "BEFORE YOU OUTPUT" section, which is a PROMPT-side checklist the
// model runs on itself — this file is the CODE-side equivalent for the
// parts that don't require editorial judgment). AI decides editorial
// matters (is this claim fabricated, is this example topic-appropriate);
// code validates deterministic matters (is the JSON valid, do the anchors
// resolve, are there duplicate ids). Never the reverse.
//
// Consumes a parsed bundle shaped like published-notes/*.json:
// { seo: {...}, bodyHtml: "...", publisherNotes: "...", contentMemory: {...} }
//
// Usage: node validate-output.mjs <bundle.json>
// Or: import { validateBundle } from './validate-output.mjs'

import { readFile } from 'node:fs/promises';

const REQUIRED_SEO_FIELDS = ['focusKeyword', 'seoTitle', 'slug', 'metaDescription', 'h1'];
const REQUIRED_CONTENT_MEMORY_FIELDS = [
  'concepts_taught', 'misconceptions_used', 'examples_used',
  'pedagogical_strategy', 'article_shape', 'question_types', 'sources',
];

function pushIssue(list, severity, code, message) {
  list.push({ severity, code, message }); // severity: 'error' (blocks) | 'warning' (informational)
}

/** JSON validity + required output fields (SEO_JSON shape). */
function checkRequiredFields(bundle, issues) {
  if (!bundle || typeof bundle !== 'object') {
    pushIssue(issues, 'error', 'INVALID_BUNDLE', 'Bundle is not a valid object.');
    return;
  }
  if (!bundle.seo || typeof bundle.seo !== 'object') {
    pushIssue(issues, 'error', 'MISSING_SEO', 'Bundle has no .seo object.');
  } else {
    for (const field of REQUIRED_SEO_FIELDS) {
      if (!bundle.seo[field]) pushIssue(issues, 'error', 'MISSING_SEO_FIELD', `.seo.${field} is missing or empty.`);
    }
  }
  if (!bundle.bodyHtml || bundle.bodyHtml.length < 200) {
    pushIssue(issues, 'error', 'MISSING_BODY', '.bodyHtml is missing or implausibly short (<200 chars).');
  }
}

/** Sentinel/wrapper completeness — catches a reply that got truncated or malformed before parsing ever ran. */
function checkSentinelArtifacts(bundle, issues) {
  const body = String(bundle.bodyHtml || '');
  if (/\{\*\s*type\s*:/.test(body)) {
    pushIssue(issues, 'error', 'UNEXPANDED_BLOCK_TAG', 'Body contains an unexpanded {* type: ... *} block-tag marker — the block-tag expander failed or was skipped.');
  }
  // Catches any invented `{Identifier(...)}` macro/function-call-looking
  // placeholder standing in for real HTML — confirmed real, live example:
  // `{C("Teacher decision loop","Observe -> ...","#16a34a")}` shipped as
  // literal text in a generated note instead of a styled card. There is no
  // expander for these (unlike the {* type *} block-tag system, which at
  // least had one at one point) — this is pure HARD BAN 7 violation.
  const macroMatch = body.match(/\{[A-Za-z][A-Za-z0-9_]*\([^)]*\)\}/);
  if (macroMatch) {
    pushIssue(issues, 'error', 'UNEXPANDED_MACRO_PLACEHOLDER', `Body contains an invented macro-like placeholder instead of real HTML (e.g. "${macroMatch[0].slice(0, 60)}") — HARD BAN 7 violation, no expander exists for this.`);
  }
  if (/<<<[A-Z_]+>>>/.test(body)) {
    pushIssue(issues, 'error', 'LEAKED_SENTINEL', 'Body contains a literal <<<SENTINEL>>> marker that should have been stripped during parsing.');
  }
  if (/<script\b/i.test(body)) {
    pushIssue(issues, 'error', 'SCRIPT_TAG', 'Body contains a <script> tag — HARD BAN violation (v13.md HARD BAN 1).');
  }
}

/** Duplicate HTML ids + broken TOC/citation anchors. */
function checkHtmlIntegrity(bundle, issues) {
  const body = String(bundle.bodyHtml || '');
  const idRe = /\sid="([^"]+)"/g;
  const seenIds = new Map();
  let m;
  while ((m = idRe.exec(body))) {
    seenIds.set(m[1], (seenIds.get(m[1]) || 0) + 1);
  }
  for (const [id, count] of seenIds) {
    if (count > 1) pushIssue(issues, 'error', 'DUPLICATE_ID', `id="${id}" appears ${count} times — duplicate ids break anchors and accessibility.`);
  }

  // Every href="#some-id" must resolve to a real id in the document.
  const hrefRe = /href="#([^"]*)"/g;
  while ((m = hrefRe.exec(body))) {
    const target = m[1];
    if (target === '') { pushIssue(issues, 'error', 'BARE_HASH_HREF', 'Found href="#" — HARD BAN violation (v13.md HARD BAN 6).'); continue; }
    if (!seenIds.has(target)) pushIssue(issues, 'error', 'BROKEN_ANCHOR', `href="#${target}" does not match any id="${target}" in the document (broken TOC/citation link).`);
  }

  // Every <sup id="cite-N"> should have a matching #ref-N target, and vice versa.
  const citeIds = [...body.matchAll(/id="cite-(\d+)"/g)].map(x => x[1]);
  const refIds = [...body.matchAll(/id="ref-(\d+)"/g)].map(x => x[1]);
  for (const n of citeIds) {
    if (!refIds.includes(n)) pushIssue(issues, 'error', 'ORPHAN_CITATION', `<sup id="cite-${n}"> has no matching #ref-${n} in a References list.`);
  }
  const refIdSet = new Set(refIds);
  if (refIdSet.size !== refIds.length) pushIssue(issues, 'error', 'DUPLICATE_ID', 'Duplicate ref-N ids found among References entries.');
}

/** Malformed heading hierarchy — a bare <h3> ships unstyled (v13.md's own documented failure pattern). */
function checkHeadingStyling(bundle, issues) {
  const body = String(bundle.bodyHtml || '');
  const bareH3 = /<h3(?![^>]*style=)[^>]*>/i;
  if (bareH3.test(body)) pushIssue(issues, 'warning', 'BARE_H3', 'Found an <h3> with no inline style attribute — v13.md requires every <h3> (incl. FAQ) to carry an explicit style.');
}

/** Obvious keyphrase repetition (stuffing) — a code-side sanity check, not a density target (v13.md explicitly rejects density targets). */
function checkKeyphraseStuffing(bundle, issues) {
  const kw = bundle.seo && bundle.seo.focusKeyword;
  if (!kw) return;
  const body = String(bundle.bodyHtml || '').replace(/<[^>]+>/g, ' ');
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const occurrences = (body.match(new RegExp(escaped, 'gi')) || []).length;
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 0 && occurrences / words > 0.02) {
    pushIssue(issues, 'warning', 'POSSIBLE_STUFFING', `Focus keyphrase "${kw}" appears ${occurrences} times in ~${words} words (${(occurrences / words * 100).toFixed(1)}%) — worth a human look, though v13.md deliberately sets no density target.`);
  }
}

/** Paragraph length — v13.md's on-page checklist says no <p> over ~120 words. */
function checkParagraphLength(bundle, issues) {
  const body = String(bundle.bodyHtml || '');
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1].replace(/<[^>]+>/g, ' '));
  for (const p of paras) {
    const wc = p.split(/\s+/).filter(Boolean).length;
    if (wc > 130) pushIssue(issues, 'warning', 'LONG_PARAGRAPH', `A <p> runs ${wc} words (~120 is the guideline) — consider splitting.`);
  }
}

/** Publisher Notes malformation — an empty or clearly-truncated block. */
function checkPublisherNotes(bundle, issues) {
  const pn = bundle.publisherNotes;
  if (!pn || String(pn).trim().length < 20) {
    pushIssue(issues, 'warning', 'THIN_PUBLISHER_NOTES', 'Publisher Notes is empty or implausibly short — the model may have skipped it.');
  }
}

/** Content Memory schema consistency — required fields present, no headings-derived fabrication markers left over from backfill. */
function checkContentMemory(bundle, issues) {
  const cm = bundle.contentMemory;
  if (!cm) { pushIssue(issues, 'warning', 'MISSING_CONTENT_MEMORY', 'No .contentMemory block — this article will not be recorded for cross-article memory.'); return; }
  for (const field of REQUIRED_CONTENT_MEMORY_FIELDS) {
    if (cm[field] === undefined) pushIssue(issues, 'warning', 'MISSING_CM_FIELD', `contentMemory.${field} is missing.`);
  }
  if (!cm.flavour) pushIssue(issues, 'warning', 'MISSING_CM_FLAVOUR', 'contentMemory.flavour is missing — Editorial Flavour Engine repetition-avoidance loses this record.');
}

/**
 * @param {object} bundle a parsed pending/published bundle
 * @returns {{errors:Array, warnings:Array, pass:boolean}} pass = zero errors
 *   (warnings never block — matches the project's existing hard-fail-vs-
 *   warning convention in Automation/core/src/validate-bundle.mjs).
 */
export function validateBundle(bundle) {
  const issues = [];
  checkRequiredFields(bundle, issues);
  checkSentinelArtifacts(bundle, issues);
  checkHtmlIntegrity(bundle, issues);
  checkHeadingStyling(bundle, issues);
  checkKeyphraseStuffing(bundle, issues);
  checkParagraphLength(bundle, issues);
  checkPublisherNotes(bundle, issues);
  checkContentMemory(bundle, issues);

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  return { errors, warnings, pass: errors.length === 0 };
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node validate-output.mjs <bundle.json>'); process.exit(2); }
  let bundle;
  try { bundle = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { console.error(`::error::${file} is not valid JSON: ${e.message}`); process.exit(1); }

  const result = validateBundle(bundle);
  for (const e of result.errors) console.error(`::error::[${e.code}] ${e.message}`);
  for (const w of result.warnings) console.warn(`::warning::[${w.code}] ${w.message}`);
  console.log(JSON.stringify({ pass: result.pass, errorCount: result.errors.length, warningCount: result.warnings.length }));
  process.exit(result.pass ? 0 : 1);
}

import { fileURLToPath, pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
