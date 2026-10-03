#!/usr/bin/env node
// EDITORIAL INTELLIGENCE — Phase 9/10 underlying LOGIC (standalone script).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, section 13
// ("NEXT_POST_READY") and section 14 ("Post-run").
//
// This is a directly-runnable Node script, NOT a GitHub Actions workflow.
// Per this task's explicit boundary, no .yml file was created under
// .github/workflows/ — see Automation/core/GITHUB_WORKFLOWS_DESIGN.md for
// the eventual (not-yet-active) workflow design this script is meant to
// slot into. This script only reads local files (Automation/content-memory/
// *.json and the local NCERT BM25 index) and writes one local output file —
// no network call, no credentials, same as every other module in this
// phase of work.
//
// Usage:
//   node generate-next-post-ready.mjs --topic "HCF and LCM" --subject Maths --exam "BPSC TRE"
//   node generate-next-post-ready.mjs                      (recommend-only mode — see below)
//
// Output: <repoRoot>/generated/editorial/next-post-ready.json (spec section 13 shape)
//
// RECOMMEND-ONLY MODE (no --topic given): this repo has no existing "next
// topic to write about" backlog/queue data source (checked: Automation/
// wp-structure/*.tsv is WordPress course/subject TAXONOMY structure, not a
// per-topic content backlog). Without a real topic backlog, fabricating a
// specific next topic string would be exactly the "fake completeness" this
// whole engine is built to avoid. So when --topic is omitted, this script
// does the one thing it CAN honestly do with existing data: recommend which
// EXAM+SUBJECT pair most deserves attention next, using Phase 5's
// deterministic exploration/exploitation selector over every exam+subject
// pair actually seen in content-memory (exploitScore favors pairs with
// bigger evidence-backed coverage gaps; timesUsed is each pair's real
// historical sample size) — and writes topic: null with a clear
// "humanActionNeeded" note. This is a genuine open question for the repo
// owner (see this run's progress report), not something this script should
// guess at.

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTopicState } from './topic-state.mjs';
import { buildEditorialGenomeWithRationale } from './editorial-genome.mjs';
import { buildEditorialBrief } from './editorial-brief.mjs';
import { selectWithExploration } from './editorial-statistics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTENT_MEMORY_DIR = path.join(REPO_ROOT, 'Automation', 'content-memory');
const DEFAULT_OUT = path.join(REPO_ROOT, 'generated', 'editorial', 'next-post-ready.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

async function loadContentMemory() {
  let files = [];
  try {
    files = (await readdir(CONTENT_MEMORY_DIR)).filter(f => f.endsWith('.json'));
  } catch {
    return []; // directory missing — honest empty history, not a crash
  }
  const records = [];
  for (const f of files) {
    try { records.push(JSON.parse(await readFile(path.join(CONTENT_MEMORY_DIR, f), 'utf8'))); }
    catch { /* unreadable/corrupt record — skip rather than fail the whole run */ }
  }
  return records;
}

/**
 * Recommend-only mode: rank every real exam+subject pair by exploration/
 * exploitation (Phase 5), where exploitScore = 1 - averageCoverage (pairs
 * with bigger evidence-backed coverage gaps score higher — "most worth
 * writing about next") and timesUsed = that pair's real historical sample
 * size (more history already written there = less urgent to explore).
 * Building a full topic state per pair (not just a frequency count) is
 * deliberate — it means the recommendation is grounded in the same
 * evidence-aware coverage signal the rest of the engine uses, not a bare
 * popularity count.
 */
async function recommendExamSubjectPair(records) {
  const pairs = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const key = `${r.exam || ''}::${r.subject || ''}`;
    if (!pairs.has(key)) pairs.set(key, { exam: r.exam || '', subject: r.subject || '' });
  }
  const candidates = [];
  for (const { exam, subject } of pairs.values()) {
    const ts = await buildTopicState({ topic: '', subject, exam }, records);
    const timesUsed = ts.recent_structures.sampleSize;
    const exploitScore = ts.coverage.dataAvailable ? (1 - ts.coverage.averageCoverage) : 0.5; // no evidence-backed coverage signal at all for this pair -> neutral, not falsely confident
    candidates.push({ id: `${exam}::${subject}`, exam, subject, exploitScore, timesUsed });
  }
  if (!candidates.length) return null;
  const { selected, ranked } = selectWithExploration(candidates, {});
  const winner = candidates.find(c => c.id === selected);
  return { winner, ranked };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = await loadContentMemory();
  const outPath = args.out ? path.resolve(args.out) : DEFAULT_OUT;

  let result;
  if (args.topic) {
    const ctx = { topic: String(args.topic), subject: String(args.subject || ''), exam: String(args.exam || '') };
    const topicState = await buildTopicState(ctx, records, { evidenceTopK: args.topK ? Number(args.topK) : undefined });
    const { genome, rationale } = buildEditorialGenomeWithRationale(topicState);
    const brief = buildEditorialBrief(topicState, genome);

    result = {
      topic: ctx.topic,
      subject: ctx.subject,
      exam: ctx.exam,
      topicState,
      evidence: topicState.evidence,
      statistics: {
        fillPosteriors: topicState.fillPosteriors,
        recent_structures: topicState.recent_structures,
        confidence: topicState.confidence,
      },
      editorialDecision: rationale,
      editorialGenome: genome,
      editorialBrief: brief,
      confidence: topicState.confidence.overall,
      generatedAt: new Date().toISOString(),
      mode: 'full',
    };
  } else {
    const recommendation = await recommendExamSubjectPair(records);
    result = {
      topic: null,
      subject: recommendation ? recommendation.winner.subject : null,
      exam: recommendation ? recommendation.winner.exam : null,
      recommendation,
      confidence: 0, // no topic chosen yet — see humanActionNeeded
      generatedAt: new Date().toISOString(),
      mode: 'recommend-only',
      humanActionNeeded: 'No topic backlog data source exists in this repo yet (checked Automation/wp-structure/*.tsv — that is WordPress course/subject taxonomy, not a content backlog). Re-run with --topic "..." --subject "..." --exam "..." once a specific next topic is chosen, or wire a real topic backlog into this script. See this session\'s EDITORIAL_INTELLIGENCE_PROGRESS_REPORT.md.',
    };
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${outPath} (mode: ${result.mode})`);
}

main().catch(e => { console.error('generate-next-post-ready.mjs failed:', e); process.exitCode = 1; });
