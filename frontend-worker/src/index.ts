/**
 * Edge SEO Platform — frontend worker.
 *
 * User-facing landing page, auth flows (login, password reset, email
 * verification, invite-set-password), authenticated app dashboard (client
 * CRUD, audit log, KV browser), and super-admin user CRUD.
 *
 * Phase B (this commit): scaffolding only. Landing page at `/` is fully
 * rendered; other routes return placeholders that Phases C–F fill in.
 *
 * Architectural anchors:
 * - Reads/writes the same D1 + KV bindings the main edge worker uses.
 *   Multi-user via `users` table (migration 0002); multi-tenant via
 *   `clients.owner_id` with super-admin override.
 * - Sessions are server-side rows in the `sessions` table, looked up via
 *   a random token in an HttpOnly Secure SameSite=Lax cookie. Phase D
 *   wires the auth middleware.
 * - Email sends use Cloudflare Email Service (public beta) via `env.EMAIL`
 *   binding. Phase C wires this. From: noreply@localpage.us.com,
 *   Reply-To: simon@localblitzmarketing.com.
 *
 * Until Phase G cut-over, this worker is reachable only via its
 * workers.dev URL: https://edge-seo-frontend.localblitzio.workers.dev
 * Phase G adds the apex `localpage.us.com/*` route and deprecates the
 * basic-auth `edge-seo-admin` worker.
 */

interface Env {
  CONFIG_KV: KVNamespace;
  CONFIG_DB: D1Database;
  SESSION_SECRET?: string;
  // EMAIL: SendEmail; // wired in Phase C
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--bg-elevated:#fff;--bg-code:#f4f4f5;--border:#e4e4e7;--border-strong:#d4d4d8;--fg:#18181b;--fg-muted:#71717a;--accent:#2563eb;--accent-fg:#fff;--green:#16a34a;--green-bg:#dcfce7;--amber:#b45309;--amber-bg:#fef3c7;--red:#b91c1c;--red-bg:#fee2e2;--shadow:0 1px 2px rgba(0,0,0,.04),0 1px 3px rgba(0,0,0,.06);--radius:.5rem;--mono:ui-monospace,"SFMono-Regular","Menlo","Cascadia Mono",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--bg-elevated:#18181b;--bg-code:#18181b;--border:#27272a;--border-strong:#3f3f46;--fg:#fafafa;--fg-muted:#a1a1aa;--accent:#60a5fa;--green:#4ade80;--green-bg:#052e16;--amber:#fbbf24;--amber-bg:#422006;--red:#f87171;--red-bg:#450a0a}}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,.mono{font-family:var(--mono);font-size:.92em}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:1rem 2rem;background:var(--bg-elevated);border-bottom:1px solid var(--border)}
.topbar .brand{display:flex;align-items:center;gap:.6rem;font-size:1rem;font-weight:600}
.topbar .logo{display:inline-block;width:1rem;height:1rem;border-radius:9999px;background:linear-gradient(135deg,#2563eb,#7c3aed)}
.topbar nav{display:flex;gap:1.25rem;font-size:.9rem}
.btn{font:inherit;border:1px solid var(--border-strong);background:var(--bg-elevated);color:var(--fg);padding:.45rem 1rem;border-radius:var(--radius);cursor:pointer;display:inline-block;text-decoration:none}
.btn:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.btn-primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.btn-primary:hover{filter:brightness(1.1);color:var(--accent-fg)}
.hero{max-width:920px;margin:5rem auto 2rem;padding:0 2rem;text-align:center}
.hero h1{font-size:2.6rem;line-height:1.1;letter-spacing:-.02em;font-weight:800;margin:0 0 1rem}
.hero p.lead{font-size:1.15rem;color:var(--fg-muted);max-width:640px;margin:0 auto 1.75rem;line-height:1.5}
.hero .cta{display:inline-flex;gap:.6rem;flex-wrap:wrap;justify-content:center}
.features{max-width:920px;margin:3rem auto;padding:0 2rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.25rem}
.feature{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem 1.5rem;box-shadow:var(--shadow)}
.feature h3{margin:0 0 .5rem;font-size:1rem;font-weight:600}
.feature p{margin:0;color:var(--fg-muted);font-size:.9rem;line-height:1.5}
.footer{margin-top:5rem;padding:2rem;text-align:center;color:var(--fg-muted);font-size:.85rem;border-top:1px solid var(--border)}
.placeholder{max-width:560px;margin:5rem auto;padding:2rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);text-align:center}
.placeholder h1{font-size:1.35rem;margin:0 0 .5rem}
.placeholder p{color:var(--fg-muted);margin:.4rem 0}
.placeholder code{background:var(--bg-code);padding:.15rem .35rem;border-radius:.25rem;font-size:.85em}
`;

function topbar(): string {
  return `<header class="topbar">
    <a class="brand" href="/"><span class="logo"></span>Edge SEO Platform</a>
    <nav>
      <a href="/login">Sign in</a>
    </nav>
  </header>`;
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${topbar()}${body}<footer class="footer">© ${new Date().getFullYear()} Edge SEO Platform</footer></body></html>`;
}

/* ─── Pages ─── */

function renderLanding(): string {
  return `<section class="hero">
    <h1>Host any site under your domain — at the edge.</h1>
    <p class="lead">Edge SEO Platform proxies, transforms, and serves websites under controlled domains using Cloudflare Workers. Add a client with one config row; serve traffic immediately on a wildcard subdomain or your custom domain.</p>
    <div class="cta">
      <a class="btn btn-primary" href="/login">Sign in</a>
      <a class="btn" href="mailto:simon@localblitzmarketing.com?subject=Request%20access%20to%20Edge%20SEO%20Platform">Request access</a>
    </div>
  </section>
  <section class="features">
    <div class="feature">
      <h3>Subfolder authority consolidation</h3>
      <p>Host SaaS content (Webflow, HubSpot, Shopify) under a client's primary domain as a subfolder. Keep canonical authority on the main brand.</p>
    </div>
    <div class="feature">
      <h3>Performance domain</h3>
      <p>A controlled secondary domain for PPC landers, programmatic SEO, and AEO experiments — the same edge runtime, separate SEO surface area.</p>
    </div>
    <div class="feature">
      <h3>Edge SEO control plane</h3>
      <p>Canonical, redirect, schema, indexation, and meta control at the edge. No CMS plugins, no per-page deploys — config rows in D1.</p>
    </div>
  </section>`;
}

function renderPlaceholder(title: string, message: string): string {
  return `<div class="placeholder">
    <h1>${esc(title)}</h1>
    <p>${message}</p>
    <p style="margin-top:1.25rem"><a href="/" class="btn">← Home</a></p>
  </div>`;
}

const htmlHeaders: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // Conservative security defaults; tighten in Phase C–F as we know what we serve.
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

/* ─── Router ─── */

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method !== "GET" && method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    // Public routes (no auth required, all phases)
    if (path === "/" || path === "") {
      return new Response(htmlPage("Edge SEO Platform", renderLanding()), { headers: htmlHeaders });
    }

    // Auth flow placeholders — Phase C wires emails, Phase D wires the actual flow.
    if (path === "/login") {
      return new Response(
        htmlPage(
          "Sign in — Edge SEO Platform",
          renderPlaceholder(
            "Sign in",
            "Coming in Phase D. Until then this worker is scaffolding only. The legacy basic-auth admin lives at <code>edge-seo-admin.localblitzio.workers.dev</code> until the cut-over in Phase G.",
          ),
        ),
        { headers: htmlHeaders },
      );
    }
    if (path === "/forgot") {
      return new Response(
        htmlPage(
          "Reset password — Edge SEO Platform",
          renderPlaceholder("Reset password", "Coming in Phase D."),
        ),
        { headers: htmlHeaders },
      );
    }
    if (path === "/reset") {
      return new Response(
        htmlPage(
          "Set new password — Edge SEO Platform",
          renderPlaceholder("Set new password", "Coming in Phase D."),
        ),
        { headers: htmlHeaders },
      );
    }
    if (path === "/verify") {
      return new Response(
        htmlPage(
          "Verify email — Edge SEO Platform",
          renderPlaceholder("Verify email", "Coming in Phase D."),
        ),
        { headers: htmlHeaders },
      );
    }
    if (path === "/logout") {
      return new Response(
        htmlPage(
          "Sign out — Edge SEO Platform",
          renderPlaceholder("Sign out", "Coming in Phase D."),
        ),
        { headers: htmlHeaders },
      );
    }

    // Authenticated app — Phase E moves the admin-worker functionality here
    // (clients CRUD, attestations, audit log, KV browser) behind the
    // session-cookie auth middleware.
    if (path === "/app" || path.startsWith("/app/")) {
      return new Response(
        htmlPage(
          "Dashboard — Edge SEO Platform",
          renderPlaceholder(
            "Dashboard",
            "The authenticated app moves here in Phase E. Until then, use the legacy <code>edge-seo-admin</code> worker.",
          ),
        ),
        { headers: htmlHeaders },
      );
    }

    // Super-admin user CRUD — Phase F.
    if (path === "/admin" || path.startsWith("/admin/")) {
      return new Response(
        htmlPage(
          "Admin — Edge SEO Platform",
          renderPlaceholder("Admin", "User management lands in Phase F."),
        ),
        { headers: htmlHeaders },
      );
    }

    return new Response(
      htmlPage("Not found — Edge SEO Platform", renderPlaceholder("Not found", "")),
      { status: 404, headers: htmlHeaders },
    );
  },
} satisfies ExportedHandler<Env>;
