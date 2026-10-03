// Local BM25 search over index.json in this same folder (built by
// ../../Automation/rag-ingestion/build-rag-index.mjs from rag/approved/
// packages). No API key, no network call.
//
// Deliberately structured as a near-twin of
// Automation/ncert-knowledge-base/retrieve.mjs — same BM25 math (identical
// K1/B constants and scoring formula), same docs/df/avgDocLen/docCount
// index shape, same retrieve()/hasCorpus() exports — so the two could be
// unified behind one retrieval interface later with no math changes, only
// a "search both doc arrays" merge. See build-rag-index.mjs's header
// comment for the full reasoning on why this is a sibling file rather than
// a merge into the NCERT index right now.
//
// Extends the NCERT version with the extra filter dimensions
// RAG_INGESTION_ENGINE.md section 8 calls for (source/topic/concept
// retrieval, not just subject), since RAG chunks carry that metadata and
// NCERT chapters don't.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../../Automation/core/src/build-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, 'index.json');

const K1 = 1.5;
const B = 0.75;

let cachedIndex = null;
function loadIndex() {
  if (cachedIndex) return cachedIndex;
  if (!existsSync(INDEX_PATH)) { cachedIndex = { docs: [], df: {}, avgDocLen: 0, docCount: 0 }; return cachedIndex; }
  cachedIndex = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  return cachedIndex;
}

// Exposed for callers/tests that want the index metadata (version, sources,
// chunk counts, built_at — RAG_INGESTION_ENGINE.md section 10) without
// running a query.
export function getIndexInfo() {
  const index = loadIndex();
  const { docs, df, ...meta } = index;
  return meta;
}

function bm25Score(queryTerms, doc, df, docCount, avgDocLen) {
  let score = 0;
  for (const term of queryTerms) {
    const tf = doc.termFreq[term];
    if (!tf) continue;
    const docFreq = df[term] || 0;
    if (!docFreq) continue;
    const idf = Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5));
    const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (doc.docLen / (avgDocLen || 1))));
    score += idf * norm;
  }
  return score;
}

function matchesFilter(doc, filter) {
  if (!filter) return true;
  if (filter.subject) {
    if (!doc.subject || doc.subject.toLowerCase() !== String(filter.subject).toLowerCase()) return false;
  }
  if (filter.source) {
    if (!doc.source || doc.source.toLowerCase() !== String(filter.source).toLowerCase()) return false;
  }
  if (filter.topic) {
    const wanted = String(filter.topic).toLowerCase();
    if (!(doc.topics || []).some(t => String(t).toLowerCase() === wanted)) return false;
  }
  if (filter.concept) {
    const wanted = String(filter.concept).toLowerCase();
    if (!(doc.concepts || []).some(c => String(c).toLowerCase() === wanted)) return false;
  }
  return true;
}

// retrieve(queryText, { subject, source, topic, concept }, topK)
//   -> [{ id, source, sourceType, subject, language, origin, page, section, topics, concepts, text, score }]
//
// Filter fields are AND-ed together when present; an empty/no filter
// searches the whole corpus. Every result retains full provenance (source
// title, page, section — RAG_INGESTION_ENGINE.md section 9) since the doc
// object is returned as-is (minus the internal termFreq/docLen fields),
// never a stripped-down summary.
export async function retrieve(queryText, filter, topK) {
  const index = loadIndex();
  if (!index.docCount) return [];
  const queryTerms = [...new Set(tokenize(queryText))];
  const pool = (filter && (filter.subject || filter.source || filter.topic || filter.concept))
    ? index.docs.filter(d => matchesFilter(d, filter))
    : index.docs;
  const scored = pool
    .map(d => ({ ...d, score: bm25Score(queryTerms, d, index.df, index.docCount, index.avgDocLen) }))
    .filter(d => d.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK || 5).map(({ termFreq, docLen, ...rest }) => rest);
}

export function hasCorpus() {
  return loadIndex().docCount > 0;
}
