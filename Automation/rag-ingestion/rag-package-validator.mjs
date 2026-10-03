// RAG INGESTION — package validator (RAG_INGESTION_ENGINE.md section 5).
//
// Validates an UPLOADED RAG PACKAGE (what a human drops into rag/incoming/
// after asking ChatGPT to turn a PDF into chunks) BEFORE it is ever indexed.
//
// This is deliberately a different, earlier pipeline stage than
// Automation/core/src/rag-evidence-validator.mjs, which validates the SHAPE
// of a retrieve.mjs query RESULT after the index already exists. That one
// asks "is this retrieval hit trustworthy enough to feed Editorial
// Intelligence?". This one asks "is this uploaded package safe and
// well-formed enough to ever become part of the index at all?". Different
// input, different failure modes, different stage — hence the distinct name.
//
// Pure, deterministic, no I/O side effects beyond reading the package itself
// (validatePackageFile) or none at all (validatePackage on an in-memory
// object/string). No network, no API key, no randomness.
//
// Usage:
//   node rag-package-validator.mjs <package.json>
// Or:
//   import { validatePackage, validatePackageFile } from './rag-package-validator.mjs';

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';

export const SUPPORTED_SCHEMA_VERSIONS = ['1'];

// See RAG_PACKAGE_SCHEMA.md "Why these bounds" for the reasoning.
const MIN_CHUNK_CHARS = 10;
const MAX_CHUNK_CHARS_WARN = 8000; // warning, not rejection — see schema doc
const MAX_CHUNK_CHARS_HARD = 20000; // beyond this it's not a "chunk" anymore — reject
const MAX_TOPIC_CONCEPT_LEN = 100;
const MAX_TOPIC_CONCEPT_ITEMS = 50;
const ALLOWED_PACKAGE_EXTENSIONS = new Set(['.json', '.jsonl']);

// Safety tier: patterns that should never legitimately appear in a chunk of
// textbook/syllabus prose. Each is a (reason, regex) pair so a hit produces
// a readable error rather than a bare boolean.
const SECRET_PATTERNS = [
  ['OpenAI-style API key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['Anthropic-style API key', /\bsk-ant-[A-Za-z0-9-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['generic key/secret/token assignment', /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}["']?/i],
  ['PEM private key block', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9_\-.]{20,}/],
];

const WORKFLOW_TAMPER_PATTERNS = [
  ['.github/workflows path reference', /\.github[\\/]workflows[\\/]/i],
  ['embedded GitHub Actions job syntax', /\bruns-on\s*:\s*[A-Za-z0-9_-]+/i],
  ['embedded GitHub Actions trigger syntax', /^\s*on\s*:\s*(push|pull_request|workflow_dispatch)/mi],
  ['instruction to modify workflow/CI', /\b(modify|edit|update|replace|overwrite)\b[^.]{0,40}\b(workflow|\.yml|\.yaml|github action)/i],
];

const EXECUTABLE_EXT_PATTERN = /\.(exe|sh|bat|cmd|ps1|vbs|scr|jar|app|dll|msi|com|apk|dmg|bin)(\s|["'\\/]|$)/i;
const SCRIPT_TAG_PATTERN = /<script\b/i;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pushError(errors, code, message) {
  errors.push(`${code}: ${message}`);
}
function pushWarning(warnings, code, message) {
  warnings.push(`${code}: ${message}`);
}

/** Recursively collects every string value in a parsed package, for safety scanning. */
function collectStrings(value, out) {
  if (typeof value === 'string') { out.push(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return; }
  if (isPlainObject(value)) { for (const k of Object.keys(value)) collectStrings(value[k], out); }
}

function runSafetyChecks(pkg, errors, warnings) {
  const strings = [];
  collectStrings(pkg, strings);
  const haystack = strings.join('\n');

  for (const [reason, re] of SECRET_PATTERNS) {
    if (re.test(haystack)) {
      pushError(errors, 'SECRET_LIKE_CONTENT', `Package text matches a pattern that looks like a ${reason} — refusing to index possible credential material.`);
    }
  }
  for (const [reason, re] of WORKFLOW_TAMPER_PATTERNS) {
    if (re.test(haystack)) {
      pushError(errors, 'WORKFLOW_TAMPER_SUSPECT', `Package text contains ${reason} — RAG packages must be inert content, never instructions that reference or modify CI/workflow files.`);
    }
  }
  if (SCRIPT_TAG_PATTERN.test(haystack)) {
    pushError(errors, 'EXECUTABLE_CONTENT', 'Package text contains a <script> tag — not allowed in a content chunk.');
  }
  if (EXECUTABLE_EXT_PATTERN.test(haystack)) {
    pushWarning(warnings, 'EXECUTABLE_EXT_MENTION', 'Package text references a filename with an executable-looking extension (.exe/.sh/.bat/...). Not rejected outright (could be legitimate prose about file types), but flagged for human review.');
  }
}

/** Structural + knowledge validation of chunks. Mutates errors/warnings. Returns the count of usable chunks. */
function validateChunks(chunks, errors, warnings) {
  if (!Array.isArray(chunks)) {
    pushError(errors, 'CHUNKS_NOT_ARRAY', '"chunks" must be an array.');
    return 0;
  }
  if (chunks.length === 0) {
    pushError(errors, 'EMPTY_CORPUS', 'Package contains zero chunks — refusing to index an empty corpus.');
    return 0;
  }

  const seenIds = new Set();
  let usable = 0;

  chunks.forEach((chunk, idx) => {
    const where = `chunks[${idx}]`;
    if (!isPlainObject(chunk)) {
      pushError(errors, 'CHUNK_NOT_OBJECT', `${where} is not an object.`);
      return;
    }

    // id
    if (typeof chunk.id !== 'string' || chunk.id.trim() === '') {
      pushError(errors, 'MISSING_CHUNK_ID', `${where} has no non-empty string "id".`);
    } else if (seenIds.has(chunk.id)) {
      pushError(errors, 'DUPLICATE_CHUNK_ID', `Chunk id "${chunk.id}" appears more than once in this package.`);
    } else {
      seenIds.add(chunk.id);
    }

    // text
    if (typeof chunk.text !== 'string' || chunk.text.trim() === '') {
      pushError(errors, 'MISSING_CHUNK_TEXT', `${where} (id="${chunk.id ?? '?'}") has no non-empty string "text".`);
    } else {
      const len = chunk.text.trim().length;
      if (len < MIN_CHUNK_CHARS) {
        pushError(errors, 'CHUNK_TOO_SHORT', `${where} (id="${chunk.id}") text is only ${len} chars (minimum ${MIN_CHUNK_CHARS}) — likely noise, not real content.`);
      } else if (len > MAX_CHUNK_CHARS_HARD) {
        pushError(errors, 'CHUNK_WAY_TOO_LONG', `${where} (id="${chunk.id}") text is ${len} chars, over the hard cap of ${MAX_CHUNK_CHARS_HARD} — this is not a "chunk", split it before re-uploading.`);
      } else {
        usable++;
        if (len > MAX_CHUNK_CHARS_WARN) {
          pushWarning(warnings, 'CHUNK_LONG', `${where} (id="${chunk.id}") text is ${len} chars, over the recommended ${MAX_CHUNK_CHARS_WARN} — BM25 scores whole chunks, so very long chunks reduce retrieval precision. Consider splitting.`);
        }
      }
    }

    // page
    if (chunk.page !== undefined && chunk.page !== null && typeof chunk.page !== 'number') {
      pushError(errors, 'INVALID_PAGE_TYPE', `${where} (id="${chunk.id ?? '?'}") "page" must be a number or null, got ${typeof chunk.page}.`);
    }

    // section
    if (chunk.section !== undefined && typeof chunk.section !== 'string') {
      pushError(errors, 'INVALID_SECTION_TYPE', `${where} (id="${chunk.id ?? '?'}") "section" must be a string, got ${typeof chunk.section}.`);
    }

    // topics / concepts
    for (const field of ['topics', 'concepts']) {
      const val = chunk[field];
      if (val === undefined) continue;
      if (!Array.isArray(val)) {
        pushError(errors, 'INVALID_METADATA_TYPE', `${where} (id="${chunk.id ?? '?'}") "${field}" must be an array of strings, got ${typeof val}.`);
        continue;
      }
      if (val.length > MAX_TOPIC_CONCEPT_ITEMS) {
        pushWarning(warnings, 'METADATA_ARRAY_LONG', `${where} (id="${chunk.id}") "${field}" has ${val.length} entries (recommended max ${MAX_TOPIC_CONCEPT_ITEMS}).`);
      }
      val.forEach((entry, i) => {
        if (typeof entry !== 'string' || entry.trim() === '') {
          pushError(errors, 'INVALID_METADATA_ENTRY', `${where} (id="${chunk.id ?? '?'}") "${field}[${i}]" must be a non-empty string.`);
        } else if (entry.length > MAX_TOPIC_CONCEPT_LEN) {
          pushWarning(warnings, 'METADATA_ENTRY_LONG', `${where} (id="${chunk.id}") "${field}[${i}]" is ${entry.length} chars (recommended max ${MAX_TOPIC_CONCEPT_LEN}) — syntactically valid but unusually long for a topic/concept label.`);
        }
      });
    }
  });

  return usable;
}

function validateStructure(pkg, errors) {
  if (!isPlainObject(pkg)) {
    pushError(errors, 'INVALID_ROOT', 'Package root is not a JSON object.');
    return;
  }
  if (typeof pkg.schema_version !== 'string') {
    pushError(errors, 'MISSING_SCHEMA_VERSION', '"schema_version" is missing or not a string.');
  } else if (!SUPPORTED_SCHEMA_VERSIONS.includes(pkg.schema_version)) {
    pushError(errors, 'UNSUPPORTED_SCHEMA_VERSION', `"schema_version" "${pkg.schema_version}" is not supported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}).`);
  }
  if (!isPlainObject(pkg.source)) {
    pushError(errors, 'MISSING_SOURCE', '"source" is missing or not an object.');
  } else {
    if (typeof pkg.source.title !== 'string' || pkg.source.title.trim() === '') {
      pushError(errors, 'MISSING_SOURCE_TITLE', '"source.title" is missing or empty — a package must identify what it came from.');
    }
    for (const field of ['type', 'subject', 'language', 'origin']) {
      if (pkg.source[field] !== undefined && typeof pkg.source[field] !== 'string') {
        pushError(errors, 'INVALID_SOURCE_FIELD_TYPE', `"source.${field}" must be a string if present, got ${typeof pkg.source[field]}.`);
      }
    }
  }
}

function computeContentHash(rawText) {
  return createHash('sha256').update(rawText, 'utf8').digest('hex');
}

/**
 * Validates an already-parsed package object (or the raw JSON text it came
 * from, for hashing). Returns the exact shape from RAG_INGESTION_ENGINE.md
 * section 5.
 *
 * @param {object} pkg - parsed package object (or array of chunks for jsonl bodies merged by caller)
 * @param {string} rawText - the raw file bytes, used only for content_hash (hashing raw bytes rather than
 *   a re-serialization keeps the hash tamper-evident against the exact uploaded content, and matches how
 *   RAG_INGESTION_ENGINE.md section 10 treats "source version/hash" as a property of the uploaded artifact).
 */
export function validatePackage(pkg, rawText) {
  const errors = [];
  const warnings = [];

  validateStructure(pkg, errors);

  let usableChunks = 0;
  if (isPlainObject(pkg) && pkg.chunks !== undefined) {
    usableChunks = validateChunks(pkg.chunks, errors, warnings);
  }

  // Safety tier always runs, even over a structurally broken package —
  // a package can be both malformed AND malicious, and a human should see both.
  runSafetyChecks(pkg, errors, warnings);

  const chunkCount = isPlainObject(pkg) && Array.isArray(pkg.chunks) ? pkg.chunks.length : 0;
  const source = isPlainObject(pkg) && isPlainObject(pkg.source) && typeof pkg.source.title === 'string'
    ? pkg.source.title
    : null;

  return {
    status: errors.length === 0 ? 'approved' : 'rejected',
    source,
    chunks: chunkCount,
    warnings,
    errors,
    content_hash: computeContentHash(rawText != null ? rawText : JSON.stringify(pkg)),
    validated_at: new Date().toISOString(),
    // Extra, non-spec field kept alongside the spec shape — useful for the
    // index builder to know how many chunks actually passed per-chunk
    // checks (vs. the raw declared count), without re-running validation.
    usable_chunks: usableChunks,
  };
}

/**
 * Validates a package file on disk. Handles the pre-parse safety/structural
 * checks a validatePackage(object) call can't do on its own: file extension
 * (unexpected file types must never sit in rag/incoming/ as if they were
 * packages) and JSON parse failures (a package that isn't even valid JSON).
 */
export function validatePackageFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!ALLOWED_PACKAGE_EXTENSIONS.has(ext)) {
    return {
      status: 'rejected',
      source: null,
      chunks: 0,
      warnings: [],
      errors: [`UNEXPECTED_FILE_TYPE: "${filePath}" has extension "${ext || '(none)'}" — only .json and .jsonl are accepted RAG package files.`],
      content_hash: null,
      validated_at: new Date().toISOString(),
      usable_chunks: 0,
    };
  }

  let rawText;
  try {
    rawText = readFileSync(filePath, 'utf8');
  } catch (e) {
    return {
      status: 'rejected',
      source: null,
      chunks: 0,
      warnings: [],
      errors: [`FILE_READ_ERROR: could not read "${filePath}": ${e.message}`],
      content_hash: null,
      validated_at: new Date().toISOString(),
      usable_chunks: 0,
    };
  }

  if (ext === '.jsonl') {
    return validateJsonlPackage(rawText);
  }

  let pkg;
  try {
    pkg = JSON.parse(rawText);
  } catch (e) {
    return {
      status: 'rejected',
      source: null,
      chunks: 0,
      warnings: [],
      errors: [`INVALID_JSON: "${filePath}" is not valid JSON: ${e.message}`],
      content_hash: computeContentHash(rawText),
      validated_at: new Date().toISOString(),
      usable_chunks: 0,
    };
  }

  return validatePackage(pkg, rawText);
}

/** JSONL variant: line 1 is a {schema_version, source} header, remaining lines are chunk objects. */
function validateJsonlPackage(rawText) {
  const lines = rawText.split(/\r?\n/).filter(l => l.trim() !== '');
  const errors = [];
  if (lines.length === 0) {
    return {
      status: 'rejected', source: null, chunks: 0, warnings: [],
      errors: ['EMPTY_FILE: .jsonl package has no lines.'],
      content_hash: computeContentHash(rawText), validated_at: new Date().toISOString(), usable_chunks: 0,
    };
  }
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (e) {
    return {
      status: 'rejected', source: null, chunks: 0, warnings: [],
      errors: [`INVALID_JSON: .jsonl header line is not valid JSON: ${e.message}`],
      content_hash: computeContentHash(rawText), validated_at: new Date().toISOString(), usable_chunks: 0,
    };
  }
  const chunks = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      chunks.push(JSON.parse(lines[i]));
    } catch (e) {
      errors.push(`INVALID_JSON: .jsonl line ${i + 1} is not valid JSON: ${e.message}`);
    }
  }
  const pkg = { schema_version: header.schema_version, source: header.source, chunks };
  const result = validatePackage(pkg, rawText);
  result.errors = [...errors, ...result.errors];
  if (errors.length) result.status = 'rejected';
  return result;
}

// CLI entry point: `node rag-package-validator.mjs <package.json>`.
function fileUrlToPath(u) {
  const p = new URL(u).pathname;
  return process.platform === 'win32' ? decodeURIComponent(p.replace(/^\//, '')) : decodeURIComponent(p);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fileUrlToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node rag-package-validator.mjs <package.json>');
    process.exit(1);
  }
  const result = validatePackageFile(file);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'approved' ? 0 : 1);
}
