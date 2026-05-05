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

import {
  APP_STYLE,
  appLayout,
  loadVisibleClients,
  renderAuditPage,
  renderClientDetail,
  renderClientsList,
  renderOverview,
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
import { type EmailBinding, resetPasswordMessage, sendEmail } from "./email.js";

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
:root{color-scheme:light dark;--bg:#fafafa;--bg-elevated:#fff;--bg-code:#f4f4f5;--border:#e4e4e7;--border-strong:#d4d4d8;--fg:#18181b;--fg-muted:#71717a;--accent:#2563eb;--accent-fg:#fff;--green:#16a34a;--green-bg:#dcfce7;--amber:#b45309;--amber-bg:#fef3c7;--red:#b91c1c;--red-bg:#fee2e2;--shadow:0 1px 2px rgba(0,0,0,.04),0 1px 3px rgba(0,0,0,.06);--radius:.5rem;--mono:ui-monospace,"SFMono-Regular","Menlo","Cascadia Mono",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--bg-elevated:#18181b;--bg-code:#18181b;--border:#27272a;--border-strong:#3f3f46;--fg:#fafafa;--fg-muted:#a1a1aa;--accent:#60a5fa;--green:#4ade80;--green-bg:#052e16;--amber:#fbbf24;--amber-bg:#422006;--red:#f87171;--red-bg:#450a0a}}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,.mono{font-family:var(--mono);font-size:.92em}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:1rem 2rem;background:var(--bg-elevated);border-bottom:1px solid var(--border)}
.topbar .brand{display:flex;align-items:center;gap:.6rem;font-size:1rem;font-weight:600}
.topbar .logo{display:inline-block;width:1rem;height:1rem;border-radius:9999px;background:linear-gradient(135deg,#2563eb,#7c3aed)}
.topbar nav{display:flex;gap:1.25rem;font-size:.9rem;align-items:center}
.topbar nav .who{color:var(--fg-muted);font-size:.82rem}
.topbar nav form{display:inline}
.topbar nav button.linklike{font:inherit;background:none;border:none;color:var(--accent);cursor:pointer;padding:0}
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
.auth-card{max-width:420px;margin:4rem auto;padding:2rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.auth-card h1{font-size:1.35rem;margin:0 0 .35rem;letter-spacing:-.01em}
.auth-card .subtitle{color:var(--fg-muted);font-size:.9rem;margin:0 0 1.5rem}
.auth-card form{display:flex;flex-direction:column;gap:.85rem}
.auth-card label{font-weight:600;font-size:.85rem;display:block;margin-bottom:.3rem}
.auth-card input[type=email],.auth-card input[type=password],.auth-card input[type=text]{font:inherit;font-size:.95rem;padding:.55rem .75rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg);color:var(--fg);width:100%}
.auth-card .form-actions{margin-top:.5rem}
.auth-card .form-actions .btn-primary{width:100%}
.auth-card .alt{margin-top:1.25rem;text-align:center;font-size:.85rem;color:var(--fg-muted)}
.flash{padding:.65rem 1rem;border-radius:var(--radius);margin:0 0 1rem;border:1px solid transparent;font-size:.9rem}
.flash-ok{background:var(--green-bg);color:var(--green);border-color:var(--green)}
.flash-warn{background:var(--amber-bg);color:var(--amber);border-color:var(--amber)}
.flash-err{background:var(--red-bg);color:var(--red);border-color:var(--red)}
${APP_STYLE}
`;

/* ─── Layout ─── */

interface FlashMessage {
  text: string;
  kind: "ok" | "warn" | "err";
}

function topbar(user: User | null): string {
  const right = user
    ? `<span class="who">${esc(user.email)}${user.role === "super_admin" ? " · super_admin" : ""}</span>
        <a href="/app">Dashboard</a>
        ${user.role === "super_admin" ? '<a href="/admin/users">Admin</a>' : ""}
        <form method="POST" action="/logout"><button type="submit" class="linklike">Sign out</button></form>`
    : `<a href="/login">Sign in</a>`;
  return `<header class="topbar">
    <a class="brand" href="/"><span class="logo"></span>Edge SEO Platform</a>
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
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title><style>${STYLE}</style></head><body>${topbar(opts.user)}<main>${flashBanner(opts.flash ?? null)}${opts.body}</main><footer class="footer">© ${new Date().getFullYear()} Edge SEO Platform</footer></body></html>`;
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
  const cta = user
    ? `<div class="cta">
        <a class="btn btn-primary" href="/app">Go to dashboard</a>
      </div>`
    : `<div class="cta">
        <a class="btn btn-primary" href="/login">Sign in</a>
        <a class="btn" href="mailto:simon@localblitzmarketing.com?subject=Request%20access%20to%20Edge%20SEO%20Platform">Request access</a>
      </div>`;
  return `<section class="hero">
    <h1>Host any site under your domain — at the edge.</h1>
    <p class="lead">Edge SEO Platform proxies, transforms, and serves websites under controlled domains using Cloudflare Workers. Add a client with one config row; serve traffic immediately on a wildcard subdomain or your custom domain.</p>
    ${cta}
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

function renderLoginForm(opts: { email: string; error: string | null; next: string }): string {
  return `<div class="auth-card">
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
    return `<div class="auth-card">
      <h1>Check your inbox</h1>
      <p class="subtitle">If an account exists for <code>${esc(opts.email)}</code>, we've sent a password reset link. The link expires in 1 hour.</p>
      <p style="font-size:.85rem;color:var(--fg-muted);margin-top:1rem;">If you don't see it, check spam — emails come from <code>noreply@edgeseo.app</code>. Replies route to <a href="mailto:simon@localblitzmarketing.com">simon@localblitzmarketing.com</a>.</p>
      <div class="alt"><a href="/login">← Back to sign in</a></div>
    </div>`;
  }
  return `<div class="auth-card">
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
  return `<div class="auth-card">
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
  return `<div class="auth-card">
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
  async fetch(request: Request, env: Env): Promise<Response> {
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
    if (path === "/logout" && method === "GET") {
      // GET /logout is a courtesy redirect — the real logout is POST.
      // Renders a one-button page so a user clicking a "logout" link
      // (without JS) still ends up signing out.
      return htmlResponse(
        htmlPage({
          title: "Sign out — Edge SEO Platform",
          body: `<div class="auth-card"><h1>Sign out?</h1><form method="POST" action="/logout"><button class="btn btn-primary" type="submit">Yes, sign out</button></form></div>`,
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
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: "Clients — Edge SEO Platform",
          body: appLayout({
            title: "Clients",
            content: await renderClientsList(env, user),
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
      const id = decodeURIComponent(path.slice("/app/clients/".length));
      // No nested sub-routes yet (Phase E v2 adds /edit, /attest, /status,
      // /cache-purge, /new). For now, anything past /app/clients/:id
      // renders the detail page (slash-tolerant).
      const cleanId = id.split("/")[0] ?? "";
      const clients = await loadVisibleClients(env, user);
      return htmlResponse(
        htmlPage({
          title: `${cleanId} — Edge SEO Platform`,
          body: appLayout({
            title: cleanId,
            content: await renderClientDetail(env, user, cleanId),
            activeNav: `client:${cleanId}`,
            user,
            flash,
            clients,
          }),
          user,
          flash: null,
        }),
      );
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
