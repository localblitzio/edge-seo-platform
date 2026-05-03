# PRD: Edge SEO Platform (Cloudflare Workers)

**Owner:** Simon White, Local Blitz Marketing
**Status:** Draft v3
**Last updated:** May 2, 2026

---

## 1. Executive summary

A Cloudflare Workers–based edge SEO platform that lets Local Blitz proxy, transform, and serve websites under domains we control, with full canonical and redirect management. The platform supports three productized offerings sharing common infrastructure:

1. **Subfolder Authority Consolidation** — host third-party SaaS content under a client's primary domain as a subfolder.
2. **Performance Domain** — operate a controlled secondary domain for PPC landing pages, programmatic SEO, AEO experiments, and conversion testing.
3. **Edge SEO Control Plane** — fine-grained canonical, redirect, schema, and indexation control without CMS plugin dependencies.

All three are built on a shared Worker runtime that reads per-client configuration from D1/KV. Onboarding a client to an already-supported transformation type is a config change. Adding a new transformation type, schema type, or condition still requires a code-and-deploy change.

The platform supports cloning any authorized source domain — client-owned or third-party — with full permission verification, audit trail, and revocation workflow.

## 2. Problem

Local Blitz delivers SEO, AEO, local SEO, Google Ads, and CRO services across a client base running varied CMSes (WordPress with Beaver Builder, hosted SaaS platforms, custom builds). Common pain points:

- Hosted content (Webflow blogs, HubSpot resource hubs) lives on subdomains, splitting link equity and limiting AEO signals.
- WordPress plugin dependencies (Yoast, Rank Math, Redirection) create technical debt, conflict, and slow page speed.
- PPC landing pages either pollute the client's organic site or get hosted on Unbounce/Instapage with no integration into the client's analytics or schema strategy.
- Programmatic location SEO requires either custom CMS development or third-party tools that don't integrate cleanly.
- Site migrations, redesigns, and CMS changes require lengthy parallel development with no good way to test in production.
- Client SEO velocity is bottlenecked by CMS access, plugin compatibility, and dev cycles.

A unified edge platform solves all of these by intercepting traffic at Cloudflare's edge, applying transformations and routing logic, and serving optimized responses without touching the underlying CMS.

## 3. Goals

- Productize three SEO offerings on a shared platform with reusable Worker template and config-driven deployment.
- Reduce per-client implementation time to under 4 hours after the first deployment.
- Provide canonical, redirect, schema, and indexation control that's superior to any WordPress plugin or CMS-native tool.
- Support permission-gated cloning of any authorized source domain.
- Maintain p95 latency overhead under 50ms vs. direct origin fetch.
- Build a defensible, auditable platform with explicit ethical guardrails.

## 4. Non-goals

- Replacing client CMSes for content authoring.
- Schema or content write-back to source sites (form pass-through with optional D1 capture is permitted; see §7.2).
- Authentication or login proxying for gated content (v1).
- Hosting unauthorized clones, scraped content, or sites used for brand impersonation, phishing, or search spam.

## 5. Product offerings

### 5.1 Subfolder Authority Consolidation

Host SaaS content (blogs, help centers, microsites) under the client's primary domain as a subfolder.

**Use cases:**
- Webflow blog under `clientdomain.com/blog/*`
- HubSpot resource hub under `clientdomain.com/resources/*`
- Shopify product education under `clientdomain.com/learn/*`

**Value:** consolidated link equity, AEO schema injection, brand consistency, removal of platform branding.

### 5.2 Performance Domain

Operate a controlled secondary domain that proxies the client's source site and adds custom landing pages, programmatic SEO pages, PPC landers, and AEO-optimized variants.

**Use cases:**
- PPC landing page factory at `clientdomain-pros.com/lp/*` with noindex
- Programmatic location pages at `clientdomain-pros.com/locations/[city]/*`
- AEO-optimized variants of every page with injected schema, llms.txt directives, and answer-first content blocks
- Conversion tracking layer (GTM, Meta Pixel, CallRail, Hotjar) without source-site changes
- A/B testing entire site experiences without CMS support
- Pre-launch SEO staging — build, index, and rank the proxy before flipping DNS to the new primary

**Value:** agency-velocity landing page deployment, isolated PPC environment, programmatic SEO at scale, controlled testing surface, client-churn resilience.

### 5.3 Edge SEO Control Plane

Fine-grained canonical, redirect, schema, and indexation control applied at Cloudflare's edge, without proxy-domain requirements. Sits on top of the client's existing site (Cloudflare must be in front of the origin).

**Use cases:**
- Replace Yoast/Rank Math/Redirection plugins with edge logic
- Bulk redirect management across legacy URL structures
- Conditional canonical rules based on URL pattern, query params, or cookies
- Schema injection by URL pattern (FAQ, Article, LocalBusiness, etc.)
- Indexation control (noindex, robots) per pattern without touching the CMS
- Sitemap generation and IndexNow auto-pinging
- 410 Gone responses for killed pages (cleaner than 404 or soft-redirect)

**Value:** technical SEO infrastructure superior to CMS-native tools, no plugin conflicts, no page-speed cost, version-controlled config, observable.

## 6. Permission-gated cloning

The platform supports cloning any source domain — first-party (client-owned) or third-party — provided authorization is captured, verified, and auditable.

### 6.1 Authorization workflow

1. **Capture** — checkbox attestation in the client intake form: "I confirm I am authorized to clone the source domain(s) listed and grant Local Blitz permission to proxy and modify their content." Captured with timestamp, IP address, and the email of the person attesting. Stored with the client record alongside the source/proxy domain mapping and scope.
2. **Audit** — every cloned domain logged with authorizing party, timestamp, attestation record, and current status.
3. **Revoke** — revocation triggers within hours: Worker returns 410 Gone or redirects to source. Documented timestamp on file.

The attestation is backed by the master service agreement, which includes representations and warranties that the client owns or has authority to authorize cloning of any source domains they list. Liability for misrepresentation sits with the client.

### 6.2 Source site preferences honored by default

- Source `robots.txt` directives respected on the proxy unless explicitly overridden in authorization.
- Source `<meta robots>` tags preserved unless overridden.
- Source security headers (CSP, X-Frame-Options) preserved or strengthened, never weakened.

### 6.3 Platform principles (internal, but referenced in client authorization docs)

- Cloned sites must be authorized in writing by a verified owner of the source domain.
- Publicly indexed cloned content must either canonical to the source or be substantively transformed.
- Platform will not be used to clone for phishing, brand impersonation, or trademark infringement.
- Platform will not be used to violate Google's spam policies (scaled scraped content, doorway pages, cloaking).

### 6.4 Use cases enabled by permission-gated cloning

- White-label platform offering for partner agencies (they bring permission, we provide infrastructure)
- Acquisition migration: temporary proxy of acquired company's site during 6–12 month consolidation
- Site-wide A/B testing of full redesigns with real-user traffic splits
- Disaster recovery and content preservation during outages or CMS migrations
- Franchise/multi-location operator support: one source, many regionally-branded proxy domains
- Pre-launch SEO staging on a proxy that gets flipped to primary at launch
- Regional/compliance variants of the same source content

## 7. Functional requirements

### 7.1 Routing layer

- Per-domain config defines path-based routing rules
- Custom paths served from Worker (with KV/D1/R2-stored content)
- Proxied paths forwarded to configured origin with transformations
- Catchall behavior (proxy or 404) configurable per client

### 7.2 Request handling

- Host header rewriting to origin's expected hostname
- Standard forwarding headers (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP`)
- Cookie domain rewriting on `Set-Cookie` responses
- Form submission interception and forwarding (with optional capture to client CRM or agency lead store)

### 7.3 Canonical management

Per-pattern canonical rules with strategies:

- `self` — self-canonical on the current domain
- `origin` — canonical to the source domain
- `custom` — canonical to a specified URL
- `noindex` — strip canonical and inject `<meta name="robots" content="noindex">`

Canonical rules also synchronize:
- `<link rel="canonical">`
- `og:url`
- `twitter:url`
- JSON-LD `@id` and `url` fields

### 7.4 Redirect management

Three layers, applied in order:

**Layer 1 — Static redirect map.** Stored in KV or D1, supports 100k+ rules. For simple `from → to` cases, defer to Cloudflare Bulk Redirects natively.

**Layer 2 — Pattern-based redirects.** Regex/glob with capture groups. For trailing slash, case normalization, structural URL changes.

**Layer 3 — Conditional redirects.** Based on geo, device, cookies, query strings, A/B buckets, referrer.

Status code support: 301, 302, 307, 308, 410.

Validation:
- Build-time loop detection
- Runtime hop limit (default 3, returns 508 on exceed)
- Auto-collapse of detected redirect chains

### 7.5 Response transformation (HTMLRewriter)

Configurable per client and per URL pattern:

- Canonical and meta tag injection/rewriting
- Schema injection (JSON-LD blocks per pattern: FAQ, Article, LocalBusiness, Service, BreadcrumbList, HowTo, Speakable)
- Internal link rewriting (origin hostnames → proxy paths)
- External link injection (contextual links to money pages or related content)
- CSS/JS injection (analytics, GTM, custom fonts, conversion pixels, CallRail)
- Element removal (platform branding, badges, unwanted UI)
- Text/content overrides
- Body content injection (answer-first blocks, FAQ sections, schema-paired content)

### 7.6 Indexation control

Per-pattern robots and indexation:

- `index,follow` (default for unique content)
- `noindex,follow` (PPC pages, test variants)
- `noindex,nofollow`
- `noarchive`, `nosnippet`, `max-image-preview` directives

X-Robots-Tag header support for non-HTML resources (PDFs, images).

### 7.7 Sitemap and IndexNow

- Generated XML sitemap per proxy domain
- Excludes redirected URLs, noindexed URLs, non-canonical URLs
- Includes only canonical destinations
- Auto-pinged via IndexNow on config changes (Bing, Yandex)
- Google Search Console submission via API

### 7.8 Caching

- Cloudflare Cache API or Cache Rules
- Default 1 hour HTML, 24 hours static assets, configurable per client and pattern
- Manual purge via Cloudflare API or admin UI
- Honors origin `Cache-Control` as baseline; allow overrides
- Cache key includes A/B variant cookie when applicable

### 7.9 Configuration schema

Per-client config is the actual product. Worker code is the runtime that interprets it.

```
{
  client_id,
  proxy_domain,
  source_domain,
  authorization: {
    attested_by_email, attested_at, attested_ip, scope, expires_at
  },
  status: "active" | "paused" | "terminated",
  routing: [...],
  redirects: { static: [...], patterns: [...], conditional: [...] },
  canonicals: [...],
  transformations: [...],
  indexation: [...],
  caching: {...},
  forms: {...},
  observability: {...}
}
```

Configs are version-controlled in Git, deployed via CI to D1/KV.

### 7.10 Multi-tenancy

- Single shared Worker runtime, one config row per proxy domain
- Configs in D1, hot-cached in KV for fast edge reads
- New client onboarding: add config row + deploy DNS, no Worker code change
- Per-client metrics, logs, and dashboards isolated by `client_id`

### 7.11 Observability

- Workers Analytics + Logpush to R2 (or external warehouse like ClickHouse/BigQuery)
- Per-client dashboards: request count, p50/p95/p99 latency, error rate, cache hit ratio, redirect volume, canonical mismatches, 4xx/5xx by pattern
- Alerts on origin 5xx spikes, Worker CPU exhaustion, latency regression, authorization expiry, redirect loops detected
- Crawl audit: log every Googlebot/Bingbot/Perplexitybot request with URL, status, canonical, response headers
- AI citation tracking: integrate with Perplexity API and similar to track which proxied URLs get cited

### 7.12 Admin UI

Cloudflare Pages or Next.js app for the agency team:

- Client list with status, attestation status, traffic volume
- Per-client config editor (with schema validation)
- Attestation capture form and record viewer
- Redirect map management
- Schema rule management
- Live request log viewer
- Manual cache purge
- Revocation flow

## 8. Technical architecture

```
User → Cloudflare edge → Edge Router Worker
                              ↓
                         Config lookup (KV, hot cache)
                              ↓
                         Redirect rules (static, pattern, conditional)
                              ↓ (if no redirect)
                         Route resolution
                              ↓
                    ┌─────────┴──────────┐
                    ↓                    ↓
              Origin fetch         Custom page fetch
              (proxied paths)      (KV/D1/R2)
                    ↓                    ↓
                    └─────────┬──────────┘
                              ↓
                       HTMLRewriter
                       (canonical, schema, links, content)
                              ↓
                       Header transformations
                       (robots, cache, security)
                              ↓
                       Cache + return
                              ↓
                       Logpush to R2/warehouse
```

**Stack:**
- Cloudflare Workers (Unbound for heavy transformation)
- D1 for config and audit logs
- KV for hot config cache
- R2 for static assets, custom landing page content, log archives
- Cloudflare Pages for admin UI
- Wrangler + GitHub Actions for deployment

## 9. Constraints and gotchas

- Worker CPU limits — Unbound recommended for transformation-heavy clients
- HTMLRewriter cannot modify `<script>` content or JSON blobs without buffering
- Origin behind Cloudflare on different account triggers Error 1000 — requires Authenticated Origin Pulls
- Cookies set by origin require explicit domain rewriting
- Origin platforms with hardcoded absolute URLs in JS bundles may leak origin domain
- Per-proxy-domain Search Console properties required; do not merge with source domain property
- Origin server load — aggressive edge caching is mandatory for high-traffic proxies
- Platform ToS — verify per-platform terms (Webflow, Shopify, HubSpot) before subfolder deployment
- Trademark — ensure proxy domain registration is appropriate to the relationship (client-owned for client work)

## 10. Success metrics

**SEO**
- Organic traffic lift on proxied content: 25%+ within 90 days vs. baseline
- Reduction in indexation/canonical errors in Search Console: 90%+ within 30 days
- Programmatic location pages indexed: 80%+ within 60 days

**AEO**
- AI citation rate (Perplexity, ChatGPT, Claude) on proxied content tracked monthly
- Schema validity: 100% of injected JSON-LD passes validator

**Performance**
- p95 latency overhead vs. direct origin: < 50ms
- Cache hit ratio: 80%+ on HTML, 95%+ on assets

**Reliability**
- Worker availability: 99.9%
- Error rate: < 0.1%
- Authorization revocation SLA: < 4 hours

**Operational**
- Per-client onboarding time after first deployment: < 4 hours
- Client churn vs. baseline: tracked separately

## 11. Rollout plan

**Phase 1 — Foundation (Weeks 1–4)**
- Build Edge Router Worker with config-driven runtime
- Implement canonical, redirect, schema, and indexation modules
- Build D1 schema for configs and audit logs
- Deploy on one pilot client (Lantern Crest blog subfolder is leading candidate)
- Establish authorization workflow and document templates
- QA checklist and regression test suite

**Phase 2 — Productize (Weeks 5–8)**
- Roll out Subfolder Authority Consolidation to 2–3 additional clients
- Launch first Performance Domain pilot (Dump IT location pages is leading candidate)
- Build admin UI v1
- Set up observability dashboards and alerting
- Document the three offerings as internal playbooks

**Phase 3 — Scale (Weeks 9–12)**
- Launch Edge SEO Control Plane as standalone offering
- Onboard 5–10 clients across the three offerings
- Refine pricing tiers
- Build sales collateral with case studies from Phase 1–2

**Phase 4 — Platform (Months 4–6)**
- Evaluate white-label / partner-agency offering
- Build self-service config tooling for non-technical agency team members
- Expand AEO measurement and reporting
- Consider productizing as SaaS for other agencies

## 12. Open questions

- Workers Paid vs. Unbound as default tier?
- Config schema in TypeScript or JSON Schema?
- Single shared D1 instance or per-client isolation?
- Pricing model — flat per domain, tiered by traffic, percentage of ad spend, or hybrid?
- For non-Cloudflare clients, what's the migration cost and how is it priced?
- Do we offer the Edge SEO Control Plane to agencies as a white-label, or keep it as Local Blitz–only competitive advantage?
- Long-term: spin out the platform as a separate SaaS product?

## 13. Risks

- **Platform ToS violations** — some hosted platforms restrict reverse-proxy reuse. Mitigation: per-platform ToS review before deployment.
- **Origin platform changes** — selectors and structures used in HTMLRewriter rules can break on origin updates. Mitigation: monitoring and a regression test suite that fetches and validates key pages.
- **Caching errors** — aggressive caching of personalized or auth'd content can leak data. Mitigation: conservative defaults; explicit allowlist for cacheable patterns.
- **SEO duplicate content** — incorrect canonical configuration creates duplicate signals. Mitigation: canonical strategy is mandatory in every client config; validated at deploy time.
- **Authorization disputes** — source-domain owner disputes a clone's authorization. Mitigation: checkbox attestation captured with timestamp/IP; master service agreement includes warranties shifting liability to the attesting client; revocation SLA is documented; audit trail is durable.
- **Trademark and brand confusion** — proxy domains that mirror client branding require client domain ownership. Mitigation: standard contract clauses; client-owned domains for client work.
- **Google policy changes** — Google could change how it treats canonicalized duplicate content. Mitigation: avoid pure mirrors; transform substantively; monitor Search Console.
- **Cloudflare dependency** — the entire platform depends on Cloudflare. Mitigation: documented; pricing reflects this; consider multi-edge as a future option.

## 14. Appendix: client-specific notes

**Lantern Crest** — Subfolder pilot candidate (blog), Performance Domain candidate for steakhouse launch with city-targeted PPC pages.

**Dump IT LLC** — Performance Domain candidate for programmatic city/dumpster-size landing pages. Existing four size pages become the template; geographic expansion to N cities via Worker logic + D1 city data.

**Buyshuttermart** — Edge SEO Control Plane candidate (replace Yoast/Redirection plugin stack); Performance Domain candidate for product-education content hub.

**Bright Bail Bonds** — Edge SEO Control Plane for canonical and redirect management; Performance Domain for resource hub and FAQ schema injection.

**functionalDNA.com** — Edge SEO Control Plane for affiliate link management, redirect optimization, and schema injection on Amazon Associates content.
