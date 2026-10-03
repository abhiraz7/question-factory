// RAG INGESTION — index builder (RAG_INGESTION_ENGINE.md sections 4 "Atomic
// indexing", 6, 8 "RAG retrieval", 10 "RAG versioning").
//
// Reads every approved package from rag/approved/, builds a BM25-compatible
// index over their chunks, and atomically publishes it to rag/index/index.json.
//
// --- Index-shape decision (read this before changing the doc shape) ---
//
// This writes a SIBLING index, not a merge into
// Automation/ncert-knowledge-base/index.json. The doc-array/df/avgDocLen/
// docCount shape is IDENTICAL to that file (see rag/index/retrieve.mjs,
// which is structurally the same BM25 reader as
// Automation/ncert-knowledge-base/retrieve.mjs, just pointed at this file
// and extended with a couple of extra filter dimensions). That satisfies
// RAG_INGESTION_ENGINE.md section 8 ("Do not create an incompatible second
// retrieval engine") without requiring either corpus to be merged:
//
//   - Reasons NOT to merge into the live NCERT index.json:
//     1. That file is a committed, working artifact other automation
//        already depends on (build-index.mjs / rebuild-corpus.mjs own its
//        lifecycle). This task's hard boundaries forbid editing existing
//        live files — index.json is generated, not hand-edited, but it is
//        still "live" in the sense that a bug in a NEW pipeline (this one)
//        must never be able to corrupt an EXISTING pipeline's output.
//     2. NCERT docs are whole-chapter granularity; RAG docs are
//        human/ChatGPT-curated chunk granularity. Mixing the two
//        granularities in one BM25 corpus would skew document-length
//        normalization (the `B`/avgDocLen terms in BM25) for both halves.
//     3. Versioning (section 10: index_version/schema_version/sources/
//        chunks/built_at) is RAG-package-specific. The NCERT index has no
//        such fields today; bolting them on would be an unrelated schema
//        change to someone else's pipeline, not something this task owns.
//
//   - Reason it's still "compatible, not divergent": retrieve.mjs's actual
//     logic (bm25Score, tokenize, the docs/df/avgDocLen/docCount reads) does
//     not care what EXTRA fields a doc carries, or what extra top-level keys
//     (index_version etc.) sit beside docs/df/avgDocLen/docCount — it only
//     ever reads those four. A future unification (one retrieve() that
//     transparently searches both corpora) could load both index.json files
//     and concatenate their `docs` arrays with zero format conversion. That
//     unification is NOT built here (it would cross into Editorial
//     Intelligence's retrieval-consumption territory, and section 7 of this
//     spec is explicitly deferred) — but the shape choice keeps it a cheap,
//     mechanical future step rather than a rewrite.
//
// Usage:
//   node build-rag-index.mjs

import { readdirSync, statSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tokenize } from '../core/src/build-index.mjs';
import { validatePackage } from './rag-package-validator.mjs';
import { atomicPublishJson } from './atomic-publish.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAG_ROOT = join(__dirname, '..', '..', 'rag');
const APPROVED_DIR = join(RAG_ROOT, 'approved');
const INDEX_DIR = join(RAG_ROOT, 'index');
const INDEX_PATH = join(INDEX_DIR, 'index.json');

const SCHEMA_VERSION = '1';
const INDEX_FORMAT_VERSION = 1; // bump this if the doc/index shape itself changes incompatibly

function listApprovedPackageFiles() {
  if (!existsSync(APPROVED_DIR)) return [];
  return readdirSync(APPROVED_DIR)
    .filter(name => name !== '.gitkeep' && (name.endsWith('.json') || name.endsWith('.jsonl')))
    .map(name => join(APPROVED_DIR, name))
    .filter(p => statSync(p).isFile());
}

/**
 * Re-validates every approved package at build time (defense in depth: a
 * package could have been hand-edited or dropped straight into approved/
 * bypassing run-validate-incoming.mjs). A package that fails re-validation
 * is skipped (with a console warning) rather than aborting the whole build
 * — one bad approved file must not block every other source from indexing,
 * mirroring section 11's "one bad upload must not break all future notes."
 */
function loadApprovedPackages() {
  const files = listApprovedPackageFiles();
  const packages = [];
  for (const filePath of files) {
    let rawText, pkg;
    try {
      rawText = readFileSync(filePath, 'utf8');
      pkg = JSON.parse(rawText);
    } catch (e) {
      console.warn(`SKIP (unreadable/invalid JSON): ${filePath}: ${e.message}`);
      continue;
    }
    const result = validatePackage(pkg, rawText);
    if (result.status !== 'approved') {
      console.warn(`SKIP (failed re-validation at build time): ${filePath}:\n  ${result.errors.join('\n  ')}`);
      continue;
    }
    packages.push({ filePath, pkg });
  }
  return packages;
}

function buildDocs(packages) {
  const docs = [];
  const df = {};
  let totalLen = 0;

  for (const { pkg } of packages) {
    const source = pkg.source || {};
    for (const chunk of pkg.chunks) {
      const text = String(chunk.text || '').trim();
      if (!text) continue; // already should have been caught by validation, but defensive
      const tokens = tokenize(text);
      const termFreq = {};
      for (const t of tokens) termFreq[t] = (termFreq[t] || 0) + 1;
      for (const t of Object.keys(termFreq)) df[t] = (df[t] || 0) + 1;
      totalLen += tokens.length;

      docs.push({
        id: chunk.id,
        source: source.title || null,
        sourceType: source.type || null,
        subject: source.subject || null,
        language: source.language || null,
        origin: source.origin || null,
        page: chunk.page ?? null,
        section: chunk.section || null,
        topics: Array.isArray(chunk.topics) ? chunk.topics : [],
        concepts: Array.isArray(chunk.concepts) ? chunk.concepts : [],
        text,
        termFreq,
        docLen: tokens.length,
      });
    }
  }

  const avgDocLen = docs.length ? totalLen / docs.length : 0;
  return { docs, df, avgDocLen, docCount: docs.length };
}

/** Deterministic content-derived version: changes iff the indexed content changes. */
function computeIndexVersion(docs) {
  const hash = createHash('sha256');
  // Sort by id so the version is stable regardless of source-file iteration order.
  const sorted = [...docs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const d of sorted) hash.update(`${d.id}\u0000${d.text}\u0000`);
  return `rag-index-v${INDEX_FORMAT_VERSION}-${hash.digest('hex').slice(0, 16)}`;
}

function validateBuiltIndex(index) {
  if (!index || typeof index !== 'object') return 'index is not an object';
  if (!Array.isArray(index.docs)) return 'index.docs is not an array';
  if (typeof index.docCount !== 'number' || index.docCount !== index.docs.length) return 'index.docCount does not match index.docs.length';
  if (!index.df || typeof index.df !== 'object') return 'index.df is missing or not an object';
  if (typeof index.avgDocLen !== 'number') return 'index.avgDocLen is not a number';
  if (typeof index.index_version !== 'string' || !index.index_version) return 'index.index_version is missing';
  if (typeof index.schema_version !== 'string' || !index.schema_version) return 'index.schema_version is missing';
  if (typeof index.built_at !== 'string' || !index.built_at) return 'index.built_at is missing';
  if (typeof index.sources !== 'number') return 'index.sources is not a number';
  if (typeof index.chunks !== 'number' || index.chunks !== index.docCount) return 'index.chunks does not match docCount';
  // Every doc must carry a non-empty id and text — a doc without a usable
  // id/text would make retrieve() results impossible to trace back to a
  // source (provenance, section 9), so treat that as a build-invalidating defect.
  for (const d of index.docs) {
    if (!d.id || typeof d.id !== 'string') return `doc missing a valid "id": ${JSON.stringify(d).slice(0, 120)}`;
    if (!d.text || typeof d.text !== 'string') return `doc "${d.id}" missing usable "text"`;
  }
  return true;
}

function main() {
  if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true });

  const packages = loadApprovedPackages();
  if (packages.length === 0) {
    console.log('No valid approved packages found in rag/approved/ — nothing to index. Previous index (if any) left untouched.');
    return;
  }

  const result = atomicPublishJson(
    INDEX_PATH,
    () => {
      const { docs, df, avgDocLen, docCount } = buildDocs(packages);
      return {
        index_version: computeIndexVersion(docs),
        schema_version: SCHEMA_VERSION,
        sources: packages.length,
        chunks: docCount,
        built_at: new Date().toISOString(),
        docs,
        df,
        avgDocLen,
        docCount,
      };
    },
    validateBuiltIndex
  );

  if (result.ok) {
    console.log(`Published ${INDEX_PATH}`);
  } else {
    console.error(`Index build FAILED: ${result.reason}`);
    process.exitCode = 1;
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
  } catch {
    return false;
  }
}

if (isDirectRun()) main();

export { buildDocs, computeIndexVersion, validateBuiltIndex, loadApprovedPackages };
