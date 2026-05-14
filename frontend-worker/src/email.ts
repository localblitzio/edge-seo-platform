/**
 * Email helpers for the frontend worker.
 *
 * Wraps the Cloudflare Email Service `env.EMAIL.send()` binding (public beta
 * April 2026) and provides three transactional templates:
 *
 *   - verifyEmail   — first-time email verification for self-signup users
 *                     (currently invite-only per Decision 1; reserved for
 *                     when open signup is enabled later)
 *   - resetPassword — "you (or someone) requested a password reset" link
 *   - invite        — super-admin invited a new user; click to set
 *                     initial password (combines verify + set-password)
 *
 * All emails:
 *   From:     Edge SEO Platform <noreply@edgeseo.app>
 *   Reply-To: simon@localblitzmarketing.com
 *
 * Plain-text variants are always supplied alongside HTML — many corporate
 * mail filters deprioritize HTML-only messages, and accessibility tools
 * use the text part.
 */

const FROM_NAME = "Edge SEO Platform";
const FROM_EMAIL = "noreply@edgeseo.app";
const REPLY_TO = "simon@localblitzmarketing.com";
const BRAND = "Edge SEO Platform";

/**
 * Type alias for the binding's send method. Cloudflare's runtime declares
 * a `SendEmail` global type; we re-state the shape here so this module
 * compiles even before `@cloudflare/workers-types` exposes the binding
 * types officially (still in public beta as of writing).
 */
export interface EmailBinding {
  send(message: {
    to: string | string[];
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | { email: string; name: string };
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

/**
 * Send a transactional email via the bound Cloudflare Email Service.
 *
 * Always sends both `html` and `text`. Sets the canonical From + Reply-To
 * headers consistently across all templates.
 *
 * @param env environment with the EMAIL binding
 * @param msg the email body — to/subject/html/text
 * @returns the messageId from Cloudflare for tracing
 */
export async function sendEmail(
  env: { EMAIL: EmailBinding },
  msg: {
    to: string;
    subject: string;
    html: string;
    text: string;
  },
): Promise<{ messageId: string }> {
  return env.EMAIL.send({
    to: msg.to,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    replyTo: REPLY_TO,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
}

/**
 * Email-safe HTML escape. Used inside templates wherever a user-supplied
 * value (email address, display name) is interpolated into HTML.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wrap content in a minimal email-friendly HTML shell. Inline styles only;
 * email clients strip <style> and external CSS.
 */
function htmlShell(opts: { preheader: string; body: string; footerNote: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
<span style="display:none;max-height:0;overflow:hidden;visibility:hidden;">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#fff;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:24px 32px 8px;">
        <div style="font-size:14px;font-weight:600;color:#18181b;letter-spacing:.01em;">${esc(BRAND)}</div>
      </td></tr>
      <tr><td style="padding:0 32px 24px;font-size:15px;line-height:1.55;color:#18181b;">
        ${opts.body}
      </td></tr>
      <tr><td style="padding:16px 32px;font-size:12px;color:#71717a;border-top:1px solid #e4e4e7;line-height:1.5;">
        ${esc(opts.footerNote)}<br>
        Replies go to <a href="mailto:${esc(REPLY_TO)}" style="color:#10b981;">${esc(REPLY_TO)}</a>.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/**
 * Email verification template. Sent when a self-signup user creates an
 * account and needs to confirm they own the email address.
 */
export function verifyEmailMessage(opts: {
  to: string;
  verifyUrl: string;
}): { to: string; subject: string; html: string; text: string } {
  const subject = `Verify your ${BRAND} email`;
  const text = [
    `Welcome to ${BRAND}.`,
    "",
    "Please verify your email address by visiting this link:",
    opts.verifyUrl,
    "",
    "This link expires in 24 hours.",
    "",
    `If you didn't request this, ignore this email — replies go to ${REPLY_TO}.`,
  ].join("\n");
  const html = htmlShell({
    preheader: `Verify your ${BRAND} email — link expires in 24 hours.`,
    footerNote: "This link expires in 24 hours. If you didn't request this, ignore this email.",
    body: `<p>Welcome to <strong>${esc(BRAND)}</strong>.</p>
      <p>Please verify your email address by clicking the button below.</p>
      <p style="margin:24px 0;"><a href="${esc(opts.verifyUrl)}" style="display:inline-block;padding:12px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Verify email</a></p>
      <p style="font-size:12px;color:#71717a;">Or paste this URL into your browser:<br><a href="${esc(opts.verifyUrl)}" style="color:#10b981;word-break:break-all;">${esc(opts.verifyUrl)}</a></p>`,
  });
  return { to: opts.to, subject, html, text };
}

/**
 * Password reset template. Sent when a user clicks "Forgot password" or
 * when the super-admin force-resets an account. The link contains a
 * single-use, time-limited token and lands on /reset?token=...
 */
export function resetPasswordMessage(opts: {
  to: string;
  resetUrl: string;
  /** "you" if the user requested it themselves; "an administrator" if a super-admin force-reset. */
  initiator?: "you" | "an administrator";
}): { to: string; subject: string; html: string; text: string } {
  const initiator = opts.initiator ?? "you";
  const subject = `Reset your ${BRAND} password`;
  const text = [
    `${initiator === "you" ? "You" : "An administrator"} requested a password reset for your ${BRAND} account.`,
    "",
    "Set a new password by visiting this link:",
    opts.resetUrl,
    "",
    "This link expires in 1 hour and can only be used once.",
    "",
    "If you didn't expect this email, you can ignore it — your password won't change unless you use the link.",
  ].join("\n");
  const html = htmlShell({
    preheader: `Reset your ${BRAND} password — link expires in 1 hour.`,
    footerNote:
      "This link expires in 1 hour and can only be used once. If you didn't expect this email, your password won't change unless you use the link.",
    body: `<p>${initiator === "you" ? "You" : "An administrator"} requested a password reset for your <strong>${esc(BRAND)}</strong> account.</p>
      <p>Click the button below to set a new password.</p>
      <p style="margin:24px 0;"><a href="${esc(opts.resetUrl)}" style="display:inline-block;padding:12px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Set new password</a></p>
      <p style="font-size:12px;color:#71717a;">Or paste this URL into your browser:<br><a href="${esc(opts.resetUrl)}" style="color:#10b981;word-break:break-all;">${esc(opts.resetUrl)}</a></p>`,
  });
  return { to: opts.to, subject, html, text };
}

/**
 * Invite template. Sent when the super-admin creates a new user via
 * /admin/users/new. Combines email-verification with set-password — the
 * invitee clicks the link to land on a "set your password" form. Once
 * password is set, the user is verified and logged in.
 */
export function inviteMessage(opts: {
  to: string;
  inviteUrl: string;
  /** Display name or email of who invited them. */
  invitedBy: string;
}): { to: string; subject: string; html: string; text: string } {
  const subject = `You're invited to ${BRAND}`;
  const text = [
    `${opts.invitedBy} invited you to join ${BRAND}.`,
    "",
    "Set your password and sign in by visiting this link:",
    opts.inviteUrl,
    "",
    "This invite expires in 7 days.",
    "",
    `If you weren't expecting this, ignore this email — replies go to ${REPLY_TO}.`,
  ].join("\n");
  const html = htmlShell({
    preheader: `You're invited to ${BRAND} — set your password to get started.`,
    footerNote: "This invite expires in 7 days. If you weren't expecting it, ignore this email.",
    body: `<p><strong>${esc(opts.invitedBy)}</strong> invited you to join <strong>${esc(BRAND)}</strong>.</p>
      <p>Click the button below to set your password and sign in.</p>
      <p style="margin:24px 0;"><a href="${esc(opts.inviteUrl)}" style="display:inline-block;padding:12px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Accept invite</a></p>
      <p style="font-size:12px;color:#71717a;">Or paste this URL into your browser:<br><a href="${esc(opts.inviteUrl)}" style="color:#10b981;word-break:break-all;">${esc(opts.inviteUrl)}</a></p>`,
  });
  return { to: opts.to, subject, html, text };
}
