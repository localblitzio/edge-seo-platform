/**
 * Audience-aware steering — resolver + action applier.
 *
 * Sits between auth (§5.2) and redirect resolution (§5.3) in the
 * worker pipeline. For each request:
 *   1. Classify the audience (human / bot family + category) from the
 *      User-Agent header
 *   2. Walk `config.audience_rules` first-match-wins
 *   3. If a rule matches, apply its action and return a terminal
 *      Response (the regular pipeline is short-circuited)
 *
 * Rule schema lives in src/config/schema.ts. Bot taxonomy comes from
 * src/observability/logger.ts so adding a new bot family extends both
 * the dashboard and audience-rule matching automatically.
 */

import type { AudienceAction, AudienceRule, ClientConfig } from "../config/schema.js";
import { renderCustomPage } from "../custom-pages/index.js";
import type { Env } from "../env.js";
import { type BotCategory, classifyUserAgentDetailed } from "../observability/logger.js";

/**
 * Discriminated audience class derived from the User-Agent. The
 * worker computes this once per request and reuses it for both
 * audience-rule matching AND the bot_hits write (so they stay in
 * sync about what counts as which family/category).
 */
export type AudienceClass =
  | { kind: "human" }
  | { kind: "bot"; family: string; category: BotCategory };

/**
 * Map a User-Agent to an audience class. Pure — no side effects.
 *
 * `human` covers anything classified as a real browser; `bot` covers
 * everything else, including unknown crawlers (`other-bot` category).
 */
export function classifyAudience(userAgent: string | null | undefined): AudienceClass {
  const detailed = classifyUserAgentDetailed(userAgent);
  if (detailed.category === "human") return { kind: "human" };
  return { kind: "bot", family: detailed.family, category: detailed.category };
}

/**
 * Walk audience_rules first-match-wins and return the matching rule
 * (or null when no rule applies). A rule matches when ALL of:
 *   - `match` regex tests the path successfully
 *   - audience.type matches the audience class kind
 *   - if audience.family set: matches the request's family
 *   - if audience.category set: matches the request's category
 *
 * Both `family` and `category` constraints are AND-ed when set —
 * lets you write "any GPTBot variant" (family-only) or "any
 * AI-training crawler" (category-only) or both.
 *
 * Malformed regex in `match` is silently skipped (admin-time
 * validator already rejected unsafe patterns).
 */
export function matchAudienceRule(
  path: string,
  audience: AudienceClass,
  config: ClientConfig,
): AudienceRule | null {
  for (const rule of config.audience_rules) {
    let pathRe: RegExp;
    try {
      pathRe = new RegExp(rule.match);
    } catch {
      continue;
    }
    if (!pathRe.test(path)) continue;

    if (rule.audience.type === "human") {
      if (audience.kind !== "human") continue;
    } else {
      // rule targets bots
      if (audience.kind !== "bot") continue;
      if (rule.audience.family && rule.audience.family !== audience.family) continue;
      if (rule.audience.category && rule.audience.category !== audience.category) continue;
    }
    return rule;
  }
  return null;
}

/**
 * Apply a matched rule's action to the in-flight request. Returns a
 * terminal Response (the regular pipeline doesn't run for this
 * request).
 *
 * Action types:
 *   - `redirect` → 3xx with Location header
 *   - `block`    → 403 or 410 with text/plain body
 *   - `custom_page` → R2/KV-backed custom page render (matches the
 *     existing `custom_page` route type — operator authors via the
 *     same UI)
 */
export async function applyAudienceAction(
  action: AudienceAction,
  url: URL,
  _config: ClientConfig,
  env: Env,
): Promise<Response> {
  switch (action.type) {
    case "redirect": {
      // Resolve the destination relative to the current proxy domain
      // when it's a path (starts with `/` or doesn't parse as URL).
      let location: string;
      try {
        const parsed = new URL(action.url);
        location = parsed.toString();
      } catch {
        location = action.url.startsWith("/") ? action.url : `/${action.url}`;
      }
      return new Response(null, {
        status: Number(action.status),
        headers: { Location: location },
      });
    }
    case "block":
      return new Response(action.status === "410" ? "Gone" : "Forbidden", {
        status: Number(action.status),
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    case "custom_page": {
      // Custom pages live in R2/KV under the operator's chosen key.
      // We delegate to the same renderer the regular custom_page
      // route uses so the behaviour is identical.
      return renderCustomPage(
        url,
        {
          match: ".*",
          type: "custom_page",
          custom_page_key: action.custom_page_key,
          origin_auth: { type: "none" },
        },
        env,
      );
    }
    default: {
      // Exhaustiveness — TS proves all branches are covered above.
      const _exhaustive: never = action;
      void _exhaustive;
      return new Response("Unknown audience action", { status: 500 });
    }
  }
}
