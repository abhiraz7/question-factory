// EDITORIAL INTELLIGENCE — Phase 11 (Search Console).
// Spec: ../../../EDITORIAL_INTELLIGENCE_ENGINE.md, section 11 ("Search
// Console should be treated as a learner-intent signal... Do NOT convert
// Search Console directly into keyword stuffing instructions.") and section
// 16 ("Runtime architecture" — expensive/credentialed work belongs in
// GitHub Actions, never the browser; this module has no browser mirror and
// is never fetched by notes-factory/index.html).
//
// Reads four values from the environment: three OAuth2 credentials
// (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
// GOOGLE_OAUTH_REFRESH_TOKEN) and the Search Console property to query
// (GSC_SITE_URL — the exact property string as Search Console shows it,
// either a URL-prefix property like "https://example.com/" or a
// domain-verified property like "sc-domain:example.com"). Deliberately NO
// hardcoded default site here: the property identifier is configuration,
// not something this public repo's source should bake in, so a missing
// GSC_SITE_URL degrades the same honest way a missing credential does
// rather than silently falling back to some guessed value. Does a
// refresh-token exchange, then queries searchAnalytics for the last ~28
// days (ending a few days back to stay inside Search Console's own
// data-freshness lag). Deliberately
// plain fetch() + manual OAuth, no googleapis SDK dependency, matching this
// repo's existing "pure, dependency-light" convention (see
// editorial-intelligence.mjs's header, and buildEvidenceBlock()/
// buildInternalLinksBlock() in notes-factory/index.html for the same
// plain-fetch pattern against a different API).
//
// Honesty rule (same convention as rag-evidence.mjs): any missing
// credential, any failed token exchange, or any failed API call returns
// `dataAvailable: false` immediately — this module never throws out of its
// public function, never fabricates a query list, and never silently
// retries into a hang. A caller (topic-state.mjs) can always tell "Search
// Console was actually queried" apart from "nothing to show yet".
//
// Visibility rule (added after a real incident: a wrong credential sat
// undiagnosed for a day because every failure mode produced the same
// generic "expired/revoked refresh token, or a network error" guess, both
// in the returned `note` and in a GitHub Actions log that said nothing at
// all — the only way to see anything was to manually fetch and decode the
// committed output file after the fact). Every failure branch below does
// two things: (1) captures Google's own `error`/`error_description` from
// the response body when one exists, instead of discarding it, and (2)
// calls console.error/console.log so the reason is visible directly in
// whatever invoked this (a GitHub Actions run log, a local `node` run)
// without needing to inspect the return value at all.

import { tokenize } from './bm25.mjs';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SEARCH_ANALYTICS_ENDPOINT = 'https://searchconsole.googleapis.com/webmasters/v3/sites';
const DEFAULT_LOOKBACK_DAYS = 28;
const DEFAULT_LAG_DAYS = 3; // GSC data for the last 1-3 days is often incomplete/missing
const DEFAULT_ROW_LIMIT = 5000;
const DEFAULT_TOP_K = 15;

// Below this per-query impression count, a row is too thin to be a
// meaningful signal either way (not enough traffic to say anything about
// learner intent or coverage) — filtered out before matching/ranking, not
// after, so it can never inflate a match count.
const MIN_IMPRESSIONS = 5;

// A matched query counts as a "weak coverage" signal when it has real
// traffic (impressions) but a low click-through rate — people are seeing
// the page in search results for this query but not clicking, or not
// enough people see it ranked well enough to click. Both thresholds are
// deliberately loose defaults; they decide "worth flagging to a human",
// not a hard cutoff.
const WEAK_CTR_THRESHOLD = 0.02;
const WEAK_POSITION_THRESHOLD = 15;

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function defaultDateRange(lookbackDays = DEFAULT_LOOKBACK_DAYS, lagDays = DEFAULT_LAG_DAYS) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - lagDays);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

/**
 * Best-effort extraction of Google's own error reason from a non-2xx JSON
 * body, in whichever shape that endpoint uses (OAuth errors look like
 * {error, error_description}; most Google API errors look like
 * {error: {code, message, status}}). Never throws — an unparseable body
 * (HTML error page, empty response) just yields a generic fallback built
 * from the HTTP status instead.
 */
async function extractErrorDetail(res) {
  try {
    const body = await res.json();
    if (typeof body.error === 'string') {
      return `${body.error}${body.error_description ? ': ' + body.error_description : ''}`;
    }
    if (body.error && typeof body.error === 'object') {
      return `${body.error.status || res.status}: ${body.error.message || 'no message'}`;
    }
  } catch (e) {
    // fall through to the generic status-based message below
  }
  return `HTTP ${res.status}`;
}

/**
 * Exchanges the long-lived refresh token for a short-lived access token.
 * Returns {accessToken: null, errorDetail} on any failure (never throws) —
 * errorDetail is Google's own reason when one came back (e.g.
 * "invalid_grant: Token has been expired or revoked.", or
 * "invalid_client: The OAuth client was not found." — exactly the signal
 * needed to tell "wrong refresh token" apart from "wrong client
 * id/secret" apart from "this wasn't a refresh token at all"), or a
 * network-error message otherwise.
 */
async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      const errorDetail = await extractErrorDetail(res);
      console.error(`[gsc.mjs] OAuth token exchange rejected by Google: ${errorDetail}`);
      return { accessToken: null, errorDetail };
    }
    const body = await res.json();
    if (!body.access_token) {
      console.error('[gsc.mjs] OAuth token exchange returned 200 but no access_token in the body — unexpected response shape.');
      return { accessToken: null, errorDetail: 'response had no access_token' };
    }
    return { accessToken: body.access_token, errorDetail: null };
  } catch (e) {
    console.error(`[gsc.mjs] OAuth token exchange network error: ${e.message}`);
    return { accessToken: null, errorDetail: `network error: ${e.message}` };
  }
}

/**
 * Raw searchAnalytics.query call, one dimension ("query"). Returns
 * {rows: null, errorDetail} on any failure (never throws), with Google's
 * own error reason when available (e.g. "PERMISSION_DENIED: ..." for an
 * account that lacks access to this property, or "NOT_FOUND: ..." for a
 * GSC_SITE_URL that doesn't match any verified property).
 */
async function querySearchAnalytics({ siteUrl, accessToken, startDate, endDate, rowLimit }) {
  try {
    const res = await fetch(
      `${SEARCH_ANALYTICS_ENDPOINT}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit }),
      }
    );
    if (!res.ok) {
      const errorDetail = await extractErrorDetail(res);
      console.error(`[gsc.mjs] searchAnalytics.query rejected by Google for site "${siteUrl}": ${errorDetail}`);
      return { rows: null, errorDetail };
    }
    const body = await res.json();
    return { rows: Array.isArray(body.rows) ? body.rows : [], errorDetail: null };
  } catch (e) {
    console.error(`[gsc.mjs] searchAnalytics.query network error: ${e.message}`);
    return { rows: null, errorDetail: `network error: ${e.message}` };
  }
}

/**
 * Plain word-overlap scoring between the topic+subject+exam and each GSC
 * query string — same lightweight approach notes-factory/index.html already
 * uses for internal-link matching (BM25 is overkill for scoring a flat list
 * of a few hundred/thousand short query strings against one topic; building
 * a full index for that would be solving a problem that does not exist, per
 * spec section 9's "grow it incrementally").
 */
function scoreQueryOverlap(queryTerms, rowQuery) {
  const rowTerms = new Set(tokenize(rowQuery));
  let overlap = 0;
  for (const t of queryTerms) if (rowTerms.has(t)) overlap++;
  return overlap;
}

/**
 * @param {{topic?:string, subject?:string, exam?:string}} ctx
 * @param {{
 *   siteUrl?: string, lookbackDays?: number, lagDays?: number,
 *   rowLimit?: number, topK?: number,
 *   env?: Record<string,string|undefined>
 * }} [options] `env` defaults to process.env — overridable for tests.
 * @returns {Promise<{
 *   dataAvailable: boolean,
 *   queries: Array<{query:string, clicks:number, impressions:number, ctr:number, position:number, overlap:number}>,
 *   weakCoverage: boolean,
 *   dateRange: {startDate:string, endDate:string},
 *   confidence: number,
 *   note: string
 * }>}
 */
export async function fetchLearnerSignals(ctx = {}, options = {}) {
  const env = options.env || process.env;
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const siteUrl = options.siteUrl || env.GSC_SITE_URL;

  const empty = (note) => ({
    dataAvailable: false,
    queries: [],
    weakCoverage: false,
    dateRange: null,
    confidence: 0,
    note,
  });

  if (!clientId || !clientSecret || !refreshToken) {
    const note = 'No GOOGLE_OAUTH_* credentials in the environment — Search Console was not queried this run.';
    console.log(`[gsc.mjs] SKIPPED: ${note}`);
    return empty(note);
  }
  if (!siteUrl) {
    const note = 'No GSC_SITE_URL configured — Search Console was not queried this run. Set it to the exact property string Search Console shows (e.g. a URL-prefix property like "https://example.com/" or a domain property like "sc-domain:example.com").';
    console.log(`[gsc.mjs] SKIPPED: ${note}`);
    return empty(note);
  }

  const { accessToken, errorDetail: tokenError } = await getAccessToken({ clientId, clientSecret, refreshToken });
  if (!accessToken) {
    return empty(`OAuth token exchange failed: ${tokenError}. Search Console was not queried this run. (If this says "invalid_client" or "unauthorized_client", GOOGLE_OAUTH_CLIENT_ID/SECRET don't match the app that issued the refresh token. If it says "invalid_grant", the refresh token itself is wrong, expired, or revoked — note that an API key is NOT a refresh token and will fail exactly this way.)`);
  }

  const { startDate, endDate } = defaultDateRange(options.lookbackDays, options.lagDays);
  const { rows, errorDetail: queryError } = await querySearchAnalytics({
    siteUrl,
    accessToken,
    startDate,
    endDate,
    rowLimit: options.rowLimit || DEFAULT_ROW_LIMIT,
  });
  if (rows === null) {
    return empty(`Search Console API call failed for site "${siteUrl}": ${queryError}. (A PERMISSION_DENIED here usually means the Google account behind the refresh token isn't a verified owner/user of this exact property in Search Console; a NOT_FOUND usually means GSC_SITE_URL doesn't exactly match a property that account has.)`);
  }

  const queryText = [ctx.topic, ctx.subject, ctx.exam].filter(Boolean).join(' ');
  const queryTerms = [...new Set(tokenize(queryText))];
  const topK = Number.isFinite(options.topK) && options.topK > 0 ? options.topK : DEFAULT_TOP_K;

  const matched = rows
    .filter(r => (r.impressions || 0) >= MIN_IMPRESSIONS)
    .map(r => ({
      query: r.keys[0],
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: Math.round((r.ctr || 0) * 10000) / 10000,
      position: Math.round((r.position || 0) * 10) / 10,
      overlap: scoreQueryOverlap(queryTerms, r.keys[0]),
    }))
    .filter(r => r.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.impressions - a.impressions)
    .slice(0, topK);

  const weakCoverage = matched.some(r => r.ctr < WEAK_CTR_THRESHOLD && r.position > WEAK_POSITION_THRESHOLD);

  // Confidence from one real, observable quantity: how much impression
  // volume backs the matched queries, relative to a threshold past which
  // more volume stops meaningfully increasing trust (diminishing returns —
  // 500 impressions across matched queries is already a solid signal; 5000
  // isn't meaningfully more trustworthy than 500 for this purpose).
  const totalImpressions = matched.reduce((s, r) => s + r.impressions, 0);
  const confidence = matched.length ? Math.round(Math.min(1, totalImpressions / 500) * 100) / 100 : 0;

  const note = matched.length
    ? `${matched.length} matching quer${matched.length === 1 ? 'y' : 'ies'} found for this topic in the ${startDate} to ${endDate} window.`
    : `Search Console was queried successfully, but no query in the ${startDate} to ${endDate} window overlapped this topic's words (${rows.length} total rows fetched for the property).`;
  console.log(`[gsc.mjs] OK: ${note}`);

  return {
    dataAvailable: true,
    queries: matched,
    weakCoverage,
    dateRange: { startDate, endDate },
    confidence,
    note,
  };
}
