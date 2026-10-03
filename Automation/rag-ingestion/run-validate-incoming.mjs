// RAG INGESTION — lifecycle runner (RAG_INGESTION_ENGINE.md section 3).
//
// Scans rag/incoming/, validates every package file with
// rag-package-validator.mjs, and moves each one to rag/approved/ or
// rag/rejected/ accordingly:
//
//   rag/incoming/   -- uploaded, not yet checked
//   rag/approved/   -- passed validation (0 errors); eligible for indexing
//   rag/rejected/   -- failed validation; kept alongside a full validation
//                      report for debugging, per RAG_INGESTION_ENGINE.md
//                      section 3: "Keep rejected files or validation
//                      reports when useful for debugging."
//
// This script is the local-script equivalent of the "VALIDATE" job in the
// parallel GitHub Actions design (see GITHUB_ACTIONS_DESIGN.md — a draft,
// not a real workflow file; see that doc and the repo-level task boundary
// for why no .yml is committed here).
//
// Pure file I/O, no network, no API key. Safe to re-run: files already
// moved out of rag/incoming/ are simply not seen again.
//
// Usage:
//   node run-validate-incoming.mjs

import { readdirSync, statSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackageFile } from './rag-package-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAG_ROOT = join(__dirname, '..', '..', 'rag');
const INCOMING_DIR = join(RAG_ROOT, 'incoming');
const APPROVED_DIR = join(RAG_ROOT, 'approved');
const REJECTED_DIR = join(RAG_ROOT, 'rejected');

function listCandidateFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name !== '.gitkeep' && !name.endsWith('.rejection.json'))
    .map(name => join(dir, name))
    .filter(p => statSync(p).isFile());
}

function main() {
  const files = listCandidateFiles(INCOMING_DIR);
  if (files.length === 0) {
    console.log('rag/incoming/ has no package files to validate (nothing but .gitkeep, or already processed).');
    return { approved: [], rejected: [] };
  }

  const approved = [];
  const rejected = [];

  for (const filePath of files) {
    const name = basename(filePath);
    const result = validatePackageFile(filePath);
    const destDir = result.status === 'approved' ? APPROVED_DIR : REJECTED_DIR;
    const destPath = join(destDir, name);

    renameSync(filePath, destPath);

    if (result.status === 'approved') {
      approved.push({ name, result });
      console.log(`APPROVED  ${name}  (${result.chunks} chunks, ${result.warnings.length} warning(s)) -> rag/approved/${name}`);
      if (result.warnings.length) {
        for (const w of result.warnings) console.log(`    warning: ${w}`);
      }
    } else {
      rejected.push({ name, result });
      const reportPath = join(REJECTED_DIR, `${name}.rejection.json`);
      writeFileSync(reportPath, JSON.stringify(result, null, 2));
      console.log(`REJECTED  ${name}  (${result.errors.length} error(s)) -> rag/rejected/${name} + ${basename(reportPath)}`);
      for (const e of result.errors) console.log(`    error: ${e}`);
    }
  }

  console.log(`\nDone: ${approved.length} approved, ${rejected.length} rejected.`);
  return { approved, rejected };
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const { rejected } = main();
  // Non-zero exit when anything was rejected — this is what lets a future
  // CI VALIDATE job (see GITHUB_ACTIONS_DESIGN.md) fail the check on a bad
  // upload using a plain exit-code check, no extra wrapper logic needed.
  if (rejected.length > 0) process.exitCode = 1;
}

export { main as runValidateIncoming };
