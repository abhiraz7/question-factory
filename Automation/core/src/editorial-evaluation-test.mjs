// EDITORIAL INTELLIGENCE — tests for the evaluation layer (editorial-evaluation.mjs).
// Same check()/pass-fail-counter/process.exitCode convention as
// architecture-test-suite.mjs and editorial-intelligence.contentmemory-test.mjs.
//
// Run: node Automation/core/src/editorial-evaluation-test.mjs

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  jaccardOverlap, scoreOverlaps, findRepeatedCardSentences, scoreStructuralSimilarity,
  scoreLexicalSimilarity, scoreQuality, scoreCoverage, scoreNovelty, qualityDrift, evaluateCandidate,
} from './editorial-evaluation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_MEMORY_DIR = path.resolve(__dirname, '..', '..', 'content-memory');

let pass = 0, fail = 0;
function check(label, condition, detail) {
  if (condition) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); }
}

async function loadRealContentMemory() {
  const files = (await readdir(CONTENT_MEMORY_DIR)).filter(f => f.endsWith('.json'));
  const records = [];
  for (const f of files) {
    try { records.push(JSON.parse(await readFile(path.join(CONTENT_MEMORY_DIR, f), 'utf8'))); }
    catch { /* skip unparsable — covered by editorial-intelligence.contentmemory-test.mjs already */ }
  }
  return records;
}

async function main() {
  // ---------- 1. jaccardOverlap ----------
  console.log('=== jaccardOverlap ====');
  check('Identical sets -> 1', jaccardOverlap(['a', 'b'], ['a', 'b']) === 1);
  check('Disjoint sets -> 0', jaccardOverlap(['a', 'b'], ['c', 'd']) === 0);
  check('Empty either side -> 0 (not NaN)', jaccardOverlap([], ['a']) === 0 && jaccardOverlap(['a'], []) === 0);
  check('Case/whitespace-insensitive', jaccardOverlap([' A ', 'b'], ['a', 'B']) === 1);
  check('Partial overlap in (0,1)', jaccardOverlap(['a', 'b', 'c'], ['b', 'c', 'd']) > 0 && jaccardOverlap(['a', 'b', 'c'], ['b', 'c', 'd']) < 1);

  // ---------- 2. scoreOverlaps shape ----------
  console.log('\n=== scoreOverlaps ====');
  const cm = { concepts_taught: ['x'], examples_used: ['y'], misconceptions_used: ['z'], question_types: ['mcq'], card_sentences_used: ['s1'] };
  const overlaps = scoreOverlaps(cm, [{ concepts_taught: ['x'] }]);
  check('Returns all 5 overlap fields as numbers in [0,1]',
    ['conceptOverlap', 'exampleOverlap', 'misconceptionOverlap', 'questionTypeOverlap', 'cardSentenceOverlap']
      .every(k => typeof overlaps[k] === 'number' && overlaps[k] >= 0 && overlaps[k] <= 1),
    JSON.stringify(overlaps));
  check('Does not crash on empty historical list', (() => { try { scoreOverlaps(cm, []); return true; } catch { return false; } })());

  // ---------- 3. findRepeatedCardSentences ----------
  console.log('\n=== findRepeatedCardSentences ====');
  const cardBody = '<div style="border-left:4px solid #000"><p>Shared sentence here.</p></div><div style="border-left:4px solid #000"><p>Unique one.</p></div>';
  const repeated = findRepeatedCardSentences(cardBody, [{ card_sentences_used: ['Shared sentence here.'] }]);
  check('Finds the one genuinely-shared sentence, not the unique one',
    repeated.length === 1 && repeated[0] === 'Shared sentence here.', JSON.stringify(repeated));
  check('Returns [] when candidate has no card sentences at all', findRepeatedCardSentences('<p>plain text</p>', [{ card_sentences_used: ['x'] }]).length === 0);
  check('Accepts raw bodyHtml historical items too (not just pre-extracted arrays)',
    findRepeatedCardSentences(cardBody, [{ bodyHtml: cardBody }]).length === 2);

  // ---------- 4. scoreStructuralSimilarity ----------
  console.log('\n=== scoreStructuralSimilarity ====');
  const noHistory = scoreStructuralSimilarity(['intro', 'body'], []);
  check('dataAvailable-style null when there is no historical shape data at all', noHistory.divergence === null);
  const sameShape = scoreStructuralSimilarity(['intro', 'body'], [{ article_shape: ['intro', 'body'] }, { article_shape: ['intro', 'body'] }]);
  check('Identical shape vs. identical history -> divergence near 0', sameShape.divergence !== null && sameShape.divergence < 0.1, JSON.stringify(sameShape));

  // ---------- 5. scoreLexicalSimilarity ----------
  console.log('\n=== scoreLexicalSimilarity ====');
  const lex = scoreLexicalSimilarity('<p>the quick brown fox jumps over the lazy dog today</p>', [{ slug: 'same', bodyHtml: '<p>the quick brown fox jumps over the lazy dog today</p>' }]);
  check('Near-identical bodies score high similarity', lex.maxSimilarity > 0.5, JSON.stringify(lex));
  check('No historical bodies -> closest is empty, similarity 0', scoreLexicalSimilarity('<p>x</p>', []).maxSimilarity === 0);

  // ---------- 6. scoreQuality ----------
  console.log('\n=== scoreQuality ====');
  const goodBundle = {
    seo: { focusKeyword: 'k', seoTitle: 's', slug: 'sl', metaDescription: 'm', h1: 'h' },
    bodyHtml: '<p>' + 'word '.repeat(3200) + '</p>' + '<div id="ad-slot-1"></div><div id="ad-slot-2"></div><div id="ad-slot-3"></div>',
    publisherNotes: 'Enough notes here to pass the thin-notes check comfortably.',
    contentMemory: { concepts_taught: [], misconceptions_used: [], examples_used: [], pedagogical_strategy: 'x', article_shape: [], question_types: [], sources: [], flavour: 'f' },
  };
  const q = scoreQuality(goodBundle);
  check('A clean, correctly-sized, correctly-ad-slotted bundle scores high', q.score > 0.8, JSON.stringify(q));
  const badBundle = { seo: {}, bodyHtml: '<script>bad</script><p>short</p>' };
  const qBad = scoreQuality(badBundle);
  check('A broken bundle (script tag, missing SEO, tiny body) scores low', qBad.score < 0.5, JSON.stringify(qBad));
  check('AI-cliché words reduce the score', scoreQuality({ seo: goodBundle.seo, bodyHtml: goodBundle.bodyHtml + ' this is a comprehensive guide that will delve into a holistic seamless game-changer' }).score < q.score);

  // ---------- 7. scoreCoverage ----------
  console.log('\n=== scoreCoverage ====');
  check('No importantConcepts -> honest dataAvailable:false (same convention as topic-state.mjs)', scoreCoverage([], []).dataAvailable === false);
  check('With importantConcepts -> dataAvailable:true and a numeric averageCoverage', (() => {
    const r = scoreCoverage(['concept A'], [{ concepts_taught: ['concept A'] }, { concepts_taught: ['concept A'] }]);
    return r.dataAvailable === true && typeof r.averageCoverage === 'number';
  })());

  // ---------- 8. scoreNovelty ----------
  console.log('\n=== scoreNovelty ====');
  check('All-zero overlaps -> novelty 1', scoreNovelty({}) === 1);
  check('High overlaps across the board -> low novelty', scoreNovelty({ conceptOverlap: 1, exampleOverlap: 1, misconceptionOverlap: 1, questionTypeOverlap: 1, cardSentenceOverlap: 1, lexicalSimilarity: 1 }) < 0.1);

  // ---------- 9. qualityDrift ----------
  console.log('\n=== qualityDrift ====');
  check('Fewer than 2 scores -> dataAvailable:false', qualityDrift([0.5]).dataAvailable === false);
  check('Rising scores -> positive slope', qualityDrift([0.5, 0.6, 0.7, 0.8]).slope > 0);
  check('Falling scores -> negative slope', qualityDrift([0.9, 0.7, 0.5, 0.3]).slope < 0);

  // ---------- 10. evaluateCandidate end-to-end, against REAL content-memory ----------
  console.log('\n=== evaluateCandidate() against real content-memory (no crash, correct shape) ===');
  const realRecords = await loadRealContentMemory();
  check('Found real content-memory records to test against', realRecords.length > 0, `found ${realRecords.length}`);
  let crashes = 0;
  for (const r of realRecords.slice(0, 10)) {
    try {
      const report = evaluateCandidate(
        { seo: {}, bodyHtml: '<p>probe body</p>', contentMemory: r },
        { historicalRecords: realRecords }
      );
      if (!report.overlaps || !report.quality || typeof report.novelty !== 'number') crashes++;
    } catch (e) { crashes++; console.log(`    error: ${e.message}`); }
  }
  check('evaluateCandidate() does not crash on real records, output shape is correct', crashes === 0, `${crashes} failure(s)`);

  // ---------- SUMMARY ----------
  console.log(`\n${'='.repeat(50)}\nTOTAL: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
  process.exitCode = fail === 0 ? 0 : 1;
}
main();
