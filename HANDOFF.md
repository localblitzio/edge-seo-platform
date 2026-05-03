# Session handoff — Phase 2 admin editor

**Created:** session ending 2026-05-03 (context window approaching limit).
**Read this first** when resuming. Then [STATUS.md](STATUS.md) for the broader picture.

## Where we are

Working tree is **clean** and pushed to `main`. Last commit is `855983c` (the
STATUS.md add). No half-baked changes. CI on GitHub is green for that commit.

The platform is **fully shipped Phase 1** + **read-only Phase 2 admin** at:

- Edge worker: https://edge-seo-platform-staging.localblitzio.workers.dev (serving Lantern Crest)
- Admin worker: https://edge-seo-admin.localblitzio.workers.dev (read-only dashboard)

## What was in flight when the session paused

Started building the **Phase 2 admin editor write surface**. User picked
option 3 from the next-steps menu and asked the agent to keep building
overnight; agent stopped before any code landed in order to leave a clean
working tree as context filled up.

**Nothing was committed for this work.** `git status` is clean, you start
from `855983c` with the read-only admin worker at `admin-worker/src/index.ts`.

## What to build next session — full plan

### Goal

Turn `admin-worker/` from a read-only dashboard into a real editor that
can do everything `npm run seed-client` can do, plus operations work
(status flips, attestation capture, cache purge), all from the web UI.

### Scope (priority-ordered)

1. **Edit config JSON** — POST handler + textarea form. Server-side Zod
   validation reusing `src/config/schema.ts` and `src/config/validator.ts`
   (spec §7 invariant: admin-time and Worker-time validation must be
   IDENTICAL, hence the import).
2. **Status flips** (active / paused / terminated) — buttons on the client
   detail page. Confirm dialog ONLY for `terminated` (one-way door per
   PRD §6.3). Update D1 `clients.status` AND mirror into `config_json.status`.
3. **Manual cache purge per client** — single button. Deletes `config:<id>`
   and `domain:<proxy_domain>` from KV.
4. **Attestation capture form** — fields per spec §6.8 schema: email, ip,
   scope (full_site | specified_paths), scope_paths (CSV when scope is
   specified_paths), user_agent. INSERT into `attestations` (append-only).
5. **Add new client** — paste JSON form. INSERT into D1, prime KV, write
   `config_create` audit_log entry.
6. **Audit log writes** — every mutation above writes a row to `audit_log`
   (table already exists in `migrations/0001_initial.sql`):
   - actor_email = the basic-auth username
   - actor_ip = `cf-connecting-ip` header
   - event_type = one of: `config_create | config_update | status_change |
     revocation | authorization_update`
   - before_hash / after_hash = FNV-1a 32-bit of the JSON for diff tracking
   - previous_status / new_status for status_change and revocation events

### Architecture

- **One file:** `admin-worker/src/index.ts` (where the read-only dashboard
  already lives). Keep it monolithic — splitting up doesn't help yet.
- **Imports of validators:** add to `admin-worker/tsconfig.json`'s `include`:
  ```
  "include": [
    "src/**/*",
    "../src/config/schema.ts",
    "../src/config/validator.ts",
    "../src/config/types.ts",
    "../src/lib/errors.ts"
  ]
  ```
  And `"rootDir": ".."` in compilerOptions so TypeScript accepts the
  out-of-directory imports. Then in `index.ts`:
  ```ts
  import { ClientConfig } from "../../src/config/schema.js";
  import { assertConfigInvariants } from "../../src/config/validator.js";
  ```
  Wrangler will bundle these via the standard module resolver. No build
  config change needed beyond the tsconfig include.
- **CSRF defense:** every POST handler checks `Origin` (or `Referer` when
  Origin missing) matches the request URL's origin. Returns 403 on mismatch.
  Combined with HTTP basic auth, that's the right level for an internal
  agency tool. SSO via Cloudflare Access is the long-term answer.
- **Form pattern:** plain HTML `<form method="POST">` with hidden fields
  for verbs. POST handler returns 303 redirect to a flash-message URL so
  `?flash=...&flash_kind=ok|warn|err` shows on the destination page.
- **Validation flow:** parse body → JSON.parse → Zod safeParse → run
  `assertConfigInvariants` → on success, persist + audit. On any failure,
  re-render the form with the user's submitted JSON pre-filled and the
  errors listed inline (don't lose their work).

### Routes to add (POST handlers)

| Method | Path | Action |
| --- | --- | --- |
| GET | `/clients/new` | Render add-new-client form |
| POST | `/clients/new` | Validate → INSERT into D1 → prime KV → audit |
| GET | `/clients/:id/edit` | Render edit form prefilled with current config |
| POST | `/clients/:id/edit` | Validate → UPDATE D1 → invalidate KV → audit |
| POST | `/clients/:id/status` | UPDATE status only → invalidate KV → audit |
| POST | `/clients/:id/cache-purge` | KV invalidate only → audit |
| GET | `/clients/:id/attest` | Render attestation form |
| POST | `/clients/:id/attest` | Validate → INSERT into attestations → audit |

All other current routes stay as-is.

### Specific code I had ready to write

I started a complete `admin-worker/src/index.ts` rewrite (~900 lines). The
key bits, in pseudocode, that you can recreate:

```typescript
// CSRF defense for POSTs
function checkCsrf(request, url) {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (origin) return origin === `${url.protocol}//${url.host}` ? null
    : new Response("CSRF: Origin mismatch", { status: 403 });
  if (referer) {
    try { return new URL(referer).host === url.host ? null
      : new Response("CSRF: Referer mismatch", { status: 403 }); } catch {}
  }
  return new Response("CSRF: missing Origin and Referer", { status: 403 });
}

// FNV-1a hash for audit before/after diff hashes (already used in M5 markers)
function fnvHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i); h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// KV invalidation pattern
async function invalidateKv(env, clientId, proxyDomain) {
  await Promise.all([
    env.CONFIG_KV.delete(`config:${clientId}`),
    env.CONFIG_KV.delete(`domain:${proxyDomain}`),
  ]);
}

// Audit log write
async function writeAudit(env, entry) {
  await env.CONFIG_DB.prepare(
    `INSERT INTO audit_log
       (client_id, actor_email, actor_ip, event_type,
        before_hash, after_hash, previous_status, new_status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    entry.client_id, entry.actor_email, entry.actor_ip, entry.event_type,
    entry.before_hash ?? null, entry.after_hash ?? null,
    entry.previous_status ?? null, entry.new_status ?? null, entry.notes ?? null,
  ).run();
}

// Edit handler skeleton
async function handleEdit(request, env, url, clientId, actor) {
  if (checkCsrf(request, url)) return that;
  const form = await request.formData();
  const json = form.get("config_json");
  // 1. JSON.parse — on fail, re-render form with error
  // 2. ClientConfig.safeParse — on fail, re-render form with issues
  // 3. assertConfigInvariants — on fail, re-render with the message
  // 4. cfg.client_id !== clientId — reject (renaming via edit not supported)
  // 5. UPDATE D1, invalidateKv, writeAudit({ event_type: "config_update", before_hash, after_hash })
  // 6. 303 redirect to /clients/:id?flash=Saved&flash_kind=ok
}
```

The renderer changes from the existing read-only file are:

- Add an actions row on the client detail page with: **Edit config**,
  **Capture attestation**, **Purge cache**, three status-flip buttons
  (active / paused / terminated). Use `<form method="POST">` for each
  button so they all carry CSRF-checkable Origin headers.
- Add a `/clients/new` page with the prefilled template and a textarea.
- Add `/clients/:id/edit` and `/clients/:id/attest` GET pages.
- Flash banner at the top of any page that has `?flash=...&flash_kind=...`
  on its URL (so flash works across the 303 redirect).

### Dependencies to verify

- `zod` is in the root `package.json`. Wrangler bundles it for the main
  worker; it should also bundle for admin-worker via the cross-import.
- `@cloudflare/workers-types` is shared.
- The integration with the existing `audit_log` table: schema in
  `migrations/0001_initial.sql` lines 49-71. Columns match the writeAudit
  shape above.

### Tests to add

- Unit test the FNV-1a hash on `admin-worker` (mirror `src/transform/_utils.test.ts` pattern).
- Unit test the CSRF check.
- Unit test the validate-then-persist flow with a mocked D1 + KV (mirror
  `src/config/loader.test.ts` mock pattern).

Integration tests for the admin worker via `@cloudflare/vitest-pool-workers`
have the same Windows runner blocker as the main worker. Skip them for now
or scope only to Linux CI runners.

### Deploy

After the build passes typecheck/lint/tests:

```powershell
cd C:\CodeProjects\DomainEdge\admin-worker
npx wrangler deploy
```

That picks up the existing secrets (ADMIN_USERNAME / ADMIN_PASSWORD) and
ships the new worker. Re-test by visiting
https://edge-seo-admin.localblitzio.workers.dev/clients/lantern-crest —
you should see the new actions row.

### Acceptance criteria

The session can mark Phase 2 admin editor done when:

- [ ] Edit Lantern Crest's config via the web form, save, see banner /
      meta change live on https://edge-seo-platform-staging.localblitzio.workers.dev/.
- [ ] Click Pause → see a 410 returned by the worker.
- [ ] Click Activate → site responds 200 again.
- [ ] Capture an attestation → see it appear in /audit.
- [ ] Add a second test client (e.g. proxying example.com) → see it in the
      Clients list, hit its proxy_domain, get a response.
- [ ] Audit log shows entries for every mutation above.

### Known gotchas

- **PowerShell vs bash**: the user's authenticated wrangler is in
  PowerShell with wrangler 4.x. The bash environment in the project has
  wrangler 3.114.x with stale or missing OAuth. NEVER run wrangler from
  bash for production-affecting commands; always have the user run them
  from PowerShell.
- **wrangler 3 vs 4 syntax**: `kv:key` (colon) in 3, `kv key` (space) in
  4. Some flags differ (`--remote` is default-implicit in 3, explicit in
  4). The seed-client script tries v3 first then falls back.
- **D1 migrations**: idempotent per wrangler tooling, but the `clients`
  table is `CREATE TABLE` (not `IF NOT EXISTS`), so don't manually run
  the migration file twice without a fresh database.
- **CI auto-deploys staging on `main`**: any push to main triggers
  GitHub Actions which deploys the main edge worker to staging. The
  admin-worker has its own deploy and is NOT in CI yet — this is a small
  gap to fix.

## What you might want to do FIRST in the next session

1. **Read this file.**
2. **Read STATUS.md.**
3. **Pick up where we left off:** start the Phase 2 admin editor build per
   the priority list above. Use the pseudocode as a scaffold.
4. **Don't forget to add admin-worker deploy to CI** — a separate GH
   Actions job that runs `npx wrangler deploy --config admin-worker/wrangler.toml`
   after the main worker deploys.

Good luck. The platform is in great shape — Phase 1 ships, the admin
editor just needs the write surface.
