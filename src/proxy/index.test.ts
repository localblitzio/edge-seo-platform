import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientConfig, RouteRule } from "../config/schema.js";
import type { Env } from "../env.js";
import { OriginFetchError } from "../lib/errors.js";
import { fetchFromOrigin } from "./index.js";

const minimalConfig = {
  source_domain: "blog.lanterncrest.com",
  client_id: "lantern-crest",
} as unknown as ClientConfig;

function makeArgs(overrides: {
  route?: RouteRule;
  env?: Record<string, unknown>;
  request?: Request;
}) {
  const request = overrides.request ?? new Request("https://lanterncrest.com/blog/post-1");
  return {
    request,
    url: new URL(request.url),
    route:
      overrides.route ??
      ({
        match: "^/blog",
        type: "proxy",
        origin: "https://blog.lanterncrest.com",
        origin_auth: { type: "none" },
      } as RouteRule),
    config: minimalConfig,
    env: (overrides.env ?? {}) as unknown as Env,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchFromOrigin — non-mTLS dispatch", () => {
  it("calls the global fetch for `none` auth", async () => {
    const expected = new Response("hi", { status: 200 });
    const seen: { input: unknown; init: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init: unknown) => {
      seen.push({ input, init });
      return expected;
    });

    const out = await fetchFromOrigin(makeArgs({}));

    expect(out).toBe(expected);
    expect(seen).toHaveLength(1);
    const sentRequest = seen[0]?.input as Request;
    expect(new URL(sentRequest.url).hostname).toBe("blog.lanterncrest.com");
  });

  it("propagates AOP fetch failures as OriginFetchError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("AOP handshake failed");
    });
    await expect(
      fetchFromOrigin(
        makeArgs({
          route: {
            match: "^/",
            type: "proxy",
            origin: "https://blog.lanterncrest.com",
            origin_auth: { type: "aop" },
          } as RouteRule,
        }),
      ),
    ).rejects.toThrow(OriginFetchError);
  });

  it("calls fetch with `cf: { cacheTtl: 0, cacheEverything: false }` to disable subrequest cache", async () => {
    const seen: { init: unknown }[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init: unknown) => {
      seen.push({ init });
      return new Response("ok");
    });
    await fetchFromOrigin(makeArgs({}));
    const init = seen[0]?.init as { cf?: Record<string, unknown> };
    expect(init.cf).toEqual({ cacheTtl: 0, cacheEverything: false });
  });

  it("falls back to source_domain when route.origin is omitted", async () => {
    const seen: { input: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      seen.push({ input });
      return new Response("ok");
    });
    await fetchFromOrigin(
      makeArgs({
        route: {
          match: "^/",
          type: "proxy",
          origin_auth: { type: "none" },
        } as RouteRule,
      }),
    );
    const sentRequest = seen[0]?.input as Request;
    expect(new URL(sentRequest.url).hostname).toBe("blog.lanterncrest.com");
  });

  it("throws when invoked on a non-proxy route (defensive guard)", async () => {
    await expect(
      fetchFromOrigin(
        makeArgs({
          route: {
            match: "^/welcome",
            type: "custom_page",
            origin_auth: { type: "none" },
          } as RouteRule,
        }),
      ),
    ).rejects.toThrow(/non-proxy route/);
  });
});

describe("fetchFromOrigin — mTLS dispatch", () => {
  it("calls the binding's fetch when origin_auth.type is mtls", async () => {
    const expected = new Response("via mtls", { status: 200 });
    let bindingCalls = 0;
    const env = {
      CLIENT_X_MTLS: {
        fetch: async () => {
          bindingCalls++;
          return expected;
        },
      },
    };

    // Stub global fetch so we can assert it was NOT called.
    let globalCalls = 0;
    vi.stubGlobal("fetch", async () => {
      globalCalls++;
      return new Response("via global");
    });

    const out = await fetchFromOrigin(
      makeArgs({
        route: {
          match: "^/",
          type: "proxy",
          origin: "https://blog.lanterncrest.com",
          origin_auth: { type: "mtls", cert_secret_name: "CLIENT_X_MTLS" },
        } as RouteRule,
        env,
      }),
    );

    expect(out).toBe(expected);
    expect(bindingCalls).toBe(1);
    expect(globalCalls).toBe(0);
  });

  it("throws OriginFetchError with binding-name context when binding is missing", async () => {
    await expect(
      fetchFromOrigin(
        makeArgs({
          route: {
            match: "^/",
            type: "proxy",
            origin: "https://blog.lanterncrest.com",
            origin_auth: { type: "mtls", cert_secret_name: "MISSING_BINDING" },
          } as RouteRule,
          env: {},
        }),
      ),
    ).rejects.toThrow(/MISSING_BINDING/);
  });

  it("throws OriginFetchError when binding exists but lacks fetch()", async () => {
    await expect(
      fetchFromOrigin(
        makeArgs({
          route: {
            match: "^/",
            type: "proxy",
            origin: "https://blog.lanterncrest.com",
            origin_auth: { type: "mtls", cert_secret_name: "BAD_BINDING" },
          } as RouteRule,
          env: { BAD_BINDING: { not_a_fetch: true } },
        }),
      ),
    ).rejects.toThrow(OriginFetchError);
  });

  it("wraps mTLS handshake failures as OriginFetchError (§6.5 step 9)", async () => {
    const env = {
      CLIENT_X_MTLS: {
        fetch: async () => {
          throw new Error("mTLS handshake failed: bad certificate");
        },
      },
    };
    await expect(
      fetchFromOrigin(
        makeArgs({
          route: {
            match: "^/",
            type: "proxy",
            origin: "https://blog.lanterncrest.com",
            origin_auth: { type: "mtls", cert_secret_name: "CLIENT_X_MTLS" },
          } as RouteRule,
          env,
        }),
      ),
    ).rejects.toThrow(OriginFetchError);
  });
});
