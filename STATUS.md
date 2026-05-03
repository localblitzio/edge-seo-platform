# Edge SEO Platform — status

**Last update:** 2026-05-03
**Phase:** 1 (foundation) shipped, with Phase-2 admin MVP overlap.
**Pilot client:** Lantern Crest Senior Living — live in staging.

This file is your at-a-glance "where are we" reminder. Everything in
[CHANGELOG.md](CHANGELOG.md) is the long-form release notes; this is the
operator's pinboard.

---

## 🌐 What's running on Cloudflare

| Worker | URL | Purpose | Bindings |
| ------ | --- | ------- | -------- |
| **edge-seo-platform-staging** | https://edge-seo-platform-staging.localblitzio.workers.dev | Main edge SEO pipeline. Serves Lantern Crest by reverse-proxying `https://lanterncrestseniorlivingsantee.com` with the full §5 transform stack on top. | `CONFIG_KV`, `CONFIG_DB`, `CONTENT_R2`, `LOGS_R2`, `METRICS` |
| **edge-seo-admin** | https://edge-seo-admin.localblitzio.workers.dev | Read-only admin dashboard. Browser the same D1 + KV bindings the main worker reads from. Behind HTTP basic auth (`ADMIN_USERNAME` / `ADMIN_PASSWORD` Worker secrets). | `CONFIG_KV`, `CONFIG_DB`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` |

**Cloudflare account:** `Simon@localblitz.io's Account` (`cf2aaefcc5131a72802197c727a911b9`)

**Resources** (all in staging, no production yet):

| Resource | Name | ID |
| --- | --- | --- |
| KV namespace | `CONFIG_KV-staging` | `dc95f90063cd4493bb3ea462759f4002` |
| D1 database | `edge-seo-platform-staging` | `a6c1786a-4999-4ac5-ad60-7faafec61283` |
| R2 bucket (content) | `edge-seo-content-staging` | — |
| R2 bucket (logs) | `edge-seo-logs-staging` | — |
| Analytics Engine | `edge_seo_metrics_staging` | — |

---

## 🐙 Git + CI

- **Repo:** https://github.com/localblitzio/edge-seo-platform (private)
- **Default branch:** `main`
- **CI:** [.github/workflows/ci.yml](.github/workflows/ci.yml) — push to `main` →
  typecheck + lint + tests → auto-deploy to staging → manual approval gate for
  production.
- **GitHub Secrets configured:**
  - `CLOUDFLARE_API_TOKEN` (with Workers + KV + D1 + Zone scopes)
  - `CLOUDFLARE_ACCOUNT_ID` = `cf2aaefcc5131a72802197c727a911b9`

---

## 👤 Pilot client config (Lantern Crest)

Source of truth: [config/lantern-crest-staging.json](config/lantern-crest-staging.json)

**Active rules:**

- **Routing** — `^/.*` proxies to `https://lanterncrestseniorlivingsantee.com` with `none` origin auth.
- **Canonical** — `^/.*` → `origin` strategy. Every page has `<link rel="canonical" href="https://lanterncrestseniorlivingsantee.com/...">` injected. Prevents duplicate-content penalty (proxy doesn't compete with source).
- **Indexation** — `^/.*` → `noindex,follow`. Search engines crawl links but don't index the proxy. Source site retains its rankings.
- **Caching** — `^/.*` → 600s TTL on the response cache (bypassed for Authorization, Set-Cookie, 5xx, bot UAs per §9.1).

**Inactive rules** (empty arrays): static / pattern / conditional redirects,
schema injections, link rewrites, element removals, content injections, meta
rewrites, forms.

---

## 🛠 Day-1 operator workflow

| Task | Command |
| ---- | ------- |
| Edit a client config | Edit `config/<client>-staging.json` locally |
| Validate before push | `npm run config:validate -- config/<client>-staging.json` |
| Push to staging | `npm run seed-client -- --env=staging --config=config/<client>-staging.json` |
| Deploy worker code | `git push` (CI auto-deploys to staging on `main`) |
| View live state | https://edge-seo-admin.localblitzio.workers.dev (browse) |
| Local end-to-end demo | `npm run demo:seed && npm run dev && npm run admin` |
| Synthetic perf check | `npm run load-test` |
| Production smoke | `npm run smoke -- --host=<proxy-domain>` |

---

## 📐 Architecture

```
            request
              ↓
    Cloudflare Edge (anycast)
              ↓
   ┌──── edge-seo-platform-staging Worker ────┐
   │                                          │
   │  §5 pipeline:                            │
   │    1. config load (KV → D1 fallback)     │
   │    2. authorization gate (status/expiry) │
   │    3. cache lookup (early)               │
   │    4-5. redirects (static/pattern/cond.) │
   │    6. route resolution                   │
   │    7. proxy fetch / custom_page          │
   │    8. 5xx handling                       │
   │    9. HTMLRewriter pipeline              │
   │   10. header transforms                  │
   │   11. cache write (post-transform)       │
   │   12. log + metrics                      │
   │                                          │
   └─────────┬────────────────┬───────────────┘
             ↓                ↓
   CONFIG_KV   CONFIG_DB    →  → fetch upstream origin
   (cache)     (truth)            (e.g. lanterncrestseniorlivingsantee.com)
        ↑                ↑
        │                │  (read by both workers)
        ↓                ↓
   ┌─── edge-seo-admin Worker ───┐
   │                              │
   │  Read-only dashboard at      │
   │  /, /clients, /clients/:id,  │
   │  /redirects, /audit, /kv     │
   │                              │
   │  HTTP basic auth gate        │
   │                              │
   └──────────────────────────────┘
```

---

## ✅ Done (Phase 1)

All M0–M12 milestones from `docs/tech-spec.md` §15:

- M0 — repo bootstrap, TypeScript strict, Biome, Vitest, wrangler.toml
- M1 — Zod ClientConfig schema + load-time invariants + KV/D1 loader
- M2 — security headers, structured logger, Analytics Engine metrics
- M3 — three-layer redirect resolver (static / pattern / conditional)
- M4 — canonical resolver with §6.3 SEO defaults (proxy → origin)
- M5 — full HTMLRewriter pipeline (meta / canonical / schema / link / element / content / indexation)
- M6 — `X-Robots-Tag` header for non-HTML responses
- M7 — proxy hardening (none/aop/header_token/mtls dispatch, upstream 5xx → 503)
- M8 — custom-pages with R2 ETag/Last-Modified passthrough
- M9 — append-only attestation recorder (D1 INSERT)
- M10 — response cache with §9.1 invariants enforced
- M11 — 15 §12.2 integration tests committed (runner blocked on Windows; documented)
- M12 — operator artifacts (validate-config, seed-client, load-test, smoke, runbook)

**262 unit tests passing**, target coverage met on high-risk modules:

- `src/config/`: 100% / 100% / 100% / 100%
- `src/redirects/`: 100% / 100% / 100% / 97%
- `src/canonical/`: 100% / 100% / 100% / 94%
- `src/lib/`: 100% across all axes

**Live verified end-to-end:**

- https://edge-seo-platform-staging.localblitzio.workers.dev/ returns 200
- `<link rel="canonical" href="https://lanterncrestseniorlivingsantee.com/">` injected (M4 + M5)
- `<meta name="robots" content="noindex,follow">` injected (M5 + new B-config)
- `Server` / `X-Powered-By` stripped from origin response (M2 + §10)
- `referrer-policy` + `x-content-type-options` added (M2 + §10)
- HTTP basic auth on admin worker prompts on first visit (Phase 2 MVP)

---

## ⚠️ Known issues / limitations

1. **Integration test runner unstable on Windows.** `tests/integration/pipeline.test.ts` has 15 §12.2 scenarios written, but `@cloudflare/vitest-pool-workers` running on wrangler 3.114 hangs mid-suite due to a Cross-Request-Promise-Resolve / Node IPC race. Unit tests cover the same logic. Re-attempt after wrangler 4 + vitest-pool-workers upgrade.
2. **Admin UI is read-only.** Editing configs / capturing attestations / flipping client status still requires `npm run seed-client` or direct SQL. Edit capability is the obvious next iteration.
3. **No production environment yet.** Staging-only. Production resources, real proxy domain, and DNS cut are unscheduled.
4. **No Logpush job configured.** Worker emits structured logs and Analytics Engine counters, but they're not yet shipped to a queryable backend. PRD §7.11 alerts not configured.
5. **No second client.** Multi-tenancy is designed in but not yet exercised. Onboarding a second client tests that "add a client = config row" assumption holds.
6. **R2 unused at runtime.** `CONTENT_R2` bound but not yet writing custom-page content; `LOGS_R2` waiting on Logpush.

---

## 🎯 Next-steps menu

Pick any. Or none — Phase 1 is shippable as-is.

| Option | Why | Effort |
| ------ | --- | ------ |
| **Edit capability in admin UI** | Removes operator from JSON+SQL loop. Web forms for rules / status / attestations. Phase 2 admin UI per spec §7.12. | ~3 hrs |
| **Onboard a second client** | Validates multi-tenancy. Pick a permissioned source, write a config, `npm run seed-client`, done. | ~30 min |
| **Production env** | Separate KV/D1/R2, real production proxy domain, click-to-deploy through GitHub Actions production gate. | ~1 hr |
| **Logpush + Grafana** | Production observability — see traffic, latency, error rates per client. Wire the §11 SLO budgets to real dashboards. | ~1 hr |
| **Real SEO content rules for Lantern Crest** | Schema injection (LocalBusiness), targeted meta rewrites, internal link rewrites. Make the proxy do useful SEO work beyond canonical-and-noindex. | ~30 min |
| **Reverse the pilot canonical** | Currently canonical points to source (don't compete). If the goal is for the proxy to rank, flip canonical to `self` and remove `noindex`. Strategic decision per use case. | ~5 min config change |

---

## 📁 Where things live

```
docs/
  prd.md, tech-spec.md            ← Source-of-truth specs
  runbooks/pilot-deploy.md        ← Step-by-step operator runbook
src/
  worker.ts                        ← Main worker entrypoint (§5 pipeline)
  config/                          ← Zod schema + loader + invariants
  redirects/                       ← Three-layer redirect resolver
  canonical/                       ← Canonical strategy (M4)
  transform/                       ← HTMLRewriter pipeline (M5)
  proxy/                           ← Origin fetch + auth dispatch (M7)
  custom-pages/                    ← R2/KV-backed page renderer (M8)
  attestation/                     ← D1 attestation recorder (M9)
  cache/                           ← Response cache + §9.1 invariants (M10)
  indexation/                      ← X-Robots-Tag header (M6)
  lib/                             ← Errors, headers
  observability/                   ← Logger, metrics
admin-worker/                      ← Hosted admin dashboard worker
admin-ui/                          ← Local read-only inspector (legacy of admin-worker)
config/
  lantern-crest-staging.json       ← Pilot client config (source of truth)
  lantern-crest.template.json      ← Template for new clients
scripts/
  validate-config.ts               ← Pre-flight Zod + invariant validator
  seed-client.ts                   ← One-command D1 upsert + KV invalidate
  load-test.mjs                    ← Synthetic perf regression detector
  post-deploy-smoke.mjs            ← Production smoke test
  seed-demo.mjs                    ← Local Miniflare demo seeder
  update-lantern-crest-staging.sql ← One-off SQL (now obsoleted by seed-client)
tests/
  integration/pipeline.test.ts     ← 15 §12.2 scenarios (runner-blocked on Windows)
migrations/
  0001_initial.sql                 ← D1 schema (clients, attestations, audit_log, form_submissions)
wrangler.toml                      ← Main worker bindings (default + staging + production envs)
```

Past commits in `git log --oneline` capture the milestone-by-milestone history.
