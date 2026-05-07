# Edge SEO Platform — status

**Last update:** 2026-05-07
**Phase:** 1 (foundation) shipped + Phase 2 (admin editor) shipped + Phases A–E
of the frontend-worker rewrite shipped + Link Projects (Slices 1–4) shipped +
Clusters (Slices A–C) shipped + bulk-create + Sites page filters + the
Clients → Proxied sites rename.
**Production:** not yet — all live infrastructure is staging.

This file is your at-a-glance "where are we" reminder. [CHANGELOG.md](CHANGELOG.md)
is the long-form release notes; [HANDOFF.md](HANDOFF.md) captures session-end
context for the next coding session; this is the operator's pinboard.

---

## 🌐 What's running on Cloudflare

| Worker | URL | Purpose |
| ------ | --- | ------- |
| **edge-seo-frontend** | `edgeseo.app/*` (+ workers.dev fallback) | App + auth surface. Landing page, /login, /forgot, /reset, /verify, /logout. Multi-tenant `/app/*` (Sites / Link projects / Clusters / Audit log) and super-admin `/admin/*`. Bound to the same `CONFIG_KV` + `CONFIG_DB` so it reads + writes the same data the proxy worker serves. Compiles `placements:*` and `cluster_links:*` KV envelopes on admin write. |
| **edge-seo-platform-staging** | `*.localpage.us.com/*`, `*.localsite.us.com/*`, `404-media.com/*`, `seoinencinitas.com/*` | Main edge SEO pipeline. Reverse-proxies + transforms + injects per the §5 lifecycle. Reads compiled `placements:<id>` and `cluster_links:<id>` from KV alongside the main `config:<id>` and merges into `content_injections`. |
| **edge-seo-admin** | https://edge-seo-admin.localblitzio.workers.dev | Legacy basic-auth dashboard. Slated for deletion (Phase G in [HANDOFF.md](HANDOFF.md)) once /app/* has full parity. |

**Cloudflare account:** `Simon@localblitz.io's Account` (`cf2aaefcc5131a72802197c727a911b9`)

**Resources** (staging):

| Resource | Name | ID |
| --- | --- | --- |
| KV namespace | `CONFIG_KV-staging` | `dc95f90063cd4493bb3ea462759f4002` |
| D1 database | `edge-seo-platform-staging` | `a6c1786a-4999-4ac5-ad60-7faafec61283` |
| R2 bucket (content) | `edge-seo-content-staging` | — |
| R2 bucket (logs) | `edge-seo-logs-staging` | — |
| Analytics Engine | `edge_seo_metrics_staging` | — |

**Worker secrets** (set via `wrangler secret put`):
- `CF_API_TOKEN` — used by auto-onboarding + cache-purge buttons + link-project HTTP cache invalidation + cluster cross-link invalidation. Scope: All zones from the account, with Workers Scripts/KV/Routes:Edit, DNS:Edit, Cache Purge:Purge.
- `INDEXNOW_KEY` — bound, IndexNow integration not yet wired
- `GSC_SERVICE_ACCOUNT_JSON` — bound, GSC integration not yet wired

---

## 🐙 Git + CI

- **Repo:** https://github.com/localblitzio/edge-seo-platform (private)
- **Default branch:** `main`
- **CI:** [.github/workflows/ci.yml](.github/workflows/ci.yml) — push to `main` →
  typecheck + lint + tests → auto-deploy `edge-seo-platform-staging`,
  `edge-seo-admin`, and `edge-seo-frontend` to staging in parallel jobs →
  manual approval gate for production.
- **GitHub Secrets configured:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

---

## 👥 Active proxied sites

7 active sites — all multi-tenant, owner_id scoped to
`simon@localblitzmarketing.com` (super-admin sees all).

| client_id | mode | proxy_domain | source/origin | Notes |
| --- | --- | --- | --- | --- |
| `lantern-crest` | subdomain_proxy | `lantern-crest.localpage.us.com` | `lanterncrestseniorlivingsantee.com` | Original pilot. Canonical=origin, noindex. |
| `404-media` | in_place | `404-media.com` | `144.202.74.213` (resolve_override) | Real customer apex on GridPane WordPress. www → apex via WP redirect. |
| `seoinencinitas` | in_place | `seoinencinitas.com` | `seoinencinitas.pages.dev` | Real customer on Cloudflare Pages. No resolve_override needed. |
| `rfengineer` | subdomain_proxy | `rfengineer.localpage.us.com` | `rfengineer.net` | Test/demo. Has link-project placement (id=3). |
| `bestofindianapolis` | subdomain_proxy | `bestofindianapolis.localpage.us.com` | `bestofindianapolis.net` | Test/demo. |
| `simonwhiteai` | subdomain_proxy | `simonwhiteai.localpage.us.com` | (operator personal) | Test/demo. |
| `theheritagesteakhouse` | subdomain_proxy | `theheritagesteakhouse.localpage.us.com` | (operator owns) | Test/demo. |

Multi-zone enabled — sites can also be on `*.localsite.us.com`.

UI calls these "Proxied sites." DB column stays `client_id` (FK on many tables) — that's an intentional terminology / schema split: in the cluster + link-project + filter UI everything reads "site"; the underlying schema is unchanged.

---

## 🛠 Day-1 operator workflow

| Task | Where |
| ---- | ----- |
| Sign in | https://edgeseo.app/login |
| **Sites:** list + filter (search, status, zone, cluster) | https://edgeseo.app/app/clients |
| **Sites:** create one new (subdomain_proxy or in_place) | https://edgeseo.app/app/clients/new — pick a zone radio or "Custom domain" |
| **Sites:** bulk-create (paste 1–100 source URLs) | "Bulk-create" button on /app/clients, or "+ Bulk-create sites for this cluster" link on a cluster detail page |
| Auto-onboard (creates DNS + Workers Route via CF API) | "Install on Cloudflare" button on an in_place site detail page |
| **Clusters:** create + manage 1–25-site groupings (topical / geo) | https://edgeseo.app/app/clusters |
| **Clusters:** opt into cross-linking (Related sites footer on every member) | "Cross-linking" section on the cluster edit page |
| **Link projects:** push a target URL via N proxied sites | https://edgeseo.app/app/link-projects |
| **Link projects:** bulk-apply across selected clients OR a cluster's members | "Bulk apply" details element on the link-project detail page (with cluster picker) |
| Verify a target URL is reachable | "Check target URL" button on the link-project detail page |
| Capture / view permission attestation | "Capture attestation" on a site detail page |
| Per-page editing (text/meta rewrites, schema, redirects) | "Edit page" link from the site detail "Pages with edits" section |
| Inspector (find CSS selectors on the source) | Form section on the site edit page → "Inspect page on source" |
| Audit log | https://edgeseo.app/app/audit |
| Purge a site's cache (KV + CF HTTP) | "Purge cache" button on the site detail page |

---

## 📐 Architecture

```
            request
              ↓
    Cloudflare Edge (anycast)
              ↓
   ┌──── edge-seo-platform-staging Worker ────┐
   │  §5 pipeline:                            │
   │    1. config load (KV → D1 fallback)     │
   │       + placements:<id>      KV merge    │  (link-project placements)
   │       + cluster_links:<id>   KV merge    │  (cluster cross-linking)
   │    2. authorization gate (status/expiry) │
   │    3. cache lookup (early)               │
   │    4–5. redirects (static/pattern/cond.) │
   │    6. route resolution                   │
   │    7. proxy fetch / custom_page          │
   │    8. 5xx handling                       │
   │    9. HTMLRewriter pipeline              │
   │   10. header transforms                  │
   │   11. cache write (post-transform)       │
   │   12. log + metrics                      │
   └─────────┬────────────────┬───────────────┘
             ↓                ↓
   CONFIG_KV   CONFIG_DB    →  → fetch upstream origin
   (cache)     (truth)
        ↑                ↑
        │   (read+write by frontend-worker)
        ↓                ↓
   ┌─── edge-seo-frontend Worker ─────────┐
   │   edgeseo.app/* — auth, multi-tenant │
   │   /app/* (Sites / Link projects /    │
   │   Clusters / Audit), super-admin     │
   │   /admin/*, debug endpoints          │
   │                                      │
   │   • compiles placements:<id> →       │
   │     KV on link-project edit          │
   │   • compiles cluster_links:<id> →    │
   │     KV on cluster edit               │
   │   • purges CF HTTP cache on edit     │
   │   • CF API: DNS, Workers Route,      │
   │     cache purge (CF_API_TOKEN)       │
   └──────────────────────────────────────┘
```

KV keyspace (everything in CONFIG_KV):
- `domain:<host>` → `<client_id>` (host → site mapping; loader's first read)
- `config:<client_id>` → JSON `ClientConfig` (the operator-defined config)
- `placements:<client_id>` → JSON `{ compiled_at, content_injections[] }` (link-project placements; written by frontend-worker on placement / project edits)
- `cluster_links:<client_id>` → JSON `{ compiled_at, content_injections[] }` (cluster cross-linking; written on cluster edit when `cross_link_enabled=1`)

Both `placements:*` and `cluster_links:*` use the same envelope shape and merge into `config.content_injections` in the loader. Order: operator rules → placement rules → cluster-link rules.

---

## ✅ Done

### Phase 1 — Foundation (M0–M12)

All milestones from `docs/tech-spec.md` §15:
- M0 repo bootstrap; M1 Zod schema + loader; M2 logger + metrics; M3 redirects;
  M4 canonical; M5 HTMLRewriter pipeline; M6 X-Robots-Tag; M7 proxy hardening;
  M8 custom-pages; M9 attestation; M10 response cache; M11 integration tests;
  M12 operator artifacts.

### Phase 2 — Admin write surface

- Editable client config (web form + raw JSON textarea)
- Per-site status flips, cache purge, attestation capture
- CSRF + flash redirect pattern

### Phases A–E — Frontend worker rewrite (multi-user)

- Phase A — D1 users/sessions/email_tokens schema, multi-tenant `clients.owner_id`
- Phase B — landing page on edgeseo.app
- Phase C — Cloudflare Email Routing for transactional mail
- Phase D — login / forgot / reset / verify / logout (PBKDF2 server-side sessions)
- Phase E — `/app/*` write surface, structured form + rich list editors,
  per-page editor, inspector for CSS selectors, custom pages, static-site ZIP
  uploads, file browser

### Slice features (post-Phase E)

- **In-place mode** — worker runs on the customer's own apex (404-media, seoinencinitas)
- **Cloudflare auto-onboard** — DNS + Workers Route created via CF API on save
- **resolve_override** — first-class form field for managed-host customers
- **Worker fingerprint header** + route-drift predeploy check
- **Multi-zone proxy support** — `localpage.us.com` + `localsite.us.com` (one radio per zone)
- **Link Projects (Slices 1–4)** — registry, per-(project × client × page-match) placements, KV-compiled content_injections merged at request time, anchor rotation, custom CSS-selector strategy, stat cards, target-URL check, bulk apply
- **Clusters (Slices A–C)** — labeled groupings of 1–25 proxied sites by topic ("Plumbing") or geo ("San Diego, CA"); link-project bulk-apply integration with cluster picker; opt-in **cross-linking** (Related sites footer between members, KV-compiled, request-time injection mirroring the link-projects pipeline)
- **Bulk-create proxied sites** — two-step paste-URLs flow that turns 1–100 source URLs into proxied sites in one go (subdomain_proxy mode, single zone + single batch attestation, optional cluster auto-assignment)
- **Sites page filters** — search + status + zone + cluster filters with client-side JS, "N of M sites" live counter, scales the page to 100s of sites
- **Clients → Proxied sites rename** — UI terminology cleanup; per-site sidebar sub-list dropped (couldn't scale past ~25 sites and the new filter card replaced it)

### Test surface

**577 unit tests passing** repo-wide. Coverage targets met on the high-risk modules:
- `src/config/`: 100% statements / branches / functions / lines (incl. loader's `placements` + `cluster_links` merge paths)
- `src/redirects/`: 100% / 100% / 100% / 97%
- `src/canonical/`: 100% / 100% / 100% / 94%
- `src/lib/`: 100% across all axes
- `frontend-worker/src/link-projects.ts`: comprehensive (validation, synthesizer, rotation, stats, bulk validation)
- `frontend-worker/src/clusters.ts`: validation + member-list + cross-link synthesizer
- `frontend-worker/src/bulk-clients.ts`: URL parsing, hostname extraction, client_id derivation, conflict resolution, validation, config build

### Live verified end-to-end

- All 7 active sites serving 200/HTML
- Canonical, robots, security-header rewrites confirmed
- Link injection working on `rfengineer`, `404-media` (verified in rendered DOM)
- Cluster cross-linking compile + KV merge tested in unit tests; UI verified on staging
- Cache purge propagates within seconds after admin edit (CF HTTP cache + KV)

---

## ⚠️ Known issues / limitations

1. **No production environment yet.** Staging-only. `wrangler.toml` has `REPLACE_WITH_PRODUCTION_KV_ID` placeholders. Spinning up production needs: new KV/D1/R2 namespaces, production CF_API_TOKEN secret, route registration on production-zone-of-record, DNS cut.
2. **No Logpush job configured.** Worker emits structured logs + Analytics Engine counters but they're not yet shipped to a queryable backend. PRD §10 SLO alerts not configured.
3. **Integration test runner unstable on Windows.** `tests/integration/pipeline.test.ts` has 15 §12.2 scenarios written, but `@cloudflare/vitest-pool-workers` on wrangler 3.114 hangs mid-suite. Unit tests cover the same logic. Re-attempt after wrangler 4 + vitest-pool-workers upgrade.
4. **Phase F not started.** `/admin/users` super-admin CRUD (invite / edit / delete / force-reset) is the next planned phase per [HANDOFF.md](HANDOFF.md).
5. **Phase G not started.** `edge-seo-admin` worker is legacy + slated for deletion once /app/* parity confirmed.
6. **IndexNow + sitemap generation not wired.** Secrets bound, code skeleton in `src/sitemap/`, no implementation.
7. **mTLS origin auth has a code path** but the per-client cert binding workflow isn't documented end-to-end.
8. **Form submissions** — D1 table exists, no read/write code in the worker.
9. **CI `deploy-production` job fails on every main push** — there's no production env yet. Easy fix in a small PR — guard behind a `workflow_dispatch` input or environment label. Mentioned in earlier handoff but unaddressed.

---

## 🎯 Next-steps menu

Pick any.

| Option | Why | Effort |
| --- | --- | --- |
| **Phase F — super-admin user CRUD** | Already in HANDOFF.md as planned next. Lets others admin sites — foundational for agency tooling. | ~2 hr |
| **SEO operational tools — IndexNow + sitemap generation** | Highest direct SEO value. Pings search engines on content changes; generates sitemaps from per-client routing config. Secrets already bound. | ~4 hr |
| **Production deploy** | First paying customer trigger. Needs new CF resources, secrets, DNS. | ~4 hr |
| **Operational dashboards** | Read Workers Analytics Engine: p95 latency, error rate, cache hit ratio per site. PRD §10. | ~3 hr |
| **Cluster Slice D — reporting** | Combined stats across cluster members (placement counts, traffic, broken-link health). Lower priority than B but rounds out the cluster product. | ~2 hr |
| **Auto-schema injection** (Cluster Slice E candidate) | GEO clusters auto-inject `LocalBusiness` JSON-LD; topical inject `Service`. Needs structured fields the cluster doesn't have yet (lat/lon, address, phone) — schema growth required first. | ~4 hr |
| **Rich form for the rest of ClientConfig** | link_rewrites, conditional redirects, element_removals are still raw-JSON edited. Operator UX gap. | ~3 hr |
| **Inspector → placement integration** | "Use this selector" button on the inspector that creates a link-project placement directly. Makes the selector strategy more discoverable. | ~2 hr |
| **Logpush + Grafana** | Production observability — see traffic, latency, error rates per site. Wire §11 SLO budgets to real dashboards. | ~3 hr |

---

## 📁 Where things live

```
docs/
  prd.md, tech-spec.md             ← Source-of-truth specs
  runbooks/                        ← Operator runbooks
src/
  worker.ts                        ← Main worker entrypoint (§5 pipeline)
  config/                          ← Zod schema, loader (reads placements:* + cluster_links:* + merges), invariants
  redirects/                       ← Three-layer redirect resolver
  canonical/                       ← Canonical strategy
  transform/                       ← HTMLRewriter pipeline (meta/canonical/schema/link/element/content/text/indexation)
  proxy/                           ← Origin fetch + auth dispatch (incl. resolve_override)
  custom-pages/                    ← R2/KV-backed page renderer
  attestation/                     ← D1 attestation recorder
  cache/                           ← Response cache + §9.1 invariants (incl. 0-byte poison guard)
  indexation/                      ← X-Robots-Tag header
  sitemap/                         ← Skeleton (not yet built)
  lib/                             ← Errors, headers
  observability/                   ← Logger, metrics, log shipper
frontend-worker/                   ← edgeseo.app worker
  src/index.ts                     ← Router (auth flows + /app/* + /admin/*)
  src/auth.ts                      ← PBKDF2 sessions, email tokens, cookies
  src/email.ts                     ← Cloudflare Email Service templates
  src/app.ts                       ← /app/* page rendering + write handlers + sidebar + Sites page (with filter card)
  src/link-projects.ts             ← Link projects: types, validation, synthesizer, KV compile, audit, all routes (~2000 lines)
  src/clusters.ts                  ← Clusters: types, validation, member-list, cross-link synthesizer + KV compile, all routes
  src/bulk-clients.ts              ← Bulk-create proxied sites: URL parser, client_id derivation, conflict resolution, validation, config build
  src/cloudflare-api.ts            ← CF API helpers (zones, DNS, routes, cache purge)
  src/inspector.ts                 ← Source-page CSS selector picker
  src/zip-extractor.ts             ← Static-site ZIP upload
  src/list-editor-js.ts            ← Client-side JS for rich list editors
  src/build-version.ts             ← Stamped at deploy time
admin-worker/                      ← Legacy basic-auth dashboard (slated for deletion in Phase G)
admin-ui/                          ← Local read-only inspector (legacy of admin-worker)
config/
  lantern-crest-staging.json       ← Pilot client config
scripts/
  validate-config.ts               ← Pre-flight Zod + invariant validator
  seed-client.ts                   ← One-command D1 upsert + KV invalidate
  load-test.mjs                    ← Synthetic perf regression detector
  post-deploy-smoke.mjs            ← Production smoke test
  check-route-drift.mjs            ← Predeploy: D1 in_place clients vs wrangler.toml routes
  stamp-build-version.mjs          ← Bakes git SHA into build-version.ts pre-deploy
tests/
  integration/pipeline.test.ts     ← 15 §12.2 scenarios (runner-blocked on Windows)
  unit/frontend-worker/            ← auth, email, list-editor, inspector, zip-extractor, link-projects, clusters, bulk-clients
  unit/admin-worker/               ← legacy admin helpers
migrations/
  0001_initial.sql                 ← clients, attestations, audit_log, form_submissions
  0002_users.sql                   ← Phase A: users, sessions, email_tokens, owner_id
  0003_link_projects.sql           ← Slice 1: link_projects table
  0004_link_project_placements.sql ← Slice 2A: per-(project × client × page-match) placements
  0005_link_project_placement_selector.sql ← Slice 3: target_selector + position columns, broaden strategy CHECK
  0006_clusters.sql                ← Cluster Slice A: clusters + cluster_members tables
  0007_cluster_cross_linking.sql   ← Cluster Slice C: cross_link_enabled column on clusters
wrangler.toml                      ← Main worker bindings + multi-zone routes
frontend-worker/wrangler.toml      ← edge-seo-frontend bindings + edgeseo.app route
admin-worker/wrangler.toml         ← Legacy admin worker bindings
```

`git log --oneline` captures the milestone-by-milestone history.
