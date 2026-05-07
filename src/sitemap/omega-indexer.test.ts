import { afterEach, describe, expect, it, vi } from "vitest";

import { pingOmegaIndexer, submitToOmegaIndexer } from "./omega-indexer.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("submitToOmegaIndexer", () => {
  it("posts form-encoded body to /amember/dashboard/api", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await submitToOmegaIndexer({
      apikey: "test-key",
      campaignname: "campaign 1",
      urls: ["https://acme.com/a", "https://acme.com/b"],
      dripfeed: 2,
    });
    expect(r.ok).toBe(true);

    const url = fetchMock.mock.calls[0]?.[0];
    expect(String(url)).toBe("https://www.omegaindexer.com/amember/dashboard/api");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    // Decode the form body and verify each field.
    const params = new URLSearchParams(init.body as string);
    expect(params.get("apikey")).toBe("test-key");
    expect(params.get("campaignname")).toBe("campaign 1");
    expect(params.get("urls")).toBe("https://acme.com/a|https://acme.com/b");
    expect(params.get("dripfeed")).toBe("2");
  });

  it("defaults dripfeed to 2 when not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await submitToOmegaIndexer({
      apikey: "k",
      campaignname: "c",
      urls: ["https://acme.com/x"],
    });
    const params = new URLSearchParams(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(params.get("dripfeed")).toBe("2");
  });

  it("URL-encodes special characters in field values (URLSearchParams handles this)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await submitToOmegaIndexer({
      apikey: "k",
      campaignname: "Test & Co — Q1 2026",
      urls: ["https://acme.com/?utm=hi&z=1"],
    });
    const rawBody = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string;
    // Raw body should contain percent-encoded ampersand, dash, etc.
    expect(rawBody).toContain("campaignname=Test+%26+Co");
    expect(rawBody).toContain("utm%3Dhi%26z%3D1");
  });

  it("returns err on non-2xx with response body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("Invalid API key", { status: 401 }),
      ) as unknown as typeof fetch;
    const r = await submitToOmegaIndexer({
      apikey: "bad",
      campaignname: "x",
      urls: ["https://acme.com/a"],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.responseBody).toBe("Invalid API key");
  });

  it("captures response body even on 200 (Omega may return error text in a 200)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("Project created: id=42", { status: 200 }),
      ) as unknown as typeof fetch;
    const r = await submitToOmegaIndexer({
      apikey: "k",
      campaignname: "c",
      urls: ["https://acme.com/a"],
    });
    expect(r.ok).toBe(true);
    expect(r.responseBody).toBe("Project created: id=42");
  });

  it("returns err on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net")) as unknown as typeof fetch;
    const r = await submitToOmegaIndexer({
      apikey: "k",
      campaignname: "c",
      urls: ["https://acme.com/a"],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe("pingOmegaIndexer", () => {
  it("no-ops when key is empty", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await pingOmegaIndexer("", ["https://acme.com/a"], "x");
    expect(r.submitted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when urls is empty", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await pingOmegaIndexer("k", [], "x");
    expect(r.submitted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a single campaign for ≤500 URLs", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("OK", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const urls = Array.from({ length: 100 }, (_, i) => `https://acme.com/p${i}`);
    const r = await pingOmegaIndexer("k", urls, "Acme 2026-05-07");
    expect(r.submitted).toBe(1);
    expect(r.ok).toBe(1);
    const params = new URLSearchParams(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(params.get("campaignname")).toBe("Acme 2026-05-07");
    expect(params.get("urls")?.split("|")).toHaveLength(100);
  });

  it("chunks > 500 URLs and names chunks (n/total)", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("OK", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const urls = Array.from({ length: 1200 }, (_, i) => `https://acme.com/p${i}`);
    const r = await pingOmegaIndexer("k", urls, "Acme");
    expect(r.submitted).toBe(3); // 500 + 500 + 200
    expect(r.ok).toBe(3);
    const body0 = new URLSearchParams((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    const body2 = new URLSearchParams((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string);
    expect(body0.get("campaignname")).toBe("Acme (1/3)");
    expect(body2.get("campaignname")).toBe("Acme (3/3)");
    expect(body2.get("urls")?.split("|")).toHaveLength(200);
  });
});
