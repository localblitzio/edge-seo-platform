import { describe, expect, it } from "vitest";

import { validLanternCrestConfig } from "../../tests/fixtures/configs/index.js";
import { ClientConfig } from "./schema.js";

describe("ClientConfig schema", () => {
  it("accepts the canonical Lantern Crest fixture", () => {
    const result = ClientConfig.safeParse(validLanternCrestConfig());
    if (!result.success) {
      throw new Error(`fixture failed validation: ${result.error.message}`);
    }
    expect(result.data.client_id).toBe("lantern-crest");
    expect(result.data.schema_version).toBe(1);
  });

  it("applies defaults to optional array fields", () => {
    const full = validLanternCrestConfig() as Record<string, unknown>;
    const {
      canonicals: _c,
      element_removals: _e,
      content_injections: _ci,
      meta_rewrites: _mr,
      caching: _ca,
      forms: _f,
      indexation: _i,
      link_rewrites: _lr,
      schema_injections: _si,
      ...minimal
    } = full;
    const result = ClientConfig.parse(minimal);
    expect(result.canonicals).toEqual([]);
    expect(result.caching).toEqual([]);
    expect(result.indexation).toEqual([]);
    expect(result.link_rewrites).toEqual([]);
  });

  it("rejects an invalid client_id (uppercase)", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    cfg.client_id = "Lantern-Crest";
    expect(ClientConfig.safeParse(cfg).success).toBe(false);
  });

  it("rejects an unknown schema_version", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    cfg.schema_version = 2;
    expect(ClientConfig.safeParse(cfg).success).toBe(false);
  });

  it("rejects a status outside the enum", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    cfg.status = "archived";
    expect(ClientConfig.safeParse(cfg).success).toBe(false);
  });

  it("rejects a non-email attested_by_email", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    (cfg.authorization as Record<string, unknown>).attested_by_email = "not-an-email";
    expect(ClientConfig.safeParse(cfg).success).toBe(false);
  });

  it("rejects a non-datetime attested_at", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    (cfg.authorization as Record<string, unknown>).attested_at = "yesterday";
    expect(ClientConfig.safeParse(cfg).success).toBe(false);
  });

  it("rejects a CanonicalStrategy.custom missing url", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    (cfg.canonicals as Array<Record<string, unknown>>)[0] = {
      match: "^/x",
      strategy: { type: "custom" },
    };
    expect(ClientConfig.safeParse(cfg).success).toBe(false);
  });

  it("rejects an OriginAuth.header_token missing secret_name", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    const route = (cfg.routing as Array<Record<string, unknown>>)[0];
    if (!route) throw new Error("fixture missing route");
    route.origin_auth = { type: "header_token", header: "X-Token" };
    expect(ClientConfig.safeParse(cfg).success).toBe(false);
  });

  it("rejects a ConditionalRedirect with an unknown condition type", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    (cfg.redirects as Record<string, unknown>).conditional = [
      {
        match: "^/.*",
        conditions: [{ type: "ip_address", value: "1.2.3.4" }],
        to: "/elsewhere",
        status: "302",
      },
    ];
    expect(ClientConfig.safeParse(cfg).success).toBe(false);
  });

  it("rejects a CacheRule with negative ttl_seconds", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    (cfg.caching as Array<Record<string, unknown>>) = [{ match: "^/", ttl_seconds: -1 }];
    expect(ClientConfig.safeParse(cfg).success).toBe(false);
  });

  it("applies the OriginAuth default when omitted on a route", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    (cfg.routing as Array<Record<string, unknown>>) = [
      { match: "^/blog", type: "proxy", origin: "https://blog.lanterncrest.com" },
    ];
    const result = ClientConfig.parse(cfg);
    const firstRoute = result.routing[0];
    if (!firstRoute) throw new Error("parsed config missing route");
    expect(firstRoute.origin_auth.type).toBe("none");
  });

  it("applies status default '301' on a StaticRedirect", () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    (cfg.redirects as Record<string, unknown>).static = [{ from: "/x", to: "/y" }];
    const parsed = ClientConfig.parse(cfg);
    const firstStatic = parsed.redirects.static[0];
    if (!firstStatic) throw new Error("parsed config missing static redirect");
    expect(firstStatic.status).toBe("301");
    expect(firstStatic.preserve_query).toBe(true);
  });
});
