/**
 * Per-slot "Test" implementations for the Settings → API keys admin
 * page. Each known slot has a corresponding tester that takes the
 * candidate value (typed into the form, NOT yet saved) plus any
 * context the test needs (e.g. a proxy domain to ping for IndexNow)
 * and returns a structured result the UI renders below the slot row.
 *
 * The test reads the in-form value rather than the stored value so
 * operators can verify a key BEFORE committing it — much better UX
 * than "save, refresh, find out it was a typo, repaste, save again."
 */

import { buildSubmissions, submitToIndexNow } from "../sitemap/indexnow.js";
import { submitToOmegaIndexer } from "../sitemap/omega-indexer.js";
import { checkPrimeBalance } from "../sitemap/prime-indexer.js";
import { submitToSinbyte } from "../sitemap/sinbyte.js";

/**
 * Discriminated result shape — `kind` tells the UI which icon/colour
 * to use; `message` is the human-readable summary; `details` carries
 * optional extra (HTTP body, JSON parse error position, etc.) shown
 * in a `<details>` block.
 */
export type TestResult =
  | { kind: "ok"; message: string; details?: string }
  | { kind: "warn"; message: string; details?: string }
  | { kind: "err"; message: string; details?: string };

/**
 * Test the IndexNow API key by posting one URL to api.indexnow.org.
 *
 * IndexNow doesn't have a "verify only" endpoint — submission IS the
 * verification. Status codes per spec:
 *   - 200 / 202 → key accepted, URL queued for re-fetch
 *   - 403       → key location mismatch (the engines fetched
 *                 https://<host>/<key>.txt and got something other
 *                 than this key)
 *   - 422       → invalid URL or malformed body
 *   - other     → unexpected; message wraps the body for debugging
 *
 * @param key the candidate IndexNow key (form value, not yet saved)
 * @param testHost the proxy domain to test against — must be a host
 *   the proxy worker actively serves so the `/<key>.txt` verification
 *   file resolves (otherwise the engines 403 us).
 */
/**
 * Per IndexNow spec, the key must be 8–128 characters from
 * `[a-zA-Z0-9-]`. Any other character (underscore, dot, slash, colon,
 * whitespace, unicode) makes the submission body fail schema check
 * server-side with a 422.
 */
const INDEXNOW_KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;

export async function testIndexNowKey(key: string, testHost: string): Promise<TestResult> {
  const trimmed = key.trim();
  if (!trimmed) {
    return { kind: "err", message: "No key provided. Enter a value before testing." };
  }
  if (!INDEXNOW_KEY_PATTERN.test(trimmed)) {
    return {
      kind: "err",
      message:
        "Key has invalid characters or length. IndexNow requires 8–128 characters from [a-zA-Z0-9-] — no underscores, dots, spaces, or punctuation. Generate a new one at https://www.bing.com/indexnow.",
    };
  }
  if (!testHost.trim()) {
    return {
      kind: "err",
      message:
        "No proxy domain available to test against. Add a proxied site first — IndexNow needs a real host so it can fetch the /<key>.txt verification file.",
    };
  }
  // Build a single-URL submission against the test host's homepage.
  const url = `https://${testHost}/`;
  const submissions = buildSubmissions(testHost, trimmed, [url]);
  const submission = submissions[0];
  if (!submission) {
    return { kind: "err", message: "Could not build IndexNow submission body." };
  }
  const result = await submitToIndexNow(submission);
  const withDetails = (base: TestResult): TestResult =>
    result.responseBody ? { ...base, details: result.responseBody } : base;
  switch (result.status) {
    case 200:
    case 202:
      return {
        kind: "ok",
        message: `Key accepted (HTTP ${result.status}). IndexNow has queued ${url} for re-crawl.`,
      };
    case 403:
      return withDetails({
        kind: "err",
        message: `HTTP 403 — IndexNow couldn't verify the key. The engines fetched https://${testHost}/${trimmed}.txt and got the wrong content. Save this key (so the proxy worker serves it) and re-test.`,
      });
    case 422:
      return withDetails({
        kind: "err",
        message: `HTTP 422 — IndexNow rejected the submission. Most common cause: the test URL (${url}) doesn't belong to host "${testHost}", or the key violates the [a-zA-Z0-9-]{8,128} format. See response body for the exact reason.`,
      });
    case 429:
      return withDetails({
        kind: "warn",
        message:
          "HTTP 429 — IndexNow is rate-limiting (potential spam guard). The key is likely valid; wait a few minutes and re-test.",
      });
    case 0:
      return {
        kind: "err",
        message: "Network error reaching api.indexnow.org. Check edge connectivity and retry.",
      };
    default:
      return withDetails({
        kind: "warn",
        message: `Unexpected HTTP ${result.status} from IndexNow. The key may still be valid — re-test in a few minutes.`,
      });
  }
}

/**
 * Test the Prime Indexer API key by hitting GET /balance. Doesn't
 * burn credits (it's a read), so it's safe to call on every Test.
 *
 * Surfaces the live credit balance + recent-transaction count so the
 * operator gets useful info beyond just "key works."
 */
export async function testPrimeIndexerKey(value: string): Promise<TestResult> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: "err", message: "No Prime Indexer key provided. Enter a value before testing." };
  }
  const result = await checkPrimeBalance(trimmed);
  if (result.ok) {
    const tx = result.balance.recentTransactionCount;
    return {
      kind: "ok",
      message: `Key valid. Current balance: ${result.balance.balance} credits${
        tx > 0 ? ` (${tx} recent transactions)` : ""
      }.`,
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      kind: "err",
      message: `Prime Indexer rejected the key (HTTP ${result.status}). Re-copy from app.primeindexer.com → Settings → API.`,
      details: result.message,
    };
  }
  if (result.status === 0) {
    return {
      kind: "err",
      message: "Network error reaching app.primeindexer.com. Check edge connectivity and retry.",
      details: result.message,
    };
  }
  return {
    kind: "warn",
    message: `Unexpected HTTP ${result.status} from Prime Indexer. The key may still be valid.`,
    details: result.message,
  };
}

/**
 * Test the Sinbyte API key by submitting one URL.
 *
 * Sinbyte has no documented read-only endpoint (no balance check, no
 * key-only verify), so the only definitive test is a real submission.
 * This burns ONE entry from the operator's plan quota — acceptable
 * cost for "did the key actually work" confidence.
 *
 * Uses method="tools" since that's what the platform uses for
 * auto-ping + manual submissions; no GSC verification required.
 */
export async function testSinbyteKey(value: string, testHost: string): Promise<TestResult> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: "err", message: "No Sinbyte key provided. Enter a value before testing." };
  }
  if (!testHost.trim()) {
    return {
      kind: "err",
      message:
        "No proxy domain available to test against. Add a proxied site first — Sinbyte tests submit a single homepage URL.",
    };
  }
  const result = await submitToSinbyte({
    apikey: trimmed,
    name: `edge-seo test ${new Date().toISOString()}`,
    dripfeed: 1,
    method: "tools",
    urls: [`https://${testHost}/`],
  });
  if (result.ok) {
    return {
      kind: "ok",
      message:
        "Sinbyte accepted the submission (status: ok). Note: this consumed ONE entry from your plan quota.",
    };
  }
  if (result.status === 0) {
    return {
      kind: "err",
      message: "Network error reaching app.sinbyte.com. Check edge connectivity and retry.",
    };
  }
  return {
    kind: "err",
    message: `Sinbyte rejected the submission (HTTP ${result.status}). The key may be invalid, the plan may be expired, or the response shape changed.`,
    ...(result.responseBody ? { details: result.responseBody } : {}),
  };
}

/**
 * Test the Omega Indexer API key by submitting one URL.
 *
 * Same pattern as Sinbyte — Omega has no documented read-only
 * endpoint (no balance check), so the only definitive test is a
 * real submission. Costs 1 credit from the operator's plan.
 */
export async function testOmegaIndexerKey(value: string, testHost: string): Promise<TestResult> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: "err", message: "No Omega Indexer key provided. Enter a value before testing." };
  }
  if (!testHost.trim()) {
    return {
      kind: "err",
      message:
        "No proxy domain available to test against. Add a proxied site first — Omega tests submit a single homepage URL.",
    };
  }
  const result = await submitToOmegaIndexer({
    apikey: trimmed,
    campaignname: `edge-seo test ${new Date().toISOString()}`,
    urls: [`https://${testHost}/`],
  });
  if (result.ok) {
    return {
      kind: "ok",
      message:
        "Omega Indexer accepted the submission (HTTP 2xx). Note: this consumed ONE credit from your Omega plan.",
      ...(result.responseBody ? { details: result.responseBody } : {}),
    };
  }
  if (result.status === 0) {
    return {
      kind: "err",
      message: "Network error reaching omegaindexer.com. Check edge connectivity and retry.",
    };
  }
  return {
    kind: "err",
    message: `Omega Indexer rejected the submission (HTTP ${result.status}). The key may be invalid, the plan may be expired, or the request shape changed.`,
    ...(result.responseBody ? { details: result.responseBody } : {}),
  };
}

/**
 * Stub tester — kept for any future indexer slot whose API contract
 * isn't yet wired. All current indexers (IndexNow, Prime, Sinbyte,
 * Omega) have real testers above; this is the fallback for new slots.
 *
 * Just checks the value is non-empty and looks plausible (printable
 * ASCII, reasonable length).
 */
export function testStubIndexerKey(value: string, serviceLabel: string): TestResult {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      kind: "err",
      message: `No ${serviceLabel} key provided. Enter a value before testing.`,
    };
  }
  if (trimmed.length < 8) {
    return {
      kind: "err",
      message: `Value is too short to be a valid ${serviceLabel} key (got ${trimmed.length} chars). Most service keys are 16–64 chars.`,
    };
  }
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    return {
      kind: "err",
      message:
        "Value contains non-printable characters. Make sure you copied the key as plain text (no smart quotes, no whitespace).",
    };
  }
  return {
    kind: "warn",
    message: `Shape check passed (${trimmed.length} printable ASCII chars). Live ${serviceLabel} integration is pending — paste the value here so the secret is ready when the integration ships.`,
  };
}

/**
 * Test a Google Search Console service-account JSON blob.
 *
 * The full GSC integration is deferred (PRD §7.8), so this is shape
 * validation only — confirms the pasted blob parses as JSON and
 * carries the expected service-account fields. A future slice will
 * extend this to do a real OAuth token exchange + a benign API call.
 */
export function testGscServiceAccount(value: string): TestResult {
  if (!value.trim()) {
    return {
      kind: "err",
      message: "No JSON provided. Paste a service-account JSON before testing.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return {
      kind: "err",
      message: "Not valid JSON. Paste the entire service-account file contents.",
      details: e instanceof Error ? e.message : String(e),
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "err", message: "JSON parsed but isn't an object." };
  }
  const obj = parsed as Record<string, unknown>;
  const required = ["client_email", "private_key", "project_id", "type"];
  const missing = required.filter(
    (k) => typeof obj[k] !== "string" || (obj[k] as string).length === 0,
  );
  if (missing.length > 0) {
    return {
      kind: "err",
      message: `JSON is missing required fields: ${missing.join(", ")}.`,
    };
  }
  if (obj.type !== "service_account") {
    return {
      kind: "warn",
      message: `Type is "${String(obj.type)}" — expected "service_account". This may not be the right credential file.`,
    };
  }
  return {
    kind: "warn",
    message:
      "JSON shape looks valid (client_email, private_key, project_id present). Live GSC integration is deferred — this is a shape check only, no API call was made.",
  };
}
