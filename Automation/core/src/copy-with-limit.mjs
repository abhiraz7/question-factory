// EDITORIAL INTELLIGENCE — Phase 12 (the 18,000-character copy contract).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, sections 17-19.
//
// ONE shared utility (spec section 18: "Do not implement separate
// character-limit logic throughout the UI"). This file is the canonical
// source and is deliberately plain, dependency-free JS using ONLY `export`
// as ESM-specific syntax (same convention flavour-engine.mjs/exam-profiles.mjs
// already use) so it can be mechanically mirrored into a browser <script>
// the exact same way gen-flavour-engine-browser.mjs mirrors flavour-
// engine.mjs — see gen-copy-with-limit-browser.mjs in this directory.
//
// NOT WIRED IN: this module is not imported by notes-factory/index.html,
// long-post-factory/index.html, or update-factory/index.html's actual copy
// buttons. Per this task's boundary, wiring it in is live-UI editing and is
// left for a human to do deliberately after review (see Phase 11 note in
// this session's progress report). This file is the complete, tested
// utility ready for that wiring.
//
// Design choices worth a human's attention (flagged, not hidden):
//   - Chunk splitting is plain character-slicing, NOT boundary-aware (it
//     can split mid-word, or even mid-HTML-tag if the input is HTML).
//     Spec section 17/18 only requires "every chunk <= MAX_COPY_CHARS" and
//     "preserve exact text order/content" — both hold exactly with plain
//     slicing, and anything boundary-aware (don't split inside a tag, don't
//     split inside a word) adds real complexity for marginal benefit on
//     content that is usually prose, not markup, by the time it reaches a
//     copy button. If a future caller copies raw HTML where a split mid-tag
//     would matter, this is the first place to revisit.
//   - Markers ("COPY 1 / 3") are chunk METADATA by default (returned
//     alongside each chunk, for the UI to render as a label), NOT prepended
//     into the copyable text itself — so what gets pasted is exactly the
//     source content, nothing extra. Set `embedMarker: true` to prepend the
//     marker as a header line inside the copied text instead; this mode
//     still guarantees every chunk (marker included) stays <= the limit.

export const MAX_COPY_CHARS = 18000;

/**
 * Builds the default marker text for one chunk. Exposed separately so a
 * caller can measure a marker's length without generating a whole split.
 * @param {number} index 1-based
 * @param {number} count total chunk count
 * @returns {string}
 */
export function defaultMarker(index, count) {
  return `COPY ${index} / ${count}`;
}

/**
 * Splits text into chunks that are each guaranteed <= maxChars, preserving
 * every character and their exact order (chunks.join('') === original
 * text, always — see copy-with-limit.contract-test.mjs for the assertion
 * against real content). Never silently truncates: if text already fits,
 * returns it as the single chunk unchanged; otherwise covers 100% of it
 * across as many chunks as needed.
 *
 * @param {string} text
 * @param {number} [maxChars=MAX_COPY_CHARS]
 * @returns {string[]}
 */
export function splitIntoChunks(text, maxChars = MAX_COPY_CHARS) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_COPY_CHARS;
  const str = text == null ? '' : String(text);
  if (!str.length) return [''];
  if (str.length <= limit) return [str];
  const chunks = [];
  for (let i = 0; i < str.length; i += limit) chunks.push(str.slice(i, i + limit));
  return chunks;
}

/**
 * The one shared copy-limit utility (spec section 18). Always returns a
 * full chunk-metadata descriptor, even when the text fits in one chunk
 * (callers should not need a separate "did it need splitting" code path —
 * they can always iterate `result.chunks`).
 *
 * When `options.embedMarker` is true, a marker header line is prepended
 * into each chunk's own text, and chunking is computed so the MARKER-
 * INCLUDING chunk still never exceeds the limit (a small fixed-point loop:
 * the marker's own text depends on the final chunk count, which depends on
 * how much room the marker leaves per chunk — this converges in at most a
 * couple of iterations for any realistic input and is capped defensively).
 *
 * @param {string} text
 * @param {{maxChars?: number, embedMarker?: boolean, markerFn?: (i:number,n:number)=>string}} [options]
 * @returns {{
 *   chunks: Array<{index:number, count:number, marker:string, text:string, length:number}>,
 *   chunkCount: number,
 *   totalChars: number,
 *   limit: number,
 *   wasSplit: boolean
 * }}
 */
export function copyWithLimit(text, options = {}) {
  const limit = Number.isFinite(options.maxChars) && options.maxChars > 0 ? Math.floor(options.maxChars) : MAX_COPY_CHARS;
  const markerFn = typeof options.markerFn === 'function' ? options.markerFn : defaultMarker;
  const str = text == null ? '' : String(text);
  const totalChars = str.length;

  if (!options.embedMarker) {
    const rawChunks = splitIntoChunks(str, limit);
    const count = rawChunks.length;
    const chunks = rawChunks.map((c, idx) => ({
      index: idx + 1,
      count,
      marker: markerFn(idx + 1, count),
      text: c,
      length: c.length,
    }));
    return { chunks, chunkCount: count, totalChars, limit, wasSplit: count > 1 };
  }

  // embedMarker: fixed-point loop — start from the no-marker split to get an
  // initial chunk-count estimate, reserve room for the worst-case marker at
  // that count, re-split, and repeat if the count changed (bounded to avoid
  // any pathological infinite loop; 5 iterations is far more than any
  // realistic input needs since reserving a few extra characters per chunk
  // changes the chunk count by at most 1 almost always).
  let count = splitIntoChunks(str, limit).length;
  for (let iteration = 0; iteration < 5; iteration++) {
    const worstCaseMarkerLen = markerFn(count, count).length + 1; // +1 for the newline separating marker from content
    const perChunkBudget = Math.max(1, limit - worstCaseMarkerLen);
    const rawChunks = splitIntoChunks(str, perChunkBudget);
    if (rawChunks.length === count) {
      const finalCount = rawChunks.length;
      const chunks = rawChunks.map((c, idx) => {
        const marker = markerFn(idx + 1, finalCount);
        return { index: idx + 1, count: finalCount, marker, text: `${marker}\n${c}`, length: marker.length + 1 + c.length };
      });
      return { chunks, chunkCount: finalCount, totalChars, limit, wasSplit: finalCount > 1 };
    }
    count = rawChunks.length;
  }
  // Fell through without converging (should not happen in practice) — fail
  // loudly rather than silently returning a possibly-over-limit chunk set.
  throw new Error('copyWithLimit: embedMarker chunking did not converge — report this input for investigation.');
}

/**
 * Attempts to copy one chunk's text to the clipboard, in whichever
 * environment this runs in. Never throws: clipboard failure is reported in
 * the return value (spec section 18: "handle clipboard failure"), never as
 * a silent no-op and never as an uncaught rejection.
 *
 * @param {string} text
 * @returns {Promise<{ok: boolean, method: 'clipboard-api'|'exec-command'|'unavailable', error?: string}>}
 */
export async function copyChunkToClipboard(text) {
  const hasNavigatorClipboard = typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function';
  if (hasNavigatorClipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard-api' };
    } catch (e) {
      // Fall through to the execCommand fallback below rather than giving
      // up immediately — some embedded/mobile webviews reject the async
      // Clipboard API but still support the legacy path.
      const fallback = tryExecCommandCopy(text);
      if (fallback.ok) return fallback;
      return { ok: false, method: 'clipboard-api', error: String(e && e.message || e) };
    }
  }
  const fallback = tryExecCommandCopy(text);
  if (fallback.ok) return fallback;
  return { ok: false, method: 'unavailable', error: 'No clipboard API available in this environment.' };
}

function tryExecCommandCopy(text) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return { ok: false, method: 'unavailable' };
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok ? { ok: true, method: 'exec-command' } : { ok: false, method: 'exec-command', error: 'execCommand(copy) returned false' };
  } catch (e) {
    return { ok: false, method: 'exec-command', error: String(e && e.message || e) };
  }
}
