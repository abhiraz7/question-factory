// Canonical registry of syllabus CSV sources — "the topic bank". Every
// pipeline that browses or cross-references planned topics reads from THIS
// file (via the generated browser mirror, shared/topic-bank-sources.js, or
// directly for Node tooling) instead of hand-maintaining its own copy.
//
// Before this file existed, notes-factory/index.html, question-factory/
// index.html and reporting/index.html each hardcoded their own separate copy
// of this same {label, url, subjectMap} data — and they had already drifted
// (question-factory's DSSSB entries had no fallback for unmapped subjects,
// reporting's coverage list didn't match either browser tool's key names).
// Add a new exam/CSV here once; every consumer picks it up automatically
// after shared/topic-bank-sources.js is regenerated (see
// gen-topic-bank-sources-browser.mjs) — never hand-edit a second copy.
//
// Field meanings:
//   label          - human-readable name shown in the "Exam source" picker.
//   url            - raw.githubusercontent.com URL the browser tools fetch
//                    the CSV from (works from any origin, incl. GitHub Pages).
//   csvPath        - the same file, as a repo-relative path. reporting/
//                    index.html fetches this directly (it's already served
//                    from the same origin) instead of going through GitHub.
//   examMatch      - the exam label a published note/long-post's own
//                    `examType` field must equal for it to count as
//                    "published" against this syllabus. Several DSSSB
//                    sources share "DSSSB" because a published DSSSB note
//                    doesn't record which DSSSB sub-exam it targets — a
//                    note's topic text is matched against each DSSSB
//                    checklist independently instead.
//   examChkFilter  - substring matched against notes-factory's EXAM_TYPES
//                    checkbox values to auto-check the right one(s). Equal
//                    to examMatch in every case so far; kept as a separate
//                    name because it's a UI concept, not a data-matching one.
//   fallbackLabel  - a more specific exam name than examMatch, used only by
//                    question-factory's Custom-preset fallback text (e.g.
//                    "DSSSB TGT Computer Science - Special Education")
//                    when a subject has no bilingual preset to map to.
//   notesSubjectMap    - raw CSV "Subject" value -> notes-factory's Subject
//                        <select> option value. Subjects with no entry here
//                        fall back to "Auto-detect".
//   questionPresetMap  - raw CSV "Subject" value -> question-factory's
//                        bilingual PRESET key. Subjects with no entry here
//                        fall back to Custom + fallbackLabel above.
export const TOPIC_BANK_SOURCES = {
  'bpsc-tre-4': {
    label: 'BPSC TRE 4 — Primary Teacher',
    url: 'https://raw.githubusercontent.com/bugignore/question-factory/main/Automation/input%20sylabuss/BPSC-TRE-4-Primary-Teacher-SEO-Topics-Hindi-v2.csv',
    csvPath: 'Automation/input sylabuss/BPSC-TRE-4-Primary-Teacher-SEO-Topics-Hindi-v2.csv',
    examMatch: 'BPSC TRE',
    examChkFilter: 'BPSC TRE',
    fallbackLabel: 'BPSC TRE 4',
    notesSubjectMap: { 'हिंदी': 'Hindi', 'अंग्रेजी': 'English', 'गणित': 'Maths', 'विज्ञान': 'Science', 'इतिहास': 'History', 'भूगोल': 'Geography' },
    questionPresetMap: { 'हिंदी': 'hindi', 'अंग्रेजी': 'english', 'गणित': 'math', 'विज्ञान': 'gs', 'इतिहास': 'gs', 'भूगोल': 'gs' },
  },
  'dsssb-tgt-cs': {
    label: 'DSSSB 2026 — TGT Computer Science',
    url: 'https://raw.githubusercontent.com/bugignore/question-factory/main/Automation/input%20sylabuss/DSSSB-2026-TGT-Computer-Science-Topics.csv',
    csvPath: 'Automation/input sylabuss/DSSSB-2026-TGT-Computer-Science-Topics.csv',
    examMatch: 'DSSSB',
    examChkFilter: 'DSSSB',
    fallbackLabel: 'DSSSB TGT Computer Science',
    notesSubjectMap: { 'Hindi': 'Hindi', 'English': 'English' },
    questionPresetMap: { 'Hindi': 'hindi', 'English': 'english' },
  },
  'dsssb-domestic-science': {
    label: 'DSSSB 2026 — Domestic Science Teacher',
    url: 'https://raw.githubusercontent.com/bugignore/question-factory/main/Automation/input%20sylabuss/DSSSB-2026-Domestic-Science-Teacher-Topics.csv',
    csvPath: 'Automation/input sylabuss/DSSSB-2026-Domestic-Science-Teacher-Topics.csv',
    examMatch: 'DSSSB',
    examChkFilter: 'DSSSB',
    fallbackLabel: 'DSSSB Domestic Science',
    notesSubjectMap: { 'Hindi': 'Hindi', 'English': 'English' },
    questionPresetMap: { 'Hindi': 'hindi', 'English': 'english' },
  },
  'dsssb-tgt-special-ed': {
    label: 'DSSSB 2026 — TGT Special Education Teacher',
    url: 'https://raw.githubusercontent.com/bugignore/question-factory/main/Automation/input%20sylabuss/DSSSB-2026-TGT-Special-Education-Teacher-Topics.csv',
    csvPath: 'Automation/input sylabuss/DSSSB-2026-TGT-Special-Education-Teacher-Topics.csv',
    examMatch: 'DSSSB',
    examChkFilter: 'DSSSB',
    fallbackLabel: 'DSSSB TGT Special Education',
    notesSubjectMap: { 'Hindi': 'Hindi', 'English': 'English' },
    questionPresetMap: { 'Hindi': 'hindi', 'English': 'english' },
  },
  'dsssb-special-educator-primary': {
    label: 'DSSSB 2026 — Special Educator (Primary)',
    url: 'https://raw.githubusercontent.com/bugignore/question-factory/main/Automation/input%20sylabuss/DSSSB-2026-Special-Educator-Primary-Topics.csv',
    csvPath: 'Automation/input sylabuss/DSSSB-2026-Special-Educator-Primary-Topics.csv',
    examMatch: 'DSSSB',
    examChkFilter: 'DSSSB',
    fallbackLabel: 'DSSSB Special Educator',
    notesSubjectMap: { 'Hindi': 'Hindi', 'English': 'English' },
    questionPresetMap: { 'Hindi': 'hindi', 'English': 'english' },
  },
};
