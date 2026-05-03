# Edge SEO Platform

Cloudflare Workers–based edge SEO platform that proxies, transforms, and
serves websites under domains we control. Single shared Worker runtime
that interprets per-client configuration loaded from D1 and KV.

**Owner:** Local Blitz Marketing
**Status:** Phase 1 — Foundation v0.1.0 (release candidate)

## Documents

- [docs/prd.md](docs/prd.md) — strategic PRD (the *why*).
- [docs/tech-spec.md](docs/tech-spec.md) — buildable technical spec
  (the *what*). Authoritative for implementation.
- [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md) — coding-agent entry
  points. Read these before contributing.

## Quick start

```bash
npm install
npm run wrangler:types       # generate Env type from wrangler.toml bindings
npm run typecheck
npm run lint
npm run test                 # unit tests
npm run test:integration     # integration tests against Miniflare
npm run dev                  # local Worker via wrangler
```

## Local demo

The repository ships a working end-to-end mock-up that exercises
config loading, authorization, redirects (static / pattern /
conditional), security headers, custom pages, and proxying — all
against local Miniflare bindings, no Cloudflare account required.

```bash
npm install
npm run demo:seed            # apply migrations, insert demo client, seed KV pages
npm run dev                  # wrangler dev (defaults to http://localhost:8787)
```

Then try (in a browser or with `curl -i`):

| URL                                      | What it exercises                                      |
| ---------------------------------------- | ------------------------------------------------------ |
| `http://localhost:8787/welcome`          | Custom page rendered from KV at `page:/welcome`        |
| `http://localhost:8787/old`              | Static redirect → 301 `/new`                           |
| `http://localhost:8787/gone`             | Static redirect with status 410                         |
| `http://localhost:8787/posts/42`         | Pattern redirect → 301 `/posts/42/` (backreference)    |
| `http://localhost:8787/about`            | Proxied to `https://example.com/about` with security headers |
| `http://localhost:8787/`                 | Proxied to `https://example.com/`                      |

Watch the `wrangler dev` console for one JSON log line per request
(structured `LogEntry` from §6.7) plus emitted Analytics Engine
counters. Inspect response headers to confirm the §10 security policy
(`x-content-type-options: nosniff`, `referrer-policy`, plus origin
`Server` / `X-Powered-By` stripped).

Reset all local Miniflare state and re-seed:

```bash
npm run demo:reset
```

### Local inspector (read-only Phase-1 dev tool)

A small HTML dashboard that reads the same Miniflare state the Worker
uses — useful for seeing what's currently configured without writing
SQL by hand. Lives in [admin-ui/](admin-ui/) and is replaced by the
real Phase-2 admin UI (PRD §7.12, tech spec §15) when that lands.

```bash
npm run admin                # http://localhost:4000
```

Pages:

| Path | What it shows |
| ---- | ------------- |
| `/` | Overview — client count, totals, table of all configured clients |
| `/clients/:id` | One client — authorization, routing, all redirect/canonical/schema/indexation/cache/form rules, raw `ClientConfig` JSON |
| `/redirects` | All redirects across all clients, in §6.2 evaluation order |
| `/audit` | `audit_log` events + `attestations` history |
| `/kv` | All `CONFIG_KV` entries with TTLs and previews |
| `/kv/:key` | Full value for a single KV entry, JSON-pretty-printed if applicable |

The demo is wired to spec §5 ordering. The HTMLRewriter pipeline
(§5 step 9) and response cache layer (§5 step 11) are not yet
implemented — `cache_status` reports `"skip"` and HTML responses
pass through unmodified. Those land in M5 and M10.

## Deploy

For the **first pilot deployment**, follow [docs/runbooks/pilot-deploy.md](docs/runbooks/pilot-deploy.md)
end-to-end. It covers Cloudflare account setup, attestation capture
(PRD §6.1), config validation, staging cut, production cut,
observability hookup, and rollback.

Operator-facing scripts:

```bash
npm run config:validate config/lantern-crest.json   # Zod + invariant pre-flight
npm run load-test                                   # synthetic perf regression check
npm run smoke -- --host=<proxy-domain>              # post-deploy smoke
```

Day-to-day deploys (after the pilot):

```bash
npm run db:migrate:staging
npm run deploy:staging

npm run db:migrate:production
npm run deploy:production
```

Deploys are normally driven by GitHub Actions (`.github/workflows/ci.yml`)
with manual approval on the `production` environment.

## Repository layout

See tech spec §2 for the canonical layout. Top level:

```
src/                  Worker source (one module per pipeline stage)
tests/                Unit, integration, and fixture data
migrations/           Forward-only D1 migrations
docs/                 PRD, tech spec, runbooks
admin-ui/             Cloudflare Pages admin app (separate package, Phase 2)
```
