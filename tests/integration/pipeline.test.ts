/**
 * End-to-end integration tests against the Worker pipeline.
 * Spec: docs/tech-spec.md §12.2.
 *
 * Run via `npm run test:integration` — uses @cloudflare/vitest-pool-workers
 * to spin up a workerd runtime with the same wrangler.toml bindings the
 * production Worker uses. `SELF.fetch` invokes our entry handler.
 *
 * Each test seeds in-memory KV / D1 fixtures via the Worker's bindings
 * (env.CONFIG_KV, env.CONFIG_DB), then exercises the pipeline through
 * `SELF.fetch` and asserts on the response.
 */

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { validLanternCrestConfig } from "../fixtures/configs/index.js";

const HOST = "lanterncrest.com";

interface ConfigOverrides {
  status?: "active" | "paused" | "terminated";
  authorization?: { expires_at?: string | null };
  routing?: unknown[];
  redirects?: unknown;
  canonicals?: unknown[];
  schema_injections?: unknown[];
  link_rewrites?: unknown[];
  element_removals?: unknown[];
  content_injections?: unknown[];
  meta_rewrites?: unknown[];
  indexation?: unknown[];
  caching?: unknown[];
}

async function seedClient(overrides: ConfigOverrides = {}): Promise<void> {
  const cfg = validLanternCrestConfig() as Record<string, unknown>;
  cfg.proxy_domain = HOST;
  Object.assign(cfg, overrides);
  if (overrides.authorization) {
    cfg.authorization = {
      ...(cfg.authorization as Record<string, unknown>),
      ...overrides.authorization,
    };
  }
  await env.CONFIG_KV.put(`domain:${HOST}`, "lantern-crest");
  await env.CONFIG_KV.put("config:lantern-crest", JSON.stringify(cfg));
}

async function clearKv(): Promise<void> {
  const list = await env.CONFIG_KV.list();
  for (const k of list.keys) await env.CONFIG_KV.delete(k.name);
}

beforeAll(async () => {
  // Apply migrations once. The vitest-pool-workers runner sets up D1 fresh
  // per test session; we only need the schema available.
  await env.CONFIG_DB.exec(
    "CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, proxy_domain TEXT NOT NULL UNIQUE, source_domain TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'terminated')), config_json TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
});

afterEach(async () => {
  await clearKv();
});

function fetchPath(path: string, init: RequestInit = {}): Promise<Response> {
  // SELF.fetch in vitest-pool-workers does NOT auto-derive Host from the
  // URL — we must set it explicitly, otherwise the Worker reads "" and
  // the loader can't find the client.
  const headers = new Headers(init.headers);
  headers.set("Host", HOST);
  return SELF.fetch(`https://${HOST}${path}`, { ...init, headers });
}

describe("§12.2 — Config resolution", () => {
  it("returns 502 ConfigNotFound when the host has no client", async () => {
    const res = await SELF.fetch("https://unknown.example/anything", {
      headers: { Host: "unknown.example" },
    });
    expect(res.status).toBe(502);
  });

  it("env.CONFIG_KV writes from the test are visible to subsequent reads (sanity)", async () => {
    await env.CONFIG_KV.put("__sanity__", "ok");
    expect(await env.CONFIG_KV.get("__sanity__")).toBe("ok");
  });

  it("a freshly-seeded config is readable via SELF.fetch", async () => {
    await seedClient({
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
    });
    const directRead = await env.CONFIG_KV.get(`domain:${HOST}`);
    expect(directRead).toBe("lantern-crest");
    // The seeded client has only a /welcome route, so /__no_match__ → 404
    // (NOT 502 ConfigNotFound).
    const res = await fetchPath("/__definitely_no_match__");
    expect(res.status).toBe(404);
  });
});

describe("§12.2 — Authorization gate (§5 step 2)", () => {
  it("returns 410 when status is 'terminated'", async () => {
    await seedClient({
      status: "terminated",
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
    });
    const res = await fetchPath("/welcome");
    expect(res.status).toBe(410);
  });

  it("returns 410 when status is 'paused'", async () => {
    await seedClient({
      status: "paused",
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
    });
    const res = await fetchPath("/welcome");
    expect(res.status).toBe(410);
  });

  it("returns 410 when authorization.expires_at is in the past", async () => {
    await seedClient({
      status: "active",
      authorization: { expires_at: "2020-01-01T00:00:00Z" },
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
    });
    const res = await fetchPath("/welcome");
    expect(res.status).toBe(410);
  });
});

describe("§12.2 — Redirect layer", () => {
  it("static redirect returns 301 to the configured destination", async () => {
    await seedClient({
      routing: [{ match: "^/.*", type: "proxy", origin: "https://example.com" }],
      redirects: {
        static: [{ from: "/old-blog", to: "/blog" }],
        patterns: [],
        conditional: [],
      },
    });
    const res = await fetchPath("/old-blog", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/blog");
  });

  it("pattern redirect rewrites with backreferences", async () => {
    await seedClient({
      routing: [{ match: "^/.*", type: "proxy", origin: "https://example.com" }],
      redirects: {
        static: [],
        patterns: [{ pattern: "^/posts/(\\d+)$", replacement: "/posts/$1/" }],
        conditional: [],
      },
    });
    const res = await fetchPath("/posts/42", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/posts/42/");
  });

  it("static redirect with status 410 returns Gone", async () => {
    await seedClient({
      routing: [{ match: "^/.*", type: "proxy", origin: "https://example.com" }],
      redirects: {
        static: [{ from: "/dead", to: "/", status: "410" }],
        patterns: [],
        conditional: [],
      },
    });
    const res = await fetchPath("/dead");
    expect(res.status).toBe(410);
  });
});

describe("§12.2 — Routing", () => {
  it("404 on unmatched path", async () => {
    await seedClient({
      routing: [{ match: "^/blog", type: "proxy", origin: "https://example.com" }],
    });
    const res = await fetchPath("/no-such-route");
    expect(res.status).toBe(404);
  });

  it("custom_page route renders HTML from KV", async () => {
    await seedClient({
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
    });
    await env.CONFIG_KV.put("page:/welcome", "<html><body>hello</body></html>");
    const res = await fetchPath("/welcome");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("hello");
  });
});

describe("§12.2 — HTMLRewriter pipeline (§5 step 9)", () => {
  it("injects a canonical link on a custom_page response (self default)", async () => {
    await seedClient({
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
      canonicals: [],
    });
    await env.CONFIG_KV.put(
      "page:/welcome",
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
    );
    const res = await fetchPath("/welcome");
    const body = await res.text();
    expect(body).toContain('<link rel="canonical"');
    expect(body).toContain('data-edge-seo-rule="canonical"');
  });

  it("rewrites <title> via meta_rewrites rule", async () => {
    await seedClient({
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
      meta_rewrites: [{ match: "^/welcome$", tag: "title", value: "Rewritten" }],
    });
    await env.CONFIG_KV.put(
      "page:/welcome",
      "<!doctype html><html><head><title>Original</title></head></html>",
    );
    const body = await (await fetchPath("/welcome")).text();
    expect(body).toContain("<title>Rewritten</title>");
    expect(body).not.toContain("<title>Original</title>");
  });

  it("removes elements matching a CSS selector", async () => {
    await seedClient({
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
      element_removals: [{ match: "^/welcome$", selector: ".badge" }],
    });
    await env.CONFIG_KV.put(
      "page:/welcome",
      '<!doctype html><html><body><div class="badge">REMOVE</div><p>keep</p></body></html>',
    );
    const body = await (await fetchPath("/welcome")).text();
    expect(body).not.toContain("REMOVE");
    expect(body).toContain("keep");
  });
});

describe("§12.2 — Security header policy (§10)", () => {
  it("adds X-Content-Type-Options and Referrer-Policy on every response", async () => {
    await seedClient({
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
    });
    await env.CONFIG_KV.put("page:/welcome", "<!doctype html><html><body>hi</body></html>");
    const res = await fetchPath("/welcome");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("applies security headers even on error responses (e.g. 502)", async () => {
    const res = await SELF.fetch("https://unknown.example/", {
      headers: { Host: "unknown.example" },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("§12.2 — Default canonical guardrails (§6.3)", () => {
  it("custom_page route default is `self`", async () => {
    await seedClient({
      routing: [{ match: "^/welcome$", type: "custom_page", custom_page_key: "" }],
      canonicals: [],
    });
    await env.CONFIG_KV.put(
      "page:/welcome",
      "<!doctype html><html><head></head><body></body></html>",
    );
    const body = await (await fetchPath("/welcome")).text();
    expect(body).toMatch(new RegExp(`<link rel="canonical" href="https?://${HOST}/welcome"`));
  });
});
