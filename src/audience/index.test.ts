import { describe, expect, it } from "vitest";

import { validLanternCrestConfig } from "../../tests/fixtures/configs/index.js";
import { ClientConfig } from "../config/schema.js";

import { applyAudienceAction, classifyAudience, matchAudienceRule } from "./index.js";

function configWith(mut: (cfg: Record<string, unknown>) => void): ClientConfig {
  const cfg = validLanternCrestConfig() as Record<string, unknown>;
  mut(cfg);
  return ClientConfig.parse(cfg);
}

describe("classifyAudience", () => {
  it("returns kind=human for browser UAs", () => {
    expect(classifyAudience("Mozilla/5.0 Chrome/120")).toEqual({ kind: "human" });
  });

  it("returns kind=bot with family + category for known crawlers", () => {
    expect(classifyAudience("Googlebot/2.1")).toEqual({
      kind: "bot",
      family: "googlebot",
      category: "search-engine",
    });
    expect(classifyAudience("GPTBot/1.0")).toEqual({
      kind: "bot",
      family: "gptbot",
      category: "ai-training",
    });
    expect(classifyAudience("PerplexityBot/1.0")).toEqual({
      kind: "bot",
      family: "perplexitybot",
      category: "ai-search",
    });
  });

  it("returns kind=bot with category=other-bot for unrecognised non-browsers", () => {
    expect(classifyAudience("curl/8.4.0")).toEqual({
      kind: "bot",
      family: "other",
      category: "other-bot",
    });
    expect(classifyAudience(null)).toEqual({
      kind: "bot",
      family: "other",
      category: "other-bot",
    });
  });
});

describe("matchAudienceRule", () => {
  it("returns null when no rules are defined", () => {
    const cfg = configWith(() => {});
    expect(matchAudienceRule("/about", { kind: "human" }, cfg)).toBeNull();
  });

  it("matches a human-targeted rule", () => {
    const cfg = configWith((c) => {
      c.audience_rules = [
        {
          match: "^/lander/.*",
          audience: { type: "human" },
          action: { type: "redirect", url: "https://moneysite.example", status: "302" },
        },
      ];
    });
    expect(matchAudienceRule("/lander/promo", { kind: "human" }, cfg)).not.toBeNull();
    expect(
      matchAudienceRule(
        "/lander/promo",
        { kind: "bot", family: "googlebot", category: "search-engine" },
        cfg,
      ),
    ).toBeNull();
  });

  it("matches a bot-targeted rule with no family/category narrowing (any bot)", () => {
    const cfg = configWith((c) => {
      c.audience_rules = [
        {
          match: "^/internal/.*",
          audience: { type: "bot" },
          action: { type: "block", status: "410" },
        },
      ];
    });
    expect(
      matchAudienceRule(
        "/internal/x",
        { kind: "bot", family: "gptbot", category: "ai-training" },
        cfg,
      ),
    ).not.toBeNull();
    expect(matchAudienceRule("/internal/x", { kind: "human" }, cfg)).toBeNull();
  });

  it("narrows by category", () => {
    const cfg = configWith((c) => {
      c.audience_rules = [
        {
          match: "^/.*",
          audience: { type: "bot", category: "ai-training" },
          action: { type: "block", status: "403" },
        },
      ];
    });
    // ai-training matches
    expect(
      matchAudienceRule("/foo", { kind: "bot", family: "gptbot", category: "ai-training" }, cfg),
    ).not.toBeNull();
    // search-engine doesn't
    expect(
      matchAudienceRule(
        "/foo",
        { kind: "bot", family: "googlebot", category: "search-engine" },
        cfg,
      ),
    ).toBeNull();
  });

  it("narrows by family", () => {
    const cfg = configWith((c) => {
      c.audience_rules = [
        {
          match: "^/.*",
          audience: { type: "bot", family: "claudebot" },
          action: { type: "block", status: "410" },
        },
      ];
    });
    expect(
      matchAudienceRule("/foo", { kind: "bot", family: "claudebot", category: "ai-training" }, cfg),
    ).not.toBeNull();
    expect(
      matchAudienceRule("/foo", { kind: "bot", family: "gptbot", category: "ai-training" }, cfg),
    ).toBeNull();
  });

  it("requires BOTH family AND category to match when both are set", () => {
    const cfg = configWith((c) => {
      c.audience_rules = [
        {
          match: "^/.*",
          audience: { type: "bot", family: "gptbot", category: "ai-training" },
          action: { type: "block", status: "410" },
        },
      ];
    });
    // exact match
    expect(
      matchAudienceRule("/foo", { kind: "bot", family: "gptbot", category: "ai-training" }, cfg),
    ).not.toBeNull();
    // family wrong
    expect(
      matchAudienceRule("/foo", { kind: "bot", family: "ccbot", category: "ai-training" }, cfg),
    ).toBeNull();
  });

  it("first-match-wins ordering", () => {
    const cfg = configWith((c) => {
      c.audience_rules = [
        {
          match: "^/.*",
          audience: { type: "bot", category: "ai-training" },
          action: { type: "block", status: "410" },
        },
        {
          match: "^/.*",
          audience: { type: "bot", category: "ai-training" },
          action: { type: "redirect", url: "/dont-reach-me", status: "302" },
        },
      ];
    });
    const matched = matchAudienceRule(
      "/foo",
      { kind: "bot", family: "gptbot", category: "ai-training" },
      cfg,
    );
    expect(matched?.action.type).toBe("block");
  });

  it("returns null on regex parse failure (silently skips)", () => {
    const cfg = configWith((c) => {
      c.audience_rules = [
        {
          match: "[unclosed",
          audience: { type: "human" },
          action: { type: "block", status: "410" },
        },
      ];
    });
    expect(matchAudienceRule("/foo", { kind: "human" }, cfg)).toBeNull();
  });
});

describe("applyAudienceAction", () => {
  const cfg = ClientConfig.parse(validLanternCrestConfig());
  const url = new URL("https://lanterncrest.com/some/path");
  const env = {} as Parameters<typeof applyAudienceAction>[3];

  it("redirect action returns 3xx with Location header", async () => {
    const r = await applyAudienceAction(
      { type: "redirect", url: "https://elsewhere.example/page", status: "302" },
      url,
      cfg,
      env,
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("https://elsewhere.example/page");
  });

  it("redirect with relative path stays relative", async () => {
    const r = await applyAudienceAction(
      { type: "redirect", url: "/some/local-path", status: "301" },
      url,
      cfg,
      env,
    );
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe("/some/local-path");
  });

  it("redirect with bare path adds leading slash", async () => {
    const r = await applyAudienceAction(
      { type: "redirect", url: "no-slash", status: "302" },
      url,
      cfg,
      env,
    );
    expect(r.headers.get("Location")).toBe("/no-slash");
  });

  it("block action returns 410 Gone by default", async () => {
    const r = await applyAudienceAction({ type: "block", status: "410" }, url, cfg, env);
    expect(r.status).toBe(410);
    expect(await r.text()).toBe("Gone");
  });

  it("block action returns 403 Forbidden when configured", async () => {
    const r = await applyAudienceAction({ type: "block", status: "403" }, url, cfg, env);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("Forbidden");
  });
});
