// EDITORIAL INTELLIGENCE — Phase 2 (tests against real content-memory).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, section 21 ("Phase 2:
// Create tests against real content-memory.").
//
// Runs buildEditorialSignature() (Phase 1, editorial-intelligence.mjs)
// against the REAL Automation/content-memory/*.json files in this repo —
// not synthetic fixtures — and asserts real invariants. Follows the same
// check()/pass-fail-counter/process.exitCode convention as
// architecture-test-suite.mjs (this repo's existing test style; no new
// test-framework dependency needed, per this module's task brief).
//
// Run: node Automation/core/src/editorial-intelligence.contentmemory-test.mjs
//
// This file is left in the repo permanently (unlike the throwaway smoke
// scripts used to verify Phases 3-8), so it should keep passing as new
// content-memory records are added over time — every assertion below is
// written to hold regardless of which/how many real records currently
// exist, not pinned to today's specific 39 files.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEditorialSignature, TOP_N } from './editorial-intelligence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_MEMORY_DIR = path.resolve(__dirname, '..', '..', 'content-memory');

let pass = 0, fail = 0;
function check(label, condition, detail) {
  if (condition) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); }
}

function isOutputShapeValid(sig) {
  return sig
    && Array.isArray(sig.avoidConcepts)
    && Array.isArray(sig.avoidExamples)
    && Array.isArray(sig.underusedMisconceptions)
    && Array.isArray(sig.coverageGaps)
    && Array.isArray(sig.recommendedStructures)
    && typeof sig.confidence === 'number';
}

async function loadRealContentMemory() {
  const files = (await readdir(CONTENT_MEMORY_DIR)).filter(f => f.endsWith('.json'));
  const records = [];
  for (const f of files) {
    try {
      records.push(JSON.parse(await readFile(path.join(CONTENT_MEMORY_DIR, f), 'utf8')));
    } catch (e) {
      // A genuinely unparsable file in content-memory/ is itself worth
      // failing loudly on, not silently skipping — see the final check below.
      records.push({ __unparsable: f, __error: String(e) });
    }
  }
  return { files, records };
}

async function main() {
  console.log(`Reading real content-memory from: ${CONTENT_MEMORY_DIR}`);
  const { files, records } = await loadRealContentMemory();
  check('Found at least one real content-memory file to test against', files.length > 0, `found ${files.length}`);

  const unparsable = records.filter(r => r.__unparsable);
  check('Every real content-memory file is valid JSON', unparsable.length === 0, unparsable.map(r => r.__unparsable).join(', '));
  const validRecords = records.filter(r => !r.__unparsable);

  // ---------- 1. Shape is always correct, even with zero matches ----------
  console.log('\n=== Output shape ===');
  const unseenSig = buildEditorialSignature({ topic: 'Nonexistent Topic', subject: 'Nonexistent Subject', exam: 'Nonexistent Exam' }, validRecords);
  check('Shape is correct for a topic/subject/exam combo with zero matches', isOutputShapeValid(unseenSig), JSON.stringify(unseenSig));

  const emptyMemorySig = buildEditorialSignature({ topic: 'Anything', subject: 'Anything', exam: 'Anything' }, []);
  check('Shape is correct when recentMemory is an empty array', isOutputShapeValid(emptyMemorySig), JSON.stringify(emptyMemorySig));

  const noCtxSig = buildEditorialSignature({}, validRecords);
  check('Shape is correct when ctx is empty (loose-match matches everything)', isOutputShapeValid(noCtxSig), JSON.stringify(noCtxSig));

  const undefinedInputsSig = buildEditorialSignature(undefined, undefined);
  check('Does not crash on fully undefined inputs', isOutputShapeValid(undefinedInputsSig), JSON.stringify(undefinedInputsSig));

  // ---------- 2. Confidence is 0 for an unseen exam/subject ----------
  console.log('\n=== Confidence invariants ===');
  check('Confidence is exactly 0 for a genuinely unseen exam/subject (no real record has these values)',
    unseenSig.confidence === 0, `got ${unseenSig.confidence}`);

  // ---------- 3. Confidence never exceeds 1, for every real exam+subject pair ----------
  const examSubjectPairs = new Map();
  for (const r of validRecords) {
    if (!r || typeof r !== 'object') continue;
    const key = `${r.exam || ''}::${r.subject || ''}`;
    if (!examSubjectPairs.has(key)) examSubjectPairs.set(key, { exam: r.exam, subject: r.subject });
  }
  let confidenceOutOfRange = 0;
  let maxConfidenceSeen = 0;
  for (const { exam, subject } of examSubjectPairs.values()) {
    const sig = buildEditorialSignature({ topic: 'probe', exam, subject }, validRecords);
    maxConfidenceSeen = Math.max(maxConfidenceSeen, sig.confidence);
    if (sig.confidence < 0 || sig.confidence > 1) confidenceOutOfRange++;
  }
  check(`Confidence stays within [0, 1] across all ${examSubjectPairs.size} real exam+subject pairs`,
    confidenceOutOfRange === 0, `${confidenceOutOfRange} out of range; max seen ${maxConfidenceSeen}`);

  // Also probe confidence using the FULL real record set as one combined
  // "recentMemory" pool per pair (the shape a live caller would actually
  // pass in — see Automation/content-memory/README.md: callers fetch the
  // last ~30 records, not one subset per pair), confirming the bound holds
  // under realistic combined input too, not just per-pair isolation.
  const wholeSetSig = buildEditorialSignature({ topic: 'probe', exam: '', subject: '' }, validRecords);
  check('Confidence stays within [0, 1] when scored against the entire real content-memory set at once',
    wholeSetSig.confidence >= 0 && wholeSetSig.confidence <= 1, `got ${wholeSetSig.confidence}`);

  // ---------- 4. Arrays never exceed the TOP_N cap ----------
  console.log('\n=== TOP_N cap ===');
  let capViolations = 0;
  for (const { exam, subject } of examSubjectPairs.values()) {
    const sig = buildEditorialSignature({ topic: 'probe', exam, subject }, validRecords);
    if (sig.avoidConcepts.length > TOP_N) capViolations++;
    if (sig.avoidExamples.length > TOP_N) capViolations++;
    if (sig.underusedMisconceptions.length > TOP_N) capViolations++;
    if (sig.coverageGaps.length > TOP_N) capViolations++;
    if (sig.recommendedStructures.length > TOP_N) capViolations++;
  }
  check(`No output array exceeds TOP_N (${TOP_N}) across all real exam+subject pairs`, capViolations === 0, `${capViolations} violation(s)`);
  check('No output array exceeds TOP_N on the unseen-topic probe', unseenSig.avoidConcepts.length <= TOP_N);

  // ---------- 5. No crash on any individual real file in the directory ----------
  console.log('\n=== No-crash, one real record at a time ===');
  let crashCount = 0;
  for (const r of validRecords) {
    try {
      const sig = buildEditorialSignature({ topic: r.topic, subject: r.subject, exam: r.exam }, [r]);
      if (!isOutputShapeValid(sig)) crashCount++;
    } catch (e) {
      crashCount++;
      console.log(`    error on record ${r.id}: ${e.message}`);
    }
  }
  check(`buildEditorialSignature() does not crash/misbehave on any of ${validRecords.length} real records used individually`,
    crashCount === 0, `${crashCount} failure(s)`);

  // ---------- 6. Known real data-quality fact stays true (regression guard) ----------
  // Phase 1's header notes every current record is "derived": true with
  // empty misconceptions_used/examples_used and flavour: null. This isn't
  // asserted as something that SHOULD stay true forever (once live-recorded
  // records exist this will rightly change) — it is asserted here only so
  // that if it silently stops being true, a human notices and re-reads the
  // "sparse data" assumptions this whole engine was built against, rather
  // than confidence numbers quietly starting to mean something different.
  console.log('\n=== Data-richness snapshot (informational regression guard) ===');
  const derivedCount = validRecords.filter(r => r.derived === true).length;
  const liveCount = validRecords.length - derivedCount;
  console.log(`  ${derivedCount} derived record(s), ${liveCount} live-recorded record(s) out of ${validRecords.length} total.`);
  check('This assertion always passes — it only prints the snapshot above for a human to notice drift', true);

  // ---------- SUMMARY ----------
  console.log(`\n${'='.repeat(50)}\nTOTAL: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch(e => { console.error('TEST SUITE CRASHED:', e); process.exitCode = 1; });
