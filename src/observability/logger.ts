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

/**
 * Higher-level grouping for the per-site Bot activity dashboard. Each
 * known bot family is tagged with one of these so the UI can show:
 * "AI training crawlers: 4,329 hits in 24h" without listing every UA.
 */
export type BotCategory =
  | "search-engine" // Google, Bing, DuckDuckGo, Yandex, Baidu — index our pages for users
  | "ai-training" // GPTBot, ClaudeBot, CCBot, Google-Extended (Gemini), Bytespider — train LLMs
  | "ai-search" // PerplexityBot, ChatGPT-User, OAI-SearchBot — answer-engine retrieval
  | "social" // Facebook, Twitter/X, LinkedIn, Slack, Pinterest — link previews
  | "monitoring" // UptimeRobot, Pingdom, etc. — operator-installed
  | "other-bot" // Anything bot-shaped we don't recognise
  | "human";

/**
 * Per-family classifier table. Each entry maps a UA substring (lowercase)
 * to a stable `family` identifier and a `category`. First match wins —
 * order matters: more-specific patterns first (e.g. "googlebot-image"
 * before "googlebot"). Patterns are checked with `String.includes`,
 * lowercased before comparison.
 *
 * Extending this table is the only safe way to add a new bot — every
 * other code path keys off `family`. Don't introduce new `category`
 * values without updating the dashboard renderer.
 */
const BOT_PATTERNS: ReadonlyArray<{
  pattern: string;
  family: string;
  category: BotCategory;
}> = [
  // Google variants — order: more-specific first.
  { pattern: "google-extended", family: "google-extended", category: "ai-training" },
  { pattern: "googlebot-image", family: "googlebot-image", category: "search-engine" },
  { pattern: "googlebot-mobile", family: "googlebot-mobile", category: "search-engine" },
  { pattern: "adsbot-google", family: "adsbot-google", category: "search-engine" },
  { pattern: "mediapartners-google", family: "mediapartners-google", category: "search-engine" },
  { pattern: "googlebot", family: "googlebot", category: "search-engine" },

  // AI training crawlers (LLM training data).
  { pattern: "gptbot", family: "gptbot", category: "ai-training" },
  { pattern: "ccbot", family: "ccbot", category: "ai-training" },
  { pattern: "bytespider", family: "bytespider", category: "ai-training" },
  { pattern: "applebot-extended", family: "applebot-extended", category: "ai-training" },
  { pattern: "claudebot", family: "claudebot", category: "ai-training" },
  { pattern: "claude-web", family: "claude-web", category: "ai-training" },
  { pattern: "anthropic-ai", family: "anthropic-ai", category: "ai-training" },
  { pattern: "meta-externalagent", family: "meta-externalagent", category: "ai-training" },

  // AI answer-engine fetchers (run inline when a user asks a question).
  { pattern: "perplexitybot", family: "perplexitybot", category: "ai-search" },
  { pattern: "perplexity-user", family: "perplexity-user", category: "ai-search" },
  { pattern: "chatgpt-user", family: "chatgpt-user", category: "ai-search" },
  { pattern: "oai-searchbot", family: "oai-searchbot", category: "ai-search" },
  { pattern: "youbot", family: "youbot", category: "ai-search" },

  // Other major search engines.
  { pattern: "bingbot", family: "bingbot", category: "search-engine" },
  { pattern: "duckduckbot", family: "duckduckbot", category: "search-engine" },
  { pattern: "yandexbot", family: "yandexbot", category: "search-engine" },
  { pattern: "baiduspider", family: "baiduspider", category: "search-engine" },
  { pattern: "applebot", family: "applebot", category: "search-engine" }, // bare Applebot (not -Extended)
  { pattern: "seznambot", family: "seznambot", category: "search-engine" },

  // Social link previewers.
  {
    pattern: "facebookexternalhit",
    family: "facebookexternalhit",
    category: "social",
  },
  { pattern: "facebookbot", family: "facebookbot", category: "social" },
  { pattern: "twitterbot", family: "twitterbot", category: "social" },
  { pattern: "linkedinbot", family: "linkedinbot", category: "social" },
  { pattern: "slackbot", family: "slackbot", category: "social" },
  { pattern: "pinterestbot", family: "pinterestbot", category: "social" },
  { pattern: "discordbot", family: "discordbot", category: "social" },
  { pattern: "telegrambot", family: "telegrambot", category: "social" },
  { pattern: "whatsapp", family: "whatsapp", category: "social" },

  // Operator-installed monitoring.
  { pattern: "uptimerobot", family: "uptimerobot", category: "monitoring" },
  { pattern: "pingdom", family: "pingdom", category: "monitoring" },
  { pattern: "statuscake", family: "statuscake", category: "monitoring" },
];

/** UA-class strings that bypass sampling (always logged). Computed
 *  from the BOT_PATTERNS table above so adding a new bot doesn't
 *  require updating two places. */
const BOT_UA_CLASSES: ReadonlySet<string> = new Set(BOT_PATTERNS.map((p) => p.family));

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
 * Detailed classification — returns both the family (for deduping +
 * dashboard grouping) and the higher-level category. Use this when
 * you need the category (e.g. the bot_hits write path); use
 * `classifyUserAgent` when you just need the family string for
 * logging.
 *
 * Heuristic substring match against BOT_PATTERNS — first match wins.
 * Lowercased before comparison.
 */
export function classifyUserAgentDetailed(userAgent: string | null | undefined): {
  family: string;
  category: BotCategory;
} {
  if (!userAgent) return { family: "other", category: "other-bot" };
  const ua = userAgent.toLowerCase();
  for (const entry of BOT_PATTERNS) {
    if (ua.includes(entry.pattern)) {
      return { family: entry.family, category: entry.category };
    }
  }
  // Generic browser detection — anything claiming to be Mozilla or naming
  // a major rendering engine is treated as human traffic for sampling.
  if (
    ua.includes("mozilla/") ||
    ua.includes("safari/") ||
    ua.includes("chrome/") ||
    ua.includes("firefox/")
  ) {
    return { family: "human", category: "human" };
  }
  // Unknown bot-shaped UA (curl, wget, libraries, custom scrapers).
  return { family: "other", category: "other-bot" };
}

/**
 * Classify a User-Agent string into one of the known classes.
 *
 * Returns just the family identifier — the value placed in
 * `LogEntry.user_agent_class`. Use `classifyUserAgentDetailed` when
 * you also need the BotCategory for grouping/dashboards.
 *
 * @param userAgent the raw `User-Agent` header value, or null
 * @returns the bot family ("googlebot", "gptbot", etc.), "human", or "other"
 * @throws never
 */
export function classifyUserAgent(userAgent: string | null | undefined): string {
  return classifyUserAgentDetailed(userAgent).family;
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
