// ARCHITECTURE TEST SUITE — covers items A-I from the modular prompt
// architecture spec. Run: node Automation/core/src/architecture-test-suite.mjs
// Every assertion here is checked against REAL files in this repo (the real
// exam-profiles.mjs, the real MASTER-PROMPT-ExamNotesPDF_v13.md, the real
// browser mirrors) — not a synthetic fixture, EXCEPT section C/D which
// import prompt-assembler.scalability-test.mjs's synthetic fixture on
// purpose (the real Master Prompt isn't modular enough yet to exercise true
// multi-module exclusion — see that file's header).

import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

let pass = 0, fail = 0;
function check(label, condition, detail) {
  if (condition) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  // ---------- A. EXAM PROFILE ----------
  console.log('\n=== A. EXAM PROFILE ===');
  const { getExamProfile: getExamProfileNode } = await import('./exam-profiles.mjs');
  const nodeProfile = getExamProfileNode('BPSC TRE 4');
  check('Node exam-profiles.mjs resolves BPSC TRE 4', nodeProfile.key === 'bpsc tre');
  check('BPSC TRE profile has the real (non-stale) paper-structure correction',
    nodeProfile.angle.includes('There is no separate CDP/Pedagogy paper'));

  global.window = global;
  const browserExamSrc = await readFile(path.join(REPO_ROOT, 'shared', 'exam-profiles.js'), 'utf8');
  new Function(browserExamSrc)();
  const browserProfile = window.ExamProfiles.getExamProfile('BPSC TRE 4');
  check('Browser mirror (shared/exam-profiles.js) resolves BPSC TRE 4', browserProfile.key === 'bpsc tre');
  check('Node and browser EXAM_PROFILES are byte-identical for BPSC TRE',
    JSON.stringify(nodeProfile) === JSON.stringify(browserProfile));

  const dupCheck = execFileSync('grep', ['-rln', 'const EXAM_PROFILES = {',
    'Automation/core/src/prompt-builder.mjs', 'Automation/core/src/exam-profiles.mjs',
    'long-post-factory/index.html', 'update-factory/index.html'
  ], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  check('Exactly ONE file defines `const EXAM_PROFILES = {`', dupCheck.length === 1 && dupCheck[0].endsWith('exam-profiles.mjs'),
    `found in: ${dupCheck.join(', ')}`);

  // ---------- B. FLAVOUR SELECTION ----------
  console.log('\n=== B. FLAVOUR SELECTION ===');
  const flavourSrc = await readFile(path.join(REPO_ROOT, 'shared', 'flavour-engine.js'), 'utf8');
  new Function(flavourSrc)();
  check('15 flavours registered', window.FlavourEngine.FLAVOUR_ENGINE.length === 15);
  const r1 = window.FlavourEngine.selectFlavour({ topic: 'HCF and LCM', subject: 'Maths', exam: 'BPSC TRE 4' }, []);
  check('Maths/HCF-LCM selects a Maths-appropriate flavour', ['worked-example', 'problem-first', 'rule-exception'].includes(r1.selected.id), r1.selected.id);
  const r2 = window.FlavourEngine.selectFlavour({ topic: 'Mughal Empire timeline', subject: 'History', exam: 'CTET Paper I' }, []);
  check('History topic selects a History-appropriate flavour', ['chronology-cause-effect', 'evidence-to-conclusion', 'case-to-concept'].includes(r2.selected.id), r2.selected.id);
  const recent = [{ flavour: r1.selected.id, exam: 'BPSC TRE 4', subject: 'Maths' }];
  const r3 = window.FlavourEngine.selectFlavour({ topic: 'HCF and LCM', subject: 'Maths', exam: 'BPSC TRE 4' }, recent);
  check('Repetition penalty changes the pick when the top choice was just used', r3.selected.id !== r1.selected.id, `still picked ${r3.selected.id}`);
  const goalWorked = window.FlavourEngine.FLAVOUR_ENGINE.find(f => f.id === 'worked-example').goal;
  const goalMisconception = window.FlavourEngine.FLAVOUR_ENGINE.find(f => f.id === 'misconception-first').goal;
  check('Different flavours have genuinely different teaching goals (not just labels)', goalWorked !== goalMisconception);
  const flowWorked = window.FlavourEngine.FLAVOUR_ENGINE.find(f => f.id === 'worked-example').flow;
  check('Flavour "flow" encodes a teaching sequence, not an adjective/label', flowWorked.includes('>'), flowWorked);

  // ---------- C & D. MODULE SELECTION + DEPENDENCIES (synthetic scalability fixture) ----------
  console.log('\n=== C & D. MODULE SELECTION + DEPENDENCIES ===');
  try {
    execFileSync('node', ['Automation/core/src/prompt-assembler.scalability-test.mjs'], { cwd: REPO_ROOT, stdio: 'pipe' });
    check('Scalability test suite (6 cases: positive+negative selection, tool isolation, dependency resolution)', true);
  } catch (e) {
    check('Scalability test suite (6 cases: positive+negative selection, tool isolation, dependency resolution)', false, e.stdout ? e.stdout.toString().split('\n').filter(l => l.startsWith('FAIL')).join('; ') : e.message);
  }

  // ---------- E. RUNTIME PROMPT COMPILATION (real v13.md) ----------
  console.log('\n=== E. RUNTIME PROMPT COMPILATION (real Master Prompt) ===');
  const { assembleRuntimePrompt, levelKeyFromLabel } = await import('./prompt-assembler.mjs');
  const masterRaw = await readFile(path.join(REPO_ROOT, 'MASTER-PROMPT-ExamNotesPDF_v13.md'), 'utf8');
  const master = masterRaw
    .replaceAll('{{REFERENCE_SOURCES_BLOCK}}', '')
    .replaceAll('{{TEACHING_LEVEL}}', 'Primary (Class 1–5)')
    .replaceAll('{{FLAVOUR_ENGINE_BLOCK}}', '[flavour block]');
  const levelKey = levelKeyFromLabel('Primary (Class 1–5)');
  const mathsResult = assembleRuntimePrompt(master, { tool: 'notes', subject: 'Maths', levelKey });
  const structureOnly = mathsResult.prompt.slice(mathsResult.prompt.indexOf('## STRUCTURE'), mathsResult.prompt.indexOf('## PREMIUM HINT'));
  check('Runtime prompt is smaller than the Master Prompt', mathsResult.prompt.length < master.length,
    `${master.length} -> ${mathsResult.prompt.length}`);
  check('STRUCTURE section keeps ONLY the Maths bullet', structureOnly.includes('**Maths:**') && !structureOnly.includes('**History:**') && !structureOnly.includes('**CDP/Pedagogy:**'));
  check('No orphaned continuation line from a trimmed bullet', !structureOnly.includes('classroom application.'));
  check('TEACHING LEVEL section keeps ONLY the Primary bullet', mathsResult.prompt.includes('Primary (Class 1–5) exams:') && !mathsResult.prompt.includes('Senior Secondary (Class 11–12) rigor'));
  check('Old VARIETY ENGINE rotation prose is gone from the runtime prompt',
    !/Voice\/persona this time.*seed%5/.test(mathsResult.prompt) && !/Example domain.*seed%6/.test(mathsResult.prompt));
  check('Old VARIETY ENGINE rotation prose is gone from the SOURCE file itself', !masterRaw.includes('VARIETY ENGINE'));
  check('EDITORIAL FLAVOUR section is present and is the stated primary mechanism', masterRaw.includes('## EDITORIAL FLAVOUR'));

  // ---------- F. TOOL CONTRACT SELECTION ----------
  console.log('\n=== F. TOOL CONTRACT SELECTION ===');
  const forNotes = assembleRuntimePrompt(master, { tool: 'notes', subject: 'Maths', levelKey });
  check('tool:notes INCLUDES the HTML/card contract module', forNotes.selectedModuleIds.includes('80_NOTES/html'));
  const forLongPost = assembleRuntimePrompt(master, { tool: 'long-post', subject: 'Maths', levelKey });
  check('tool:long-post EXCLUDES the Notes-only HTML/card contract module', forLongPost.excludedModuleIds.includes('80_NOTES/html'));
  const toolUsage = execFileSync('grep', ['-c', 'window.PromptAssembler',
    'notes-factory/index.html', 'long-post-factory/index.html', 'update-factory/index.html'
  ], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().split('\n');
  const counts = toolUsage.map(l => Number(l.split(':').pop()));
  check('All 3 browser tools genuinely call window.PromptAssembler (not just notes-factory)', counts.every(c => c > 0), toolUsage.join(' | '));

  // ---------- G. CONTENT MEMORY ----------
  console.log('\n=== G. CONTENT MEMORY ===');
  const cmFiles = (await readdir(path.join(REPO_ROOT, 'Automation', 'content-memory'))).filter(f => f.endsWith('.json'));
  check('Content Memory has backfilled records', cmFiles.length > 0, `${cmFiles.length} files`);
  const sample = JSON.parse(await readFile(path.join(REPO_ROOT, 'Automation', 'content-memory', cmFiles[0]), 'utf8'));
  check('Backfilled records are marked derived:true (historical, lower-confidence)', sample.derived === true);
  check('Backfilled records do NOT fabricate a pedagogical_strategy/flavour from headings', sample.pedagogical_strategy === 'unknown' && sample.flavour === null);
  const cmSchemaInPrompt = (await readFile(path.join(REPO_ROOT, 'notes-factory', 'index.html'), 'utf8')).includes('CONTENT_MEMORY_JSON');
  check('Generation-time Content Memory schema is wired into the live prompt contract', cmSchemaInPrompt);

  // ---------- H. SIMILARITY ----------
  console.log('\n=== H. SIMILARITY ===');
  const { findClosestArticles } = await import('./similarity-check.mjs');
  const closest = findClosestArticles('the quick brown fox jumps over the lazy dog many times today', [
    { slug: 'identical', bodyHtml: 'the quick brown fox jumps over the lazy dog many times today' },
    { slug: 'unrelated', bodyHtml: 'भारत की राजधानी दिल्ली है और यह एक बड़ा शहर है' },
  ]);
  check('Identical text scores near-1.0 similarity', closest[0].slug === 'identical' && closest[0].similarity > 0.9, JSON.stringify(closest));
  check('Unrelated text scores near-0 similarity', closest.find(c => c.slug === 'unrelated').similarity < 0.05);
  const workflowWiring = execFileSync('grep', ['-l', 'similarity-check.mjs',
    '.github/workflows/pub-note.yml', '.github/workflows/pub-lpost.yml'
  ], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().split('\n');
  check('Both publish workflows call the similarity checker', workflowWiring.length === 2);

  // ---------- I. OUTPUT VALIDATION ----------
  console.log('\n=== I. OUTPUT VALIDATION ===');
  const { validateBundle } = await import('./validate-output.mjs');
  const broken = {
    seo: { focusKeyword: 'x', seoTitle: '', slug: 'y', metaDescription: 'z', h1: 'h' },
    bodyHtml: '<div id="a">t</div><div id="a">d</div><a href="#missing">l</a><a href="#">b</a><script>alert(1)</script><sup id="cite-1">[1]</sup>',
    publisherNotes: 'this is a long enough publisher note to pass the thin-notes check',
  };
  const brokenResult = validateBundle(broken);
  check('Validator FAILS a genuinely broken bundle', !brokenResult.pass);
  check('Validator catches duplicate ids', brokenResult.errors.some(e => e.code === 'DUPLICATE_ID'));
  check('Validator catches broken TOC anchors', brokenResult.errors.some(e => e.code === 'BROKEN_ANCHOR'));
  check('Validator catches bare href="#"', brokenResult.errors.some(e => e.code === 'BARE_HASH_HREF'));
  check('Validator catches orphan citations', brokenResult.errors.some(e => e.code === 'ORPHAN_CITATION'));
  check('Validator catches <script> tags', brokenResult.errors.some(e => e.code === 'SCRIPT_TAG'));

  const realNote = JSON.parse(await readFile(path.join(REPO_ROOT, 'published-notes', 'bpsc-tre-notes-2026.json'), 'utf8'));
  const realResult = validateBundle(realNote);
  check('Validator PASSES a genuinely clean real published note (no false positive)', realResult.pass, JSON.stringify(realResult.errors));

  // ---------- SUMMARY ----------
  console.log(`\n${'='.repeat(50)}\nTOTAL: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch(e => { console.error('SUITE CRASHED:', e); process.exitCode = 1; });
