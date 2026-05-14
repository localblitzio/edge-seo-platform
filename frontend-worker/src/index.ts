/**
 * Edge SEO Platform — frontend worker.
 *
 * Phase D: full auth flows — login, forgot, reset, verify, logout — plus
 * authenticated route gating for /app/* (any user) and /admin/* (super-
 * admin only). Authenticated app contents and super-admin user CRUD are
 * still placeholders; Phases E and F replace those with real handlers.
 *
 * Architectural anchors:
 * - Sessions are random tokens stored server-side in `sessions` (D1).
 *   Cookie carries the token; we look it up on every request. Lets us
 *   revoke instantly (logout, password change, force expire all sessions).
 * - Passwords hashed with PBKDF2-SHA-256, 200k iterations, 16-byte salt.
 *   Stored as `pbkdf2$iter$saltHex$hashHex` so verify reads the iteration
 *   count from the value itself.
 * - Email sends via Cloudflare Email Service (`env.EMAIL.send`) — From
 *   noreply@edgeseo.app, Reply-To simon@localblitzmarketing.com. The
 *   edgeseo.app zone is the application domain; localpage.us.com is the
 *   proxy zone for customer traffic and not used for app email or auth.
 * - CSRF defense: every POST checks `Origin` (or `Referer` fallback)
 *   matches the request URL host. Combined with HttpOnly Secure
 *   SameSite=Lax session cookie, this is the right level for an
 *   internal agency tool.
 *
 * Flash messages survive the 303 redirect via ?flash=...&kind=ok|warn|err
 * — same pattern as the admin-worker.
 */

import { defaultZoneForEnv } from "../../src/config/proxy-zone.js";
import { PRODUCTION_PROXY_ZONES, STAGING_PROXY_ZONES } from "../../src/config/proxy-zone.js";
import { ACTIVE_INDEXERS } from "../../src/secrets/indexer-registry.js";
import { getSecret } from "../../src/secrets/store.js";
import {
  APP_STYLE,
  NEW_CLIENT_TEMPLATE,
  appLayout,
  handleAttestPost,
  handleCachePurgePost,
  handleCloudflareInstallPost,
  handleDeleteCustomPagePost,
  handleEditClientPost,
  handleEditCustomPageGet,
  handleEditCustomPagePost,
  handleNewClientPost,
  handleNewCustomPageGet,
  handleNewCustomPagePost,
  handleNewStaticSiteGet,
  handleNewStaticSitePost,
  handleRestorePost,
  handleSiteFileDeletePost,
  handleSiteFileEditGet,
  handleSiteFileEditPost,
  handleSiteFilesGet,
  handleSoftDeletePost,
  handleStatusPost,
  literalPathFromMatch,
  loadVisibleClient,
  loadVisibleClients,
  renderAttestForm,
  renderAuditPage,
  renderClientDetail,
  renderClientsList,
  renderEditClientForm,
  renderEditCustomPageForm,
  renderNewClientForm,
  renderNewCustomPageForm,
  renderNewStaticSiteForm,
  renderOverview,
  renderPerPageEditor,
  renderSiteFileEditForm,
  renderSiteFilesPage,
  renderSoftDeleteConfirm,
  summarizeEditedPages,
} from "./app.js";
import {
  type EmailTokenKind,
  RESET_PASSWORD_TOKEN_TTL_MS,
  type Role,
  type SessionWithUser,
  type User,
  consumeEmailToken,
  createEmailToken,
  createSession,
  destroyAllSessionsForUser,
  destroySession,
  getSessionWithUser,
  getUserByEmail,
  parseSessionCookie,
  sessionCookieHeader,
  setPassword as setUserPassword,
  verifyPassword,
} from "./auth.js";
import { loadBotActivityData, renderBotActivityPage } from "./bot-activity.js";
import {
  handleBulkConfirmPost,
  handleBulkPreviewPost,
  renderBulkNewForm,
  renderBulkPreview,
  renderBulkResult,
} from "./bulk-clients.js";
import {
  handleClusterStatusPost,
  handleEditClusterPost,
  handleNewClusterPost,
  loadAllClusterMembersByCluster,
  loadClusterMemberCounts,
  loadClusterPageData,
  loadVisibleClusters,
  renderClusterDetail,
  renderClustersList,
  renderEditClusterForm,
  renderNewClusterForm,
} from "./clusters.js";
import {
  defaultScrapeFormPrefill,
  handleRescrapePost,
  handleScrapeStartPost,
  isStuck,
  renderScrapeForm,
  renderScrapeProgress,
  runScrapeJob,
  scrapeAutoRefreshHeader,
} from "./data-source-scrape.js";
import { type EmailBinding, resetPasswordMessage, sendEmail } from "./email.js";
import {
  type PlacementFilters,
  handleClusterSubmitIndexersPost,
  handleEmbedApplyConfirmPost,
  handleEmbedApplyPost,
  handleEmbedDeletePost,
  handleEmbedEditPost,
  handleEmbedNewPost,
  handleEmbedReapplyPost,
  handlePlacementRemovePost,
  loadPlacementsForEmbed,
  loadVisibleEmbed,
  loadVisibleEmbeds,
  loadVisiblePlacements,
  renderClusterSubmitIndexersFormBlock,
  renderClusterSubmitResult,
  renderEmbedApplyForm,
  renderEmbedApplyPicker,
  renderEmbedApplyResult,
  renderEmbedDetail,
  renderEmbedForm,
  renderEmbedsList,
  renderPlacementsList,
} from "./embeds.js";
import { FAVICON_DATA_URL } from "./favicon-data-url.js";
import {
  handleBulkDeletePost,
  loadClientsByIds,
  loadGeneratedClientIds,
  loadGeneratedSites,
  renderBulkDeleteConfirm,
  renderGeneratedSitesList,
} from "./generated-sites.js";
import {
  type IndexationFilters,
  LAST_CHECK_AGE_FILTERS,
  type LastCheckAgeFilter,
  handleBulkRecheck,
  handleClusterBulkCheck,
  loadIndexationOverview,
  renderBulkRecheckResult,
  renderIndexationOverviewPage,
} from "./indexation-overview.js";
import {
  handleIndexationCheck,
  handleIndexingSubmit,
  handleMakeIndexable,
  handleProbeUrl,
  handleReindexAll,
  loadIndexingPageData,
  renderIndexingPage,
} from "./indexing.js";
import { inspectSourcePage } from "./inspector.js";
import {
  handleBulkPlacementPost,
  handleCheckTargetPost,
  handleDeletePlacementPost,
  handleEditLinkProjectPost,
  handleEditPlacementPost,
  handleLinkProjectStatusPost,
  handleNewLinkProjectPost,
  handleNewPlacementPost,
  loadProjectPageData,
  loadVisibleLinkProject,
  loadVisibleLinkProjects,
  renderEditLinkProjectForm,
  renderEditPlacementPage,
  renderLinkProjectDetail,
  renderLinkProjectsList,
  renderNewLinkProjectForm,
} from "./link-projects.js";
import { LOGO_DATA_URL } from "./logo-data-url.js";
import {
  defaultSerpPrefill,
  handleSerpPickPost,
  handleSerpQueryPost,
  renderSerpNewForm,
  renderSerpPicker,
} from "./serp-new.js";
import { handleSettingsApiKeysPost, renderSettingsApiKeysPage } from "./settings.js";
import {
  handleDataSourceEditPost,
  handleDataSourceNewPost,
  handleGenerateConfirmPost,
  handleGeneratePreviewPost,
  handleTemplateEditPost,
  handleTemplateNewPost,
  renderDataSourceForm,
  renderDataSourcesList,
  renderGenerateForm,
  renderGeneratePreview,
  renderGenerateResult,
  renderTemplateForm,
  renderTemplatesList,
} from "./site-templates-ui.js";
import {
  loadVisibleDataSource,
  loadVisibleDataSources,
  loadVisibleTemplate,
  loadVisibleTemplates,
} from "./site-templates.js";
import { getTemplateStarter } from "./template-starters.js";

interface Env {
  CONFIG_KV: KVNamespace;
  CONFIG_DB: D1Database;
  SESSION_SECRET?: string;
  EMAIL: EmailBinding;
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
/* ─── Palette ─── Emerald accent. Light = warm off-white base, dark = manual opt-in via [data-theme="dark"] on <html>. */
:root{
  color-scheme:light;
  --bg:#fafafb;
  --bg-elevated:#ffffff;
  --bg-sidebar:#f7f8f9;
  --bg-code:#f1f3f5;
  --bg-tint:linear-gradient(180deg,#fafafb 0%,#f7faf9 100%);
  --border:#e5e7eb;
  --border-strong:#d1d5db;
  --fg:#0a0a0a;
  --fg-muted:#6b7280;
  --accent:#10b981;
  --accent-hover:#059669;
  --accent-fg:#ffffff;
  --accent-bg:#d1fae5;
  --accent-bg-strong:#a7f3d0;
  --accent-soft:#ecfdf5;
  --green:#10b981;
  --green-bg:#d1fae5;
  --amber:#d97706;
  --amber-bg:#fef3c7;
  --red:#dc2626;
  --red-bg:#fee2e2;
  --shadow-sm:0 1px 2px rgba(15,23,42,.04);
  --shadow:0 1px 3px rgba(15,23,42,.06),0 1px 2px rgba(15,23,42,.04);
  --shadow-md:0 4px 12px rgba(15,23,42,.08);
  --shadow-lg:0 10px 25px rgba(15,23,42,.1);
  --radius:.5rem;
  --radius-sm:.375rem;
  --radius-lg:.75rem;
  --mono:ui-monospace,"SFMono-Regular","Menlo","Cascadia Mono",monospace
}
html[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0a0a0b;
  --bg-elevated:#141416;
  --bg-sidebar:#0e0e10;
  --bg-code:#1a1a1d;
  --bg-tint:linear-gradient(180deg,#0a0a0b 0%,#0d1110 100%);
  --border:#26262a;
  --border-strong:#3f3f46;
  --fg:#fafafa;
  --fg-muted:#a1a1aa;
  --accent:#34d399;
  --accent-hover:#10b981;
  --accent-fg:#052e16;
  --accent-bg:rgba(52,211,153,.12);
  --accent-bg-strong:rgba(52,211,153,.22);
  --accent-soft:rgba(52,211,153,.06);
  --green:#34d399;
  --green-bg:rgba(52,211,153,.12);
  --amber:#fbbf24;
  --amber-bg:rgba(251,191,36,.12);
  --red:#f87171;
  --red-bg:rgba(248,113,113,.12);
  --shadow-sm:0 1px 2px rgba(0,0,0,.3);
  --shadow:0 1px 3px rgba(0,0,0,.4),0 1px 2px rgba(0,0,0,.3);
  --shadow-md:0 4px 12px rgba(0,0,0,.5);
  --shadow-lg:0 10px 25px rgba(0,0,0,.6)
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);background-image:var(--bg-tint);background-attachment:fixed;color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:var(--accent);text-decoration:none;transition:color .15s ease}a:hover{color:var(--accent-hover);text-decoration:underline}
code,.mono{font-family:var(--mono);font-size:.92em}
::selection{background:var(--accent-bg-strong);color:var(--fg)}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:.85rem 2rem;background:var(--bg-elevated);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50;backdrop-filter:saturate(180%) blur(6px);background:color-mix(in srgb,var(--bg-elevated) 92%,transparent)}
.topbar .brand{display:flex;align-items:center;gap:.7rem;font-size:1rem;font-weight:600;color:var(--fg)}
.topbar .brand:hover{text-decoration:none}
.topbar .logo{display:inline-block;height:4.9rem;aspect-ratio:4/1;background-image:url("${LOGO_DATA_URL}");background-size:contain;background-position:left center;background-repeat:no-repeat}
html[data-theme="dark"] .topbar .logo{filter:brightness(0) invert(1)}
.auth-card .logo{display:block;margin:0 auto 1rem;width:4.5rem;height:4.5rem;background-image:url("${FAVICON_DATA_URL}");background-size:contain;background-position:center;background-repeat:no-repeat}
.topbar nav{display:flex;gap:1.25rem;font-size:.9rem;align-items:center}
.topbar nav .who{color:var(--fg-muted);font-size:.82rem}
.topbar nav form{display:inline}
.topbar nav button.linklike{font:inherit;background:none;border:none;color:var(--accent);cursor:pointer;padding:0;transition:color .15s ease}
.topbar nav button.linklike:hover{color:var(--accent-hover)}
.theme-toggle{font:inherit;background:none;border:1px solid var(--border);width:2rem;height:2rem;border-radius:9999px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;color:var(--fg-muted);transition:all .15s ease;padding:0}
.theme-toggle:hover{border-color:var(--accent);color:var(--accent);transform:rotate(15deg)}
.theme-toggle svg{width:1rem;height:1rem}
.theme-toggle .icon-sun{display:none}
html[data-theme="dark"] .theme-toggle .icon-moon{display:none}
html[data-theme="dark"] .theme-toggle .icon-sun{display:block}
.btn{font:inherit;font-weight:500;border:1px solid var(--border-strong);background:var(--bg-elevated);color:var(--fg);padding:.45rem 1rem;border-radius:var(--radius);cursor:pointer;display:inline-block;text-decoration:none;transition:all .15s ease;box-shadow:var(--shadow-sm)}
.btn:hover{border-color:var(--accent);color:var(--accent);text-decoration:none;box-shadow:var(--shadow)}
.btn-primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);box-shadow:var(--shadow-sm)}
.btn-primary:hover{background:var(--accent-hover);border-color:var(--accent-hover);color:var(--accent-fg);box-shadow:var(--shadow-md);transform:translateY(-1px)}
.btn-primary:active{transform:translateY(0);box-shadow:var(--shadow-sm)}
.hero{max-width:920px;margin:5rem auto 2rem;padding:0 2rem;text-align:center}
.hero h1{font-size:2.75rem;line-height:1.05;letter-spacing:-.025em;font-weight:800;margin:0 0 1rem;background:linear-gradient(135deg,var(--fg) 0%,var(--accent) 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p.lead{font-size:1.15rem;color:var(--fg-muted);max-width:640px;margin:0 auto 1.75rem;line-height:1.5}
.hero .cta{display:inline-flex;gap:.6rem;flex-wrap:wrap;justify-content:center}
.features{max-width:920px;margin:3rem auto;padding:0 2rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.25rem}
.feature{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1.25rem 1.5rem;box-shadow:var(--shadow);transition:transform .2s ease,box-shadow .2s ease}
.feature:hover{transform:translateY(-2px);box-shadow:var(--shadow-md);border-color:color-mix(in srgb,var(--accent) 30%,var(--border))}
.feature h3{margin:0 0 .5rem;font-size:1rem;font-weight:600}
.feature p{margin:0;color:var(--fg-muted);font-size:.9rem;line-height:1.5}
.footer{margin-top:5rem;padding:2rem;text-align:center;color:var(--fg-muted);font-size:.85rem;border-top:1px solid var(--border)}
.placeholder{max-width:560px;margin:5rem auto;padding:2rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);text-align:center;box-shadow:var(--shadow)}
.placeholder h1{font-size:1.35rem;margin:0 0 .5rem}
.placeholder p{color:var(--fg-muted);margin:.4rem 0}
.placeholder code{background:var(--bg-code);padding:.15rem .35rem;border-radius:.25rem;font-size:.85em}
.auth-card{max-width:420px;margin:4rem auto;padding:2.25rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-md)}
.auth-card h1{font-size:1.4rem;margin:0 0 .35rem;letter-spacing:-.015em;font-weight:700}
.auth-card .subtitle{color:var(--fg-muted);font-size:.9rem;margin:0 0 1.5rem}
.auth-card form{display:flex;flex-direction:column;gap:.85rem}
.auth-card label{font-weight:600;font-size:.85rem;display:block;margin-bottom:.3rem}
.auth-card input[type=email],.auth-card input[type=password],.auth-card input[type=text]{font:inherit;font-size:.95rem;padding:.6rem .85rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg);color:var(--fg);width:100%;transition:border-color .15s ease,box-shadow .15s ease}
.auth-card input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
.auth-card .form-actions{margin-top:.5rem}
.auth-card .form-actions .btn-primary{width:100%;padding:.6rem 1rem}
.auth-card .alt{margin-top:1.25rem;text-align:center;font-size:.85rem;color:var(--fg-muted)}
.flash{padding:.7rem 1rem;border-radius:var(--radius);margin:0 0 1rem;border:1px solid transparent;font-size:.9rem;display:flex;align-items:center;gap:.5rem;animation:flash-in .2s ease}
@keyframes flash-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.flash-ok{background:var(--green-bg);color:var(--green);border-color:color-mix(in srgb,var(--green) 30%,transparent)}
.flash-warn{background:var(--amber-bg);color:var(--amber);border-color:color-mix(in srgb,var(--amber) 30%,transparent)}
.flash-err{background:var(--red-bg);color:var(--red);border-color:color-mix(in srgb,var(--red) 30%,transparent)}
${APP_STYLE}
`;

/* ─── Layout ─── */

interface FlashMessage {
  text: string;
  kind: "ok" | "warn" | "err";
}

/**
 * Inline script in <head> — reads the `theme` cookie and sets the
 * matching `data-theme` attribute on <html> before the body paints,
 * so no flash-of-wrong-theme on navigation. Tiny + minified.
 */
const THEME_INLINE_SCRIPT = `<script>(function(){try{var m=document.cookie.match(/(?:^|; )theme=(light|dark)/);if(m&&m[1]==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}})();</script>`;

/**
 * Theme-toggle button — single form that POSTs to `/theme`, no
 * payload needed (the endpoint reads the current cookie and flips
 * it). Both sun + moon icons are present; CSS shows the right one
 * based on the `[data-theme]` attribute on <html>.
 */
const THEME_TOGGLE = `<form method="POST" action="/theme" style="display:inline">
  <button type="submit" class="theme-toggle" title="Toggle dark mode" aria-label="Toggle dark mode">
    <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
  </button>
</form>`;

function topbar(user: User | null): string {
  const right = user
    ? `<span class="who">${esc(user.email)}${user.role === "super_admin" ? " · super_admin" : ""}</span>
        <a href="/app">Dashboard</a>
        ${user.role === "super_admin" ? '<a href="/admin/users">Admin</a>' : ""}
        ${THEME_TOGGLE}
        <form method="POST" action="/logout"><button type="submit" class="linklike">Sign out</button></form>`
    : `<a href="/login">Sign in</a>${THEME_TOGGLE}`;
  return `<header class="topbar">
    <a class="brand" href="/" aria-label="Edge SEO Platform — home"><span class="logo"></span></a>
    <nav>${right}</nav>
  </header>`;
}

function flashBanner(flash: FlashMessage | null): string {
  if (!flash) return "";
  return `<div class="flash flash-${esc(flash.kind)}" role="alert">${esc(flash.text)}</div>`;
}

function htmlPage(opts: {
  title: string;
  body: string;
  user: User | null;
  flash?: FlashMessage | null;
  /** Extra raw HTML to inject into <head> — e.g. an auto-refresh meta tag. */
  headExtra?: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title><link rel="icon" type="image/png" href="${FAVICON_DATA_URL}">${opts.headExtra ?? ""}${THEME_INLINE_SCRIPT}<style>${STYLE}</style></head><body>${topbar(opts.user)}<main>${flashBanner(opts.flash ?? null)}${opts.body}</main><footer class="footer">© ${new Date().getFullYear()} Edge SEO Platform</footer></body></html>`;
}

const htmlHeadersBase: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { ...htmlHeadersBase, ...(init.headers as Record<string, string> | undefined) },
  });
}

/* ─── CSRF + flash helpers ─── */

function checkCsrf(request: Request, url: URL): Response | null {
  const expected = `${url.protocol}//${url.host}`;
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === expected ? null : new Response("CSRF: Origin mismatch", { status: 403 });
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const ref = new URL(referer);
      return ref.host === url.host && ref.protocol === url.protocol
        ? null
        : new Response("CSRF: Referer mismatch", { status: 403 });
    } catch {
      return new Response("CSRF: invalid Referer", { status: 403 });
    }
  }
  return new Response("CSRF: missing Origin and Referer", { status: 403 });
}

function readFlash(url: URL): FlashMessage | null {
  const text = url.searchParams.get("flash");
  if (!text) return null;
  const kindRaw = url.searchParams.get("flash_kind");
  const kind: FlashMessage["kind"] =
    kindRaw === "ok" || kindRaw === "warn" || kindRaw === "err" ? kindRaw : "ok";
  return { text, kind };
}

function flashRedirect(
  location: string,
  flash: FlashMessage,
  extraHeaders: Record<string, string> = {},
): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, {
    status: 303,
    headers: { location: target, ...extraHeaders },
  });
}

/** Same-origin "next" URL for post-login redirect — only allow paths,
 * never absolute URLs that could send users off-site. */
function safeNext(raw: string | null): string {
  if (!raw) return "/app";
  if (!raw.startsWith("/")) return "/app";
  if (raw.startsWith("//")) return "/app"; // protocol-relative
  return raw;
}

/* ─── Pages ─── */

function renderLanding(user: User | null): string {
  const ctaPrimary = user
    ? `<div class="cta">
        <a class="btn btn-primary" href="/app">Go to dashboard</a>
      </div>`
    : `<div class="cta">
        <a class="btn btn-primary" href="/login">Sign in</a>
        <a class="btn" href="mailto:simon@localblitzmarketing.com?subject=Request%20access%20to%20Edge%20SEO%20Platform">Request access</a>
      </div>`;
  return `<style>
.stakes{max-width:920px;margin:1.5rem auto 0;padding:0 2rem;text-align:center}
.stakes p{color:var(--fg-muted);max-width:640px;margin:0 auto;font-size:.95rem;line-height:1.6}
.stakes p strong{color:var(--fg)}
.plan{max-width:920px;margin:4rem auto 0;padding:0 2rem}
.plan h2,.outcome h2{font-size:1.5rem;letter-spacing:-.01em;margin:0 0 .5rem;text-align:center}
.plan p.intro,.outcome p.intro{color:var(--fg-muted);text-align:center;margin:0 auto 1.75rem;max-width:640px}
.plan-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.25rem;counter-reset:step}
.plan-step{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem 1.5rem;box-shadow:var(--shadow);position:relative}
.plan-step::before{counter-increment:step;content:counter(step);position:absolute;top:-.7rem;left:1.25rem;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--accent);color:var(--accent-fg);font-weight:700;font-size:.85rem;display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow)}
.plan-step h3{margin:.25rem 0 .5rem;font-size:1rem;font-weight:600}
.plan-step p{margin:0;color:var(--fg-muted);font-size:.9rem;line-height:1.5}
.outcome{max-width:920px;margin:4rem auto 5rem;padding:0 2rem;text-align:center}
.outcome .cta{display:inline-flex;gap:.6rem;flex-wrap:wrap;justify-content:center;margin-top:1.5rem}
.features h2{font-size:1.5rem;letter-spacing:-.01em;text-align:center;margin:0 0 1.5rem}
.features-wrap{max-width:920px;margin:4rem auto 0;padding:0 2rem}
</style>

<section class="hero">
  <h1>Your campaigns deserve to compound — not scatter.</h1>
  <p class="lead">Every PPC lander on a one-off domain, every Webflow page on a subdomain, every HubSpot blog on a separate property — that's SEO equity you don't get back. Edge SEO Platform consolidates it under your primary domain, at the edge, in seconds.</p>
  ${ctaPrimary}
</section>

<section class="stakes">
  <p><strong>The cost of doing nothing:</strong> authority leaks across subdomains, every CMS plugin is a deploy risk, and the experiment your strategist proposed last quarter is still waiting on engineering.</p>
</section>

<section class="plan">
  <h2>A clear path to consolidated authority</h2>
  <p class="intro">Three steps. No new CMS. No engineering tickets per page.</p>
  <div class="plan-steps">
    <div class="plan-step">
      <h3>Configure your domain</h3>
      <p>Add a client in the dashboard. One row in the config — no new repo, no DNS reshuffle on the proxy side.</p>
    </div>
    <div class="plan-step">
      <h3>Map your content</h3>
      <p>Point paths at SaaS origins (Webflow, HubSpot, Shopify) or upload custom landers. Set canonicals, redirects, and schema as rules.</p>
    </div>
    <div class="plan-step">
      <h3>Ship at the edge</h3>
      <p>Cloudflare Workers serve every request, every region, in milliseconds. Edits propagate from one source of truth — no per-page deploys.</p>
    </div>
  </div>
</section>

<div class="features-wrap">
  <section class="features">
    <div class="feature">
      <h3>Subfolder authority consolidation</h3>
      <p>Webflow, HubSpot, Shopify content under your primary domain as a subfolder. Authority concentrates where you've earned it.</p>
    </div>
    <div class="feature">
      <h3>Performance domain</h3>
      <p>A controlled secondary domain for PPC landers, programmatic SEO, and AEO experiments. Same runtime, separate SEO surface area.</p>
    </div>
    <div class="feature">
      <h3>Edge SEO control plane</h3>
      <p>Canonical, redirect, schema, indexation, and meta rules — edited in the dashboard, applied at the edge. No CMS plugins.</p>
    </div>
  </section>
</div>

<section class="outcome">
  <h2>What changes after you consolidate</h2>
  <p class="intro">Your campaigns live under one domain. Authority compounds across every page. Edits go live in seconds, not sprints. Your team stops fighting CMS plugins and starts running experiments.</p>
  ${ctaPrimary}
</section>`;
}

function renderLoginForm(opts: { email: string; error: string | null; next: string }): string {
  return `<div class="auth-card"><span class="logo" aria-hidden="true"></span>
    <h1>Sign in</h1>
    <p class="subtitle">Welcome back to Edge SEO Platform.</p>
    ${opts.error ? `<div class="flash flash-err">${esc(opts.error)}</div>` : ""}
    <form method="POST" action="/login${opts.next !== "/app" ? `?next=${encodeURIComponent(opts.next)}` : ""}">
      <div>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="username" value="${esc(opts.email)}">
      </div>
      <div>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Sign in</button>
      </div>
    </form>
    <div class="alt"><a href="/forgot">Forgot password?</a></div>
  </div>`;
}

function renderForgotForm(opts: { email: string; submitted: boolean }): string {
  if (opts.submitted) {
    return `<div class="auth-card"><span class="logo" aria-hidden="true"></span>
      <h1>Check your inbox</h1>
      <p class="subtitle">If an account exists for <code>${esc(opts.email)}</code>, we've sent a password reset link. The link expires in 1 hour.</p>
      <p style="font-size:.85rem;color:var(--fg-muted);margin-top:1rem;">If you don't see it, check spam — emails come from <code>noreply@edgeseo.app</code>. Replies route to <a href="mailto:simon@localblitzmarketing.com">simon@localblitzmarketing.com</a>.</p>
      <div class="alt"><a href="/login">← Back to sign in</a></div>
    </div>`;
  }
  return `<div class="auth-card"><span class="logo" aria-hidden="true"></span>
    <h1>Reset password</h1>
    <p class="subtitle">Enter your email and we'll send a reset link.</p>
    <form method="POST" action="/forgot">
      <div>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email" value="${esc(opts.email)}">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Send reset link</button>
      </div>
    </form>
    <div class="alt"><a href="/login">← Back to sign in</a></div>
  </div>`;
}

function renderResetForm(opts: { token: string; error: string | null }): string {
  return `<div class="auth-card"><span class="logo" aria-hidden="true"></span>
    <h1>Set new password</h1>
    <p class="subtitle">Choose a strong password. Once set, you'll be signed in.</p>
    ${opts.error ? `<div class="flash flash-err">${esc(opts.error)}</div>` : ""}
    <form method="POST" action="/reset?token=${encodeURIComponent(opts.token)}">
      <div>
        <label for="password">New password</label>
        <input id="password" name="password" type="password" required autocomplete="new-password" minlength="12">
      </div>
      <div>
        <label for="confirm">Confirm password</label>
        <input id="confirm" name="confirm" type="password" required autocomplete="new-password" minlength="12">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Set password and sign in</button>
      </div>
    </form>
  </div>`;
}

function renderTokenError(opts: { title: string; message: string }): string {
  return `<div class="auth-card"><span class="logo" aria-hidden="true"></span>
    <h1>${esc(opts.title)}</h1>
    <p class="subtitle">${esc(opts.message)}</p>
    <div class="alt"><a href="/forgot">Request a new link</a> · <a href="/login">Back to sign in</a></div>
  </div>`;
}

function renderPlaceholder(title: string, message: string): string {
  return `<div class="placeholder">
    <h1>${esc(title)}</h1>
    <p>${message}</p>
    <p style="margin-top:1.25rem"><a href="/" class="btn">← Home</a></p>
  </div>`;
}

/* ─── Auth flow handlers ─── */

async function handleLoginPost(
  request: Request,
  env: Env,
  url: URL,
  user: User | null,
): Promise<Response> {
  if (user) return new Response(null, { status: 303, headers: { location: "/app" } });
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = safeNext(url.searchParams.get("next"));

  const renderError = (errMsg: string, status = 400) =>
    htmlResponse(
      htmlPage({
        title: "Sign in — Edge SEO Platform",
        body: renderLoginForm({ email, error: errMsg, next }),
        user: null,
      }),
      { status },
    );

  if (!email || !password) {
    return renderError("Email and password are required.");
  }
  const targetUser = await getUserByEmail(env, email);
  // Always run verifyPassword even when user is missing, to keep timing
  // similar between known and unknown emails. Use a dummy hash with the
  // same iteration count so PBKDF2 cost is comparable.
  const dummyHash =
    "pbkdf2$200000$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000ff";
  const ok = await verifyPassword(password, targetUser?.password_hash ?? dummyHash);
  if (!targetUser || !targetUser.password_hash || !ok) {
    return renderError("Invalid email or password.", 401);
  }
  if (targetUser.email_verified_at === null) {
    return renderError(
      "Please verify your email first. Check your inbox for the verification link.",
      403,
    );
  }
  const { token, expiresAt } = await createSession(env, targetUser.id, request);
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      "set-cookie": sessionCookieHeader({ token, expiresAt }),
    },
  });
}

async function handleForgotPost(request: Request, env: Env, url: URL): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  if (!email) {
    return htmlResponse(
      htmlPage({
        title: "Reset password — Edge SEO Platform",
        body: renderForgotForm({ email, submitted: false }),
        user: null,
      }),
      { status: 400 },
    );
  }
  // Always show the same "check your inbox" page, whether or not the
  // email exists. Don't leak account existence.
  const target = await getUserByEmail(env, email);
  if (target) {
    const { token } = await createEmailToken(env, {
      userId: target.id,
      kind: "reset_password",
      ttlMs: RESET_PASSWORD_TOKEN_TTL_MS,
    });
    const resetUrl = `${url.protocol}//${url.host}/reset?token=${encodeURIComponent(token)}`;
    try {
      await sendEmail(env, resetPasswordMessage({ to: target.email, resetUrl, initiator: "you" }));
    } catch (e) {
      // Log error but still pretend success to user; they retry if mail
      // doesn't arrive. Operator sees the failure in worker logs.
      console.error("forgot: email send failed", e);
    }
  }
  return htmlResponse(
    htmlPage({
      title: "Check your inbox — Edge SEO Platform",
      body: renderForgotForm({ email, submitted: true }),
      user: null,
    }),
  );
}

async function handleResetGet(env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  if (!token) {
    return htmlResponse(
      htmlPage({
        title: "Invalid link — Edge SEO Platform",
        body: renderTokenError({ title: "Invalid link", message: "Reset token is missing." }),
        user: null,
      }),
      { status: 400 },
    );
  }
  // Pre-flight check: SELECT to see if token looks valid (don't consume).
  // We probe by re-using consumeEmailToken's lookup logic but inline so we
  // don't mark it used. A clean approach: fetch the row, leave used_at NULL.
  const row = await env.CONFIG_DB.prepare(
    "SELECT kind, expires_at, used_at FROM email_tokens WHERE token = ? LIMIT 1",
  )
    .bind(token)
    .first<{ kind: EmailTokenKind; expires_at: string; used_at: string | null }>();
  if (
    !row ||
    row.used_at !== null ||
    row.kind !== "reset_password" ||
    new Date(row.expires_at).getTime() < Date.now()
  ) {
    return htmlResponse(
      htmlPage({
        title: "Invalid link — Edge SEO Platform",
        body: renderTokenError({
          title: "Link expired or invalid",
          message: "This reset link is no longer valid. Request a new one.",
        }),
        user: null,
      }),
      { status: 400 },
    );
  }
  return htmlResponse(
    htmlPage({
      title: "Set new password — Edge SEO Platform",
      body: renderResetForm({ token, error: null }),
      user: null,
    }),
  );
}

async function handleResetPost(request: Request, env: Env, url: URL): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const token = url.searchParams.get("token") ?? "";
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  const renderErr = (errMsg: string, status = 400) =>
    htmlResponse(
      htmlPage({
        title: "Set new password — Edge SEO Platform",
        body: renderResetForm({ token, error: errMsg }),
        user: null,
      }),
      { status },
    );

  if (password.length < 12) return renderErr("Password must be at least 12 characters.");
  if (password !== confirm) return renderErr("Passwords don't match.");

  const targetUser = await consumeEmailToken(env, token, "reset_password");
  if (!targetUser) {
    return htmlResponse(
      htmlPage({
        title: "Invalid link — Edge SEO Platform",
        body: renderTokenError({
          title: "Link expired or invalid",
          message: "This reset link is no longer valid. Request a new one.",
        }),
        user: null,
      }),
      { status: 400 },
    );
  }
  await setUserPassword(env, targetUser.id, password);
  // Setting password also implicitly verifies email (the recipient could
  // read the reset link, so the address is theirs).
  await env.CONFIG_DB.prepare(
    "UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id = ?",
  )
    .bind(targetUser.id)
    .run();
  // Log out everywhere as a security precaution: the prior owner of this
  // account (if any) doesn't get to keep their old session.
  await destroyAllSessionsForUser(env, targetUser.id);
  // Then issue a fresh session for the new password owner.
  const { token: newToken, expiresAt } = await createSession(env, targetUser.id, request);
  return new Response(null, {
    status: 303,
    headers: {
      location: `/app?flash=${encodeURIComponent("Password set. You're signed in.")}&flash_kind=ok`,
      "set-cookie": sessionCookieHeader({ token: newToken, expiresAt }),
    },
  });
}

async function handleVerifyGet(env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  if (!token) {
    return htmlResponse(
      htmlPage({
        title: "Invalid link — Edge SEO Platform",
        body: renderTokenError({
          title: "Invalid link",
          message: "Verification token is missing.",
        }),
        user: null,
      }),
      { status: 400 },
    );
  }
  const targetUser = await consumeEmailToken(env, token, "verify_email");
  if (!targetUser) {
    return htmlResponse(
      htmlPage({
        title: "Invalid link — Edge SEO Platform",
        body: renderTokenError({
          title: "Link expired or already used",
          message: "Verification links are single-use and expire after 24 hours.",
        }),
        user: null,
      }),
      { status: 400 },
    );
  }
  await env.CONFIG_DB.prepare(
    "UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id = ?",
  )
    .bind(targetUser.id)
    .run();
  return flashRedirect("/login", { text: "Email verified. Please sign in.", kind: "ok" });
}

async function handleLogoutPost(
  request: Request,
  env: Env,
  url: URL,
  sessionToken: string | null,
): Promise<Response> {
  // CSRF: logout is state-changing.
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  if (sessionToken) await destroySession(env, sessionToken);
  return new Response(null, {
    status: 303,
    headers: {
      location: `/?flash=${encodeURIComponent("Signed out.")}&flash_kind=ok`,
      "set-cookie": sessionCookieHeader({ token: null }),
    },
  });
}

/* ─── Helpers ─── */

function redirectToLogin(url: URL): Response {
  const next = url.pathname + url.search;
  return new Response(null, {
    status: 303,
    headers: { location: `/login?next=${encodeURIComponent(next)}` },
  });
}

/* ─── Router ─── */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const flash = readFlash(url);

    if (method !== "GET" && method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    // Try to attach a session — best-effort. Protected routes redirect on null.
    const sessionToken = parseSessionCookie(request);
    let sessionData: SessionWithUser | null = null;
    if (sessionToken) {
      try {
        sessionData = await getSessionWithUser(env, sessionToken);
      } catch (e) {
        console.error("getSessionWithUser failed", e);
      }
    }
    const user = sessionData?.user ?? null;

    /* ─── Public ─── */
    if ((path === "/" || path === "") && method === "GET") {
      return htmlResponse(
        htmlPage({ title: "Edge SEO Platform", body: renderLanding(user), user, flash }),
      );
    }

    /* ─── Auth flows ─── */

    if (path === "/login" && method === "GET") {
      if (user) return new Response(null, { status: 303, headers: { location: "/app" } });
      const next = safeNext(url.searchParams.get("next"));
      return htmlResponse(
        htmlPage({
          title: "Sign in — Edge SEO Platform",
          body: renderLoginForm({ email: "", error: null, next }),
          user: null,
          flash,
        }),
      );
    }
    if (path === "/login" && method === "POST") {
      return handleLoginPost(request, env, url, user);
    }

    if (path === "/forgot" && method === "GET") {
      return htmlResponse(
        htmlPage({
          title: "Reset password — Edge SEO Platform",
          body: renderForgotForm({ email: "", submitted: false }),
          user: null,
          flash,
        }),
      );
    }
    if (path === "/forgot" && method === "POST") {
      return handleForgotPost(request, env, url);
    }

    if (path === "/reset" && method === "GET") {
      return handleResetGet(env, url);
    }
    if (path === "/reset" && method === "POST") {
      return handleResetPost(request, env, url);
    }

    if (path === "/verify" && method === "GET") {
      return handleVerifyGet(env, url);
    }

    if (path === "/logout" && method === "POST") {
      return handleLogoutPost(request, env, url, sessionToken);
    }

    // Theme toggle — reads the current `theme` cookie, flips it,
    // sets new cookie, 303-redirects back to the referer. No CSRF
    // check (purely cosmetic, no security implications).
    if (path === "/theme" && method === "POST") {
      const cookie = request.headers.get("cookie") ?? "";
      const current = cookie.match(/(?:^|;\s*)theme=(light|dark)/)?.[1] ?? "light";
      const next = current === "dark" ? "light" : "dark";
      const back = request.headers.get("referer") ?? "/";
      return new Response(null, {
        status: 303,
        headers: {
          location: back,
          "set-cookie": `theme=${next}; Path=/; SameSite=Lax; Max-Age=31536000`,
        },
      });
    }
    if (path === "/logout" && method === "GET") {
      // GET /logout is a courtesy redirect — the real logout is POST.
      // Renders a one-button page so a user clicking a "logout" link
      // (without JS) still ends up signing out.
      return htmlResponse(
        htmlPage({
          title: "Sign out — Edge SEO Platform",
          body: `<div class="auth-card"><span class="logo" aria-hidden="true"></span><h1>Sign out?</h1><form method="POST" action="/logout"><button class="btn btn-primary" type="submit">Yes, sign out</button></form></div>`,
          user,
        }),
      );
    }

    /* ─── Authenticated app (Phase E v1: read-only client + audit views) ─── */

    if (path === "/app" || path === "/app/") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "Overview — Edge SEO Platform",
          body: appLayout({
            title: "Overview",
            content: await renderOverview(env, user),
            activeNav: "home",
            user,
            flash,
            clients,
          }),
          user,
          flash: null, // flash rendered inside app layout
        }),
      );
    }

    if (path === "/app/clients") {
      if (!user) return redirectToLogin(url);
      // Load clients + cluster filter data in parallel — the Sites
      // page filter dropdowns need both, so we orchestrate here
      // rather than have renderClientsList call into clusters.ts
      // (which would be a circular import).
      const showDeleted = url.searchParams.get("show_deleted") === "1";
      const showGenerated = url.searchParams.get("show_generated") === "1";
      const [allClients, visibleClusters, generatedIds] = await Promise.all([
        loadVisibleClients(env, user, { includeDeleted: showDeleted }),
        loadVisibleClusters(env, user),
        loadGeneratedClientIds(env),
      ]);
      // Hide programmatic-SEO clients by default — they live on their
      // own page at /app/generated-sites. Toggle ?show_generated=1 to
      // merge them back into this list.
      const clients = showGenerated
        ? allClients
        : allClients.filter((c) => !generatedIds.has(c.client_id));
      const hiddenGeneratedCount = allClients.length - clients.length;
      const clusterMembers = await loadAllClusterMembersByCluster(
        env,
        visibleClusters.map((c) => c.id),
      );
      return htmlResponse(
        htmlPage({
          title: "Proxied sites — Edge SEO Platform",
          body: appLayout({
            title: "Proxied sites",
            content: renderClientsList(clients, visibleClusters, clusterMembers, user, {
              showDeleted,
              showGenerated,
              hiddenGeneratedCount,
            }),
            activeNav: "clients",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    // /app/clients/new (must come before the /app/clients/:id catch-all)
    if (path === "/app/clients/new" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New proxied site — Edge SEO Platform",
          body: appLayout({
            title: "New proxied site",
            content: renderNewClientForm(NEW_CLIENT_TEMPLATE, null),
            activeNav: "clients",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }
    if (path === "/app/clients/new" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleNewClientPost(request, env, url, user);
      if (result.response) return result.response;
      // Validation failed: re-render the form with the error + the user's
      // submitted JSON pre-filled so they don't lose their work.
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New proxied site — Edge SEO Platform",
          body: appLayout({
            title: "New proxied site",
            content: renderNewClientForm(
              result.rerenderError?.raw ?? NEW_CLIENT_TEMPLATE,
              result.rerenderError?.error ?? "Unknown error",
            ),
            activeNav: "clients",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
        { status: 400 },
      );
    }

    /* ─── Bulk-create sites (paste-URLs flow, /app/clients/bulk-new) ─── */
    /* MUST come before the catch-all "/app/clients/<id>" route below.   */

    if (path === "/app/clients/bulk-new" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      const visibleClusters = await loadVisibleClusters(env, user);
      // ?cluster_id=N pre-selects the cluster (used by the
      // "Bulk-create sites for this cluster" link on a cluster page).
      // Only honor the value if it's actually one of the operator's
      // visible clusters — otherwise leave it null and let the
      // operator pick from the dropdown.
      const clusterIdParam = url.searchParams.get("cluster_id");
      let preselectedClusterId: number | null = null;
      if (clusterIdParam) {
        const parsed = Number.parseInt(clusterIdParam, 10);
        if (Number.isFinite(parsed) && parsed > 0 && visibleClusters.some((c) => c.id === parsed)) {
          preselectedClusterId = parsed;
        }
      }
      return htmlResponse(
        htmlPage({
          title: "Bulk-create sites — Edge SEO Platform",
          body: appLayout({
            title: "Bulk-create sites",
            content: renderBulkNewForm({
              prefill: {
                zone: defaultZoneForEnv(env as { ENV?: string }),
                zone_strategy: "single",
                attested_by_email: user.email,
                attested_ip: "",
                scope: "full_site",
                bypass_attestation: false,
                canonical_mode: "none",
                cluster_id: preselectedClusterId,
                status: "active",
                raw_urls: "",
              },
              visibleClusters,
              errors: [],
            }),
            activeNav: "clients",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/clients/bulk-new/preview" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleBulkPreviewPost(request, env, url, user);
      if (result.response) return result.response;
      const clients = await loadVisibleClients(env, user);
      if (result.step1Render) {
        return htmlResponse(
          htmlPage({
            title: "Bulk-create sites — Edge SEO Platform",
            body: appLayout({
              title: "Bulk-create sites",
              content: renderBulkNewForm(result.step1Render),
              activeNav: "clients",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }
      if (result.step2Render) {
        return htmlResponse(
          htmlPage({
            title: "Preview — Bulk-create sites — Edge SEO Platform",
            body: appLayout({
              title: "Preview — Bulk-create sites",
              content: renderBulkPreview({ ...result.step2Render, errors: [] }),
              activeNav: "clients",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }
      return new Response("Internal error", { status: 500 });
    }

    if (path === "/app/clients/bulk-new/confirm" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleBulkConfirmPost(request, env, url, user);
      if (result.response) return result.response;
      if (!result.result) return new Response("Internal error", { status: 500 });
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "Bulk-create result — Edge SEO Platform",
          body: appLayout({
            title: "Bulk-create result",
            content: renderBulkResult(result.result),
            activeNav: "clients",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    /* ─── Create sites from SERP (/app/clients/serp-new) ─── */
    /* MUST come before the catch-all "/app/clients/<id>" route below. */

    if (path === "/app/clients/serp-new" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      const visibleClusters = await loadVisibleClusters(env, user);
      return htmlResponse(
        htmlPage({
          title: "Create sites from SERP — Edge SEO Platform",
          body: appLayout({
            title: "Create sites from SERP",
            content: renderSerpNewForm({
              prefill: defaultSerpPrefill(env as { ENV?: string }),
              visibleClusters,
              errors: [],
            }),
            activeNav: "clients",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/clients/serp-new/preview" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleSerpQueryPost(request, env, url, user);
      if (result.response) return result.response;
      const clients = await loadVisibleClients(env, user);
      if (result.formRender) {
        return htmlResponse(
          htmlPage({
            title: "Create sites from SERP — Edge SEO Platform",
            body: appLayout({
              title: "Create sites from SERP",
              content: renderSerpNewForm(result.formRender),
              activeNav: "clients",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }
      if (result.pickerRender) {
        return htmlResponse(
          htmlPage({
            title: "SERP results — Edge SEO Platform",
            body: appLayout({
              title: "SERP results",
              content: renderSerpPicker({ ...result.pickerRender, errors: [] }),
              activeNav: "clients",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }
      return new Response("Internal error", { status: 500 });
    }

    if (path === "/app/clients/serp-new/preview-pick" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleSerpPickPost(request, env, url, user);
      if (result.response) return result.response;
      if (!result.step2Render) return new Response("Internal error", { status: 500 });
      const clients = await loadVisibleClients(env, user);
      // Render the preview via the existing bulk preview template —
      // confirm POST goes to /app/clients/bulk-new/confirm which is
      // the same final step as the paste-URLs flow.
      return htmlResponse(
        htmlPage({
          title: "Preview — SERP create — Edge SEO Platform",
          body: appLayout({
            title: "Preview — SERP create",
            content: renderBulkPreview({ ...result.step2Render, errors: [] }),
            activeNav: "clients",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path.startsWith("/app/clients/")) {
      if (!user) return redirectToLogin(url);
      const rest = path.slice("/app/clients/".length);
      const slash = rest.indexOf("/");
      const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
      const sub = slash === -1 ? "" : rest.slice(slash + 1);
      const clients = await loadVisibleClients(env, user);

      // Detail page (read-only)
      if (sub === "" && method === "GET") {
        return htmlResponse(
          htmlPage({
            title: `${id} — Edge SEO Platform`,
            body: appLayout({
              title: id,
              content: await renderClientDetail(env, user, id),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // Edit form + handler
      if (sub === "edit" && method === "GET") {
        const client = await loadVisibleClient(env, user, id);
        if (!client) {
          return htmlResponse(
            htmlPage({
              title: `${id} — Edge SEO Platform`,
              body: appLayout({
                title: id,
                content:
                  '<h1>Not found</h1><div class="empty">No client with that id, or you don\'t have access to it.</div>',
                activeNav: `client:${id}`,
                user,
                flash,
                clients,
              }),
              user,
              flash: null,
            }),
            { status: 404 },
          );
        }
        const pretty = JSON.stringify(JSON.parse(client.config_json), null, 2);
        return htmlResponse(
          htmlPage({
            title: `Edit ${id} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${id}`,
              content: renderEditClientForm(client, pretty, null),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }
      if (sub === "edit" && method === "POST") {
        const result = await handleEditClientPost(request, env, url, user, id);
        if (result.response) return result.response;
        return htmlResponse(
          htmlPage({
            title: `Edit ${id} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${id}`,
              content: renderEditClientForm(
                result.rerenderError?.client ?? ({} as never),
                result.rerenderError?.raw ?? "",
                result.rerenderError?.error ?? "Unknown error",
              ),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      // Status flip (POST only)
      if (sub === "status" && method === "POST") {
        return handleStatusPost(request, env, url, user, id);
      }

      // Cache purge (POST only)
      if (sub === "cache-purge" && method === "POST") {
        return handleCachePurgePost(request, env, url, user, id);
      }

      // Soft-delete: GET shows the type-to-confirm page; POST executes.
      if (sub === "delete" && method === "GET") {
        const client = await loadVisibleClient(env, user, id);
        if (!client) {
          return new Response(null, { status: 303, headers: { location: "/app/clients" } });
        }
        return htmlResponse(
          htmlPage({
            title: `Delete ${client.client_id}? — Edge SEO Platform`,
            body: appLayout({
              title: "Delete site",
              content: renderSoftDeleteConfirm({ client, errors: [] }),
              activeNav: "clients",
              user,
              flash,
              clients: await loadVisibleClients(env, user),
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "delete" && method === "POST") {
        const result = await handleSoftDeletePost(request, env, url, user, id);
        if ("redirect" in result) return result.redirect;
        const client = await loadVisibleClient(env, user, id);
        if (!client) {
          return new Response(null, { status: 303, headers: { location: "/app/clients" } });
        }
        return htmlResponse(
          htmlPage({
            title: `Delete ${client.client_id}? — Edge SEO Platform`,
            body: appLayout({
              title: "Delete site",
              content: renderSoftDeleteConfirm({ client, errors: result.errors }),
              activeNav: "clients",
              user,
              flash,
              clients: await loadVisibleClients(env, user),
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      if (sub === "restore" && method === "POST") {
        return handleRestorePost(request, env, url, user, id);
      }

      // Per-site "Reindex now" — fan-out to every configured indexer
      // using the full eligible-URL list (no per-row selection).
      // Equivalent to a save-time auto-ping but on demand.
      if (sub === "indexing/reindex" && method === "POST") {
        const csrf = checkCsrf(request, url);
        if (csrf) return csrf;
        return handleReindexAll(env, user, id);
      }

      // Per-row live HTTP probe — fetched by the Indexing page's
      // inline JS to render SEO diagnostics inline (status, title,
      // canonical, meta description, robots).
      if (sub === "indexing/probe" && method === "POST") {
        const csrf = checkCsrf(request, url);
        if (csrf) return csrf;
        return handleProbeUrl(request, env, user, id);
      }

      // Per-URL "Check indexed" — DataForSEO site:URL probe.
      // Always force=true so the operator's click bypasses the 24h
      // cache and gets fresh data. Result rendered as flash on the
      // indexing page after redirect.
      if (sub === "indexing/check" && method === "POST") {
        const csrf = checkCsrf(request, url);
        if (csrf) return csrf;
        return handleIndexationCheck(request, env, user, id);
      }

      // Per-URL "Make indexable" — upsert path-anchored
      // canonical=self + index,follow rules on this client's config.
      // Idempotent: re-clicking replaces the same rule rather than
      // stacking.
      if (sub === "indexing/make-indexable" && method === "POST") {
        const csrf = checkCsrf(request, url);
        if (csrf) return csrf;
        return handleMakeIndexable(request, env, user, id);
      }

      // Per-site Bot activity dashboard: search engine + AI bot crawl counts.
      if (sub === "bots" && method === "GET") {
        const data = await loadBotActivityData(env, user, id);
        if (!data) {
          return new Response("Not found", { status: 404 });
        }
        return htmlResponse(
          htmlPage({
            title: `Bots — ${id} — Edge SEO Platform`,
            body: appLayout({
              title: `Bots — ${id}`,
              content: renderBotActivityPage(data),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // Per-site Indexing page: GET renders the diagnostic table +
      // submit form; POST submits selected paths to one indexer.
      if (sub === "indexing") {
        if (method === "POST") {
          const csrf = checkCsrf(request, url);
          if (csrf) return csrf;
          return handleIndexingSubmit(request, env, user, id);
        }
        const data = await loadIndexingPageData(env, user, id);
        if (!data) {
          return new Response("Not found", { status: 404 });
        }
        return htmlResponse(
          htmlPage({
            title: `Indexing ${id} — Edge SEO Platform`,
            body: appLayout({
              title: `Indexing ${id}`,
              content: renderIndexingPage(data),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // Cloudflare auto-onboard (in_place mode only) — creates DNS
      // record + Workers Route on the customer's zone via API.
      if (sub === "cf-install" && method === "POST") {
        return handleCloudflareInstallPost(request, env, url, user, id);
      }

      // Attestation form + handler
      if (sub === "attest" && method === "GET") {
        const client = await loadVisibleClient(env, user, id);
        if (!client) {
          return htmlResponse(
            htmlPage({
              title: `${id} — Edge SEO Platform`,
              body: appLayout({
                title: id,
                content: "<h1>Not found</h1>",
                activeNav: `client:${id}`,
                user,
                flash,
                clients,
              }),
              user,
              flash: null,
            }),
            { status: 404 },
          );
        }
        return htmlResponse(
          htmlPage({
            title: `Attest ${id} — Edge SEO Platform`,
            body: appLayout({
              title: `Attest ${id}`,
              content: renderAttestForm(client, null),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }
      if (sub === "attest" && method === "POST") {
        const result = await handleAttestPost(request, env, url, user, id);
        if (result.response) return result.response;
        return htmlResponse(
          htmlPage({
            title: `Attest ${id} — Edge SEO Platform`,
            body: appLayout({
              title: `Attest ${id}`,
              content: renderAttestForm(
                result.rerenderError?.client ?? ({} as never),
                result.rerenderError?.error ?? "Unknown error",
              ),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      // /app/clients/:id/page?match=...&path=... — per-page editor
      // (Piece B of the page-tracking work). Filters list-section
      // rules by match=`<filter>` and renders an Inspect panel
      // pre-loaded with `path` (or the literal path derived from the
      // filter regex). Submits to /edit so existing handler runs.
      if (sub === "page" && method === "GET") {
        const client = await loadVisibleClient(env, user, id);
        if (!client) {
          return htmlResponse(
            htmlPage({
              title: `${id} — Edge SEO Platform`,
              body: appLayout({
                title: id,
                content:
                  '<h1>Not found</h1><div class="empty">No client with that id, or you don\'t have access to it.</div>',
                activeNav: `client:${id}`,
                user,
                flash,
                clients,
              }),
              user,
              flash: null,
            }),
            { status: 404 },
          );
        }
        const matchParam = url.searchParams.get("match") ?? "";
        const pathParam = url.searchParams.get("path");
        let effectiveMatch = matchParam;
        if (!effectiveMatch && pathParam) {
          // Derive a literal-match regex from a path query param. Use
          // `/?$` so the rule matches BOTH `/about-us` and `/about-us/`
          // — many origins (WordPress) canonicalize to the trailing-
          // slash form, and we don't want operators to have to know
          // which form the proxy is currently serving.
          const stripped = pathParam.replace(/\/+$/, "");
          if (stripped === "") {
            effectiveMatch = "^/$";
          } else {
            const escaped = stripped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            effectiveMatch = `^${escaped}/?$`;
          }
        }
        if (!effectiveMatch) {
          return new Response(null, {
            status: 303,
            headers: { location: `/app/clients/${encodeURIComponent(id)}` },
          });
        }
        // Try to derive a literal path for display + Inspect pre-fill.
        // Prefer an existing rule's derived path (handles edge cases the
        // standalone derivation might miss), but fall back to deriving
        // from the match itself so a brand-new page has its Inspect
        // input pre-filled with the path instead of `/`.
        const summary = summarizeEditedPages(JSON.parse(client.config_json));
        const existing = summary.find((g) => g.match === effectiveMatch);
        const literalPath = existing?.literalPath ?? literalPathFromMatch(effectiveMatch);
        const pretty = JSON.stringify(JSON.parse(client.config_json), null, 2);
        return htmlResponse(
          htmlPage({
            title: `Edit page — ${id} — Edge SEO Platform`,
            body: appLayout({
              title: literalPath ?? effectiveMatch,
              content: renderPerPageEditor({
                client,
                match: effectiveMatch,
                literalPath,
                prefilledJson: pretty,
                error: null,
              }),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // /app/clients/:id/custom-page/new — render upload form
      if (sub === "custom-page/new" && method === "GET") {
        const r = await handleNewCustomPageGet(env, user, id);
        if (r instanceof Response) return r;
        return htmlResponse(
          htmlPage({
            title: `New custom page — ${id}`,
            body: appLayout({
              title: `New custom page — ${id}`,
              content: renderNewCustomPageForm(r.client, null),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // /app/clients/:id/custom-page/new — handle upload submission
      if (sub === "custom-page/new" && method === "POST") {
        const result = await handleNewCustomPagePost(request, env, url, user, id);
        if (result.response) return result.response;
        const re = result.rerenderError;
        if (!re) return new Response("Internal error", { status: 500 });
        return htmlResponse(
          htmlPage({
            title: `New custom page — ${id}`,
            body: appLayout({
              title: `New custom page — ${id}`,
              content: renderNewCustomPageForm(re.client, re.error, {
                path: re.path,
                html: re.html,
              }),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      // /app/clients/:id/custom-page/delete — remove R2 object + route
      if (sub === "custom-page/delete" && method === "POST") {
        return handleDeleteCustomPagePost(request, env, url, user, id);
      }

      // /app/clients/:id/custom-page/new-site — render zip upload form
      if (sub === "custom-page/new-site" && method === "GET") {
        const r = await handleNewStaticSiteGet(env, user, id);
        if (r instanceof Response) return r;
        return htmlResponse(
          htmlPage({
            title: `Upload static site — ${id}`,
            body: appLayout({
              title: `Upload static site — ${id}`,
              content: renderNewStaticSiteForm(r.client, null),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // /app/clients/:id/custom-page/new-site — handle zip upload submission
      if (sub === "custom-page/new-site" && method === "POST") {
        const result = await handleNewStaticSitePost(request, env, url, user, id);
        if (result.response) return result.response;
        const re = result.rerenderError;
        if (!re) return new Response("Internal error", { status: 500 });
        return htmlResponse(
          htmlPage({
            title: `Upload static site — ${id}`,
            body: appLayout({
              title: `Upload static site — ${id}`,
              content: renderNewStaticSiteForm(re.client, re.error, re.basePath),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      // /app/clients/:id/custom-page/edit?match=... — render edit form
      if (sub === "custom-page/edit" && method === "GET") {
        const matchParam = url.searchParams.get("match") ?? "";
        if (!matchParam) {
          return new Response(null, {
            status: 303,
            headers: { location: `/app/clients/${encodeURIComponent(id)}` },
          });
        }
        const r = await handleEditCustomPageGet(env, user, id, matchParam);
        if (r instanceof Response) return r;
        return htmlResponse(
          htmlPage({
            title: `Edit custom page — ${id}`,
            body: appLayout({
              title: `Edit custom page — ${id}`,
              content: renderEditCustomPageForm({
                client: r.client,
                match: r.match,
                literalPath: r.literalPath,
                html: r.html,
                error: null,
              }),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // /app/clients/:id/custom-page/edit — handle save (overwrites R2)
      if (sub === "custom-page/edit" && method === "POST") {
        const result = await handleEditCustomPagePost(request, env, url, user, id);
        if (result.response) return result.response;
        const re = result.rerenderError;
        if (!re) return new Response("Internal error", { status: 500 });
        return htmlResponse(
          htmlPage({
            title: `Edit custom page — ${id}`,
            body: appLayout({
              title: `Edit custom page — ${id}`,
              content: renderEditCustomPageForm({
                client: re.client,
                match: re.match,
                literalPath: re.literalPath,
                html: re.html,
                error: re.error,
              }),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      // /app/clients/:id/custom-page/files?match=... — file browser
      if (sub === "custom-page/files" && method === "GET") {
        const matchParam = url.searchParams.get("match") ?? "";
        if (!matchParam) {
          return new Response(null, {
            status: 303,
            headers: { location: `/app/clients/${encodeURIComponent(id)}` },
          });
        }
        const r = await handleSiteFilesGet(env, user, id, matchParam);
        if (r instanceof Response) return r;
        return htmlResponse(
          htmlPage({
            title: `Files — ${id} ${r.basePath}`,
            body: appLayout({
              title: `Files — ${id}`,
              content: renderSiteFilesPage(r),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // /app/clients/:id/custom-page/file/edit?match=...&path=... — single-file edit form
      if (sub === "custom-page/file/edit" && method === "GET") {
        const matchParam = url.searchParams.get("match") ?? "";
        const pathParam = url.searchParams.get("path") ?? "";
        if (!matchParam || !pathParam) {
          return new Response(null, {
            status: 303,
            headers: { location: `/app/clients/${encodeURIComponent(id)}` },
          });
        }
        const r = await handleSiteFileEditGet(env, user, id, matchParam, pathParam);
        if (r instanceof Response) return r;
        return htmlResponse(
          htmlPage({
            title: `Edit ${r.relPath} — ${id}`,
            body: appLayout({
              title: `Edit ${r.relPath} — ${id}`,
              content: renderSiteFileEditForm({ ...r, error: null }),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // /app/clients/:id/custom-page/file/edit — handle save
      if (sub === "custom-page/file/edit" && method === "POST") {
        const result = await handleSiteFileEditPost(request, env, url, user, id);
        if (result.response) return result.response;
        const re = result.rerenderError;
        if (!re) return new Response("Internal error", { status: 500 });
        return htmlResponse(
          htmlPage({
            title: `Edit ${re.relPath} — ${id}`,
            body: appLayout({
              title: `Edit ${re.relPath} — ${id}`,
              content: renderSiteFileEditForm({ ...re, error: re.error }),
              activeNav: `client:${id}`,
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      // /app/clients/:id/custom-page/file/delete — remove a single file
      if (sub === "custom-page/file/delete" && method === "POST") {
        return handleSiteFileDeletePost(request, env, url, user, id);
      }

      // /app/clients/:id/inspect/fetch — JSON endpoint for the
      // page-element picker. Fetches the source domain at the given
      // ?path= and returns a list of structural elements with
      // computed CSS selectors so the UI can pre-fill text_rewrites.
      if (sub === "inspect/fetch" && method === "GET") {
        const client = await loadVisibleClient(env, user, id);
        if (!client) {
          return new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        const inspectPath = url.searchParams.get("path") ?? "/";
        let cfg: { source_domain?: string; routing?: Array<{ origin?: string }> };
        try {
          cfg = JSON.parse(client.config_json);
        } catch (e) {
          return new Response(
            JSON.stringify({ error: `config_json parse error: ${(e as Error).message}` }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }
        // Prefer routing[0].origin (the URL the proxy actually fetches
        // from), fall back to https://${source_domain}.
        const sourceBase =
          cfg.routing?.[0]?.origin ?? (cfg.source_domain ? `https://${cfg.source_domain}` : null);
        if (!sourceBase) {
          return new Response(
            JSON.stringify({ error: "No routing[0].origin or source_domain configured" }),
            { status: 422, headers: { "content-type": "application/json" } },
          );
        }
        try {
          const result = await inspectSourcePage(sourceBase, inspectPath);
          return new Response(JSON.stringify(result), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: `fetch failed: ${(e as Error).message}` }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }
      }

      // Unknown sub-route — fall through to 404 below.
    }

    /* ─── Embeds (library + cluster bulk-apply + reapply) ─── */
    /* Order: list, new, then `/:id/...` actions before the `/:id` catch. */

    if (path === "/app/embeds" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      const rows = await loadVisibleEmbeds(env, user);
      return htmlResponse(
        htmlPage({
          title: "Embeds — Edge SEO Platform",
          body: appLayout({
            title: "Embeds",
            content: renderEmbedsList(rows, user),
            activeNav: "embeds",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/embeds/new" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New embed — Edge SEO Platform",
          body: appLayout({
            title: "New embed",
            content: renderEmbedForm({ prefill: {}, errors: [], mode: "new" }),
            activeNav: "embeds",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/embeds/new" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleEmbedNewPost(request, env, url, user);
      if ("redirect" in result) return result.redirect;
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New embed — Edge SEO Platform",
          body: appLayout({
            title: "New embed",
            content: renderEmbedForm({
              prefill: result.prefill,
              errors: result.errors,
              mode: "new",
            }),
            activeNav: "embeds",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
        { status: 400 },
      );
    }

    /* ─── Indexation overview (platform-wide) ─── */

    if (path === "/app/indexation" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      const visibleClusters = await loadVisibleClusters(env, user);
      const filters: IndexationFilters = {};
      const statusRaw = url.searchParams.get("status");
      if (
        statusRaw === "indexed" ||
        statusRaw === "not_indexed" ||
        statusRaw === "unknown" ||
        statusRaw === "unchecked"
      ) {
        filters.status = statusRaw;
      }
      const clusterIdRaw = url.searchParams.get("cluster_id");
      if (clusterIdRaw) {
        const n = Number.parseInt(clusterIdRaw, 10);
        if (Number.isFinite(n) && n > 0) filters.cluster_id = n;
      }
      const search = url.searchParams.get("search");
      if (search && search.trim().length > 0) filters.search = search;
      const ageRaw = url.searchParams.get("last_check_age");
      if (ageRaw && (LAST_CHECK_AGE_FILTERS as readonly string[]).includes(ageRaw)) {
        filters.last_check_age = ageRaw as LastCheckAgeFilter;
      }
      const data = await loadIndexationOverview(env, user, filters, visibleClusters);
      return htmlResponse(
        htmlPage({
          title: "Indexation — Edge SEO Platform",
          body: appLayout({
            title: "Indexation",
            content: renderIndexationOverviewPage(data),
            activeNav: "indexation",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/indexation/recheck" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleBulkRecheck(request, env, url, user);
      if (result.response) return result.response;
      if (!result.result) return new Response("Internal error", { status: 500 });
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "Recheck result — Edge SEO Platform",
          body: appLayout({
            title: "Recheck result",
            content: renderBulkRecheckResult(result.result),
            activeNav: "indexation",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    // Placements analytics — MUST come before the /app/embeds/:id catch-all.
    if (path === "/app/embeds/placements" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      const filters: PlacementFilters = {};
      const embedIdRaw = url.searchParams.get("embed_id");
      if (embedIdRaw) {
        const n = Number.parseInt(embedIdRaw, 10);
        if (Number.isFinite(n) && n > 0) filters.embed_id = n;
      }
      const clusterIdRaw = url.searchParams.get("cluster_id");
      if (clusterIdRaw) {
        const n = Number.parseInt(clusterIdRaw, 10);
        if (Number.isFinite(n) && n > 0) filters.cluster_id = n;
      }
      const search = url.searchParams.get("client_search");
      if (search && search.trim().length > 0) filters.client_search = search;
      const [rows, embeds, allClusters] = await Promise.all([
        loadVisiblePlacements(env, user, filters),
        loadVisibleEmbeds(env, user),
        loadVisibleClusters(env, user),
      ]);
      return htmlResponse(
        htmlPage({
          title: "Embed placements — Edge SEO Platform",
          body: appLayout({
            title: "Embed placements",
            content: renderPlacementsList({
              rows,
              embeds,
              clusters: allClusters,
              filters,
              user,
            }),
            activeNav: "embeds",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path.startsWith("/app/embeds/")) {
      if (!user) return redirectToLogin(url);
      const rest = path.slice("/app/embeds/".length);
      const slash = rest.indexOf("/");
      const idStr = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? "" : rest.slice(slash + 1);
      const embedId = Number.parseInt(idStr, 10);
      if (!Number.isFinite(embedId) || embedId <= 0) {
        return new Response("Invalid embed id", { status: 400 });
      }
      const embed = await loadVisibleEmbed(env, user, embedId);
      if (!embed) return new Response("Embed not found", { status: 404 });
      const clients = await loadVisibleClients(env, user);

      // Build the indexer-option list once per request — used by both
      // the apply form and the reapply section of the detail page.
      const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
      const indexerOptions = await Promise.all(
        ACTIVE_INDEXERS.map(async (i) => ({
          slotKey: i.slotKey,
          label: i.label,
          color: i.color,
          available: ((await getSecret(sharedEnv, i.slotKey)) ?? "").length > 0,
        })),
      );

      // GET /app/embeds/:id — detail page
      if (sub === "" && method === "GET") {
        const placements = await loadPlacementsForEmbed(env, embedId);
        return htmlResponse(
          htmlPage({
            title: `${embed.name} — Embed — Edge SEO Platform`,
            body: appLayout({
              title: `Embed: ${embed.name}`,
              content: renderEmbedDetail({ embed, placements, indexerOptions }),
              activeNav: "embeds",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "edit" && method === "GET") {
        return htmlResponse(
          htmlPage({
            title: `Edit ${embed.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit embed: ${embed.name}`,
              content: renderEmbedForm({
                prefill: {
                  id: embed.id,
                  name: embed.name,
                  kind: embed.kind,
                  html: embed.html,
                  default_position: embed.default_position,
                },
                errors: [],
                mode: "edit",
              }),
              activeNav: "embeds",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "edit" && method === "POST") {
        const result = await handleEmbedEditPost(request, env, url, user, embedId);
        if ("redirect" in result) return result.redirect;
        return htmlResponse(
          htmlPage({
            title: `Edit ${embed.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit embed: ${embed.name}`,
              content: renderEmbedForm({
                prefill: result.prefill,
                errors: result.errors,
                mode: "edit",
              }),
              activeNav: "embeds",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      if (sub === "delete" && method === "POST") {
        return handleEmbedDeletePost(request, env, url, user, embedId);
      }

      if (sub === "apply" && method === "GET") {
        const visibleClusters = await loadVisibleClusters(env, user);
        return htmlResponse(
          htmlPage({
            title: `Apply ${embed.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Apply: ${embed.name}`,
              content: renderEmbedApplyForm({
                embed,
                visibleClusters,
                indexerOptions,
                errors: [],
              }),
              activeNav: "embeds",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "apply" && method === "POST") {
        // Step-1 POST: renders the per-site picker (step 2).
        const result = await handleEmbedApplyPost(request, env, url, user, embedId);
        if ("response" in result) return result.response;
        return htmlResponse(
          htmlPage({
            title: `Pick sites — ${embed.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Pick sites — ${embed.name}`,
              content: renderEmbedApplyPicker({
                ...result.picker,
                errors: [],
              }),
              activeNav: "embeds",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "apply/confirm" && method === "POST") {
        // Step-2 POST: actually apply to operator-selected client_ids.
        const result = await handleEmbedApplyConfirmPost(request, env, url, user, embedId);
        if ("response" in result) return result.response;
        return htmlResponse(
          htmlPage({
            title: `Apply result — ${embed.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Apply result — ${embed.name}`,
              content: renderEmbedApplyResult(result.result),
              activeNav: "embeds",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub.startsWith("remove/") && method === "POST") {
        const clientId = decodeURIComponent(sub.slice("remove/".length));
        if (!clientId) return new Response("Missing client_id", { status: 400 });
        return handlePlacementRemovePost(request, env, url, user, embedId, clientId);
      }

      if (sub === "reapply" && method === "POST") {
        const result = await handleEmbedReapplyPost(request, env, url, user, embedId);
        if ("response" in result) return result.response;
        return htmlResponse(
          htmlPage({
            title: `Reapply result — ${embed.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Reapply result — ${embed.name}`,
              content: renderEmbedApplyResult(result.result),
              activeNav: "embeds",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      return new Response("Not found", { status: 404 });
    }

    /* ─── Clusters (Slice A: registry only) ─── */

    if (path === "/app/clusters" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      const rows = await loadVisibleClusters(env, user);
      const memberCounts = await loadClusterMemberCounts(
        env,
        rows.map((r) => r.id),
      );
      return htmlResponse(
        htmlPage({
          title: "Clusters — Edge SEO Platform",
          body: appLayout({
            title: "Clusters",
            content: renderClustersList(rows, memberCounts, user),
            activeNav: "clusters",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/clusters/new" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New cluster — Edge SEO Platform",
          body: appLayout({
            title: "New cluster",
            content: renderNewClusterForm(null, clients, []),
            activeNav: "clusters",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/clusters/new" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleNewClusterPost(request, env, url, user);
      if (result.response) return result.response;
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New cluster — Edge SEO Platform",
          body: appLayout({
            title: "New cluster",
            content: renderNewClusterForm(
              result.rerenderError?.prefill ?? null,
              result.rerenderError?.visibleClients ?? clients,
              result.rerenderError?.errors ?? ["Unknown error"],
            ),
            activeNav: "clusters",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
        { status: 400 },
      );
    }

    if (path.startsWith("/app/clusters/")) {
      if (!user) return redirectToLogin(url);
      const rest = path.slice("/app/clusters/".length);
      const slash = rest.indexOf("/");
      const idStr = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? "" : rest.slice(slash + 1);
      const id = Number.parseInt(idStr, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return new Response(null, { status: 303, headers: { location: "/app/clusters" } });
      }
      const clients = await loadVisibleClients(env, user);
      const data = await loadClusterPageData(env, user, id);
      if (!data) {
        return htmlResponse(
          htmlPage({
            title: "Not found — Edge SEO Platform",
            body: appLayout({
              title: "Cluster",
              content:
                '<h1>Not found</h1><div class="empty">No cluster with that id, or you don\'t have access to it.</div>',
              activeNav: "clusters",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 404 },
        );
      }

      if (sub === "" && method === "GET") {
        // Build indexer options once for the inline submit form.
        const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
        const indexerOptions = await Promise.all(
          ACTIVE_INDEXERS.map(async (i) => ({
            slotKey: i.slotKey,
            label: i.label,
            color: i.color,
            available: ((await getSecret(sharedEnv, i.slotKey)) ?? "").length > 0,
          })),
        );
        const submitBlock = renderClusterSubmitIndexersFormBlock({
          clusterId: data.cluster.id,
          indexerOptions,
        });
        return htmlResponse(
          htmlPage({
            title: `${data.cluster.label} — Edge SEO Platform`,
            body: appLayout({
              title: data.cluster.label,
              content: renderClusterDetail(
                data.cluster,
                data.members,
                data.visibleClients,
                submitBlock,
              ),
              activeNav: "clusters",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "check-indexation" && method === "POST") {
        const result = await handleClusterBulkCheck(request, env, url, user, data.cluster.id);
        if (result.response) return result.response;
        if (!result.result) return new Response("Internal error", { status: 500 });
        return htmlResponse(
          htmlPage({
            title: `Indexation check — ${data.cluster.label} — Edge SEO Platform`,
            body: appLayout({
              title: `Indexation check — ${data.cluster.label}`,
              content: renderBulkRecheckResult({
                scope: `cluster: ${data.cluster.label}`,
                results: result.result.results,
              }),
              activeNav: "clusters",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "submit-indexers" && method === "POST") {
        const result = await handleClusterSubmitIndexersPost(request, env, url, data.cluster);
        if ("response" in result) return result.response;
        return htmlResponse(
          htmlPage({
            title: `Indexer submission — ${data.cluster.label} — Edge SEO Platform`,
            body: appLayout({
              title: `Indexer submission — ${data.cluster.label}`,
              content: renderClusterSubmitResult({
                cluster: data.cluster,
                results: result.results,
              }),
              activeNav: "clusters",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "edit" && method === "GET") {
        return htmlResponse(
          htmlPage({
            title: `Edit ${data.cluster.label} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${data.cluster.label}`,
              content: renderEditClusterForm(
                data.cluster,
                data.members,
                null,
                data.visibleClients,
                [],
              ),
              activeNav: "clusters",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "edit" && method === "POST") {
        const result = await handleEditClusterPost(request, env, url, user, id);
        if (result.response) return result.response;
        const re = result.rerenderError;
        if (!re) return new Response("Internal error", { status: 500 });
        return htmlResponse(
          htmlPage({
            title: `Edit ${re.row.label} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${re.row.label}`,
              content: renderEditClusterForm(
                re.row,
                re.members,
                re.prefill,
                re.visibleClients,
                re.errors,
              ),
              activeNav: "clusters",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      if (sub === "status" && method === "POST") {
        return handleClusterStatusPost(request, env, url, user, id);
      }

      // Unknown sub-route — fall through to 404 below.
    }

    if (path === "/app/audit") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "Audit log — Edge SEO Platform",
          body: appLayout({
            title: "Audit log",
            content: await renderAuditPage(env, user),
            activeNav: "audit",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    /* ─── Settings → API keys (super-admin only) ─── */

    if (path === "/app/settings/api-keys") {
      if (!user) return redirectToLogin(url);
      if (user.role !== "super_admin") {
        return new Response("Forbidden — super-admin only.", { status: 403 });
      }
      let testResults: Awaited<ReturnType<typeof handleSettingsApiKeysPost>>["testResults"];
      if (method === "POST") {
        const csrf = checkCsrf(request, url);
        if (csrf) return csrf;
        const outcome = await handleSettingsApiKeysPost(request, env, user);
        if (outcome.redirect) return outcome.redirect;
        testResults = outcome.testResults;
      }
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "API keys — Edge SEO Platform",
          body: appLayout({
            title: "API keys",
            content: await renderSettingsApiKeysPage(env, testResults),
            activeNav: "settings:api-keys",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    /* ─── Link projects (Slice 1: read-only registry) ─── */

    if (path === "/app/link-projects" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      const rows = await loadVisibleLinkProjects(env, user);
      return htmlResponse(
        htmlPage({
          title: "Link projects — Edge SEO Platform",
          body: appLayout({
            title: "Link projects",
            content: renderLinkProjectsList(rows, user),
            activeNav: "link-projects",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/link-projects/new" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New link project — Edge SEO Platform",
          body: appLayout({
            title: "New link project",
            content: renderNewLinkProjectForm(null, []),
            activeNav: "link-projects",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/link-projects/new" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleNewLinkProjectPost(request, env, url, user);
      if (result.response) return result.response;
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New link project — Edge SEO Platform",
          body: appLayout({
            title: "New link project",
            content: renderNewLinkProjectForm(
              result.rerenderError?.prefill ?? null,
              result.rerenderError?.errors ?? ["Unknown error"],
            ),
            activeNav: "link-projects",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
        { status: 400 },
      );
    }

    if (path.startsWith("/app/link-projects/")) {
      if (!user) return redirectToLogin(url);
      const rest = path.slice("/app/link-projects/".length);
      const slash = rest.indexOf("/");
      const idStr = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? "" : rest.slice(slash + 1);
      const id = Number.parseInt(idStr, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return new Response(null, { status: 303, headers: { location: "/app/link-projects" } });
      }
      const clients = await loadVisibleClients(env, user);
      const row = await loadVisibleLinkProject(env, user, id);
      if (!row) {
        return htmlResponse(
          htmlPage({
            title: "Not found — Edge SEO Platform",
            body: appLayout({
              title: "Link project",
              content:
                '<h1>Not found</h1><div class="empty">No link project with that id, or you don\'t have access to it.</div>',
              activeNav: "link-projects",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 404 },
        );
      }

      if (sub === "" && method === "GET") {
        // Detail page bundles project + placements + visible clients
        // so the "add placement" form can render with a populated
        // <select>. loadProjectPageData runs the placement and client
        // queries in parallel.
        const data = await loadProjectPageData(env, user, id);
        if (!data) {
          // Project disappeared between the visibility check above and
          // here — treat as not found.
          return new Response(null, {
            status: 303,
            headers: { location: "/app/link-projects" },
          });
        }
        return htmlResponse(
          htmlPage({
            title: `${row.label} — Edge SEO Platform`,
            body: appLayout({
              title: row.label,
              content: renderLinkProjectDetail(
                data.project,
                data.placements,
                data.visibleClients,
                data.visibleClusters,
                data.clusterMembers,
              ),
              activeNav: "link-projects",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "placements/new" && method === "POST") {
        return handleNewPlacementPost(request, env, url, user, id);
      }

      if (sub === "placements/bulk-new" && method === "POST") {
        return handleBulkPlacementPost(request, env, url, user, id);
      }

      if (sub === "check-target" && method === "POST") {
        return handleCheckTargetPost(request, env, url, user, id);
      }

      // /app/link-projects/:id/placements/:pid/edit and /delete
      if (sub.startsWith("placements/") && (method === "POST" || method === "GET")) {
        const placementRest = sub.slice("placements/".length);
        const slash2 = placementRest.indexOf("/");
        if (slash2 === -1) {
          return new Response(null, {
            status: 303,
            headers: { location: `/app/link-projects/${id}` },
          });
        }
        const placementIdStr = placementRest.slice(0, slash2);
        const placementSub = placementRest.slice(slash2 + 1);
        const placementId = Number.parseInt(placementIdStr, 10);
        if (!Number.isFinite(placementId) || placementId <= 0) {
          return new Response(null, {
            status: 303,
            headers: { location: `/app/link-projects/${id}` },
          });
        }

        if (placementSub === "edit" && method === "GET") {
          const data = await loadProjectPageData(env, user, id);
          if (!data) {
            return new Response(null, {
              status: 303,
              headers: { location: "/app/link-projects" },
            });
          }
          const placement = data.placements.find((p) => p.id === placementId);
          if (!placement) {
            return new Response(null, {
              status: 303,
              headers: { location: `/app/link-projects/${id}` },
            });
          }
          return htmlResponse(
            htmlPage({
              title: `Edit placement — ${row.label}`,
              body: appLayout({
                title: `Edit placement — ${row.label}`,
                content: renderEditPlacementPage(
                  data.project,
                  placement,
                  data.visibleClients,
                  null,
                  [],
                ),
                activeNav: "link-projects",
                user,
                flash,
                clients,
              }),
              user,
              flash: null,
            }),
          );
        }

        if (placementSub === "edit" && method === "POST") {
          const result = await handleEditPlacementPost(request, env, url, user, id, placementId);
          if (result.response) return result.response;
          const re = result.rerenderError;
          if (!re) return new Response("Internal error", { status: 500 });
          return htmlResponse(
            htmlPage({
              title: `Edit placement — ${row.label}`,
              body: appLayout({
                title: `Edit placement — ${row.label}`,
                content: renderEditPlacementPage(
                  re.project,
                  re.placement,
                  re.visibleClients,
                  re.prefill,
                  re.errors,
                ),
                activeNav: "link-projects",
                user,
                flash,
                clients,
              }),
              user,
              flash: null,
            }),
            { status: 400 },
          );
        }

        if (placementSub === "delete" && method === "POST") {
          return handleDeletePlacementPost(request, env, url, user, id, placementId);
        }
      }

      if (sub === "edit" && method === "GET") {
        return htmlResponse(
          htmlPage({
            title: `Edit ${row.label} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${row.label}`,
              content: renderEditLinkProjectForm(row, null, []),
              activeNav: "link-projects",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "edit" && method === "POST") {
        const result = await handleEditLinkProjectPost(request, env, url, user, id);
        if (result.response) return result.response;
        return htmlResponse(
          htmlPage({
            title: `Edit ${row.label} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${row.label}`,
              content: renderEditLinkProjectForm(
                result.rerenderError?.row ?? row,
                result.rerenderError?.prefill ?? null,
                result.rerenderError?.errors ?? ["Unknown error"],
              ),
              activeNav: "link-projects",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      if (sub === "status" && method === "POST") {
        return handleLinkProjectStatusPost(request, env, url, user, id);
      }

      // Unknown sub-route — fall through to 404 below.
    }

    // /app/debug/cf-token — super-admin-only diagnostic. Reports
    // whether `env.CF_API_TOKEN` is bound, its byte length + first
    // 8 chars (NEVER the full value), and what Cloudflare's
    // /user/tokens/verify says when called with it. Used to spot
    // mismatches between the secret stored on the worker and the
    // operator's local token.
    if (path === "/app/debug/cf-token") {
      if (!user) return redirectToLogin(url);
      if (user.role !== "super_admin") {
        return new Response("forbidden", { status: 403 });
      }
      const token = env.CF_API_TOKEN;
      const out: Record<string, unknown> = {
        bound: !!token,
        length: token?.length ?? 0,
        prefix: token ? token.slice(0, 8) : null,
        // Trim-detect: if the value has trailing whitespace, the
        // length-mismatch will out them. Spot-check by reporting the
        // length BEFORE and AFTER trim().
        trimmed_length: token ? token.trim().length : 0,
      };
      if (token) {
        try {
          const verifyResp = await fetch(
            "https://api.cloudflare.com/client/v4/user/tokens/verify",
            { headers: { Authorization: `Bearer ${token}` } },
          );
          out.verify_status = verifyResp.status;
          out.verify_body = await verifyResp.json();
        } catch (e) {
          out.verify_error = (e as Error).message;
        }
        // Run the SAME call the auto-onboard form makes, so we see if
        // there's something specific about the zone-list endpoint.
        // Try the debug zone (404-media.com) and report verbatim.
        try {
          const zoneResp = await fetch(
            "https://api.cloudflare.com/client/v4/zones?name=404-media.com",
            { headers: { Authorization: `Bearer ${token}` } },
          );
          out.zones_status = zoneResp.status;
          out.zones_body = await zoneResp.json();
        } catch (e) {
          out.zones_error = (e as Error).message;
        }
        // And the same call BUT with Content-Type set (matching what
        // the form's callCf does) — see if that's the differentiator.
        try {
          const zoneCtResp = await fetch(
            "https://api.cloudflare.com/client/v4/zones?name=404-media.com",
            {
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            },
          );
          out.zones_ct_status = zoneCtResp.status;
          out.zones_ct_body = await zoneCtResp.json();
        } catch (e) {
          out.zones_ct_error = (e as Error).message;
        }
      }
      return new Response(JSON.stringify(out, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    /* ─── Programmatic SEO: site templates + data sources ─── */
    // Templates list / new / edit live under /app/templates. The fixed
    // `/new` route MUST come before the catch-all `/:id` so it isn't
    // shadowed.

    if (path === "/app/templates" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      const rows = await loadVisibleTemplates(env, user);
      return htmlResponse(
        htmlPage({
          title: "Templates — Edge SEO Platform",
          body: appLayout({
            title: "Templates",
            content: renderTemplatesList(rows, user),
            activeNav: "templates",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/templates/new" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      // ?starter=<id> pre-fills the form from a TEMPLATE_STARTERS entry.
      // Unknown ids silently fall back to a blank form so a bad URL
      // doesn't 404 — the operator still gets to write a template.
      const starterId = url.searchParams.get("starter");
      const starter = starterId ? getTemplateStarter(starterId) : null;
      const prefill = starter
        ? {
            name: starter.name,
            kind: starter.kind,
            path_pattern: starter.path_pattern,
            html_template: starter.html_template,
          }
        : {};
      return htmlResponse(
        htmlPage({
          title: starter ? `New template: ${starter.label}` : "New template — Edge SEO Platform",
          body: appLayout({
            title: starter ? `New template: ${starter.label}` : "New template",
            content: renderTemplateForm({ prefill, errors: [], mode: "new" }),
            activeNav: "templates",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/templates/new" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleTemplateNewPost(request, env, url, user);
      if ("redirect" in result) return result.redirect;
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New template — Edge SEO Platform",
          body: appLayout({
            title: "New template",
            content: renderTemplateForm({
              prefill: result.prefill,
              errors: result.errors,
              mode: "new",
            }),
            activeNav: "templates",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
        { status: 400 },
      );
    }

    if (path.startsWith("/app/templates/")) {
      if (!user) return redirectToLogin(url);
      const rest = path.slice("/app/templates/".length);
      const slash = rest.indexOf("/");
      const idStr = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? "" : rest.slice(slash + 1);
      const id = Number.parseInt(idStr, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return new Response(null, { status: 303, headers: { location: "/app/templates" } });
      }
      const tmpl = await loadVisibleTemplate(env, user, id);
      if (!tmpl) return new Response("Template not found", { status: 404 });
      const clients = await loadVisibleClients(env, user);

      // GET /app/templates/:id/edit
      if (sub === "edit" && method === "GET") {
        return htmlResponse(
          htmlPage({
            title: `Edit ${tmpl.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${tmpl.name}`,
              content: renderTemplateForm({
                prefill: {
                  id: tmpl.id,
                  name: tmpl.name,
                  kind: tmpl.kind,
                  html_template: tmpl.html_template,
                  path_pattern: tmpl.path_pattern,
                },
                errors: [],
                mode: "edit",
              }),
              activeNav: "templates",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      if (sub === "edit" && method === "POST") {
        const result = await handleTemplateEditPost(request, env, url, user, id);
        if ("redirect" in result) return result.redirect;
        return htmlResponse(
          htmlPage({
            title: `Edit ${tmpl.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${tmpl.name}`,
              content: renderTemplateForm({
                prefill: { ...result.prefill, id },
                errors: result.errors,
                mode: "edit",
              }),
              activeNav: "templates",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }

      // GET /app/templates/:id/generate — pick data source + target
      if (sub === "generate" && method === "GET") {
        const dataSources = await loadVisibleDataSources(env, user);
        const zones =
          (env as { ENV?: string }).ENV === "staging"
            ? Array.from(STAGING_PROXY_ZONES)
            : Array.from(PRODUCTION_PROXY_ZONES);
        return htmlResponse(
          htmlPage({
            title: `Generate — ${tmpl.name}`,
            body: appLayout({
              title: `Generate — ${tmpl.name}`,
              content: renderGenerateForm({
                template: tmpl,
                dataSources,
                visibleClients: clients.map((c) => ({
                  client_id: c.client_id,
                  proxy_domain: c.proxy_domain,
                })),
                zones,
                errors: [],
              }),
              activeNav: "templates",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // POST /app/templates/:id/generate/preview
      if (sub === "generate/preview" && method === "POST") {
        const result = await handleGeneratePreviewPost(request, env, url, user, id);
        if ("response" in result) return result.response;
        return htmlResponse(
          htmlPage({
            title: `Preview — ${tmpl.name}`,
            body: appLayout({
              title: `Preview — ${tmpl.name}`,
              content: renderGeneratePreview(result.preview),
              activeNav: "templates",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // POST /app/templates/:id/generate/confirm — execute the render
      if (sub === "generate/confirm" && method === "POST") {
        const result = await handleGenerateConfirmPost(request, env, url, user, id);
        if ("response" in result) return result.response;
        return htmlResponse(
          htmlPage({
            title: `Result — ${tmpl.name}`,
            body: appLayout({
              title: `Result — ${tmpl.name}`,
              content: renderGenerateResult(result.result),
              activeNav: "templates",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
        );
      }

      // Unknown sub-route → 404 below.
    }

    // Data sources

    if (path === "/app/data-sources" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      const rows = await loadVisibleDataSources(env, user);
      return htmlResponse(
        htmlPage({
          title: "Data sources — Edge SEO Platform",
          body: appLayout({
            title: "Data sources",
            content: renderDataSourcesList(rows, user),
            activeNav: "data-sources",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/data-sources/new" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New data source — Edge SEO Platform",
          body: appLayout({
            title: "New data source",
            content: renderDataSourceForm({ prefill: {}, errors: [], mode: "new" }),
            activeNav: "data-sources",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/data-sources/new" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const result = await handleDataSourceNewPost(request, env, url, user);
      if ("redirect" in result) return result.redirect;
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "New data source — Edge SEO Platform",
          body: appLayout({
            title: "New data source",
            content: renderDataSourceForm({
              prefill: result.prefill,
              errors: result.errors,
              mode: "new",
            }),
            activeNav: "data-sources",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
        { status: 400 },
      );
    }

    /* ─── Generated sites (programmatic SEO) ─── */

    if (path === "/app/generated-sites" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const showDeleted = url.searchParams.get("show_deleted") === "1";
      const [allRows, clients] = await Promise.all([
        loadGeneratedSites(env, user),
        loadVisibleClients(env, user, { includeDeleted: true }),
      ]);
      const rows = showDeleted ? allRows : allRows.filter((r) => !r.deleted_at);
      return htmlResponse(
        htmlPage({
          title: "Generated sites — Edge SEO Platform",
          body: appLayout({
            title: "Generated sites",
            content: renderGeneratedSitesList({ rows, user, showDeleted }),
            activeNav: "generated-sites",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/generated-sites/bulk-delete" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const ids = url.searchParams.getAll("client_id");
      if (ids.length === 0) {
        return new Response(null, {
          status: 303,
          headers: { location: "/app/generated-sites" },
        });
      }
      const [clients, allClients] = await Promise.all([
        loadClientsByIds(env, user, ids),
        loadVisibleClients(env, user, { includeDeleted: true }),
      ]);
      return htmlResponse(
        htmlPage({
          title: `Bulk delete ${clients.length} site${clients.length === 1 ? "" : "s"}`,
          body: appLayout({
            title: "Bulk delete",
            content: renderBulkDeleteConfirm({
              clients,
              errors: [],
              returnTo: "/app/generated-sites",
            }),
            activeNav: "generated-sites",
            user,
            flash,
            clients: allClients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/generated-sites/bulk-delete" && method === "POST") {
      if (!user) return redirectToLogin(url);
      return handleBulkDeletePost(request, env, url, user);
    }

    /* ─── Phase B: DataForSEO Maps scrape → data source ─── */
    // These string paths MUST come before the numeric-id catch-all
    // below, otherwise `new-scrape` gets parsed as id=NaN.

    if (path === "/app/data-sources/new-scrape" && method === "GET") {
      if (!user) return redirectToLogin(url);
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "Scrape Google Maps — Edge SEO Platform",
          body: appLayout({
            title: "Scrape Google Maps",
            content: renderScrapeForm({ prefill: defaultScrapeFormPrefill(), errors: [] }),
            activeNav: "data-sources",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
    }

    if (path === "/app/data-sources/new-scrape/start" && method === "POST") {
      if (!user) return redirectToLogin(url);
      const outcome = await handleScrapeStartPost(request, env, url, user);
      if (outcome.redirect && outcome.job) {
        // Kick off the background scrape — we redirect immediately
        // and the job continues for the worker invocation lifetime.
        ctx.waitUntil(runScrapeJob(env, outcome.job.dataSourceId, outcome.job.config));
        return outcome.redirect;
      }
      if (outcome.redirect) return outcome.redirect;
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "Scrape Google Maps — Edge SEO Platform",
          body: appLayout({
            title: "Scrape Google Maps",
            content: renderScrapeForm({
              prefill: outcome.prefill ?? defaultScrapeFormPrefill(),
              errors: outcome.errors ?? ["Unknown error"],
            }),
            activeNav: "data-sources",
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
        { status: 400 },
      );
    }

    if (path.startsWith("/app/data-sources/")) {
      if (!user) return redirectToLogin(url);
      const rest = path.slice("/app/data-sources/".length);
      const slash = rest.indexOf("/");
      const idStr = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? "" : rest.slice(slash + 1);
      const id = Number.parseInt(idStr, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return new Response(null, { status: 303, headers: { location: "/app/data-sources" } });
      }
      const ds = await loadVisibleDataSource(env, user, id);
      if (!ds) return new Response("Data source not found", { status: 404 });
      const clients = await loadVisibleClients(env, user);

      if (sub === "rescrape" && method === "POST") {
        const outcome = await handleRescrapePost(request, env, url, user, ds);
        if (outcome.job) {
          ctx.waitUntil(runScrapeJob(env, outcome.job.dataSourceId, outcome.job.config));
        }
        if (outcome.redirect) return outcome.redirect;
        return new Response("Internal error", { status: 500 });
      }

      if (sub === "edit" && method === "GET") {
        const stuck = isStuck(ds.scrape_status, ds.scrape_progress_updated_at);
        const isScraped = ds.source_kind === "dataforseo_business_listings";
        const progressBlock = isScraped ? renderScrapeProgress({ ds, stuck }) : "";
        const headExtra = isScraped ? scrapeAutoRefreshHeader(ds, stuck) : "";
        return htmlResponse(
          htmlPage({
            title: `Edit ${ds.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${ds.name}`,
              content: `${progressBlock}${renderDataSourceForm({
                prefill: {
                  id: ds.id,
                  name: ds.name,
                  source_kind: ds.source_kind,
                  columns: ds.columns,
                  rows: ds.rows,
                },
                errors: [],
                mode: "edit",
              })}`,
              activeNav: "data-sources",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
            headExtra,
          }),
        );
      }

      if (sub === "edit" && method === "POST") {
        const result = await handleDataSourceEditPost(request, env, url, user, id);
        if ("redirect" in result) return result.redirect;
        return htmlResponse(
          htmlPage({
            title: `Edit ${ds.name} — Edge SEO Platform`,
            body: appLayout({
              title: `Edit ${ds.name}`,
              content: renderDataSourceForm({
                prefill: { ...result.prefill, id },
                errors: result.errors,
                mode: "edit",
              }),
              activeNav: "data-sources",
              user,
              flash,
              clients,
            }),
            user,
            flash: null,
          }),
          { status: 400 },
        );
      }
    }

    /* ─── Super-admin (Phase F fills these in) ─── */

    if (path === "/admin" || path.startsWith("/admin/")) {
      if (!user) return redirectToLogin(url);
      if (user.role !== "super_admin") {
        return htmlResponse(
          htmlPage({
            title: "Forbidden — Edge SEO Platform",
            body: renderPlaceholder("Forbidden", "Only super-admins can access this page."),
            user,
          }),
          { status: 403 },
        );
      }
      return htmlResponse(
        htmlPage({
          title: "Admin — Edge SEO Platform",
          body: renderPlaceholder("Admin", "User CRUD lands in Phase F."),
          user,
          flash,
        }),
      );
    }

    return htmlResponse(
      htmlPage({
        title: "Not found — Edge SEO Platform",
        body: renderPlaceholder("Not found", ""),
        user,
      }),
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;

// Re-export Role so the type is bundled (in case future code imports from here).
export type { Role };
