// RAG INGESTION — atomic publish helper (RAG_INGESTION_ENGINE.md section 6).
//
// Generic "build to temp, validate the temp artifact, then atomically
// replace the live file" primitive. Used by build-rag-index.mjs, but kept
// as its own small, independently testable module rather than inlined,
// because the atomicity guarantee is the single most safety-critical piece
// of this whole package: a bug here is the one thing that could actually
// corrupt the live index that every future note-generation run depends on.
//
// Contract:
//   1. buildFn() returns the full JSON-serializable content to publish (or
//      throws — any throw aborts BEFORE anything on disk is touched beyond
//      a throwaway temp file, which is cleaned up).
//   2. The built content is written to a temp file IN THE SAME DIRECTORY as
//      the target (same-volume rename is what makes the final step atomic;
//      a temp dir on a different drive would turn the "atomic" rename into
//      a copy, reopening the exact race this module exists to close).
//   3. validateFn(content) is called against the in-memory built content
//      (not a re-read of the temp file — the temp file is just that
//      in-memory content serialized, so re-reading it would only catch a
//      disk-write error, which fs.writeFileSync already throws on
//      synchronously; validating the same object we're about to publish is
//      both sufficient and simpler). Returning a falsy value or throwing
//      both count as "invalid" and abort the publish.
//   4. Only if both build and validate succeed does the temp file get
//      renamed over the target path. fs.renameSync is used rather than
//      copy+delete because a rename is a single filesystem operation: a
//      process crash mid-rename cannot leave a half-written target file,
//      whereas a crash mid-copy could.
//   5. On ANY failure at any step, the temp file is removed and the target
//      path is left completely untouched — exactly the RAG_INGESTION_ENGINE.md
//      section 11 rule: "failed index build -> preserve previous index."
//
// Pure Node builtins only (node:fs, node:path, node:crypto) — no deps.

import { writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * @param {string} targetPath - final path to publish to, e.g. rag/index/index.json
 * @param {() => object} buildFn - builds and returns the JSON-serializable content. May throw.
 * @param {(content: object) => (true|string)} validateFn - returns true if content is publishable,
 *   or a string describing why not. May throw (treated the same as returning a failure string).
 * @returns {{ ok: true, publishedPath: string } | { ok: false, reason: string }}
 */
export function atomicPublishJson(targetPath, buildFn, validateFn) {
  const dir = dirname(targetPath);
  const tempPath = join(dir, `.${basename(targetPath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);

  let content;
  try {
    content = buildFn();
  } catch (e) {
    return { ok: false, reason: `build failed, previous index (if any) left untouched: ${e.message}` };
  }

  let verdict;
  try {
    verdict = validateFn(content);
  } catch (e) {
    return { ok: false, reason: `temp-index validation threw, previous index (if any) left untouched: ${e.message}` };
  }
  if (verdict !== true) {
    return { ok: false, reason: `temp-index validation failed, previous index (if any) left untouched: ${verdict}` };
  }

  try {
    writeFileSync(tempPath, JSON.stringify(content));
  } catch (e) {
    cleanupTemp(tempPath);
    return { ok: false, reason: `failed to write temp file, previous index (if any) left untouched: ${e.message}` };
  }

  try {
    renameSync(tempPath, targetPath);
  } catch (e) {
    cleanupTemp(tempPath);
    return { ok: false, reason: `atomic rename failed, previous index (if any) left untouched: ${e.message}` };
  }

  return { ok: true, publishedPath: targetPath };
}

function cleanupTemp(tempPath) {
  try {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  } catch {
    // best-effort cleanup only — a stray .tmp-* file is harmless clutter,
    // never a correctness problem, since nothing ever reads it by name.
  }
}
