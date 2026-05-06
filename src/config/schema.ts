/**
 * ClientConfig schema — the single source of truth.
 * Spec: docs/tech-spec.md §4 (transcribed verbatim).
 *
 * TypeScript types are inferred from these schemas. Do NOT redefine types
 * elsewhere — extend the Zod schema here and the inferred types follow.
 *
 * Load-time invariants beyond raw Zod parse live in `validator.ts`.
 */

import { z } from "zod";

export const RedirectStatusCode = z.enum(["301", "302", "307", "308", "410"]);

export const StaticRedirect = z.object({
  /** exact path match, must start with `/` */
  from: z.string(),
  /** absolute URL or path */
  to: z.string(),
  status: RedirectStatusCode.default("301"),
  preserve_query: z.boolean().default(true),
});

export const PatternRedirect = z.object({
  /** regex, anchored unless explicitly not */
  pattern: z.string(),
  /** supports $1, $2 backreferences */
  replacement: z.string(),
  status: RedirectStatusCode.default("301"),
});

export const ConditionalRedirect = z.object({
  /** regex on path */
  match: z.string(),
  conditions: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("geo_country"), in: z.array(z.string()) }),
      z.object({
        type: z.literal("device"),
        is: z.enum(["mobile", "desktop", "tablet"]),
      }),
      z.object({
        type: z.literal("cookie"),
        name: z.string(),
        equals: z.string().optional(),
        exists: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("query_param"),
        name: z.string(),
        equals: z.string().optional(),
        exists: z.boolean().optional(),
      }),
      z.object({ type: z.literal("referrer"), contains: z.string() }),
    ]),
  ),
  to: z.string(),
  status: RedirectStatusCode.default("302"),
});

export const CanonicalStrategy = z.discriminatedUnion("type", [
  z.object({ type: z.literal("self") }),
  z.object({ type: z.literal("origin") }),
  z.object({ type: z.literal("custom"), url: z.string().url() }),
  z.object({ type: z.literal("noindex") }),
]);

export const CanonicalRule = z.object({
  /** regex on path */
  match: z.string(),
  strategy: CanonicalStrategy,
  sync_og_url: z.boolean().default(true),
  sync_twitter_url: z.boolean().default(true),
  sync_jsonld_url: z.boolean().default(true),
});

export const SchemaInjection = z.object({
  match: z.string(),
  schema_type: z.enum([
    "FAQPage",
    "Article",
    "LocalBusiness",
    "Service",
    "BreadcrumbList",
    "HowTo",
    "Speakable",
    "Product",
  ]),
  /** JSON-LD payload — must be JSON-serializable (validator.ts enforces) */
  payload: z.record(z.unknown()),
  position: z.enum(["head_append", "head_prepend"]).default("head_append"),
});

export const LinkRewriteRule = z.object({
  /** path regex; rule applies on pages whose path matches */
  match: z.string(),
  /** regex on href */
  match_pattern: z.string(),
  /** supports backreferences */
  replacement: z.string(),
});

export const ElementRemoveRule = z.object({
  /** path regex */
  match: z.string(),
  /** CSS selector */
  selector: z.string(),
});

export const ContentInjectRule = z.object({
  /** path regex */
  match: z.string(),
  /** target element */
  selector: z.string(),
  position: z.enum(["before", "after", "prepend", "append", "replace"]),
  html: z.string(),
});

export const MetaRewriteRule = z.object({
  /** path regex */
  match: z.string(),
  tag: z.enum([
    "title",
    "description",
    "robots",
    "og:title",
    "og:description",
    "og:image",
    "og:type",
    "og:site_name",
    "twitter:card",
    "twitter:title",
    "twitter:description",
    "twitter:image",
  ]),
  value: z.string(),
});

export const TextRewriteRule = z.object({
  /**
   * Path regex. Rule applies on pages whose path matches.
   * Validated by `assertConfigInvariants` for ReDoS shape and ≤512 chars.
   */
  match: z.string(),
  /**
   * CSS selector — anything HTMLRewriter accepts. Examples: `h1`,
   * `h2.hero-title`, `main p:first-of-type`, `[data-cta]`.
   */
  selector: z.string(),
  /**
   * `text` (default) replaces the element's inner content with text-
   * escaped content (no HTML allowed; `<`, `>`, `&` are entity-encoded).
   * `html` replaces with raw HTML — caller is responsible for safety.
   */
  mode: z.enum(["text", "html"]).default("text"),
  /** The replacement content. */
  content: z.string(),
});

export const IndexationRule = z.object({
  match: z.string(),
  robots: z.enum(["index,follow", "noindex,follow", "noindex,nofollow", "index,nofollow"]),
  additional_directives: z
    .array(z.enum(["noarchive", "nosnippet", "max-image-preview:large", "max-snippet:-1"]))
    .default([]),
});

export const OriginAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("aop") }),
  z.object({
    type: z.literal("header_token"),
    header: z.string(),
    secret_name: z.string(),
  }),
  z.object({ type: z.literal("mtls"), cert_secret_name: z.string() }),
]);

export const RouteRule = z.object({
  /** path regex, anchored at start unless explicitly not (e.g. "^/blog/", "^/lp/") */
  match: z.string(),
  type: z.enum(["proxy", "custom_page"]),
  /** required for proxy */
  origin: z.string().optional(),
  origin_auth: OriginAuth.default({ type: "none" }),
  /** strip from path before forwarding */
  strip_prefix: z.string().optional(),
  /** KV/R2 key prefix for custom_page */
  custom_page_key: z.string().optional(),
});

export const CacheRule = z.object({
  match: z.string(),
  ttl_seconds: z.number().int().nonnegative(),
  cache_key_includes_cookies: z.array(z.string()).default([]),
  bypass_on_cookie: z.array(z.string()).default([]),
});

export const FormHandling = z.object({
  /** regex on form action URL */
  match_action: z.string(),
  forward_to: z.string().url(),
  capture_to_d1: z.boolean().default(false),
});

export const Authorization = z.object({
  attested_by_email: z.string().email(),
  attested_at: z.string().datetime(),
  attested_ip: z.string(),
  scope: z.enum(["full_site", "specified_paths"]),
  scope_paths: z.array(z.string()).optional(),
  expires_at: z.string().datetime().nullable(),
});

export const ClientConfig = z.object({
  /**
   * RFC 1035 LDH (letter-digit-hyphen), no leading/trailing hyphen, ≤63 chars.
   * Tighter than the original `[a-z0-9_-]+` so the same string is safe to use
   * as a DNS subdomain when a client adopts the default proxy zone (no
   * underscores in DNS labels, length cap, edge-hyphen rule). Existing
   * clients are unaffected as long as their ids are already DNS-safe.
   */
  client_id: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    .max(63),
  /**
   * Deployment mode for this client.
   *   - `subdomain_proxy` (default, back-compat): the worker runs on a
   *     controlled zone like `*.localpage.us.com`. `proxy_domain` is
   *     the public-facing host, `source_domain` is the upstream.
   *     Cookie domains and absolute Location headers are rewritten
   *     from source → proxy on the way out.
   *   - `in_place`: the worker runs on the customer's own domain via
   *     a Workers Route on the same Cloudflare account. `proxy_domain`
   *     and `source_domain` are typically identical (the customer's
   *     domain). Origin-pull goes to `routing[].origin` (which MUST
   *     differ from the customer's domain, e.g. `origin.customer.com`,
   *     to avoid an infinite loop). Cookie/Location host rewrites are
   *     skipped because the customer-facing host equals the source.
   */
  mode: z.enum(["subdomain_proxy", "in_place"]).default("subdomain_proxy"),
  /**
   * Bare DNS hostname — `acme.com`, `www.acme.com`, `lp.acme.co.uk`. NO
   * scheme (`https://`), NO trailing path (`/`), NO port. The schema
   * regex below catches the most common operator mistake (pasting a
   * full URL into the field) so the loop guard in validator.ts can do
   * a simple host-equality check.
   *
   * Allowed: lowercase letters, digits, hyphens, dots. Each label
   * 1–63 chars. Total length ≤ 253 chars (DNS limit).
   */
  proxy_domain: z
    .string()
    .min(1)
    .max(253)
    .regex(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
      "must be a bare hostname (no scheme, port, or path) — e.g. www.acme.com",
    ),
  source_domain: z
    .string()
    .min(1)
    .max(253)
    .regex(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
      "must be a bare hostname (no scheme, port, or path) — e.g. www.acme.com",
    ),
  authorization: Authorization,
  status: z.enum(["active", "paused", "terminated"]),
  routing: z.array(RouteRule),
  redirects: z.object({
    static: z.array(StaticRedirect).default([]),
    patterns: z.array(PatternRedirect).default([]),
    conditional: z.array(ConditionalRedirect).default([]),
  }),
  canonicals: z.array(CanonicalRule).default([]),
  schema_injections: z.array(SchemaInjection).default([]),
  link_rewrites: z.array(LinkRewriteRule).default([]),
  element_removals: z.array(ElementRemoveRule).default([]),
  content_injections: z.array(ContentInjectRule).default([]),
  text_rewrites: z.array(TextRewriteRule).default([]),
  meta_rewrites: z.array(MetaRewriteRule).default([]),
  indexation: z.array(IndexationRule).default([]),
  caching: z.array(CacheRule).default([]),
  forms: z.array(FormHandling).default([]),
  /**
   * Schema version. Bumping requires: a discriminated union over
   * `schema_version` with both old and new variants, plus a migration
   * function applied on read. Never break-replace without migration coverage.
   */
  schema_version: z.literal(1),
});

export type ClientConfig = z.infer<typeof ClientConfig>;
export type StaticRedirect = z.infer<typeof StaticRedirect>;
export type PatternRedirect = z.infer<typeof PatternRedirect>;
export type ConditionalRedirect = z.infer<typeof ConditionalRedirect>;
export type CanonicalRule = z.infer<typeof CanonicalRule>;
export type CanonicalStrategy = z.infer<typeof CanonicalStrategy>;
export type SchemaInjection = z.infer<typeof SchemaInjection>;
export type LinkRewriteRule = z.infer<typeof LinkRewriteRule>;
export type ElementRemoveRule = z.infer<typeof ElementRemoveRule>;
export type ContentInjectRule = z.infer<typeof ContentInjectRule>;
export type TextRewriteRule = z.infer<typeof TextRewriteRule>;
export type MetaRewriteRule = z.infer<typeof MetaRewriteRule>;
export type IndexationRule = z.infer<typeof IndexationRule>;
export type OriginAuth = z.infer<typeof OriginAuth>;
export type RouteRule = z.infer<typeof RouteRule>;
export type CacheRule = z.infer<typeof CacheRule>;
export type FormHandling = z.infer<typeof FormHandling>;
export type Authorization = z.infer<typeof Authorization>;
