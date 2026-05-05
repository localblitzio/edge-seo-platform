import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";

import type { RouteRule } from "../config/schema.js";
import type { Env } from "../env.js";
import { renderCustomPage } from "./index.js";

interface R2Entry {
  body: string;
  httpEtag?: string;
  uploaded?: Date;
}

function makeR2(entries: Record<string, R2Entry>): R2Bucket {
  return {
    get: async (key: string) => {
      const e = entries[key];
      if (!e) return null;
      return {
        text: async () => e.body,
        httpEtag: e.httpEtag,
        uploaded: e.uploaded,
      };
    },
  } as unknown as R2Bucket;
}

function makeKv(entries: Record<string, string>): KVNamespace {
  return {
    get: async (key: string) => entries[key] ?? null,
  } as unknown as KVNamespace;
}

function makeEnv(r2: Record<string, R2Entry> = {}, kv: Record<string, string> = {}): Env {
  return {
    CONTENT_R2: makeR2(r2),
    CONFIG_KV: makeKv(kv),
  } as unknown as Env;
}

const customRoute: RouteRule = {
  match: "^/welcome$",
  type: "custom_page",
  custom_page_key: "",
  origin_auth: { type: "none" },
};

describe("renderCustomPage", () => {
  it("returns 200 + HTML from R2 when present", async () => {
    const env = makeEnv({ "/welcome": { body: "<html>r2</html>" } });
    const response = await renderCustomPage(new URL("https://x/welcome"), customRoute, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>r2</html>");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("passes ETag and Last-Modified through from R2 metadata", async () => {
    const uploaded = new Date("2026-01-15T10:00:00Z");
    const env = makeEnv({
      "/welcome": { body: "<html></html>", httpEtag: '"r2-etag"', uploaded },
    });
    const response = await renderCustomPage(new URL("https://x/welcome"), customRoute, env);
    expect(response.headers.get("etag")).toBe('"r2-etag"');
    expect(response.headers.get("last-modified")).toBe(uploaded.toUTCString());
  });

  it("falls back to KV when R2 misses", async () => {
    const env = makeEnv({}, { "page:/welcome": "<html>kv</html>" });
    const response = await renderCustomPage(new URL("https://x/welcome"), customRoute, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>kv</html>");
  });

  it("returns 404 when neither R2 nor KV has content", async () => {
    const env = makeEnv();
    const response = await renderCustomPage(new URL("https://x/welcome"), customRoute, env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("uses the custom_page_key prefix when set", async () => {
    const env = makeEnv({ "landing/lp/austin-tx": { body: "<html>austin</html>" } });
    const route: RouteRule = {
      match: "^/lp/.*",
      type: "custom_page",
      custom_page_key: "landing",
      origin_auth: { type: "none" },
    };
    const response = await renderCustomPage(new URL("https://x/lp/austin-tx"), route, env);
    expect(await response.text()).toBe("<html>austin</html>");
  });

  it("returns 500 if invoked on a non-custom_page route (defensive)", async () => {
    const env = makeEnv();
    const proxyRoute: RouteRule = {
      match: "^/",
      type: "proxy",
      origin: "https://x.example",
      origin_auth: { type: "none" },
    };
    const response = await renderCustomPage(new URL("https://x/"), proxyRoute, env);
    expect(response.status).toBe(500);
  });

  it("R2 is checked BEFORE KV (R2 wins on key collision)", async () => {
    const env = makeEnv(
      { "/welcome": { body: "<html>r2-wins</html>" } },
      { "page:/welcome": "<html>kv-loses</html>" },
    );
    const response = await renderCustomPage(new URL("https://x/welcome"), customRoute, env);
    expect(await response.text()).toBe("<html>r2-wins</html>");
  });

  it("trailing slash on URL finds the no-slash storage key (alt fallback)", async () => {
    // Operator typed `/test-lp` in the upload form → stored at
    // `lantern-crest/test-lp`. User visits `/test-lp/` with trailing slash;
    // the route's `^/test-lp/?$` matches both, but the lookup must too.
    const env = makeEnv({ "lantern-crest/test-lp": { body: "<html>found</html>" } });
    const route: RouteRule = {
      match: "^/test-lp/?$",
      type: "custom_page",
      custom_page_key: "lantern-crest",
      origin_auth: { type: "none" },
    };
    const response = await renderCustomPage(new URL("https://x/test-lp/"), route, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>found</html>");
  });

  it("no trailing slash on URL finds the slash-stored key (alt fallback)", async () => {
    // Inverse: operator typed `/test-lp/` and visitor hit `/test-lp`.
    const env = makeEnv({ "lantern-crest/test-lp/": { body: "<html>found</html>" } });
    const route: RouteRule = {
      match: "^/test-lp/?$",
      type: "custom_page",
      custom_page_key: "lantern-crest",
      origin_auth: { type: "none" },
    };
    const response = await renderCustomPage(new URL("https://x/test-lp"), route, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>found</html>");
  });

  it("primary key wins when both forms exist (explicit storage trumps alt)", async () => {
    const env = makeEnv({
      "lantern-crest/test-lp": { body: "<html>no-slash</html>" },
      "lantern-crest/test-lp/": { body: "<html>with-slash</html>" },
    });
    const route: RouteRule = {
      match: "^/test-lp/?$",
      type: "custom_page",
      custom_page_key: "lantern-crest",
      origin_auth: { type: "none" },
    };
    // Visitor on /test-lp/ — primaryKey is "lantern-crest/test-lp/", which exists.
    const r1 = await renderCustomPage(new URL("https://x/test-lp/"), route, env);
    expect(await r1.text()).toBe("<html>with-slash</html>");
    // Visitor on /test-lp — primaryKey is "lantern-crest/test-lp", which exists.
    const r2 = await renderCustomPage(new URL("https://x/test-lp"), route, env);
    expect(await r2.text()).toBe("<html>no-slash</html>");
  });
});
