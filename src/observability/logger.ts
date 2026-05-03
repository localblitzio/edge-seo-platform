/**
 * Per-request structured logger.
 * Spec: docs/tech-spec.md §6.7.
 *
 * Sampling (§6.7):
 *   - 100% for bot user-agents (always log SEO-relevant requests).
 *   - 5% for human traffic (default; configurable per env in future).
 *   - Always log on status >= 500 OR when `errors[]` is non-empty.
 *
 * Redaction (§10):
 *   - Never log: full body (req or res), cookies, Authorization header,
 *     query params matching `/(token|key|password|auth|secret|api)/i`.
 *   - The `LogEntry` shape excludes bodies/cookies/auth headers by design;
 *     `request_url` is the only field that can carry sensitive query
 *     parameters, so we redact it on emission as a defense-in-depth pass.
 *
 * SLO calculations (cache hit ratio, p95 latency, error rate from PRD §10)
 * MUST come from `metrics.ts` (Workers Analytics Engine), NOT this stream.
 * The sampled log stream is for diagnostics only.
 */

/** Default human-traffic sample rate (§6.7). Override per env in future. */
export const DEFAULT_HUMAN_SAMPLE_RATE = 0.05;

/** UA-class strings that bypass sampling (always logged). */
const BOT_UA_CLASSES: ReadonlySet<string> = new Set([
  "googlebot",
  "bingbot",
  "perplexitybot",
  "claudebot",
  "gptbot",
]);

const SENSITIVE_QUERY_PARAM_RE = /^(token|key|password|auth|secret|api)/i;
const REDACTED = "REDACTED";

export interface LogEntry {
  timestamp: string;
  client_id: string;
  proxy_domain: string;
  request_url: string;
  request_method: string;
  request_path: string;
  /**
   * Classifier identifier. Well-known values: "googlebot", "bingbot",
   * "perplexitybot", "claudebot", "gptbot", "human", "other". New bots
   * can be added via the classifier without spec changes.
   */
  user_agent_class: string;
  status: number;
  origin_status: number | null;
  pipeline_stage:
    | "redirect_static"
    | "redirect_pattern"
    | "redirect_conditional"
    | "proxy"
    | "custom_page"
    | "404";
  redirect_destination: string | null;
  canonical_url: string | null;
  canonical_strategy: string | null;
  cache_status: "hit" | "miss" | "bypass" | "skip";
  duration_ms: number;
  origin_duration_ms: number | null;
  errors: string[];
}

export interface LogRequestOptions {
  /** Override the human sampling rate (0..1). Defaults to 0.05. */
  humanSampleRate?: number;
  /** Override the random source for deterministic testing. */
  random?: () => number;
}

/**
 * Whether a `user_agent_class` value is one of the known bot classifiers.
 *
 * @param uaClass the value placed in `LogEntry.user_agent_class`
 * @returns true for bot UAs, false otherwise
 * @throws never
 */
export function isBotUserAgentClass(uaClass: string): boolean {
  return BOT_UA_CLASSES.has(uaClass);
}

/**
 * Classify a User-Agent string into one of the known classes.
 *
 * Heuristic substring match. Future bots are added to this function
 * (config-driven classifier registry is a future improvement; the
 * `user_agent_class` field is intentionally `string`, not an enum,
 * to allow that without a schema bump).
 *
 * @param userAgent the raw `User-Agent` header value, or null
 * @returns one of "googlebot" | "bingbot" | "perplexitybot" | "claudebot"
 *   | "gptbot" | "human" | "other"
 * @throws never
 */
export function classifyUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "other";
  const ua = userAgent.toLowerCase();
  if (ua.includes("googlebot")) return "googlebot";
  if (ua.includes("bingbot")) return "bingbot";
  if (ua.includes("perplexitybot")) return "perplexitybot";
  if (ua.includes("claudebot") || ua.includes("claude-")) return "claudebot";
  if (ua.includes("gptbot") || ua.includes("oai-searchbot")) return "gptbot";
  // Generic browser detection — anything claiming to be Mozilla or naming
  // a major rendering engine is treated as human traffic for sampling.
  if (
    ua.includes("mozilla/") ||
    ua.includes("safari/") ||
    ua.includes("chrome/") ||
    ua.includes("firefox/")
  ) {
    return "human";
  }
  return "other";
}

/**
 * Decide whether a given LogEntry should be emitted under the current
 * sampling policy.
 *
 * @param entry the constructed log entry
 * @param humanSampleRate sampling rate for human UAs (0..1)
 * @param random RNG used to compare against the sample rate
 * @returns true if the entry should be emitted
 * @throws never
 */
export function shouldLog(entry: LogEntry, humanSampleRate: number, random: () => number): boolean {
  // Always-log conditions short-circuit the sampler.
  if (entry.status >= 500) return true;
  if (entry.errors.length > 0) return true;
  if (isBotUserAgentClass(entry.user_agent_class)) return true;
  return random() < humanSampleRate;
}

/**
 * Emit a `LogEntry` according to the sampling and redaction policy.
 *
 * @param entry the constructed log entry
 * @param options optional overrides for sampling rate / RNG
 * @returns void
 * @throws never (logging is best-effort)
 */
export function logRequest(entry: LogEntry, options: LogRequestOptions = {}): void {
  const humanSampleRate = options.humanSampleRate ?? DEFAULT_HUMAN_SAMPLE_RATE;
  const random = options.random ?? Math.random;

  if (!shouldLog(entry, humanSampleRate, random)) return;

  const redacted: LogEntry = {
    ...entry,
    request_url: redactSensitiveQueryParams(entry.request_url),
  };

  // Logpush picks up `console.log` JSON lines and ships them to LOGS_R2
  // (see spec §7.11). Use `console.log`, not `console.error`, so the
  // log pipeline doesn't treat the stream as error output.
  console.log(JSON.stringify(redacted));
}

/**
 * Redact query-string values whose parameter name matches the sensitive
 * regex from §10. Returns the input unchanged if the URL is unparseable
 * or has no query string.
 *
 * @param url an absolute or relative URL string
 * @returns URL with sensitive query values replaced by "REDACTED"
 * @throws never
 */
export function redactSensitiveQueryParams(url: string): string {
  // Parse against a placeholder base so relative URLs work.
  let parsed: URL;
  try {
    parsed = new URL(url, "https://_redaction_placeholder.invalid");
  } catch {
    return url;
  }
  if (!parsed.search) return url;

  let mutated = false;
  const names = Array.from(parsed.searchParams.keys());
  for (const name of names) {
    if (SENSITIVE_QUERY_PARAM_RE.test(name)) {
      parsed.searchParams.set(name, REDACTED);
      mutated = true;
    }
  }
  if (!mutated) return url;

  // If the input was a full URL, return the parsed full URL; otherwise
  // strip the synthetic origin so we return a relative URL like the input.
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return parsed.toString();
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
