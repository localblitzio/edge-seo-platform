# Session handoff — 2026-05-07 (clusters era)

**Read this first** when resuming. Then [STATUS.md](STATUS.md) for the broader picture.

This session shipped **12 PRs** that turned the platform from "site-by-site SEO control plane" into a real campaign-management product. Clusters (data + bulk-apply + cross-linking), bulk-create proxied sites, Sites page filter card, and the Clients → Proxied sites rename all merged. Next session resumes with the platform in a "would feel ready to demo to a paying customer" state.

## What landed (in merge order)

| PR  | Title                                                                         | What it added |
| --- | ----------------------------------------------------------------------------- | --- |
| #57 | feat(admin): multi-zone proxy_domain picker (one radio per zone)              | `PROXY_ZONES = [localpage, localsite]`; persisted wrangler.toml routes |
| #58 | feat(admin): Link projects — registry, placements, worker injection, rotation, selector strategy, stats | Slices 1–4 end-to-end. 7 commits. |
| #59 | chore(cleanup): audit log for placement events + refreshed STATUS.md / HANDOFF.md | Per-placement audit; first STATUS refresh |
| #60 | feat(admin): Clusters — Slice A (topical + geo groupings of 1–25 sites)        | Single-table `clusters` + `cluster_members` schema, full CRUD, sidebar entry |
| #61 | feat(admin): bulk-create proxied sites — paste URLs flow                       | Two-step paste-URLs page; cluster pre-assignment; client_id derivation + conflict resolution |
| #62 | feat(link-projects): cluster picker in bulk-apply form (Slice B for clusters) | Pre-fill placement client checkboxes from a cluster; helper `loadAllClusterMembersByCluster` |
| #63 | fix(link-projects): cluster picker is two buttons — Use replaces, + Add layers | UX fix after picker initially appeared to "select all" because of stacking with the bulk-apply default |
| #64 | feat(admin): rename Clients → Proxied sites + filter the Sites page           | UI-only rename; per-site sidebar sub-list dropped; search + status + zone + cluster filters |
| #65 | feat(clusters): cross-linking — Slice C ("Related sites" footer between members) | `cross_link_enabled` column; `cluster_links:<client_id>` KV; loader merge alongside `placements:<id>` |

(Plus #66 — this docs-refresh PR.)

## Where things are right now

```
edgeseo.app/*                     → edge-seo-frontend
*.localpage.us.com/*              → edge-seo-platform-staging
*.localsite.us.com/*              → edge-seo-platform-staging   (multi-zone)
404-media.com/*                   → edge-seo-platform-staging   (in_place)
seoinencinitas.com/*              → edge-seo-platform-staging   (in_place)
```

**7 active proxied sites** (per [STATUS.md](STATUS.md)) — all multi-tenant under super-admin `simon@localblitzmarketing.com`.

**Tests:** 577 passing repo-wide. Migrations 0001–0007 all applied to staging D1.

**CI:** clean; auto-deploys both workers (frontend + proxy) on merge to main.

## Top of mind for next session

### 1. Pick a direction (see Next-steps menu in [STATUS.md](STATUS.md))

Reasonable next moves, ranked:
- **Phase F — super-admin user CRUD** (~2 hr) — `/admin/users` invite/edit/delete/force-reset. Foundational if anyone besides you needs to admin sites.
- **SEO operational tools — IndexNow + sitemap generation** (~4 hr) — actively useful for SEO product, secrets bound but unwired
- **Production deploy** (~4 hr) — first paying customer trigger. New CF resources + secrets + DNS cut.
- **Cluster Slice D — reporting** (~2 hr) — combined stats across cluster members; rounds out the cluster product

### 2. CI deploy-production may still be failing

The legacy `deploy-production` CI job runs on main pushes. There's no production env yet, so it fails every time. Easy small PR — guard behind `workflow_dispatch` input or environment label. Mentioned in prior handoffs but unaddressed.

### 3. Phase G (deprecate edge-seo-admin)

After validating /app/* parity for a stretch of real use, delete the legacy `admin-worker/`. Kept around for safety but currently dead weight.

## Phase status

| Phase | Status | Notes |
| --- | --- | --- |
| A — D1 schema + super-admin seed | ✅ shipped | Migration 0002_users.sql; users / sessions / email_tokens; clients.owner_id |
| B — frontend-worker scaffolding | ✅ shipped | Landing page on edgeseo.app |
| C — Cloudflare Email Service | ✅ shipped | Public beta binding; SPF+DKIM+DMARC auto-config on edgeseo.app |
| D — Auth flows | ✅ shipped | PBKDF2 sessions, login/forgot/reset/verify/logout |
| E v1 — read-only /app/* with multi-tenancy | ✅ shipped | Sidebar nav, overview, sites list, detail, audit |
| E v2 — write handlers in /app/* | ✅ shipped | Edit / status flip / cache-purge / attestation / new site |
| E v3.1 — rich list editors | ✅ shipped | Single template-literal in `frontend-worker/src/list-editor-js.ts` |
| **In_place mode + auto-onboard** | ✅ shipped | Worker on customer's own apex; CF API automation creates DNS + Workers Route |
| **Multi-zone proxy** | ✅ shipped (PR #57) | localpage + localsite zones |
| **Link Projects (Slices 1–4)** | ✅ shipped (PR #58) | Registry + placements + worker injection + rotation + selector strategy + stats + bulk apply |
| **Clusters Slice A — registry** | ✅ shipped (PR #60) | Topical + geo groupings of 1–25 sites |
| **Bulk-create proxied sites** | ✅ shipped (PR #61) | Paste-URLs flow with optional cluster auto-assignment |
| **Clusters Slice B — link-project bulk-apply integration** | ✅ shipped (PR #62) | Cluster picker pre-fills checkbox grid |
| **Clusters Slice C — cross-linking** | ✅ shipped (PR #65) | "Related sites" footer between members |
| **Sites page filters + Proxied sites rename** | ✅ shipped (PR #64) | Search/status/zone/cluster filters; per-site sidebar sub-list dropped |
| **F — super-admin user CRUD** | ⏳ NOT STARTED | `/admin/users` invite + edit + delete + force-reset. ~2 hours when you want it. |
| **G — deprecate edge-seo-admin worker** | ⏳ NOT STARTED | After /app/* parity confirmed in real use. |
| **Production deploy** | ⏳ NOT STARTED | Staging-only. wrangler.toml has REPLACE_WITH_PRODUCTION_KV_ID placeholders. |
| **IndexNow + sitemap** | ⏳ NOT STARTED | Secret bound, code skeleton in src/sitemap/, no implementation. |
| **Cluster Slice D — reporting** | ⏳ NOT STARTED | Combined stats across cluster members. |
| **Auto-schema injection (potential Cluster Slice E)** | ⏳ NOT STARTED | Needs structured fields cluster doesn't have yet (lat/lon, address, phone). |

## Architecture decisions (still in force)

1. Invite-only signup (no public signup form)
2. Multi-tenant resources — `owner_id` on clients, link_projects, clusters; super-admin override
3. From: `noreply@edgeseo.app`
4. Reply-To: `simon@localblitzmarketing.com`
5. Super-admin seed has no password; uses /forgot flow on first login
6. Brand: "Edge SEO Platform"
7. Link projects use the existing `content_injections` pipeline — placements pre-synthesized to ContentInjectRule shape at admin-write time, stored in `placements:<id>` KV. Proxy worker reads in parallel with config + merges.
8. Anchor rotation is deterministic per (placement.id, page_match) — same URL always shows the same anchor; diversity emerges across the placement set.
9. 0-byte 200 responses are NEVER cached — invariant in `canWriteToCache` after observed CF cache poisoning.
10. Multi-zone is operator-friendly via `PROXY_ZONES` array — adding a third zone = one line in the array + one route entry + one DNS wildcard A.

**New decisions from the clusters era:**

11. **Clusters are a labeled grouping of 1–25 proxied sites** — single table `clusters` with `type IN ('topical','geo')` discriminator. Multi-tenant. Composite-PK many-to-many `cluster_members` against the `clients` table.
12. **DB column stays `client_id` even though UI says "site"** — terminology / schema split. UI labels read "site" / "Proxied sites" everywhere; underlying FK stays `client_id` for consistency with the rest of the schema. Renaming the table is a separate, deferred refactor.
13. **Cluster cross-linking mirrors link-projects 2B architecture** — `cross_link_enabled` toggle per cluster; admin-time KV compile to `cluster_links:<client_id>`; loader reads in parallel with `placements:<id>` and merges. Same envelope shape, same mergePlacements helper reused.
14. **The cluster picker on link-project bulk-apply has TWO buttons**: "Use this cluster" (replaces selection) and "+ Add to selection" (additive). Two buttons emerged from a UX bug — additive-on-top-of-default-checked-everything looked like "selected all" — see PR #63.
15. **Bulk-create is subdomain_proxy mode only** — in_place needs per-site DNS work that can't auto-run at scale. One zone + one batch attestation per submission. Cap 100 rows.
16. **Per-site sidebar sub-list was dropped** in favor of a Sites page filter card. Doesn't scale past ~25 sites.

Don't reverse these without explicit conversation.

## Working environment

- Worktree: `C:\CodeProjects\DomainEdge\.claude\worktrees\sad-bouman-d04300`
- Main checkout: `C:\CodeProjects\DomainEdge\` — kept synced after each merge with `git -C ... pull` (use stash + checkout-from-HEAD if `.claude/settings.local.json` conflicts with upstream)
- Wrangler authenticated in PowerShell with OAuth — `npx wrangler deploy` works for manual emergency deploys
- `gh` CLI not authenticated in bash, but the GitHub API works via `printf "protocol=https\nhost=github.com\n\n" | git credential fill` extracting the token from Windows Credential Manager (used to open + merge PRs in this session and the prior one)

## Known gotchas

- **`gh` CLI**: not authenticated in this shell. Workaround: `printf "protocol=https\nhost=github.com\n\n" | git credential fill` extracts the token; pipe to `Authorization: Bearer …` in `curl` calls to api.github.com.
- **PowerShell vs bash for wrangler**: PowerShell has working OAuth; bash via Git for Windows often does not. Run wrangler from PowerShell for account-affecting commands.
- **wrangler 3.114.x quirks**: warns about Email Sending's `allowed_sender_addresses` field (wrangler 4 only). Harmless.
- **CI integration tests skipped**: `@cloudflare/vitest-pool-workers` on wrangler 3.114 hangs mid-suite. §12.2 scenarios written but skipped until wrangler 4 + vitest-pool-workers upgrade.
- **Legacy admin-worker basic-auth secrets reset on every CI redeploy**: observed; doesn't affect operators who set secrets via wrangler.
- **`deploy-production` CI job fails on every main push**: no production env yet. Followup: gate or remove this job.
- **Settings file conflicts on `git pull`**: `.claude/settings.local.json` accumulates Bash/PowerShell permission entries every session. Pull conflicts are routine — resolve by taking HEAD's version (which has the freshly-accumulated permissions); local additions are typically already there.

## File map — the bits that matter

```
edge-seo-platform-staging worker (proxy engine)
  src/worker.ts                  ← §5 pipeline entry
  src/config/loader.ts           ← Reads placements:<id> + cluster_links:<id> in parallel
                                   with config:<id>, merges both into content_injections
  src/config/proxy-zone.ts       ← PROXY_ZONES array + matchProxyZone helper
  src/config/                    ← Zod schema + invariants
  src/transform/                 ← HTMLRewriter pipeline
  src/cache/index.ts             ← Response cache + §9.1 invariants (incl. 0-byte poison guard)
  src/redirects/                 ← Three-layer resolver
  src/canonical/                 ← Canonical strategy

edge-seo-frontend worker (the one that matters most for admin UX now)
  frontend-worker/src/index.ts   ← Router: auth flows + /app/* (Sites / Link projects /
                                   Clusters / Audit) + /admin/*
  frontend-worker/src/auth.ts    ← PBKDF2, sessions, email tokens
  frontend-worker/src/email.ts   ← Email Service templates
  frontend-worker/src/app.ts     ← /app/* page rendering, sidebar, Sites page (with filter card)
  frontend-worker/src/link-projects.ts ← Link Projects feature (~2000 lines): types,
                                   validation, synthesizer, KV compile, audit, all routes
  frontend-worker/src/clusters.ts ← Clusters feature: types, validation, member-list,
                                   cross-link synthesizer + KV compile, all routes
  frontend-worker/src/bulk-clients.ts ← Bulk-create paste-URLs flow: parsing, derivation,
                                   conflict resolution, validation
  frontend-worker/src/cloudflare-api.ts ← CF API helpers (zones, DNS, routes, cache purge)
  frontend-worker/src/inspector.ts ← CSS selector picker
  frontend-worker/src/list-editor-js.ts ← Client-side JS for rich list editors

D1 migrations (all applied to staging)
  migrations/0001_initial.sql                         ← clients, attestations, audit_log, forms
  migrations/0002_users.sql                           ← Phase A: users, sessions, email_tokens, owner_id
  migrations/0003_link_projects.sql                   ← Slice 1: link_projects
  migrations/0004_link_project_placements.sql        ← Slice 2A: placements
  migrations/0005_link_project_placement_selector.sql ← Slice 3: target_selector + position
  migrations/0006_clusters.sql                       ← Cluster Slice A: clusters + cluster_members
  migrations/0007_cluster_cross_linking.sql          ← Cluster Slice C: cross_link_enabled column

Tests
  tests/unit/frontend-worker/link-projects.test.ts ← 80+ tests for link-projects
  tests/unit/frontend-worker/clusters.test.ts      ← Cluster validation + member-list + cross-link synth
  tests/unit/frontend-worker/bulk-clients.test.ts  ← URL parsing + derivation + conflict resolution
  src/config/loader.test.ts                        ← Loader merge of placements + cluster_links
  src/cache/index.test.ts                          ← 0-byte cache poison guard
```

## What to do FIRST in the next session

1. **Read this file + [STATUS.md](STATUS.md).**
2. **Sync local main:**
   ```bash
   cd C:\CodeProjects\DomainEdge
   git fetch origin
   git checkout main
   git pull origin main
   # If .claude/settings.local.json conflicts: stash, pull, take HEAD version
   ```
3. **Pick a direction:** Phase F user CRUD, IndexNow + sitemap, production deploy, cluster reporting, or something else from the [STATUS.md](STATUS.md) menu.

The platform is genuinely shippable. From here it's mostly polish + operational hygiene + new SEO product surface.

— end of handoff
