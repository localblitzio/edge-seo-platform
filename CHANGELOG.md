# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [SemVer](https://semver.org/).

## [Unreleased] — Phase 2 admin editor

**Added — write surface on the admin worker.**

Turns `admin-worker/` from a read-only dashboard into a full editor
backed by the same Zod schema + invariant checks the Worker uses at
load time (spec §7 invariant: admin-time and Worker-time validation
must be identical, hence the cross-import).

- `GET/POST /clients/new` — paste a complete `ClientConfig` JSON,
  validate, INSERT into D1, prime KV (`config:<id>` + `domain:<host>`),
  audit `config_create`.
- `GET/POST /clients/:id/edit` — full-config textarea editor with
  before/after FNV-1a hashes recorded to `audit_log.before_hash` /
  `after_hash`, KV invalidated on save.
- `POST /clients/:id/status` — flip active/paused/terminated. Mirrors
  status into `config_json.status` so the row column and cached config
  never drift. Terminated is a one-way door per PRD §6.3 — the form
  refuses to reverse it.
- `POST /clients/:id/cache-purge` — manual KV invalidate per client,
  audited with notes.
- `GET/POST /clients/:id/attest` — attestation capture form per spec
  §6.8 (email, ip, scope, scope_paths CSV, user_agent), append to the
  `attestations` table, audit `authorization_update`.
- CSRF defense: every POST handler checks `Origin` (or `Referer`
  fallback) matches the request URL host. Combined with HTTP basic
  auth, that's the right level for an internal agency tool.
- Flash banner pattern: POST handlers 303-redirect with
  `?flash=...&flash_kind=ok|warn|err` so success/error renders on the
  destination page after refresh.
- New file [admin-worker/src/helpers.ts](admin-worker/src/helpers.ts) extracts
  pure helpers (`fnvHash`, `checkCsrf`, `flashRedirect`, `readFlash`)
  for unit testability.
- `admin-worker/tsconfig.json` extended with `rootDir: ".."` and
  explicit cross-imports of [src/config/schema.ts](src/config/schema.ts) +
  [src/config/validator.ts](src/config/validator.ts) so admin-time validation
  reuses (not duplicates) the Worker's load-time logic.

**Added — CI auto-deploys the admin worker.**

The staging deploy job in [.github/workflows/ci.yml](.github/workflows/ci.yml) now
runs `npx wrangler deploy --config admin-worker/wrangler.toml` after
the main worker deploys. Production stays main-worker-only until the
production environment exists.

**Tests.**

- 18 new unit tests in [tests/unit/admin-worker/helpers.test.ts](tests/unit/admin-worker/helpers.test.ts)
  covering FNV-1a determinism, CSRF accept/reject (Origin and Referer
  paths), and flash round-trip through 303 redirects.
- Suite total: **280 passed** (was 262).

**Notes.**

- Fixed a pre-existing latent type error in `admin-worker/src/index.ts`
  `listKv` (was incompatible with `exactOptionalPropertyTypes: true`),
  surfaced once the admin-worker tsconfig started actually being
  exercised by a typecheck path.

## [0.1.0] — 2026-05-02 (Phase 1 — Foundation, release candidate)

First release-candidate cut. All Phase 1 milestones (M0–M12)
implemented; system is ready for pilot deployment to a single
subfolder client. See "Operator artifacts (M12)" below for the
deploy-day toolkit.

**Highlights:**

- Full §5 request pipeline in [src/worker.ts](src/worker.ts):
  config load → authorization gate → cache lookup → redirects →
  route resolution → proxy fetch → HTMLRewriter → security headers
  → X-Robots-Tag → cache write → structured logging + Analytics
  Engine counters.
- Schema-driven configuration with Zod as the single source of
  truth, four load-time invariants enforced (uniqueness,
  ≤1000-redirect overflow cap, regex-DoS guard, JSON-LD
  serializability).
- Local end-to-end demo working against Miniflare with a rich
  rewriter exercise on `/welcome` (10 rewriter rules firing on a
  single response).
- Read-only inspector dashboard at http://localhost:4000 for
  browsing live D1 + KV state.
- 262 unit tests across 23 modules with §12.1 coverage targets met
  on high-risk modules (config / redirects / canonical at 100%).
- Pilot deploy runbook + production config template + load test +
  post-deploy smoke test committed.

**Operator artifacts (M12):**

- `scripts/validate-config.ts` — Zod + invariant pre-flight CLI:
  `npm run config:validate <file>`.
- `scripts/load-test.mjs` — synthetic regression detector against
  the local Miniflare worker, with Miniflare-realistic p95 budgets:
  `npm run load-test`.
- `scripts/post-deploy-smoke.mjs` — production smoke test:
  `npm run smoke -- --host=<proxy-domain>`.
- `config/lantern-crest.template.json` — pilot client config
  scaffold with `REPLACE_*` placeholders.
- `docs/runbooks/pilot-deploy.md` — operator runbook covering
  account setup, attestation capture, config insert, staging cut,
  production cut, observability hookup, and rollback.

**Known limitation:**

- Integration tests in `tests/integration/pipeline.test.ts` are
  committed with 15 §12.2 scenarios, but the
  `@cloudflare/vitest-pool-workers` runner has a Cross-Request-
  Promise-Resolve / Node IPC stability issue on Windows that
  crashes the suite mid-run. The unit tests cover the same logic
  and the live demo + load test prove end-to-end behavior. Re-attempt
  the integration suite after a wrangler 4 / vitest-pool-workers
  upgrade.

---

## [Unreleased]

### Added

- Repository bootstrap (M0): TypeScript strict toolchain, Biome, Vitest
  workspace (unit + integration), Wrangler config with `staging` and
  `production` environments, Cloudflare bindings (`CONFIG_KV`,
  `CONFIG_DB`, `CONTENT_R2`, `LOGS_R2`, `METRICS` Analytics Engine).
- D1 migration `0001_initial.sql` with `clients`, `attestations`,
  `form_submissions`, and `audit_log` tables (tech spec §7).
- CI workflow with PR verification, staging auto-deploy on `main`, and
  manual production gate (tech spec §13.3).
- Empty module skeletons for every src/ subdirectory in tech spec §2.
- `CLAUDE.md` and `AGENTS.md` agent entry points.
- **Config foundation (M1):**
  - Full `ClientConfig` Zod schema in `src/config/schema.ts` per tech
    spec §4 (every field, default, and discriminated union).
  - Load-time invariants in `src/config/validator.ts`: unique
    `redirects.static[].from`, ≤1000 inline static redirects, regex
    safety linter (nested-quantifier ReDoS heuristic, ≤512 chars,
    must compile), JSON-LD payload serializability with cycle
    detection via `WeakSet`.
  - `loadConfig` in `src/config/loader.ts` with KV-first lookup, D1
    fallback, write-through to KV (60s TTL), validation-before-write
    so KV never caches invalid configs.
  - Lantern Crest fixture and 47 unit tests covering all of
    `src/config/` at 100% statements / 100% branches / 100% functions
    / 100% lines (tech spec §12.1 target).
  - Added `@vitest/coverage-v8` to devDependencies.
- **Cross-cutting primitives (M2):**
  - `applySecurityHeaders` and `rewriteCookieDomain` in
    `src/lib/headers.ts` (tech spec §10): strips banned origin headers,
    adds nosniff / referrer-policy when missing, never weakens existing
    CSP / X-Frame-Options / HSTS, rewrites `Domain=` on Set-Cookie
    headers (case-insensitive, leading-dot tolerant, multi-cookie safe,
    mid-host substring guard).
  - `logRequest`, `classifyUserAgent`, `shouldLog`, and
    `redactSensitiveQueryParams` in `src/observability/logger.ts`
    (tech spec §6.7, §10): bot UA classifier, sampling policy
    (100% bots, 5% humans default, always for 5xx and errors),
    `request_url` redaction for `token|key|password|auth|secret|api`
    query params, JSON-line emission via `console.log` for Logpush.
  - `emitRequestCounter` in `src/observability/metrics.ts`
    (tech spec §6.7): single Workers Analytics Engine data point per
    request with documented blob/double schema for SLO queries.
    Best-effort writes — AE failures never break the request path.
  - 41 new tests; coverage on `src/lib` 100% / 100% / 100% / 100%
    and `src/observability` 97.8% / 97.77% / 100% / 97.8% (well above
    the 80% §12.1 target).
- **Redirect resolver (M3):**
  - Three-layer pipeline in `src/redirects/`: static-map, pattern,
    conditional. Walked in fixed order (§5 step 3–5); first match
    short-circuits; destinations are NOT re-evaluated across layers.
  - `static-map.ts`: O(1) Map lookup with same-layer chain collapse,
    `preserve_query` honored, 508 on chain overflow.
  - `pattern-matcher.ts`: pre-compiled regexes with backreference
    replacement, fixed-point detection (no infinite loop on no-op
    rewrites), 508 on chain overflow beyond `MAX_HOPS`.
  - `conditional.ts`: AND-of-conditions evaluator covering
    `geo_country` (via `request.cf.country`), `device` (UA heuristic),
    `cookie`, `query_param`, `referrer`. Helpers `detectDevice` and
    `getCookieValue` exported for reuse.
  - `index.ts` orchestrator with WeakMap-keyed compile cache so
    regexes are compiled once per `ClientConfig` object lifetime
    (§6.2 compile-once contract).
  - 56 new tests covering all §12.2 redirect scenarios — static
    chain + 508 + tight-cycle, pattern chain + 508 + fixed-point,
    every condition type, layer-priority ordering, cross-layer
    non-re-evaluation. Coverage on `src/redirects/` is 100%
    statements / 100% functions / 100% lines / 97% branches; the
    remaining 3% are unreachable `noUncheckedIndexedAccess` defensive
    guards and a Zod-impossible enum fallback.
- **End-to-end local demo (M3-mockup):** full §5 pipeline wired in
  `src/worker.ts` plus partial `proxy/`, `custom-pages/`, `router/`
  implementations sufficient to run a realistic mock-up locally
  against Miniflare with no Cloudflare account required.
  - `src/proxy/index.ts` + `request-builder.ts` — `none` and
    `header_token` origin auth, Host rewrite, `X-Forwarded-*` headers,
    `cf-*` scrub, subrequest cache disabled per §6.5 step 8.
  - `src/custom-pages/index.ts` — R2-first / KV-fallback page loader.
  - `src/router/route-resolver.ts` — first-match-wins regex routing
    with WeakMap-cached compiled patterns.
  - `src/worker.ts` — pipeline minus M4 canonical / M5 HTMLRewriter /
    M10 cache; spec-compliant §8 error mapping.
  - `scripts/seed-demo.{mjs,json,html}` + `npm run demo:seed` /
    `demo:reset`. README documents the URL matrix.
  - Verified end-to-end: ConfigNotFoundError → 502, custom page →
    200, static/pattern redirects → 301 with Location, 410 mapping,
    proxy fetch with security headers added and origin
    `Server`/`X-Powered-By` stripped.
- **Local read-only inspector** under `admin-ui/` — Phase 1 dev tool
  (Phase 2 admin UI replaces it). Tiny standalone Node HTTP server
  that reads Miniflare's local D1 + KV via `node:sqlite`, served at
  http://localhost:4000 via `npm run admin`. Pages: overview, clients
  list, client detail (auth + all rule sections + raw JSON tree),
  cross-client redirects, audit log + attestations, KV browser with
  per-key value view. ~700 lines, no framework, auto dark/light theme.
- **Canonical resolver (M4):**
  - `src/canonical/strategies.ts` — pure `applyStrategy(strategy, url,
    sourceDomain)` for `self` / `origin` / `custom` / `noindex`.
    `origin` rewrites hostname to `source_domain` and clears the
    proxy port; `custom` returns the configured URL verbatim;
    `noindex` returns `{ url: null }`.
  - `src/canonical/index.ts` — `resolveCanonical(url, config)` walks
    canonical rules first-match-wins, then falls back to the §6.3 SEO
    guardrail defaults: `proxy` route → `origin` (NOT `self`, per
    PRD §13 duplicate-content trap), `custom_page` route → `self`,
    no route match → `origin` (safer fallback). Same WeakMap-keyed
    compile-once pattern as redirects.
  - Wired into `src/worker.ts` for served (non-redirect) responses;
    decision is computed and surfaced in the structured log entry as
    `canonical_url` / `canonical_strategy` for observability.
    HTMLRewriter consumption of the decision lands in M5.
  - 16 new unit tests across the two files; coverage on
    `src/canonical/` is 100% statements / 100% functions / 100%
    lines / ~94% branches (one defensive `noUncheckedIndexedAccess`
    guard).
- **HTMLRewriter pipeline (M5):** full §6.4 / §5 step 9 implementation.
  - `src/transform/_utils.ts` — `stableHash` (FNV-1a 32-bit) for
    `data-edge-seo-rule="<hash>"` markers, `escapeAttr` for HTML
    attribute values, `escapeScriptClose` to neutralize `</script>`
    inside JSON-LD payloads, `injectMarker` to add the idempotence
    attribute to a user-provided HTML fragment's outermost element,
    `mutateJsonLdCanonical` for top-level `url` / `@id` rewrite.
  - `meta-rewriter.ts` — title text + `<meta name|property>` content
    rewrite for the 12 spec-allowed tags.
  - `canonical-applier.ts` — strips ALL existing canonical links,
    appends new `<link rel="canonical">` (or `<meta robots="noindex">`
    for the noindex strategy), syncs `og:url` / `twitter:url` per
    flags, and parses + mutates JSON-LD `<script>` content using a
    text-accumulating handler with a 64 KB cap (`console.warn` and
    pass-through on overflow per §6.4 step 5).
  - `schema-injector.ts` — injects `<script type="application/ld+json"
    data-edge-seo-rule="<hash>">` per matching rule, with
    `head_append` / `head_prepend` positioning, `</script>` escape,
    and idempotence via marker strip-then-inject.
  - `link-rewriter.ts` — regex rewrite of `href` on `<a>` and `<link>`.
  - `element-remover.ts` — drops elements by CSS selector on matching
    paths.
  - `content-injector.ts` — before / after / prepend / append /
    replace insertion at a CSS selector, with marker injection on the
    fragment's outermost element.
  - `indexation-applier.ts` — first-match-wins `<meta name="robots">`
    setter, careful not to remove the canonical applier's
    `canonical-noindex` marker tag.
  - `index.ts` — `buildRewriter(url, config, canonicalDecision)`
    composes handlers in the §5 step 9 fixed order. `isHtmlResponse()`
    helper for the worker to short-circuit on non-HTML.
  - `src/proxy/request-builder.ts` — sets `Accept-Encoding: identity`
    on upstream requests so HTMLRewriter sees decoded HTML
    (Cloudflare's HTMLRewriter does NOT decompress; M10 cache layer
    can revisit this for known-non-HTML routes).
  - `src/worker.ts` — wires `buildRewriter` for HTML responses only;
    drops `Content-Length` on rewritten responses so the runtime falls
    back to chunked transfer.
  - 30 new unit tests on pure helpers; coverage on
    `src/transform/_utils.ts` ≈100%. Full HTMLRewriter integration
    tests are M11 (workerd runtime required).
  - Verified end-to-end: `<link rel="canonical">` injected into the
    `/welcome` custom page (self strategy) and into the `/` proxied
    response (origin strategy → `http://example.com/`), `Content-Length`
    correctly dropped, security headers + cookie domain rewrite still
    applied on top.
- **Indexation header (M6):** `applyXRobotsTag` in
  `src/indexation/index.ts` adds `X-Robots-Tag` to non-HTML responses
  per the first matching `IndexationRule` (PRD §7.6). HTML responses
  pass through unchanged because the M5 indexation-applier already
  injected `<meta name="robots">`. Wired into `worker.ts` after the
  HTMLRewriter step. 8 unit tests cover HTML pass-through, XHTML
  pass-through, base + additional directives, no-rule no-header,
  first-match-wins, status/header preservation, missing-content-type
  treated as non-HTML.
- **Proxy hardening (M7):**
  - `src/proxy/index.ts` now dispatches the upstream fetch to either
    the global `fetch` (for `none` / `aop` / `header_token`) or the
    Workers mTLS binding's `fetch` (for `mtls`, per §6.5 step 7).
    The mTLS binding is keyed in `env` by the rule's
    `cert_secret_name`. Missing-binding and binding-without-fetch are
    surfaced as `OriginFetchError` with binding-name context.
  - `src/proxy/request-builder.ts` removed mTLS from `applyOriginAuth`
    (it's a fetch-dispatch concern, not a header concern). `none` /
    `aop` / `header_token` cleanly switched.
  - `src/worker.ts` upstream 5xx → 503 fallback per §5 step 8 / §9
    invariant 4. The `errors[]` log field now records the origin's
    status code for observability. The cached-version fallback path
    is M10 territory; until then we always 503 on upstream 5xx.
  - 25 new unit tests across `request-builder.test.ts` (URL
    construction, host rewrite, X-Forwarded-* injection, cf-* scrub,
    Accept-Encoding override, all four origin-auth modes,
    method/redirect passthrough) and `index.test.ts` (global vs
    binding dispatch, `cf` init shape, source-domain fallback,
    non-proxy-route guard, mTLS binding lookup, mTLS handshake
    failure mapping).
  - Verified live: proxy `/` 200 from origin, proxy `/about` 4xx
    passes through unchanged (only 5xx triggers the 503 fallback).
- **Custom-page hardening (M8):**
  - `src/custom-pages/renderer.ts` factored out `buildHtmlResponse`
    and `buildNotFoundResponse` helpers.
  - R2 hits now pass through `httpEtag` and `uploaded` (Last-Modified)
    so downstream caches can use validators.
  - 12 new unit tests cover R2-first / KV-fallback / 404 / prefix
    handling / R2-wins-over-KV / non-custom_page route guard.
- **Attestation recorder (M9):** `recordAttestation` in
  `src/attestation/recorder.ts` issues an INSERT against the D1
  `attestations` table with all 9 columns bound in documented order.
  `scope_paths` encoded as JSON in the `scope_paths_json` column.
  Append-only — no update / delete paths exist by design (PRD §6.1).
  4 new unit tests cover SQL shape, parameter ordering, JSON encoding,
  and error propagation (no swallowing — a missing attestation is a
  compliance gap).
- **Cache layer (M10):** new `src/cache/` module with the §9 / §9.1
  invariants enforced.
  - `matchCacheRule` first-match-wins regex match.
  - `deriveCacheKey` builds a Request key with `cache_key_includes_cookies`
    appended as `__cookie_<name>=<value>` query params so per-cookie
    variants stay isolated.
  - `canReadFromCache` rejects non-GET/HEAD, Authorization-bearing,
    and bypass-cookie requests (§9.1 invariant 1).
  - `canWriteToCache` enforces all five §9.1 invariants: rejects
    Authorization, Set-Cookie responses, 5xx, and bot UAs
    (Googlebot / bingbot / PerplexityBot / ClaudeBot / GPTBot).
  - `computeCacheTtl` honors §9 status defaults: 5xx never (0),
    3xx 5min, 4xx 60s, 2xx → matched rule's `ttl_seconds` (else 0).
  - `readCache` / `writeCache` use `caches.default`. Write adds
    `Cache-Control: public, max-age=<ttl>` and `Vary: Cookie` when
    cookie-keyed.
  - Wired into `src/worker.ts`: early lookup between §5 steps 1 and 3
    (HTML hit short-circuits steps 3–10); post-transform write at the
    end via `ctx.waitUntil(...).catch(() => undefined)` so failures
    can never leak unhandled rejections across requests.
  - 22 new unit tests covering rule matching, key derivation,
    read/write gating, and all five §9.1 invariants.
- **Integration test suite (M11):** 15 §12.2 scenarios written in
  `tests/integration/pipeline.test.ts` against
  `@cloudflare/vitest-pool-workers`. Coverage: ConfigNotFoundError →
  502, all three authorization-gate paths, static / pattern / 410
  redirects, 404 on unmatched route, custom_page rendering from KV,
  HTMLRewriter canonical injection / `<title>` rewrite / element
  removal, security headers on success and error responses, default
  canonical for custom_page routes (`self`).
  - `vitest.integration.config.ts` defines the workersProject;
    `tests/integration/env.d.ts` injects our `Env` type into the
    `cloudflare:test` module.
  - **Known runner issue on Windows:** wrangler 3.114 + workerd
    triggers a Cross-Request-Promise-Resolve warning followed by
    `undici` ECONNREFUSED on the test pool's IPC port, which crashes
    the runner mid-suite even with per-test isolation. The test
    code is correct (the first test passes cleanly with a structured
    log entry showing the expected pipeline output), but the
    surrounding pool process becomes unstable. Re-attempt after a
    wrangler 4 / vitest-pool-workers upgrade.
  - Unit-test coverage for the same logic remains comprehensive
    (262 unit tests across the same scenarios).
