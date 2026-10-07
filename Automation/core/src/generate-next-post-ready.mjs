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
// RECOMMEND-ONLY MODE (no --topic given): this used to have no real topic
// backlog (Automation/wp-structure/*.tsv is WordPress course/subject
// TAXONOMY, not a content backlog) — fixed by wiring in
// Automation/core/src/topic-bank-sources.mjs, the same syllabus CSV
// registry notes-factory/question-factory/update-factory's own "Topic Bank"
// UIs already browse (Automation/input sylabuss/*.csv). Candidates now come
// from the UNION of (a) every exam+subject pair actually seen in
// content-memory and (b) every exam+subject pair with backlog topics, so a
// brand-new exam with zero published notes but a real planned syllabus is
// still considered, not just pairs that already have history. This also
// fixes a real, confirmed bug: the old version always called
// buildTopicState({topic:'', ...}) — an empty topic can never retrieve RAG
// evidence, so coverage.dataAvailable was always false and exploitScore
// silently fell back to the same neutral 0.5 for every candidate,
// regardless of real coverage. Now a real unpublished backlog topic (when
// one exists for that pair) is used to build topic state, so exploitScore
// reflects actual evidence-backed coverage again.

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTopicState } from './topic-state.mjs';
import { buildEditorialGenomeWithRationale } from './editorial-genome.mjs';
import { buildEditorialBrief } from './editorial-brief.mjs';
import { selectWithExploration } from './editorial-statistics.mjs';
import { TOPIC_BANK_SOURCES } from './topic-bank-sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTENT_MEMORY_DIR = path.join(REPO_ROOT, 'Automation', 'content-memory');
const DEFAULT_OUT = path.join(REPO_ROOT, 'generated', 'editorial', 'next-post-ready.json');

// Minimal RFC4180-ish line splitter — same shape as the one duplicated in
// notes-factory/question-factory/update-factory's own Topic Bank UIs (no
// shared Node module for it exists yet; this is a 4th small copy, not a new
// pattern, consistent with how those three already each keep their own).
function splitCsvLine(line) {
  const out = []; let cur = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}
function parseTopicBankCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const subjectIdx = header.indexOf('subject');
  const topicIdx = header.indexOf('topic');
  if (subjectIdx === -1 || topicIdx === -1) return [];
  return lines.slice(1).map(line => {
    const c = splitCsvLine(line);
    return { subjectLabel: (c[subjectIdx] || '').trim(), topic: (c[topicIdx] || '').trim() };
  }).filter(r => r.topic);
}

function normalizeTopicText(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Reads every registered syllabus CSV straight off disk (this script only
 * ever runs locally/in CI, never a browser — no need for the raw.
 * githubusercontent.com fetch the browser tools use) and groups unpublished
 * candidate topics by {exam, subject} using each source's own examMatch +
 * notesSubjectMap, exactly like notes-factory's useTopicBankRow() does.
 * "Unpublished" is an approximate, normalized-text match against this
 * exam's content-memory topics — same cheap-approximation philosophy
 * notes-factory's own early-warning duplicate check already uses; the real
 * hard gate stays wherever it already lives (vCheckUniqueness).
 * @returns {Map<string, Array<{subjectLabel:string, topic:string}>>} keyed by `${exam}::${subject}`
 */
async function loadTopicBacklog(records) {
  const publishedByExam = new Map(); // exam -> Set(normalized topic text)
  for (const r of records) {
    if (!r || !r.topic) continue;
    const exam = r.exam || '';
    if (!publishedByExam.has(exam)) publishedByExam.set(exam, new Set());
    publishedByExam.get(exam).add(normalizeTopicText(r.topic));
  }

  const backlog = new Map();
  for (const source of Object.values(TOPIC_BANK_SOURCES)) {
    let text;
    try { text = await readFile(path.join(REPO_ROOT, source.csvPath), 'utf8'); }
    catch { continue; } // CSV missing/unreadable — skip this source, not a fatal error for the whole run
    const rows = parseTopicBankCsv(text);
    const publishedSet = publishedByExam.get(source.examMatch) || new Set();
    for (const row of rows) {
      if (publishedSet.has(normalizeTopicText(row.topic))) continue; // already covered for this exam
      const subject = source.notesSubjectMap[row.subjectLabel] || 'Auto-detect';
      const key = `${source.examMatch}::${subject}`;
      if (!backlog.has(key)) backlog.set(key, []);
      backlog.get(key).push({ subjectLabel: row.subjectLabel, topic: row.topic });
    }
  }
  return backlog;
}

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
  const backlog = await loadTopicBacklog(records);

  // Union of pairs seen in content-memory AND pairs with backlog topics —
  // a new exam with zero published notes but a real planned syllabus must
  // still be a candidate, not just pairs that already have history.
  const pairs = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const key = `${r.exam || ''}::${r.subject || ''}`;
    if (!pairs.has(key)) pairs.set(key, { exam: r.exam || '', subject: r.subject || '' });
  }
  for (const key of backlog.keys()) {
    if (!pairs.has(key)) {
      const [exam, subject] = key.split('::');
      pairs.set(key, { exam, subject });
    }
  }

  const candidates = [];
  for (const { exam, subject } of pairs.values()) {
    const key = `${exam}::${subject}`;
    const backlogTopics = backlog.get(key) || [];
    // Use a real unpublished backlog topic (when one exists) to build topic
    // state, so RAG evidence/coverage can actually be computed — an empty
    // topic string can never retrieve anything, which is the bug being
    // fixed here (see header comment).
    const probeTopic = backlogTopics.length ? backlogTopics[0].topic : '';
    const ts = await buildTopicState({ topic: probeTopic, subject, exam }, records);
    const timesUsed = ts.recent_structures.sampleSize;
    const exploitScore = ts.coverage.dataAvailable ? (1 - ts.coverage.averageCoverage) : 0.5; // still neutral, honestly, for a pair with no backlog topic AND no evidence signal
    candidates.push({ id: key, exam, subject, exploitScore, timesUsed, backlogRemaining: backlogTopics.length, nextTopicSuggestion: backlogTopics[0] ? backlogTopics[0].topic : null });
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
    const suggestion = recommendation ? recommendation.winner.nextTopicSuggestion : null;
    result = {
      // Still null in "recommend-only" mode's own topic field — a human (or
      // another run with --topic) makes the final call, this script never
      // silently promotes a suggestion into a commitment. nextTopicSuggestion
      // below is the real, evidence-backed candidate when the backlog has one.
      topic: null,
      subject: recommendation ? recommendation.winner.subject : null,
      exam: recommendation ? recommendation.winner.exam : null,
      recommendation,
      confidence: 0, // no topic chosen yet — see humanActionNeeded/nextTopicSuggestion
      generatedAt: new Date().toISOString(),
      mode: 'recommend-only',
      humanActionNeeded: suggestion
        ? `Real backlog candidate found: "${suggestion}" (${recommendation.winner.exam}/${recommendation.winner.subject}, ${recommendation.winner.backlogRemaining} more unpublished in this pair's syllabus). Re-run with --topic "${suggestion}" --subject "${recommendation.winner.subject}" --exam "${recommendation.winner.exam}" to get a full editorial brief for it, or pick a different one from Automation/input sylabuss/.`
        : 'No unpublished backlog topic found for the top-ranked exam+subject pair (its syllabus CSV may be fully covered, or no CSV maps to it yet — see Automation/core/src/topic-bank-sources.mjs). Re-run with --topic "..." --subject "..." --exam "..." once a specific next topic is chosen some other way.',
    };
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${outPath} (mode: ${result.mode})`);
}

main().catch(e => { console.error('generate-next-post-ready.mjs failed:', e); process.exitCode = 1; });
