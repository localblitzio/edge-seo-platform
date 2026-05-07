import { afterEach, describe, expect, it, vi } from "vitest";

import { pingSinbyte, submitToSinbyte } from "./sinbyte.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("submitToSinbyte", () => {
  it("posts to /api/indexing/ with apikey in body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await submitToSinbyte({
      apikey: "test-key",
      name: "batch1",
      dripfeed: 1,
      method: "tools",
      urls: ["https://acme.com/a"],
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    const url = fetchMock.mock.calls[0]?.[0];
    expect(String(url)).toBe("https://app.sinbyte.com/api/indexing/");
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.apikey).toBe("test-key");
    expect(body.name).toBe("batch1");
    expect(body.dripfeed).toBe(1);
    expect(body.method).toBe("tools");
    expect(body.urls).toEqual(["https://acme.com/a"]);
  });

  it("returns err when response status is non-200", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
    const r = await submitToSinbyte({
      apikey: "bad",
      name: "x",
      dripfeed: 0,
      method: "tools",
      urls: ["https://acme.com/a"],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.responseBody).toBe("Unauthorized");
  });

  it("returns err when 200 body doesn't have status:ok", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "bad key" }), { status: 200 }),
      ) as unknown as typeof fetch;
    const r = await submitToSinbyte({
      apikey: "bad",
      name: "x",
      dripfeed: 0,
      method: "tools",
      urls: ["https://acme.com/a"],
    });
    expect(r.ok).toBe(false);
    expect(r.responseBody).toContain("bad key");
  });

  it("returns err when 200 body isn't JSON", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>down</html>", { status: 200 }),
      ) as unknown as typeof fetch;
    const r = await submitToSinbyte({
      apikey: "k",
      name: "x",
      dripfeed: 0,
      method: "tools",
      urls: ["https://acme.com/a"],
    });
    expect(r.ok).toBe(false);
    expect(r.responseBody).toContain("html");
  });

  it("returns err on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net")) as unknown as typeof fetch;
    const r = await submitToSinbyte({
      apikey: "k",
      name: "x",
      dripfeed: 0,
      method: "tools",
      urls: ["https://acme.com/a"],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe("pingSinbyte", () => {
  it("no-ops when key is empty", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await pingSinbyte("", ["https://acme.com/a"], "x");
    expect(r.submitted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when urls is empty", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await pingSinbyte("k", [], "x");
    expect(r.submitted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a single batch for ≤500 URLs with method=tools, dripfeed=1", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const urls = Array.from({ length: 100 }, (_, i) => `https://acme.com/p${i}`);
    const r = await pingSinbyte("k", urls, "Acme 2026-05-07");
    expect(r.submitted).toBe(1);
    expect(r.ok).toBe(1);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.method).toBe("tools");
    expect(body.dripfeed).toBe(1);
    expect(body.name).toBe("Acme 2026-05-07");
  });

  it("chunks > 500 URLs and names chunks (n/total)", async () => {
    // Use mockImplementation so each call gets a fresh Response (the
    // body is single-read; reusing one Response across 3 calls
    // would hit "Body is unusable" on calls 2 and 3).
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const urls = Array.from({ length: 1200 }, (_, i) => `https://acme.com/p${i}`);
    const r = await pingSinbyte("k", urls, "Acme");
    expect(r.submitted).toBe(3); // 500 + 500 + 200
    expect(r.ok).toBe(3);
    const body0 = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    const body2 = JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string);
    expect(body0.name).toBe("Acme (1/3)");
    expect(body2.name).toBe("Acme (3/3)");
    expect(body2.urls).toHaveLength(200);
  });
});
