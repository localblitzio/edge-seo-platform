# Technical Specification: Edge SEO Platform

**Companion to:** `edge-seo-platform-prd.md`
**Audience:** Claude Code, OpenAI Codex, and other coding agents
**Status:** Draft v1
**Last updated:** May 2, 2026

---

## How to use this document

This document is the buildable specification. The PRD describes *why* and *what for whom*; this document describes *what to build, exactly*. When the two conflict, this document wins for implementation details.

Read this document end-to-end before writing any code. Do not begin implementation until all of Section 1 (Ground Rules) is understood.

---

## 1. Ground Rules

### 1.1 Behaviors required of the coding agent

- Read the entire spec before starting any task.
- For any ambiguity not resolved by this spec, stop and ask. Do not guess.
- Do not add features, endpoints, configuration options, or modules that are not specified here.
- Do not "improve" or refactor unrelated code while making changes.
- Do not add dependencies beyond those listed in Section 3 without explicit approval.
- Use TypeScript strict mode. No `any` types unless explicitly justified in a code comment.
- Every public function must have a JSDoc comment with `@param`, `@returns`, and `@throws`.
- Every module must have a corresponding test file. Tests run before commits.
- All commits must pass lint, typecheck, and test before being pushed.

### 1.2 Behaviors prohibited

- Do not write to read-only mounts.
- Do not modify `wrangler.toml` to add new bindings without updating this spec.
- Do not remove or weaken security headers.
- Do not log full request bodies, cookies, or auth headers.
- Do not implement caching strategies not described in Section 9.
- Do not implement authentication or session handling for proxied content.
- Do not write code that fetches third-party origins not configured in client config.

### 1.3 Definition of done (per task)

A task is complete when:
1. The code is written and matches the spec exactly.
2. TypeScript compiles with no errors and no `any` types.
3. Unit tests cover the new code (target: 80%+ line coverage).
4. Integration tests pass against a local Miniflare/Workerd instance.
5. The change is documented in `CHANGELOG.md`.
6. A short summary of what was built and any deviations from spec is reported back.

---

## 2. Repository structure

```
edge-seo-platform/
├── README.md
├── CHANGELOG.md
├── CLAUDE.md                          # entry point for Claude Code
├── AGENTS.md                          # entry point for Codex
├── package.json
├── tsconfig.json
├── wrangler.toml
├── biome.json                         # linter/formatter config
├── vitest.config.ts
├── .github/workflows/ci.yml
├── docs/
│   ├── prd.md                         # the strategic PRD
│   ├── tech-spec.md                   # this document
│   └── runbooks/
├── src/
│   ├── worker.ts                      # Worker entry point
│   ├── router/
│   │   ├── index.ts
│   │   ├── path-matcher.ts
│   │   └── route-resolver.ts
│   ├── redirects/
│   │   ├── index.ts
│   │   ├── static-map.ts
│   │   ├── pattern-matcher.ts
│   │   └── conditional.ts
│   ├── canonical/
│   │   ├── index.ts
│   │   └── strategies.ts
│   ├── transform/
│   │   ├── index.ts
│   │   ├── schema-injector.ts
│   │   ├── link-rewriter.ts
│   │   ├── element-remover.ts
│   │   ├── content-injector.ts
│   │   └── meta-rewriter.ts
│   ├── indexation/
│   │   └── index.ts
│   ├── proxy/
│   │   ├── index.ts
│   │   ├── request-builder.ts
│   │   └── response-handler.ts
│   ├── custom-pages/
│   │   ├── index.ts
│   │   └── renderer.ts
│   ├── config/
│   │   ├── schema.ts                  # zod schema, source of truth
│   │   ├── loader.ts                  # KV/D1 loader with cache
│   │   ├── validator.ts
│   │   └── types.ts                   # generated from schema
│   ├── observability/
│   │   ├── logger.ts
│   │   ├── metrics.ts
│   │   └── log-shipper.ts
│   ├── sitemap/
│   │   ├── generator.ts
│   │   └── indexnow.ts
│   ├── attestation/
│   │   └── recorder.ts
│   └── lib/
│       ├── errors.ts
│       └── headers.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
│       ├── html/                      # sample origin responses
│       └── configs/                   # sample client configs
├── admin-ui/                          # Cloudflare Pages app, separate package
└── migrations/                        # D1 schema migrations
```

`CLAUDE.md` and `AGENTS.md` should each be a short pointer file: "Read `docs/tech-spec.md` first. Then read the module spec for the area you're working in."

---

## 3. Stack and dependencies

### 3.1 Runtime

- Cloudflare Workers (Unbound, not Bundled)
- Wrangler 3.x (latest stable)
- Node 20.x (for tooling only, not runtime)
- TypeScript 5.x with `strict: true`

### 3.2 Approved dependencies

Production:
- `zod` — config schema validation (single source of truth for types)
- `itty-router` — only if needed for admin-UI routing; not for Worker (Worker uses native routing)

Development:
- `vitest` — test runner
- `@cloudflare/workers-types` — Worker types
- `miniflare` / `workerd` — local Worker emulation for integration tests
- `@biomejs/biome` — lint and format
- `wrangler` — deploy

Do not add: lodash, axios, moment, express, koa, or any HTTP client libraries. Use native `fetch` and the Workers runtime APIs.

### 3.3 Cloudflare bindings (declared in `wrangler.toml`)

- `CONFIG_KV` — KV namespace for hot config cache
- `CONFIG_DB` — D1 database for source-of-truth config and audit logs
- `CONTENT_R2` — R2 bucket for custom landing page content
- `LOGS_R2` — R2 bucket for log archives (Logpush destination)
- `CACHE` — default Cloudflare cache (no binding name; access via `caches.default`)

Environment variables (set as Worker secrets, not vars):
- `INDEXNOW_KEY` — IndexNow API key
- `GSC_SERVICE_ACCOUNT_JSON` — Google Search Console submission credentials

---

## 4. Configuration schema (source of truth)

Defined as a Zod schema in `src/config/schema.ts`. TypeScript types are generated from it. This is the contract the entire system depends on.

```typescript
import { z } from "zod";

export const RedirectStatusCode = z.enum(["301", "302", "307", "308", "410"]);

export const StaticRedirect = z.object({
  from: z.string(),                    // exact path match, must start with /
  to: z.string(),                      // absolute URL or path
  status: RedirectStatusCode.default("301"),
  preserve_query: z.boolean().default(true),
});

export const PatternRedirect = z.object({
  pattern: z.string(),                 // regex, anchored unless explicitly not
  replacement: z.string(),             // supports $1, $2 backreferences
  status: RedirectStatusCode.default("301"),
});

export const ConditionalRedirect = z.object({
  match: z.string(),                   // regex on path
  conditions: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("geo_country"), in: z.array(z.string()) }),
    z.object({ type: z.literal("device"), is: z.enum(["mobile", "desktop", "tablet"]) }),
    z.object({ type: z.literal("cookie"), name: z.string(), equals: z.string().optional(), exists: z.boolean().optional() }),
    z.object({ type: z.literal("query_param"), name: z.string(), equals: z.string().optional(), exists: z.boolean().optional() }),
    z.object({ type: z.literal("referrer"), contains: z.string() }),
  ])),
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
  match: z.string(),                   // regex on path
  strategy: CanonicalStrategy,
  sync_og_url: z.boolean().default(true),
  sync_twitter_url: z.boolean().default(true),
  sync_jsonld_url: z.boolean().default(true),
});

export const SchemaInjection = z.object({
  match: z.string(),
  schema_type: z.enum(["FAQPage", "Article", "LocalBusiness", "Service", "BreadcrumbList", "HowTo", "Speakable", "Product"]),
  payload: z.record(z.unknown()),      // JSON-LD payload as object
  position: z.enum(["head_append", "head_prepend"]).default("head_append"),
});

export const LinkRewriteRule = z.object({
  match: z.string(),                   // path regex; rule applies on pages whose path matches
  match_pattern: z.string(),           // regex on href
  replacement: z.string(),             // supports backreferences
});

export const ElementRemoveRule = z.object({
  match: z.string(),                   // path regex
  selector: z.string(),                // CSS selector
});

export const ContentInjectRule = z.object({
  match: z.string(),                   // path regex
  selector: z.string(),                // target element
  position: z.enum(["before", "after", "prepend", "append", "replace"]),
  html: z.string(),
});

export const MetaRewriteRule = z.object({
  match: z.string(),                   // path regex
  tag: z.enum(["title", "description", "robots", "og:title", "og:description", "og:image", "og:type", "og:site_name", "twitter:card", "twitter:title", "twitter:description", "twitter:image"]),
  value: z.string(),
});

export const IndexationRule = z.object({
  match: z.string(),
  robots: z.enum(["index,follow", "noindex,follow", "noindex,nofollow", "index,nofollow"]),
  additional_directives: z.array(z.enum(["noarchive", "nosnippet", "max-image-preview:large", "max-snippet:-1"])).default([]),
});

export const OriginAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("aop") }),                                                  // Cloudflare Authenticated Origin Pulls
  z.object({ type: z.literal("header_token"), header: z.string(), secret_name: z.string() }),
  z.object({ type: z.literal("mtls"), cert_secret_name: z.string() }),
]);

export const RouteRule = z.object({
  match: z.string(),                   // path regex, anchored at start unless explicitly not (e.g., "^/blog/", "^/lp/")
  type: z.enum(["proxy", "custom_page"]),
  origin: z.string().optional(),       // required for proxy
  origin_auth: OriginAuth.default({ type: "none" }),
  strip_prefix: z.string().optional(), // strip from path before forwarding
  custom_page_key: z.string().optional(), // KV/R2 key prefix for custom_page
});

export const CacheRule = z.object({
  match: z.string(),
  ttl_seconds: z.number().int().nonnegative(),
  cache_key_includes_cookies: z.array(z.string()).default([]),
  bypass_on_cookie: z.array(z.string()).default([]),
});

export const FormHandling = z.object({
  match_action: z.string(),            // regex on form action URL
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
  client_id: z.string().regex(/^[a-z0-9_-]+$/),
  proxy_domain: z.string(),
  source_domain: z.string(),
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
  meta_rewrites: z.array(MetaRewriteRule).default([]),
  indexation: z.array(IndexationRule).default([]),
  caching: z.array(CacheRule).default([]),
  forms: z.array(FormHandling).default([]),
  schema_version: z.literal(1),         // bumping requires: discriminated union over schema_version with both old and new variants, plus a migration function applied on read; never break-replace without migration coverage
});

export type ClientConfig = z.infer<typeof ClientConfig>;
```

Validate every config at load time. Reject and alert on validation failure; do not fall back to defaults.

**Additional load-time invariants** (enforced beyond raw Zod parse):

- `redirects.static[].from` MUST be unique within a config; duplicates fail validation.
- `redirects.static[]` MUST contain at most 1000 entries inline; configs above the cap MUST move the overflow to a separate KV key (`redirects:${client_id}`) populated by the admin pipeline. Workloads exceeding 100k rules MUST use Cloudflare Bulk Redirects (configured outside the Worker); the Worker still applies pattern and conditional layers.
- All user-supplied regex fields (`pattern`, `match`, `match_pattern`) are validated against a regex linter that rejects nested quantifiers (e.g., `(a+)+`), unbounded backtracking, and patterns longer than 512 characters. Validation failure rejects the entire config; the Worker continues serving the previously cached config until a valid replacement loads.
- For every `RouteRule` of type `proxy` whose `canonicals` do NOT contain a matching rule, validation MAY warn but does not fail (default canonical for proxy routes is `origin`; see §6.3).
- JSON-LD payloads in `schema_injections[].payload` MUST be JSON-serializable; validation runs `JSON.stringify` and fails on cycles or non-serializable values.

---

## 5. Worker request lifecycle (exact order)

The Worker's `fetch` handler executes the following pipeline in this order. Any step may short-circuit and return.

```
1. Resolve config (host header → client_id → ClientConfig from KV)
   Failure: return 502 with error log.

2. Check authorization status and expiry
   If status !== "active": return 410 Gone with text "Service unavailable".
   If authorization.expires_at is set and now > expires_at: return 410 Gone with text "Authorization expired".

3. Apply static redirect map
   If match: return redirect response, log, end.

4. Apply pattern redirect rules
   If match: return redirect response, log, end.

5. Apply conditional redirect rules
   If match: return redirect response, log, end.

6. Resolve route (routing[].match against URL path)
   If no match: return 404.

7. Fetch upstream
   If route.type === "proxy": fetch from origin with rewritten Host.
   If route.type === "custom_page": fetch from KV/R2 by key.

8. Validate response
   On origin 5xx: serve cached version if available, else return 503.
   On origin 4xx: pass through unmodified.

9. Apply HTMLRewriter pipeline (HTML responses only)
   - meta_rewrites
   - canonical (must run after meta_rewrites)
   - schema_injections
   - link_rewrites
   - element_removals
   - content_injections
   - indexation (sets robots meta)

10. Apply header transformations
    - Rewrite Set-Cookie domain
    - Strip origin-leaking headers (Server, X-Powered-By)
    - Add security headers if missing (X-Content-Type-Options: nosniff)
    - Apply cache-control per CacheRule

11. Apply caching
    - Match against CacheRule
    - Store the POST-transform response in `caches.default` with computed cache key
    - Cache lookup runs early (between steps 1 and 3): on cache hit for an HTML response, skip steps 3–10 and return the stored post-transform body directly. The subrequest cache (`cf` object on origin fetch in §6.5) is disabled — caching happens only at the response layer described here.
    - See §9 cache safety invariants for bypass rules.

12. Log to observability pipeline (sampled per Section 11)

13. Return response
```

Each step is a separate module with an explicit input/output contract. See module specs below.

---

## 6. Module specifications

### 6.1 Config loader (`src/config/loader.ts`)

```typescript
export async function loadConfig(
  hostHeader: string,
  env: Env,
  ctx: ExecutionContext
): Promise<ClientConfig | null>;
```

Behavior:
1. Look up `client_id` by `proxy_domain = hostHeader` in KV (key: `domain:${hostHeader}`).
2. If found, fetch full config from KV (key: `config:${client_id}`).
3. If not in KV, fall back to D1 query. On hit, write-through to KV with 60s TTL.
4. Validate against `ClientConfig` Zod schema.
5. Return validated config or `null` if not found.

Performance budget: 5ms p99 on KV cache hit. 50ms p99 on D1 fallback.

Large static-redirect maps (>1000 entries) are stored as a separate KV key (`redirects:${client_id}`) and loaded lazily on first redirect-resolution attempt per request, then cached on the request-scoped object for that request's lifetime.

Errors:
- Throw `ConfigNotFoundError` if domain unknown.
- Throw `ConfigValidationError` with the Zod error if schema invalid.

**Revocation propagation.** On any `status` change to `paused` or `terminated`:
1. Update the D1 `clients` row.
2. Delete KV keys `domain:${proxy_domain}`, `config:${client_id}`, and `redirects:${client_id}`.
3. Issue a Cloudflare API cache purge for the proxy domain (zone purge or by cache tag if tagged).
4. Append an entry to D1 `audit_log` with actor, timestamp, and previous/new status.

End-to-end revocation propagation SLA = admin-action latency + KV global propagation (≤60s) + edge cache purge propagation (typically <30s, ≤5 min worst case). The PRD's "within hours" SLA reflects this compound bound and includes admin response time.

### 6.2 Redirect resolver (`src/redirects/index.ts`)

```typescript
export interface RedirectResult {
  matched: true;
  destination: string;
  status: 301 | 302 | 307 | 308 | 410;
  source_layer: "static" | "pattern" | "conditional";
  source_index: number;
}

export interface NoRedirect {
  matched: false;
}

export function resolveRedirect(
  url: URL,
  request: Request,
  config: ClientConfig
): RedirectResult | NoRedirect;
```

Behavior:
1. Apply static map first (exact path match, O(1) via Map lookup).
2. Apply pattern rules in array order (regex match, first wins).
3. Apply conditional rules in array order (first matching set of conditions wins).
4. Loop detection: if destination resolves to another redirect rule, follow up to 3 hops; on overflow return `{ matched: true, destination: "/", status: 508 }` and log.

**Layer evaluation rules:**
- Each request walks the three layers (static → pattern → conditional) at most once in order. The first match in any layer short-circuits and returns; the destination URL is NOT re-evaluated against earlier or later layers.
- The 3-hop loop guard applies only when a destination matches another rule in the SAME layer (e.g., a static-map entry whose `to` is itself another static-map `from`). Cross-layer chaining is not supported.

Constraints:
- Compile regex patterns once per config load, not per request. Cache compiled patterns. The same compile-once contract applies to all transform regexes (canonicals, link rewrites, element removals, content injections, meta rewrites, indexation).
- Static map lookup must be O(1).

### 6.3 Canonical resolver (`src/canonical/index.ts`)

```typescript
export interface CanonicalDecision {
  strategy: "self" | "origin" | "custom" | "noindex";
  url: string | null;                  // null when strategy is noindex
  sync_og: boolean;
  sync_twitter: boolean;
  sync_jsonld: boolean;
}

export function resolveCanonical(
  url: URL,
  config: ClientConfig
): CanonicalDecision;
```

Behavior:
1. Match URL path against canonical rules in order; first match wins.
2. For `self`: return the proxy URL (current request URL).
3. For `origin`: rewrite hostname to `source_domain`, preserve path/query.
4. For `custom`: return the configured URL.
5. For `noindex`: return `{ strategy: "noindex", url: null, ... }`.
6. If no rule matches: default depends on the resolved route type.
   - For `proxy` routes: return `{ strategy: "origin", url: <source URL with same path/query>, sync_og: true, sync_twitter: true, sync_jsonld: true }`. This avoids publishing the proxy as canonical of duplicated source content (the SEO duplicate-content failure called out in PRD §13).
   - For `custom_page` routes: return `{ strategy: "self", url: currentUrl, sync_og: true, sync_twitter: true, sync_jsonld: true }` (custom pages are unique to the proxy domain).

The HTMLRewriter consumer applies the decision:
- Strip all existing `<link rel="canonical">` tags. Insert one new canonical with the resolved URL (unless noindex).
- If `sync_og`: replace `<meta property="og:url" content="...">`.
- If `sync_twitter`: replace `<meta name="twitter:url" content="...">`.
- If `sync_jsonld`: parse `<script type="application/ld+json">`, update `url` and `@id` fields, re-serialize.
- If `noindex`: do not insert canonical; insert `<meta name="robots" content="noindex">`.

### 6.4 HTMLRewriter pipeline (`src/transform/index.ts`)

```typescript
export function buildRewriter(
  url: URL,
  config: ClientConfig,
  canonicalDecision: CanonicalDecision
): HTMLRewriter;
```

Behavior:
1. Build a single `HTMLRewriter` instance with handlers attached in the order specified in Section 5, step 9.
2. Each transformation type has its own builder function in its own file.
3. Handlers must be idempotent: running the rewriter twice on the same input produces the same output. Every injected element MUST carry a `data-edge-seo-rule="<rule_id>"` attribute (where `<rule_id>` is a stable hash of the rule definition); before injection, the rewriter removes any existing element matching that marker.
4. Handlers must not buffer the full response body; per-element text accumulation is permitted where required.
5. Where a transformation needs to operate on `<script type="application/ld+json">` content, accumulate the element's text via `text` handler chunks, mutate, and re-emit on the closing tag. Cap accumulated payload at 64 KB per element; on overflow, leave the script unmodified and log a warning.

Worked example — schema injection:

Input HTML:
```html
<head><title>Old Title</title></head>
```

Config:
```json
{ "match": "/.*", "schema_type": "FAQPage", "payload": { "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [...] }, "position": "head_append" }
```

Expected output:
```html
<head><title>Old Title</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[...]}</script></head>
```

Edge cases:
- If a `<script type="application/ld+json">` of the same `@type` already exists, the injected one is appended after it (do not deduplicate; the consumer config decides).
- Escape `</script>` in payloads to `<\/script>`.
- Validate JSON-LD payload is serializable; reject config at load time if not.

### 6.5 Proxy fetch (`src/proxy/index.ts`)

```typescript
export async function fetchFromOrigin(
  request: Request,
  url: URL,
  route: RouteRule,
  config: ClientConfig
): Promise<Response>;
```

Behavior:
1. Build new URL: hostname → `route.origin || config.source_domain`, path → strip `route.strip_prefix` if present.
2. Build new Request: copy method, body, headers; rewrite `Host` to origin hostname.
3. Add `X-Forwarded-For: ${request.headers.get("CF-Connecting-IP")}`.
4. Add `X-Forwarded-Proto: https`.
5. Add `X-Forwarded-Host: ${url.hostname}`.
6. Remove `cf-*` headers except those required by Cloudflare.
7. Apply `route.origin_auth`:
   - `none`: no auth headers added.
   - `aop`: rely on Cloudflare zone-level Authenticated Origin Pulls — no per-request work, but the zone MUST have AOP configured against the origin's expected client cert (operational checklist: §13).
   - `header_token`: read secret named `secret_name` from `env`, set request header `${header}: ${secret}`.
   - `mtls`: use Workers mTLS binding referenced by `cert_secret_name`. Wrangler binding required in `wrangler.toml`.
8. Set fetch options: `redirect: "manual"` (we handle origin redirects ourselves), `cf: { cacheTtl: 0, cacheEverything: false }` (we manage caching at the response layer; subrequest cache disabled).
9. On fetch error (network, timeout, AOP/mTLS handshake failure): throw `OriginFetchError` with cause.
10. Return raw response.

### 6.6 Custom page renderer (`src/custom-pages/index.ts`)

```typescript
export async function renderCustomPage(
  url: URL,
  route: RouteRule,
  env: Env
): Promise<Response>;
```

Behavior:
1. Build storage key: `${route.custom_page_key}${url.pathname}`.
2. Fetch from R2 first (for HTML/MDX content).
3. Fall back to KV (for small dynamic pages).
4. If neither has content: return 404.
5. Wrap content in HTML response with `Content-Type: text/html; charset=utf-8`.
6. Apply same HTMLRewriter pipeline as proxied pages.

### 6.7 Logger (`src/observability/logger.ts`)

```typescript
export interface LogEntry {
  timestamp: string;                   // ISO 8601
  client_id: string;
  proxy_domain: string;
  request_url: string;
  request_method: string;
  request_path: string;
  user_agent_class: string;            // classifier identifier; well-known values: "googlebot" | "bingbot" | "perplexitybot" | "claudebot" | "gptbot" | "human" | "other". New bots added via config-driven classifier without spec changes.
  status: number;
  origin_status: number | null;
  pipeline_stage: "redirect_static" | "redirect_pattern" | "redirect_conditional" | "proxy" | "custom_page" | "404";
  redirect_destination: string | null;
  canonical_url: string | null;
  canonical_strategy: string | null;
  cache_status: "hit" | "miss" | "bypass" | "skip";
  duration_ms: number;
  origin_duration_ms: number | null;
  errors: string[];
}
```

Behavior:
1. Construct `LogEntry` per request.
2. Sample at 100% for bot user agents (always log SEO-relevant requests).
3. Sample at 5% for human traffic (configurable).
4. Always log on status >= 500 or when `errors[]` is non-empty.
5. Write to `console.log` as JSON (Logpush picks it up).
6. Never log: full request body, full response body, cookies, Authorization header, query strings containing `token`, `key`, `password`, `auth`.

**Always-on aggregate counters.** In addition to per-request log entries, the Worker emits unsampled counters via Workers Analytics Engine on every request:

- `requests_total{client_id, status, cache_status, pipeline_stage}`
- `worker_duration_ms` histogram by `{client_id, cache_status}`
- `origin_duration_ms` histogram by `{client_id}`
- `bytes_out` histogram by `{client_id, content_type_class}`

SLO calculations (cache hit ratio, p95 latency, error rate from PRD §10) MUST read from these unsampled counters. The sampled per-request log stream is for diagnostics only and MUST NOT be used to compute headline SLOs.

### 6.8 Attestation recorder (`src/attestation/recorder.ts`)

```typescript
export interface AttestationRecord {
  client_id: string;
  proxy_domain: string;
  source_domain: string;
  attested_by_email: string;
  attested_at: string;
  attested_ip: string;
  user_agent: string;
  scope: "full_site" | "specified_paths";
  scope_paths: string[] | null;
}

export async function recordAttestation(
  record: AttestationRecord,
  env: Env
): Promise<void>;
```

Behavior: append-only insert into D1 table `attestations`. Never update or delete. The admin UI reads this table for audit.

---

## 7. D1 schema

Migration files live in `migrations/`. Use Wrangler's D1 migration tooling.

```sql
-- 0001_initial.sql

CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  proxy_domain TEXT NOT NULL UNIQUE,
  source_domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'terminated')),
  config_json TEXT NOT NULL,           -- full ClientConfig serialized
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_clients_proxy_domain ON clients(proxy_domain);
CREATE INDEX idx_clients_status ON clients(status);

CREATE TABLE attestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  proxy_domain TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  attested_by_email TEXT NOT NULL,
  attested_at TEXT NOT NULL,
  attested_ip TEXT NOT NULL,
  user_agent TEXT,
  scope TEXT NOT NULL,
  scope_paths_json TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

CREATE INDEX idx_attestations_client ON attestations(client_id);

CREATE TABLE form_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  proxy_domain TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_json TEXT NOT NULL,
  forwarded_status INTEGER,
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

CREATE INDEX idx_forms_client ON form_submissions(client_id);
```

Constraints:
- Migrations are forward-only. Never edit a deployed migration; always add a new one.
- Every schema change requires a migration script and a corresponding update to `ClientConfig` schema if the change is config-related.
- `config_json` is the serialized `ClientConfig`. The Zod schema is the source of truth; the column is just storage.
- The admin pipeline MUST validate against the Zod `ClientConfig` schema before INSERT or UPDATE on `clients.config_json`. The Worker re-validates on every load (§6.1). On any divergence between admin-time and load-time validation, alert and refuse to populate KV — the Worker continues serving the previously cached config until a valid replacement loads.
- An additional `audit_log` table records every config write (actor email, IP, before/after diff hash, timestamp) and every revocation event. Append-only.

---

## 8. Error handling policy

Define error classes in `src/lib/errors.ts`:

```typescript
export class ConfigNotFoundError extends Error {}
export class ConfigValidationError extends Error {}
export class OriginFetchError extends Error { constructor(public origin: string, public cause: unknown) { super(); } }
export class RedirectLoopError extends Error {}
export class TransformError extends Error {}
```

Top-level handler in `src/worker.ts`:

```typescript
try {
  return await handleRequest(request, env, ctx);
} catch (e) {
  if (e instanceof ConfigNotFoundError) return new Response("Not configured", { status: 502 });
  if (e instanceof ConfigValidationError) { logCritical(e); return new Response("Configuration error", { status: 500 }); }
  if (e instanceof OriginFetchError) return new Response("Upstream unavailable", { status: 503 });
  if (e instanceof RedirectLoopError) return new Response("Redirect loop", { status: 508 });
  logCritical(e);
  return new Response("Internal error", { status: 500 });
}
```

No unhandled exceptions reach the user. All errors are logged with full stack and request context.

---

## 9. Caching policy

- HTML responses: respect `CacheRule` from config; default 1 hour for matched routes, no cache otherwise.
- Static assets (CSS, JS, images, fonts): default 24 hours.
- Custom pages: cache as HTML.
- Redirect responses: cache for 5 minutes (so redirect rule changes propagate quickly).
- 4xx responses: cache for 60 seconds.
- 5xx responses: never cache; serve previous cache if available (stale-while-error).
- Cache key: full URL plus any cookies in `cache_key_includes_cookies`.
- Cache bypass: any cookie in `bypass_on_cookie` skips cache.

The cache stores POST-transform responses (after the §5 step 9 HTMLRewriter pipeline). Use `caches.default` for response caching. Do not implement a custom cache layer. Subrequest caching (the `cf` object on origin `fetch`) is disabled — see §6.5 step 8.

### 9.1 Cache safety invariants (mandatory)

The following invariants MUST hold for every cacheable response. Violating any one disqualifies the response from the shared cache:

1. **Authorization-bearing requests bypass the public cache.** Any request with an `Authorization` header is served origin-direct, with `Cache-Control: private, no-store` added to the response.
2. **Set-Cookie responses are not stored in the shared cache.** If the post-transform response carries any `Set-Cookie` header, the response is not written to `caches.default` and is served with `Cache-Control: private, no-store` unless the config explicitly opts in via a `CacheRule` flag (`allow_cache_with_set_cookie: true` — not in v1 schema; future).
3. **Vary on the cookies that key the cache.** The response `Vary` header MUST include any cookie names listed in `cache_key_includes_cookies` (encoded as `Vary: Cookie` plus the cache key derivation; document the limitation).
4. **5xx responses are never written.** On origin 5xx, serve the previously cached response if available; do not overwrite the cache.
5. **Bot user-agents bypass the cache writes.** Bot requests served from cache are fine, but bot-fetched responses are not stored — bots may receive uncached variants and we do not want bot-shaped responses (e.g., conditional canonicals) leaking to humans.

---

## 10. Security requirements

- Strip these response headers from origin: `Server`, `X-Powered-By`, `X-AspNet-Version`, `X-AspNetMvc-Version`.
- Add these response headers if missing: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- Do not weaken: existing `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`.
- Cookie domain rewriting: parse every `Set-Cookie`, rewrite the `Domain=` attribute from source domain to proxy domain. If no `Domain=` is set, leave alone.
- Do not log Authorization headers, cookies, or query parameters matching `/(token|key|password|auth|secret|api)/i`.
- Worker secrets (`INDEXNOW_KEY`, etc.) are never logged or returned in responses.

---

## 11. Performance budgets

Per-request, on cache miss:
- Config lookup: 5ms p99
- Redirect resolution: 1ms p99
- Origin fetch: depends on origin; budget 800ms p95
- HTMLRewriter pipeline: 20ms p99 for typical pages, 50ms p99 for transformation-heavy pages
- Total Worker CPU time: 50ms p99 (Unbound limit is far higher; this is a quality budget)

On cache hit: 10ms p99 total.

Performance is verified in CI with synthetic load tests against Miniflare.

---

## 12. Testing

### 12.1 Unit tests

Every module has a corresponding `*.test.ts` file. Run with `npm test`.

Required coverage:
- `src/redirects/`: 100% (high-risk logic)
- `src/canonical/`: 100%
- `src/transform/`: 90%+
- `src/config/`: 100%
- All other modules: 80%+

### 12.2 Integration tests

In `tests/integration/`, using Miniflare. Each scenario sets up a fake origin, a config, and a series of requests. Asserts on response status, headers, and body.

Required scenarios:
- Subfolder proxy: request to `/blog/post-1` proxies to origin, canonical is rewritten, schema is injected.
- Static redirect: request to `/old-url` returns 301 to `/new-url`.
- Pattern redirect: request to `/posts/123` returns 301 to `/posts/123/`.
- Redirect loop: 3-hop chain returns 508.
- Cross-layer non-re-evaluation: pattern redirect rewrites `/old-post` → `/post-1`; subsequent independent request to `/post-1` resolves canonical for the destination, not the original. Verifies layers don't re-walk.
- Custom page: request to `/lp/austin-tx` serves R2 content.
- 410 on terminated client status.
- 410 on expired authorization (`expires_at` in past, status still `active`).
- 404 on unknown route.
- Cookie domain rewriting on Set-Cookie.
- HTMLRewriter no-op when origin returns non-HTML.
- Origin 5xx serves cached version.
- Default canonical for proxy route with no canonical rule resolves to `origin`, not `self`.
- Default canonical for custom_page route with no canonical rule resolves to `self`.
- HTMLRewriter idempotence: running the rewriter twice on the same origin response produces identical output (verifies `data-edge-seo-rule` markers).
- Malformed origin HTML mid-stream (truncated body, invalid UTF-8): rewriter does not throw; response closes cleanly; error is logged.
- HTMLRewriter handler exception mid-response: response closes cleanly with logged error; partial body is acceptable, but no infinite hang.
- Authenticated Origin Pulls (`origin_auth: aop`) failure: returns 503 `OriginFetchError`, not a hung connection.
- Header-token origin auth: secret is added to outbound request and is NOT logged.
- Cache safety: response with `Set-Cookie` is not stored in shared cache. Request with `Authorization` header bypasses cache.
- Schema-version mismatch on D1 read: rejects the new config and continues serving previously cached version.
- Revocation: status flip to `terminated` deletes KV keys; subsequent request returns 410 within global propagation window (test asserts ≤60s in CI).
- Regex DoS guard: attempting to load a config with `(a+)+$` is rejected at load time; previously cached config remains active.
- JSON-LD payload >64 KB in a single `<script>` element: rewriter leaves it unmodified and logs warning; response still completes.
- Bot user-agent traffic emits unsampled aggregate counters even when per-request log is sampled out.

### 12.3 Schema tests

Every example config in `tests/fixtures/configs/` must validate against the Zod schema. CI fails if any fixture is invalid.

---

## 13. Deployment

### 13.1 Build and deploy commands

```bash
# Local development
npm run dev                    # wrangler dev with local Miniflare

# Tests
npm run test                   # unit tests
npm run test:integration       # integration tests
npm run typecheck              # tsc --noEmit
npm run lint                   # biome check

# Deploy
npm run deploy:staging         # wrangler deploy --env staging
npm run deploy:production      # wrangler deploy --env production

# D1 migrations
npm run db:migrate:staging
npm run db:migrate:production
```

### 13.2 Environments

- `staging`: `*.staging.localblitz.workers.dev`, separate D1, KV, R2.
- `production`: client domains, production bindings.

### 13.3 CI/CD

GitHub Actions workflow:
1. On PR: typecheck, lint, test, integration test.
2. On merge to `main`: deploy to staging.
3. Manual approval gate to production.
4. D1 migrations run before Worker deployment in each environment.

---

## 14. Out of scope (do not build)

- Authentication or session proxying
- WebSocket proxying
- gRPC proxying
- File upload handling beyond what origin natively supports
- Server-side rendering of JS-heavy SPAs (we serve what origin returns)
- Image optimization / resizing (use Cloudflare Image Resizing if needed; not in this Worker)
- Email sending (forms forward to client CRM; we don't send mail)
- Admin UI in this repo's `src/` (admin UI is a separate package in `admin-ui/`, not built in initial phase)
- A/B test management UI (variant assignment via cookie is supported; UI for managing experiments is out of scope v1)

---

## 15. Phase boundaries

### Phase 1 — Foundation

Done when:
- All modules in Section 6 implemented.
- Config schema in `src/config/schema.ts` matches Section 4 exactly.
- D1 migrations applied; one client (Lantern Crest) configured.
- Integration tests pass for all scenarios in Section 12.2.
- One subfolder deployment live in production with monitoring.
- `CHANGELOG.md` documents v0.1.0 release.

### Phase 2 — Productize

Done when:
- 3+ clients onboarded across Subfolder and Performance Domain offerings.
- Admin UI v1 in `admin-ui/` package allows: view clients, view attestations, view logs, manual cache purge.
- Sitemap and IndexNow modules implemented.
- Form handling and D1 capture working.
- Observability dashboard live (Logpush → R2 → Grafana or similar).

### Phase 3 — Scale

Done when:
- Edge SEO Control Plane offering documented with sample configs.
- 10+ clients onboarded.
- Performance budgets met under production load.
- Automated regression test suite running daily against production proxy domains.

---

## 16. Reporting back

After each task or phase, report:

1. What was built (modules, files, lines of code rough count).
2. What was deferred and why.
3. Any deviations from this spec and the reason.
4. Test results (pass count, coverage delta).
5. Open questions for the human.

Do not summarize the spec back. Summarize the work.
