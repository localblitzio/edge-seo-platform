import { describe, expect, it } from "vitest";

import {
  inviteMessage,
  resetPasswordMessage,
  verifyEmailMessage,
} from "../../../frontend-worker/src/email.js";

const VERIFY_URL = "https://localpage.us.com/verify?token=abc123";
const RESET_URL = "https://localpage.us.com/reset?token=abc123";
const INVITE_URL = "https://localpage.us.com/reset?token=invite-abc";

describe("verifyEmailMessage", () => {
  it("addresses the recipient and produces both html + text", () => {
    const m = verifyEmailMessage({ to: "alice@example.com", verifyUrl: VERIFY_URL });
    expect(m.to).toBe("alice@example.com");
    expect(m.subject).toContain("Verify");
    expect(m.subject).toContain("Edge SEO Platform");
    expect(m.html.length).toBeGreaterThan(100);
    expect(m.text.length).toBeGreaterThan(40);
  });

  it("includes the verify URL verbatim in both html and text", () => {
    const m = verifyEmailMessage({ to: "alice@example.com", verifyUrl: VERIFY_URL });
    expect(m.text).toContain(VERIFY_URL);
    expect(m.html).toContain(VERIFY_URL);
  });

  it("html-escapes hostile-looking URL components in the html body", () => {
    const url = "https://localpage.us.com/verify?token=abc&x=<script>";
    const m = verifyEmailMessage({ to: "alice@example.com", verifyUrl: url });
    // Raw < / > / & must NOT appear unescaped in the html.
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("&amp;");
    // But the text version is unescaped (text/plain doesn't need it).
    expect(m.text).toContain(url);
  });

  it("mentions the 24-hour expiry policy in body", () => {
    const m = verifyEmailMessage({ to: "alice@example.com", verifyUrl: VERIFY_URL });
    expect(m.text).toMatch(/24 hours/);
    expect(m.html).toMatch(/24 hours/);
  });
});

describe("resetPasswordMessage", () => {
  it("defaults the initiator to 'you' when not supplied", () => {
    const m = resetPasswordMessage({ to: "alice@example.com", resetUrl: RESET_URL });
    expect(m.text.toLowerCase()).toMatch(/you requested/);
    expect(m.html.toLowerCase()).toMatch(/you requested/);
  });

  it("uses 'an administrator' phrasing when force-reset by admin", () => {
    const m = resetPasswordMessage({
      to: "alice@example.com",
      resetUrl: RESET_URL,
      initiator: "an administrator",
    });
    expect(m.text.toLowerCase()).toMatch(/an administrator requested/);
    expect(m.html.toLowerCase()).toMatch(/an administrator requested/);
  });

  it("includes the reset URL in both html and text", () => {
    const m = resetPasswordMessage({ to: "alice@example.com", resetUrl: RESET_URL });
    expect(m.text).toContain(RESET_URL);
    expect(m.html).toContain(RESET_URL);
  });

  it("mentions the 1-hour single-use expiry", () => {
    const m = resetPasswordMessage({ to: "alice@example.com", resetUrl: RESET_URL });
    expect(m.text).toMatch(/1 hour/);
    expect(m.text.toLowerCase()).toMatch(/once/);
  });
});

describe("inviteMessage", () => {
  it("addresses the recipient and credits the inviter", () => {
    const m = inviteMessage({
      to: "alice@example.com",
      inviteUrl: INVITE_URL,
      invitedBy: "Simon",
    });
    expect(m.to).toBe("alice@example.com");
    expect(m.text).toContain("Simon invited you");
    expect(m.html).toContain("Simon");
  });

  it("html-escapes the inviter's display name", () => {
    const m = inviteMessage({
      to: "alice@example.com",
      inviteUrl: INVITE_URL,
      invitedBy: "<script>",
    });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    // text version is unescaped.
    expect(m.text).toContain("<script>");
  });

  it("mentions the 7-day expiry", () => {
    const m = inviteMessage({
      to: "alice@example.com",
      inviteUrl: INVITE_URL,
      invitedBy: "Simon",
    });
    expect(m.text).toMatch(/7 days/);
    expect(m.html).toMatch(/7 days/);
  });

  it("includes the invite URL in both html and text", () => {
    const m = inviteMessage({
      to: "alice@example.com",
      inviteUrl: INVITE_URL,
      invitedBy: "Simon",
    });
    expect(m.text).toContain(INVITE_URL);
    expect(m.html).toContain(INVITE_URL);
  });
});
