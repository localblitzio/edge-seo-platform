# Runbook: pilot deployment (M12)

**Audience:** Local Blitz operator with Cloudflare account access.
**Outcome:** First production client (Lantern Crest blog subfolder)
serving live traffic through the Edge SEO Platform.

This runbook satisfies tech spec §15 Phase 1 done criteria 3, 4, 5.

---

## 0. Pre-flight (do once per account)

These are one-time setup steps. Skip if already done for staging.

### 0.1. Cloudflare account assets

Create these in the Cloudflare dashboard (or via `wrangler` CLI) and
record the IDs:

```bash
wrangler kv namespace create CONFIG_KV --env production
wrangler kv namespace create CONFIG_KV --env staging

wrangler d1 create edge-seo-platform-production
wrangler d1 create edge-seo-platform-staging

wrangler r2 bucket create edge-seo-content-production
wrangler r2 bucket create edge-seo-content-staging
wrangler r2 bucket create edge-seo-logs-production
wrangler r2 bucket create edge-seo-logs-staging
```

Replace the `REPLACE_WITH_*` placeholders in `wrangler.toml`'s
`[env.production]` and `[env.staging]` blocks with the returned IDs.
Commit the change.

### 0.2. CI secrets

Set these in the GitHub repo's `staging` and `production` Environments:

- `CLOUDFLARE_API_TOKEN` — token with `Workers Scripts:Edit`,
  `D1:Edit`, `Workers KV Storage:Edit`, `Workers R2 Storage:Edit`,
  `DNS:Edit`, `Logs:Edit`.
- `CLOUDFLARE_ACCOUNT_ID` — the account containing the bindings above.

### 0.3. Worker secrets

```bash
wrangler secret put INDEXNOW_KEY --env production
wrangler secret put GSC_SERVICE_ACCOUNT_JSON --env production
```

(Phase 2 / sitemap module requires these. Optional for M12 / pilot.)

### 0.4. Generate the typed Env

```bash
npm run wrangler:types
```

Commit `worker-configuration.d.ts`.

---

## 1. Apply migrations to staging

```bash
npm run db:migrate:staging
```

Verify the four tables exist:

```bash
wrangler d1 execute CONFIG_DB --env staging \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
# expect: attestations, audit_log, clients, form_submissions
```

---

## 2. Deploy to staging

```bash
git push origin main          # CI auto-deploys on push
# or:
npm run deploy:staging
```

Sanity check the Worker is responding:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://edge-seo-platform-staging.<account>.workers.dev/__healthz
# expect 502 (no client configured for that host) — proves the Worker is live
```

---

## 3. Capture the attestation

Per PRD §6.1, every cloned domain requires a captured attestation.
For the pilot:

1. Lantern Crest signs the master service agreement.
2. The intake form is filled out by the authorized person at Lantern
   Crest (not by the operator).
3. Attestation is recorded in D1 staging via `recordAttestation` —
   either through the Phase-2 admin UI (when it lands) OR a one-off
   SQL run for the pilot:

```bash
ATTEST_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ATTEST_IP="$(curl -s ifconfig.me)"
ATTEST_EMAIL="REPLACE_WITH_OWNER_EMAIL"
SCOPE_PATHS='["\/blog"]'

wrangler d1 execute CONFIG_DB --env staging --command \
  "INSERT INTO attestations (client_id, proxy_domain, source_domain, attested_by_email, attested_at, attested_ip, user_agent, scope, scope_paths_json) VALUES \
   ('lantern-crest', 'REPLACE_WITH_PROD_DOMAIN', 'REPLACE_WITH_HOSTED_BLOG_DOMAIN', '$ATTEST_EMAIL', '$ATTEST_AT', '$ATTEST_IP', 'manual operator entry', 'specified_paths', '$SCOPE_PATHS')"
```

The audit trail is the D1 `attestations` table — append-only, never
overwritten.

---

## 4. Validate the production config

Copy `config/lantern-crest.template.json` to `config/lantern-crest.json`
and fill in `REPLACE_*`. Then validate:

```bash
npx tsx scripts/validate-config.mjs config/lantern-crest.json
```

Exit code MUST be 0. The validator runs the same Zod schema and
load-time invariants the Worker uses (per spec §7: "On any divergence
between admin-time and load-time validation, alert and refuse to
populate KV").

---

## 5. Insert into staging D1 + KV

```bash
CLIENT_ID="lantern-crest"
PROXY_DOMAIN="REPLACE_WITH_PROD_DOMAIN"
SOURCE_DOMAIN="REPLACE_WITH_HOSTED_BLOG_DOMAIN"
CONFIG_PATH="config/lantern-crest.json"
CONFIG_JSON=$(jq -c . "$CONFIG_PATH")

# 1. INSERT into D1 (single source of truth)
wrangler d1 execute CONFIG_DB --env staging --command \
  "INSERT INTO clients (client_id, proxy_domain, source_domain, status, config_json, schema_version) \
   VALUES ('$CLIENT_ID', '$PROXY_DOMAIN', '$SOURCE_DOMAIN', 'active', '$CONFIG_JSON', 1)"

# 2. Hot-cache in KV (60s TTL is automatic on Worker write-through —
#    but seeding directly avoids a cold first request)
wrangler kv key put --binding=CONFIG_KV --env staging \
  "domain:$PROXY_DOMAIN" "$CLIENT_ID"
wrangler kv key put --binding=CONFIG_KV --env staging \
  "config:$CLIENT_ID" --path="$CONFIG_PATH"
```

---

## 6. DNS cut to staging

Add a Cloudflare proxied DNS record for the proxy domain pointing at
the staging Worker's hostname (or an existing CNAME). Verify DNS
propagation:

```bash
dig +short A "$PROXY_DOMAIN"
# expect: a Cloudflare anycast IP
```

Run the post-deploy smoke test:

```bash
node scripts/post-deploy-smoke.mjs --host="$PROXY_DOMAIN"
```

All checks MUST pass.

---

## 7. Promote to production

After ≥24h of staging traffic with no errors in the structured logs:

1. Apply migrations:

```bash
npm run db:migrate:production
```

2. Re-validate the config (paranoia is free):

```bash
npx tsx scripts/validate-config.mjs config/lantern-crest.json
```

3. INSERT and KV-seed against production (same commands as step 5,
   `--env production`).

4. Deploy:

```bash
npm run deploy:production
# or: merge to main and approve the production gate in Actions
```

5. Cut production DNS. Re-run the smoke test against production.

---

## 8. Observability hookup

### 8.1. Logpush → R2

In the Cloudflare dashboard, create a Logpush job:

- Source: Worker `edge-seo-platform-production`
- Destination: R2 bucket `edge-seo-logs-production`
- Format: NDJSON
- Fields: include `Outcome`, `OutcomeReason`, `RequestUrl`,
  `ResponseStatus`, `Logs.Message` (the JSON `LogEntry` from §6.7
  goes here via `console.log`)

### 8.2. Analytics Engine dashboard

The Worker emits one Analytics Engine data point per request to the
`edge_seo_metrics_production` dataset (M2 / §6.7). Build a dashboard
that queries:

- p50 / p95 / p99 of `double2` (worker_duration_ms) by `blob1`
  (client_id) and `blob3` (cache_status) — covers spec §11 budgets.
- Request count by `blob1` × `double1` (status) — covers SLO #4
  "Error rate: < 0.1%" from PRD §10.
- `double3` (origin_duration_ms; -1 = N/A) p95 by `blob1` — covers
  origin perf.
- `double4` (bytes_out) sum by `blob4` (content_type_class) — bandwidth.

(Dataset schema is documented in `src/observability/metrics.ts`.)

### 8.3. Alerts

Per PRD §7.11, set up alerts for:

- Origin 5xx spike (any client)
- Worker CPU exhaustion
- Latency regression (p95 > 200ms for 5min)
- Authorization expiry approaching (`expires_at` < now + 30d)
- Redirect loops detected (`status: 508` count > 0)

Cloudflare's notification system can read directly from Analytics Engine.

---

## 9. Done criteria (tech spec §15 Phase 1)

- [ ] All M0–M11 modules implemented (✓ at this point in the project)
- [ ] Config schema matches §4 exactly (✓ — verified by validator)
- [ ] D1 migrations applied to production (step 7.1)
- [ ] Lantern Crest configured (step 7.3)
- [ ] Integration tests pass for §12.2 (test suite written; runner
      blocker documented in CHANGELOG — re-attempt after wrangler 4
      upgrade)
- [ ] Subfolder deployment live with monitoring (steps 7.4 + 8)
- [ ] CHANGELOG.md documents v0.1.0 release (separate step — see
      `docs/runbooks/release.md` if added)

---

## 10. Rollback

If anything is wrong post-cut:

```bash
# 1. Set client status to paused → 410 Gone for new requests
wrangler d1 execute CONFIG_DB --env production --command \
  "UPDATE clients SET status='paused' WHERE client_id='lantern-crest'"

# 2. Purge the cached config (KV entries) so the loader re-reads D1
wrangler kv key delete --binding=CONFIG_KV --env production \
  "domain:REPLACE_WITH_PROD_DOMAIN"
wrangler kv key delete --binding=CONFIG_KV --env production \
  "config:lantern-crest"

# 3. Purge the response cache for the proxy domain
wrangler cache purge --zone <zone-id>  # or via dashboard

# 4. (If DNS-side rollback needed) point DNS back to the prior origin
```

The Worker's revocation SLA is documented at ≤4h end-to-end (PRD §10),
which assumes the steps above are taken promptly.
