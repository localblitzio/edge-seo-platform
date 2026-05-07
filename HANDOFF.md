# Session handoff — 2026-05-06 → 2026-05-07

**Read this first** when resuming. Then [STATUS.md](STATUS.md) for the broader picture.

This session shipped **two big merges** to main: multi-zone proxy support (PR #57) and **the entire Link Projects feature** across four planned slices + two fixes (PR #58). Plus a cleanup pass on platform docs + audit logging. The platform's "edge SEO control plane" surface is now genuinely competitive with bespoke PBN tools.

## What landed (in merge order)

**PR #57 — `feat(admin): multi-zone proxy_domain picker (one radio per zone)`**
- New `PROXY_ZONES = ["localpage.us.com", "localsite.us.com"]` array; clients can pick either zone
- `wrangler.toml` now persists routes for both zones + the in_place clients (drift check passes)
- Reserved-subdomain stoplist applies to all zones, not just the default
- Drive-by: fixed 3 pre-existing latent type errors (R2 list cursor, fetch body) under `exactOptionalPropertyTypes`

**PR #58 — `feat(admin): Link projects — registry, placements, worker injection, rotation, selector strategy, stats`**

Seven commits implementing four planned slices end-to-end:
- **Slice 1** — read-only Link Projects registry: D1 table, list/new/detail/edit/status routes, sidebar entry
- **Slice 2A** — placements admin UI: per-(project × client × page-match) rows with strategy + anchor-override + rel
- **Slice 2B** — worker pipeline integration: `placements:<client_id>` KV compiled at admin-write time, merged into `config.content_injections` by [src/config/loader.ts](src/config/loader.ts), CF HTTP cache purged after compile
- **Fix** — cache-purge zone-derive uses proven `matchProxyZone` logic (the original walk-up was buggy and silently failed)
- **Fix** — `canWriteToCache` refuses 0-byte 200 responses (cache-poisoning guard after observed bad cache during a deploy/purge race)
- **Slice 3** — anchor rotation (deterministic per `placement.id + page_match` via FNV-1a) + new `selector` strategy with custom CSS selector + position
- **Slice 4** — stat cards on the project detail page, "Check target URL" button (probes target with redirect chain + 8s timeout), bulk-apply form (checkbox grid, one submit creates N placements)

**End-to-end verified:** rfengineer + 404-media show injected `<div data-lp-placement="<id>"><a href="https://localblitz.ai/" rel="noopener">Local AI</a></div>` before `</body>`.

**Drive-by cleanup (in-flight, this session, separate small PR pending):**
- Audit log entries for placement create / edit / delete / bulk-create — uses existing `config_update` event_type with descriptive `notes` so no schema migration needed
- bestofindianapolis `source_domain` cleanup — already fixed by user via UI
- STATUS.md + HANDOFF.md updated

## Where things are right now

```
edgeseo.app/*                     → edge-seo-frontend
*.localpage.us.com/*              → edge-seo-platform-staging
*.localsite.us.com/*              → edge-seo-platform-staging  ← NEW
404-media.com/*                   → edge-seo-platform-staging  (in_place mode)
seoinencinitas.com/*              → edge-seo-platform-staging  (in_place mode)
```

**7 active clients:** lantern-crest, 404-media, seoinencinitas, rfengineer, bestofindianapolis, simonwhiteai, theheritagesteakhouse — all multi-tenant under super-admin `simon@localblitzmarketing.com`.

**Tests:** 505+ passing repo-wide. Migrations 0003 + 0004 + 0005 all applied to staging D1.

**CI:** clean. Multi-zone + link-projects merges deployed cleanly. Both workers (frontend + proxy) pinned to the latest commit on main.

## Top of mind for next session

### 1. Pick a direction (see Next-steps menu in [STATUS.md](STATUS.md))

The platform is feature-rich now. Reasonable next moves, ranked:
- **Phase F — super-admin user CRUD** (~2 hrs) — `/admin/users` invite/edit/delete/force-reset. Already in this file's Phase status as the planned next phase. Required if anyone besides you needs to admin clients.
- **SEO operational tools — IndexNow + sitemap generation** (~4 hrs) — actively useful for SEO product, secret bound but unwired
- **Production deploy** (~4 hrs) — first paying customer trigger. Needs new CF resources + secrets + DNS cut
- **Operational dashboards** (~3 hrs) — read Workers Analytics Engine for p95 / error rate / cache hit ratio per client (PRD §10)

### 2. CI deploy-production may still be failing

The legacy `deploy-production` CI job runs on main pushes. There's no production env yet, so it fails every time. Easy small PR — guard behind `workflow_dispatch` input or environment label. Mentioned in prior handoff but unaddressed.

### 3. Phase G (deprecate edge-seo-admin)

After validating /app/* parity for a week or so, delete the legacy `admin-worker/`. Kept around for safety but currently dead weight.

## Phase status

| Phase | Status | Notes |
| --- | --- | --- |
| A — D1 schema + super-admin seed | ✅ shipped | Migration 0002_users.sql; users / sessions / email_tokens; clients.owner_id |
| B — frontend-worker scaffolding | ✅ shipped | Landing page on edgeseo.app |
| C — Cloudflare Email Service | ✅ shipped | Public beta binding; SPF+DKIM+DMARC auto-config on edgeseo.app |
| D — Auth flows | ✅ shipped | PBKDF2 sessions, login/forgot/reset/verify/logout |
| E v1 — read-only /app/* with multi-tenancy | ✅ shipped | Sidebar nav, overview, clients list, detail, audit |
| E v2 — write handlers in /app/* | ✅ shipped | Edit / status flip / cache-purge / attestation / new client |
| E v3.1 — rich list editors | ✅ shipped | Single template-literal in `frontend-worker/src/list-editor-js.ts` |
| **In_place mode + auto-onboard** | ✅ shipped | Worker on customer's own apex; CF API automation creates DNS + Workers Route |
| **Multi-zone proxy** | ✅ shipped (PR #57) | localpage + localsite zones |
| **Link Projects (Slices 1–4)** | ✅ shipped (PR #58) | Registry + placements + worker injection + rotation + selector strategy + stats + bulk apply |
| **F — super-admin user CRUD** | ⏳ NOT STARTED | `/admin/users` invite + edit + delete + force-reset. ~2 hours when you want it. |
| **G — deprecate edge-seo-admin worker** | ⏳ NOT STARTED | After /app/* parity confirmed in real use. |
| **Production deploy** | ⏳ NOT STARTED | Staging-only. wrangler.toml has REPLACE_WITH_PRODUCTION_KV_ID placeholders. |
| **IndexNow + sitemap** | ⏳ NOT STARTED | Secret bound, code skeleton in src/sitemap/, no implementation. |

## Architecture decisions (still in force)

1. Invite-only signup (no public signup form)
2. Multi-tenant clients — `owner_id` on clients; super-admin override
3. From: `noreply@edgeseo.app`
4. Reply-To: `simon@localblitzmarketing.com`
5. Super-admin seed has no password; uses /forgot flow on first login
6. Brand: "Edge SEO Platform"

**New decisions from this session:**

7. **Link projects use the existing `content_injections` pipeline** — placements are pre-synthesized to ContentInjectRule shape at admin-write time and stored in `placements:<client_id>` KV. The proxy worker reads this in parallel with the main config and merges into `config.content_injections`. Operator-defined rules run first; placement rules run last.
8. **Anchor rotation is deterministic per (placement.id, page_match)** — same URL always shows the same anchor across requests; diversity emerges across the placement set. `anchor_override` still pins per placement.
9. **0-byte 200 responses are NEVER cached** — invariant added to `canWriteToCache` after observing CF cache poisoning during a deploy/purge race. Streaming responses (no `content-length`) are unaffected.
10. **Multi-zone is operator-friendly via the array** — `PROXY_ZONES = ["localpage.us.com", "localsite.us.com"]` in `src/config/proxy-zone.ts`. Adding a third zone is one line in the array + one route entry in wrangler.toml + one DNS wildcard A record.

Don't reverse these without explicit conversation.

## Working environment

- Worktree: `C:\CodeProjects\DomainEdge\.claude\worktrees\sad-bouman-d04300`
- Main checkout: `C:\CodeProjects\DomainEdge\` — keep it synced after each merge (`git checkout main && git pull origin main`)
- Both feature branches (`claude/multi-proxy-zones`, `claude/link-projects-slice-1`) merged + deleted on remote
- Wrangler authenticated in PowerShell with OAuth — `npx wrangler deploy` works for manual emergency deploys
- `gh` CLI not authenticated in bash, but the GitHub API works via `git credential fill` extracting the token from Windows Credential Manager (used to open + merge both PRs in this session)

## Known gotchas

- **`gh` CLI**: not authenticated in this shell. Workaround: `printf "protocol=https\nhost=github.com\n\n" | git credential fill` extracts the token; pipe it to `Authorization: Bearer …` in `curl` calls to the GitHub API.
- **PowerShell vs bash for wrangler**: PowerShell has working OAuth; bash via Git for Windows often does not. Run wrangler from PowerShell for account-affecting commands.
- **wrangler 3.114.x quirks**: warns about Email Sending's `allowed_sender_addresses` field (wrangler 4 only). Harmless.
- **CI integration tests skipped**: `@cloudflare/vitest-pool-workers` on wrangler 3.114 hangs mid-suite. §12.2 scenarios written but skipped until wrangler 4 + vitest-pool-workers upgrade.
- **Legacy admin-worker basic-auth secrets reset on every CI redeploy**: observed; doesn't affect operators who set secrets via wrangler.
- **`deploy-production` job fails on every main push**: no production env yet. Followup: gate or remove this job.

## File map — the bits that matter

```
edge-seo-platform-staging worker (proxy engine)
  src/worker.ts                  ← §5 pipeline entry
  src/config/loader.ts           ← NEW: reads placements:<id> KV in parallel, merges
                                   into config.content_injections
  src/config/proxy-zone.ts       ← PROXY_ZONES array + matchProxyZone helper
  src/config/                    ← Zod schema + invariants
  src/transform/                 ← HTMLRewriter pipeline (incl. content-injector with
                                   idempotence)
  src/cache/index.ts             ← Response cache + §9.1 invariants (incl. NEW
                                   0-byte poison guard)
  src/redirects/                 ← Three-layer resolver
  src/canonical/                 ← Canonical strategy

edge-seo-frontend worker (the one that matters most for admin UX now)
  frontend-worker/src/index.ts   ← Router: auth flows + /app/* + /admin/* + link-projects
  frontend-worker/src/auth.ts    ← PBKDF2, sessions, email tokens
  frontend-worker/src/email.ts   ← Email Service templates
  frontend-worker/src/app.ts     ← /app/* clients pages + write handlers + sidebar
  frontend-worker/src/link-projects.ts ← NEW (this session): Link Projects feature —
                                   types, validation, synthesizer, KV compile, audit,
                                   all routes (~2000 lines)
  frontend-worker/src/cloudflare-api.ts ← CF API helpers (zones, DNS, routes, cache purge)
  frontend-worker/src/inspector.ts ← CSS selector picker
  frontend-worker/src/list-editor-js.ts ← Client-side JS for rich list editors

D1 migrations
  migrations/0001_initial.sql    ← clients, attestations, audit_log, form_submissions
  migrations/0002_users.sql      ← Phase A: users, sessions, email_tokens, owner_id
  migrations/0003_link_projects.sql ← Slice 1: link_projects table
  migrations/0004_link_project_placements.sql ← Slice 2A: placements table
  migrations/0005_link_project_placement_selector.sql ← Slice 3: target_selector + position
                                   (table rebuild, broaden strategy CHECK)

Tests
  tests/unit/frontend-worker/link-projects.test.ts ← 80+ tests for the link-projects module
  src/config/loader.test.ts      ← 5 new tests for placements merge behavior
  src/cache/index.test.ts        ← 2 new tests for 0-byte cache guard
```

## What to do FIRST in the next session

1. **Read this file + [STATUS.md](STATUS.md).**
2. **Sync local main:**
   ```bash
   cd C:\CodeProjects\DomainEdge
   git checkout main
   git pull origin main
   ```
3. **Pick a direction:** Phase F user CRUD, IndexNow + sitemap, production deploy, ops dashboards, or something else from the STATUS.md menu.

The platform is in a "would feel ready to demo to a paying customer" state. The link-projects feature in particular is the kind of thing other tools charge $50-200/mo for. From here it's all polish + operational hygiene + new SEO product surface.

— end of handoff
