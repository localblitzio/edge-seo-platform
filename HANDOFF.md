# Session handoff — 2026-05-04 → 2026-05-05

**Read this first** when resuming. Then [STATUS.md](STATUS.md) for the broader picture.

This was a **massive session**. 21 PRs shipped, multi-user auth + multi-tenant
clients live on a new app domain, full edit UI with rich form editors, real
emails delivering. The platform is genuinely usable end-to-end now.

## Where things are right now

```
edgeseo.app/*                  → edge-seo-frontend  (NEW: landing, auth, /app, /admin)
*.localpage.us.com/*           → edge-seo-platform-staging  (proxy engine, §5 pipeline)
edge-seo-frontend.localblitzio.workers.dev (workers.dev fallback)
edge-seo-admin.localblitzio.workers.dev (legacy basic-auth admin — slated for deprecation)
```

**What's live and working:**
- `https://edgeseo.app/` — landing
- `https://edgeseo.app/login` — login (you have a password set; super-admin = simon@localblitzmarketing.com)
- `https://edgeseo.app/forgot` — reset flow (verified — emails deliver from noreply@edgeseo.app)
- `https://edgeseo.app/app` — overview / dashboard
- `https://edgeseo.app/app/clients` — clients list (multi-tenant: super-admin sees all, regular users see WHERE owner_id = self)
- `https://edgeseo.app/app/clients/new` — create new client (form auto-fills subdomain + origin from typed values)
- `https://edgeseo.app/app/clients/:id/edit` — edit client with **5 rich list-section editors**:
  - Indexation rules
  - Canonical rules
  - Schema injections (with JSON-LD payload editor)
  - Static redirects
  - Meta rewrites
- `https://edgeseo.app/app/clients/:id/attest` — attestation form
- `https://edgeseo.app/app/clients/:id/status` (POST) — flip active/paused/terminated
- `https://edgeseo.app/app/clients/:id/cache-purge` (POST) — manual KV invalidate
- `https://edgeseo.app/app/audit` — audit log + attestations (filtered)
- Three real proxy clients serve traffic: lantern-crest, rfengineer, simonwhiteai

**Tests:** 345 passing. 13 todo. 12 skipped.

**CI:** clean. Auto-deploys all three workers (edge-seo-platform-staging,
edge-seo-admin, edge-seo-frontend) to staging on merge to main.

## Top of mind for next session

### 1. URGENT credential rotation (you, ~3 min)

These are still in chat history of this session — they should be considered
compromised:

- **Cloudflare Global API Key** — https://dash.cloudflare.com/profile/api-tokens
  → scroll to Global API Key at the bottom → **Roll**.
- **Admin worker basic-auth secrets** (legacy `edge-seo-admin` worker) —
  reset to your own values:
  ```powershell
  cd C:\CodeProjects\DomainEdge
  npx wrangler secret put ADMIN_USERNAME --name edge-seo-admin
  npx wrangler secret put ADMIN_PASSWORD --name edge-seo-admin
  ```

### 2. Use the editor in real onboarding

Best feedback signal: actually onboard a real client through
`/app/clients/new`. The auto-fill + rich form editors should make it
much faster than the legacy admin worker. Note any rough edges and
tell me — those are the most valuable bugs to fix.

### 3. CI deploy-production failing every push

The workflow has a `deploy-production` job that runs on main pushes.
There's no production env yet, so it fails every time. Easy fix in a
small PR — guard it behind a manual workflow_dispatch input or a
"prod-ready" branch label.

## Phase status

| Phase | Status | Notes |
| --- | --- | --- |
| A — D1 schema + super-admin seed | ✅ shipped | Migration 0002_users.sql; users / sessions / email_tokens; clients.owner_id |
| B — frontend-worker scaffolding | ✅ shipped | Landing page on edgeseo.app |
| C — Cloudflare Email Service | ✅ shipped | Public beta binding; SPF+DKIM+DMARC auto-config on edgeseo.app |
| D — Auth flows | ✅ shipped | PBKDF2 (25k iter, fits Workers Bundled CPU budget), sessions, login/forgot/reset/verify/logout |
| E v1 — read-only /app/* with multi-tenancy | ✅ shipped | Sidebar nav, overview, clients list, detail, audit |
| E v2 — write handlers in /app/* | ✅ shipped | Edit / status flip / cache-purge / attestation / new client; ownership-checked POSTs |
| E v3 — rich list editors (FAILED, reverted) | ❌ rolled back in PR #20 | Inline JS broke V8 parsing |
| E v3.1 — rich list editors take 2 | ✅ shipped (PR #21) | Single template-literal in `frontend-worker/src/list-editor-js.ts`, parse-validated by `new Function()` test before deploy |
| F — super-admin user CRUD | ⏳ NOT STARTED | `/admin/users` invite + edit + delete + force-reset. ~2 hours when you want it. |
| G — deprecate edge-seo-admin worker | ⏳ NOT STARTED | After you've used /app/* for a few days and confirmed it has parity. |

## Architecture decisions captured (six decisions earlier in this session)

1. **Invite-only signup** (no public signup form)
2. **Multi-tenant clients** — `owner_id` on clients; super-admin override
3. **From: `noreply@edgeseo.app`**
4. **Reply-To: `simon@localblitzmarketing.com`**
5. **Super-admin seed has no password; uses /forgot flow on first login**
6. **Brand: "Edge SEO Platform"**

These shape every UX choice in the auth + admin flows. Don't reverse without
explicit conversation.

## Working environment

- Worktree: `C:\CodeProjects\DomainEdge\.claude\worktrees\sad-bouman-d04300`
- Main checkout: `C:\CodeProjects\DomainEdge\` — keep it synced after each merge
  (`git checkout main && git pull origin main`)
- Wrangler authenticated in PowerShell with OAuth — `npx wrangler deploy` works
  for manual emergency deploys
- Tests run on Linux CI (Ubuntu); local Windows lint shows ~97 CRLF/LF false
  positives that don't appear in CI — ignore them locally

## Known gotchas

- **PowerShell vs bash for wrangler**: PowerShell has working OAuth; bash via
  Git for Windows often does not. Always run wrangler from PowerShell for
  account-affecting commands.
- **wrangler 3.114.x quirks**: warns about Email Sending's
  `allowed_sender_addresses` field (wrangler 4 only). Harmless — application
  code hardcodes the From.
- **CI integration tests skipped**: `@cloudflare/vitest-pool-workers` on
  wrangler 3.114 has a hang in mid-suite. The §12.2 scenarios are written
  but skipped from CI until wrangler 4 + vitest-pool-workers upgrade.
- **Legacy admin-worker basic-auth secrets reset on every CI redeploy**:
  observed three times. Looks like a Cloudflare Workers behavior on the
  legacy Bundled CPU model. Doesn't affect operators who set their own
  secrets through wrangler — only an issue if you're rotating them via
  the Cloudflare REST API.
- **deploy-production job fails on every main push**: no production env
  exists yet. Followup: gate or remove this job.

## File map (the bits that matter)

```
edge-seo-platform-staging worker (UNCHANGED — proxy engine)
  src/worker.ts                  ← §5 pipeline entry
  src/config/                    ← Zod schema + invariants + proxy-zone helpers
  src/transform/                 ← HTMLRewriter pipeline
  src/redirects/                 ← Three-layer resolver
  ...                            ← all unchanged from Phase 1

edge-seo-admin worker (LEGACY, deprecating in Phase G)
  admin-worker/src/index.ts      ← basic-auth dashboard, monolithic

edge-seo-frontend worker (NEW, the one that matters now)
  frontend-worker/src/index.ts   ← router: landing, /login, /forgot, /reset,
                                   /verify, /logout, /app/*, /admin/*
  frontend-worker/src/auth.ts    ← PBKDF2, sessions, email tokens, cookies
  frontend-worker/src/email.ts   ← Cloudflare Email Service templates
  frontend-worker/src/app.ts     ← /app/* page rendering + write handlers
  frontend-worker/src/list-editor-js.ts  ← String.raw client-side JS for the
                                          rich list-section editors (Phase E v3.1)
  frontend-worker/wrangler.toml  ← Worker config: route on edgeseo.app/*,
                                   D1 + KV + Email Sending bindings

D1 migrations
  migrations/0001_initial.sql    ← clients, attestations, audit_log, form_submissions
  migrations/0002_users.sql      ← users, sessions, email_tokens, clients.owner_id

Tests
  tests/unit/frontend-worker/    ← auth, email templates, list-editor parse-validation
  tests/unit/admin-worker/       ← legacy admin helpers
  src/**/*.test.ts               ← per-module unit tests for the proxy engine
```

## What to do FIRST in the next session

1. **Read this file.**
2. **Read STATUS.md.**
3. **Rotate creds (top of mind item 1).** If you didn't do it yet.
4. Pick one of:
   - Real-world client onboarding via /app/clients/new (best signal)
   - Phase F (super-admin user CRUD)
   - Phase G (delete admin-worker)
   - CI cleanup (deploy-production guard)

The platform is genuinely shippable as-is. Everything from here is polish
and operational hygiene. Good luck.

— end of handoff
