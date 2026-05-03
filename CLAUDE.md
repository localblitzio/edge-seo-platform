# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

**This repo is at the planning stage — there is no source code yet.** It contains two specification documents that fully describe the system to be built:

- [edge-seo-platform-prd.md](edge-seo-platform-prd.md) — strategic PRD (the *why* and *what for whom*)
- [edge-seo-platform-tech-spec.md](edge-seo-platform-tech-spec.md) — buildable technical specification (the *what to build, exactly*)

When the two conflict on implementation details, the tech spec wins.

**Read [edge-seo-platform-tech-spec.md](edge-seo-platform-tech-spec.md) end-to-end before writing any code.** Section 1 ("Ground Rules") is non-negotiable and section-numbered references in this file map back to that document.

## What is being built

An edge SEO platform on Cloudflare Workers that proxies, transforms, and serves websites under controlled domains. One shared Worker runtime interprets per-client configuration loaded from D1/KV — adding a new client is a config row, not a deploy. Three productized offerings ride on the same runtime:

1. **Subfolder Authority Consolidation** — host SaaS content (Webflow, HubSpot, Shopify) under a client's primary domain as a subfolder.
2. **Performance Domain** — controlled secondary domain for PPC landers, programmatic SEO, AEO experiments.
3. **Edge SEO Control Plane** — canonical, redirect, schema, indexation control at the edge without CMS plugins.

Permission-gated cloning is core: every proxied source domain must have a captured attestation record. See PRD §6 and tech spec §6.8.

## Architectural anchors (what to internalize before touching code)

### Request lifecycle is a fixed pipeline (tech spec §5)

The Worker's `fetch` handler executes a strict ordered pipeline. Don't reorder, don't add steps:

```
1. Resolve config (host header → client_id → ClientConfig from KV; D1 fallback)
2. Check authorization status and expiry → 410 if paused/terminated/expired
3-5. Redirects: static → pattern → conditional (first match wins, no cross-layer chaining)
6. Resolve route (proxy vs custom_page)
7. Fetch upstream (origin or KV/R2)
8. Validate response (5xx → stale-while-error)
9. HTMLRewriter pipeline: meta_rewrites → canonical → schema_injections → link_rewrites → element_removals → content_injections → indexation
10. Header transformations (cookies, security headers, cache-control)
11. Caching (post-transform; cache lookup short-circuits steps 3–10 on HTML hit)
12. Sampled logging + always-on aggregate counters
13. Return
```

Cache stores POST-transform responses in `caches.default`. Subrequest cache (`cf` object on origin fetch) is **disabled** — caching happens only at the response layer.

### Config is the product

`src/config/schema.ts` defines a Zod schema (`ClientConfig`) that is the single source of truth. TypeScript types are generated from it. Every config is validated at admin-write time AND at Worker load time. On validation failure, **the Worker continues serving the previously cached config** — never falls back to defaults. See tech spec §4 and §6.1.

### Module boundaries are prescribed

The tech spec dictates the directory layout (§2) and gives explicit input/output contracts for each module (§6). Don't invent new modules or merge prescribed ones.

### HTMLRewriter handlers must be idempotent

Every injected element carries `data-edge-seo-rule="<rule_id>"` (stable hash of the rule). The rewriter removes any pre-existing element with that marker before injecting. Don't buffer full response bodies; per-element text accumulation is allowed, capped at 64 KB for `<script type="application/ld+json">`. See §6.4.

### Default canonical for proxy routes is `origin`, not `self`

This is the SEO duplicate-content failure mode called out in PRD §13. Custom-page routes default to `self`. See §6.3.

### Cache safety invariants are mandatory (§9.1)

Authorization-bearing requests bypass the public cache. Set-Cookie responses aren't shared-cached. 5xx responses are never written. Bot-fetched responses aren't stored (avoid bot-shaped variants leaking to humans). Vary on cookies that key the cache.

### Compile regexes once per config load

Not per request. Applies to all transform regexes (canonicals, link rewrites, element removals, content injections, meta rewrites, indexation, redirect patterns).

### SLOs read from unsampled aggregate counters, not the sampled log stream

Per-request logs are sampled (100% bots, 5% humans). SLOs (cache hit ratio, p95 latency, error rate from PRD §10) come from Workers Analytics Engine counters. See §6.7.

## Hard rules from spec §1.1–1.2

- TypeScript strict mode. No `any` types unless explicitly justified in a code comment.
- Every public function has JSDoc with `@param`, `@returns`, `@throws`.
- Every module has a corresponding test file.
- For any ambiguity not resolved by the spec, **stop and ask**. Do not guess.
- Do not add features, endpoints, config options, or modules not specified.
- Do not "improve" or refactor unrelated code while making changes.
- Do not add dependencies beyond §3.2 without explicit approval.
- Do not modify `wrangler.toml` to add bindings without updating the spec.
- Do not weaken security headers, log full bodies / cookies / auth headers, or implement caching strategies outside §9.

## Approved dependencies (tech spec §3.2)

**Production:** `zod`. (`itty-router` only if needed for admin UI; the Worker uses native routing.)

**Development:** `vitest`, `@cloudflare/workers-types`, `miniflare`/`workerd`, `@biomejs/biome`, `wrangler`.

**Banned:** lodash, axios, moment, express, koa, any HTTP client library. Use native `fetch` and Workers runtime APIs.

## Cloudflare bindings (declared in `wrangler.toml`)

- `CONFIG_KV` — hot config cache
- `CONFIG_DB` — D1 source-of-truth config and audit logs
- `CONTENT_R2` — custom landing page content
- `LOGS_R2` — Logpush destination
- `caches.default` — response cache (no binding)

Secrets (Worker secrets, not vars): `INDEXNOW_KEY`, `GSC_SERVICE_ACCOUNT_JSON`.

## Commands (planned — not yet implemented)

These are defined in tech spec §13.1 and become real once `package.json` exists:

```bash
npm run dev                    # wrangler dev with local Miniflare
npm run test                   # unit tests (vitest)
npm run test:integration       # integration tests against Miniflare
npm run typecheck              # tsc --noEmit
npm run lint                   # biome check
npm run deploy:staging
npm run deploy:production
npm run db:migrate:staging
npm run db:migrate:production
```

To run a single vitest file once it exists: `npm run test -- path/to/file.test.ts`. To run by name: `npm run test -- -t "test name"`.

## Definition of done (per task, spec §1.3)

1. Code matches the spec exactly.
2. TypeScript compiles, no `any` types.
3. Unit test coverage targets met (§12.1: redirects/canonical/config 100%, transform 90%+, others 80%+).
4. Integration tests pass against Miniflare.
5. `CHANGELOG.md` updated.
6. Short report of what was built and any spec deviations.

## Phase 1 scope

Phase 1 (foundation) is what to build first. Done criteria in spec §15:
- All modules in §6 implemented
- Config schema matches §4 exactly
- D1 migrations applied; Lantern Crest configured as pilot client
- Integration tests pass for all §12.2 scenarios
- One subfolder deployment live with monitoring

Admin UI lives in a separate `admin-ui/` package and is **out of scope** for the initial Worker build.

## Reporting back

After each task, report (per spec §16): what was built, what was deferred and why, any spec deviations, test results, open questions. Don't summarize the spec back — summarize the work.
