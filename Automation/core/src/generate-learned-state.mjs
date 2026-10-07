#!/usr/bin/env node
// EDITORIAL INTELLIGENCE — learned-state persistence (closes part of the
// "LEARNED STATE -> NEXT GENERATION" loop for notes-factory specifically).
//
// Phase 1's buildEditorialSignature() already runs LIVE in the browser
// (shared/editorial-intelligence.js), computed fresh from content-memory on
// every "Build prompt" click — nothing here duplicates that (avoidConcepts/
// avoidExamples/avoidCardSentences/underusedMisconceptions all already
// reach the prompt without this file). What Phase 1 deliberately does NOT
// compute (coverageGaps/recommendedStructures are left [] on purpose,
// documented as deferred to later phases) is the one thing this script
// adds: topic-state.mjs's recent_structures (article-shape distribution,
// structural divergence/repetitiveness) and, where real NCERT/RAG evidence
// exists for that subject, a coverage summary — both genuinely need
// Node-side computation (topic-state.mjs -> rag-evidence.mjs ->
// retrieve.mjs -> node:fs), which is exactly why they can't run in the
// browser (see shared/editorial-intelligence.js's own header comment).
// Running them here, in CI, once per publish, and committing ONE small
// JSON the browser can plain fetch() sidesteps that node:fs blocker
// entirely — the browser never runs this computation, it only ever reads a
// precomputed result, same pattern as topic-bank-sources.js/content-memory.
//
// Output: generated/editorial/learned-state.json
//   { byExamSubject: { "EXAM::SUBJECT": { recentStructures, coverage, sampleSize } }, generatedAt }
// Physically separate from Automation/content-memory/ (raw per-article
// records) per this engine's explicit state-separation rule — this file
// holds aggregated, derived state, never a copy of any article's own data.
//
// Usage: node generate-learned-state.mjs [--out <path>]

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTopicState } from './topic-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTENT_MEMORY_DIR = path.join(REPO_ROOT, 'Automation', 'content-memory');
const DEFAULT_OUT = path.join(REPO_ROOT, 'generated', 'editorial', 'learned-state.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--out') out.out = argv[++i];
  return out;
}

async function loadContentMemory() {
  let files = [];
  try { files = (await readdir(CONTENT_MEMORY_DIR)).filter(f => f.endsWith('.json')); }
  catch { return []; }
  const records = [];
  for (const f of files) {
    try { records.push(JSON.parse(await readFile(path.join(CONTENT_MEMORY_DIR, f), 'utf8'))); }
    catch { /* skip unparsable — not this script's job to fix the repo's data */ }
  }
  return records;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = args.out ? path.resolve(args.out) : DEFAULT_OUT;
  const records = await loadContentMemory();

  const pairs = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const key = `${r.exam || ''}::${r.subject || ''}`;
    if (!pairs.has(key)) pairs.set(key, { exam: r.exam || '', subject: r.subject || '' });
  }

  const byExamSubject = {};
  for (const [key, { exam, subject }] of pairs.entries()) {
    const ts = await buildTopicState({ topic: '', exam, subject }, records);
    byExamSubject[key] = {
      recentStructures: ts.recent_structures,
      coverage: ts.coverage.dataAvailable ? { averageCoverage: ts.coverage.averageCoverage, gaps: ts.coverage.gaps } : null,
      sampleSize: ts.recent_structures.sampleSize,
    };
  }

  const result = { byExamSubject, generatedAt: new Date().toISOString() };
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${outPath} (${Object.keys(byExamSubject).length} exam+subject pair(s))`);
}

main().catch(e => { console.error('generate-learned-state.mjs failed:', e); process.exitCode = 1; });
