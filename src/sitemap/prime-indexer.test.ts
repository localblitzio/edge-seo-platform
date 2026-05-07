import { afterEach, describe, expect, it, vi } from "vitest";

import { checkPrimeBalance, pingPrimeIndexer, submitToPrimeIndexer } from "./prime-indexer.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = vi.fn().mockImplementation(impl) as unknown as typeof fetch;
}

describe("checkPrimeBalance", () => {
  it("returns ok with parsed balance on HTTP 200", async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            balance: 450,
            recentTransactions: [{ id: "1", amount: 100, type: "PURCHASE", date: "2026-01-27" }],
          }),
          { status: 200 },
        ),
    );
    const r = await checkPrimeBalance("valid-key");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.balance.balance).toBe(450);
      expect(r.balance.recentTransactionCount).toBe(1);
    }
  });

  it("sends x-api-key header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ balance: 0 }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await checkPrimeBalance("test-key-abc");
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit)?.headers as Record<
      string,
      string
    >;
    expect(headers["x-api-key"]).toBe("test-key-abc");
  });

  it("returns err on 401", async () => {
    mockFetch(async () => new Response("Unauthorized", { status: 401 }));
    const r = await checkPrimeBalance("invalid-key");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.message).toContain("Unauthorized");
    }
  });

  it("returns err on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;
    const r = await checkPrimeBalance("any-key");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(0);
      expect(r.message).toContain("ENOTFOUND");
    }
  });

  it("returns err on malformed response (missing balance field)", async () => {
    mockFetch(async () => new Response("{}", { status: 200 }));
    const r = await checkPrimeBalance("valid-but-weird");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("balance");
    }
  });
});

describe("submitToPrimeIndexer", () => {
  it("posts to /projects with the body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ projectId: "proj_abc" }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await submitToPrimeIndexer("k", {
      name: "test project",
      urls: ["https://acme.com/a", "https://acme.com/b"],
    });
    expect(r.ok).toBe(true);
    expect(r.projectId).toBe("proj_abc");
    const url = fetchMock.mock.calls[0]?.[0];
    expect(String(url)).toBe("https://app.primeindexer.com/api/v1/projects");
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.name).toBe("test project");
    expect(body.urls).toHaveLength(2);
  });

  it("returns err on 4xx with response body", async () => {
    mockFetch(async () => new Response("Insufficient credits", { status: 402 }));
    const r = await submitToPrimeIndexer("k", { name: "x", urls: ["https://acme.com/a"] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(402);
    expect(r.responseBody).toBe("Insufficient credits");
  });

  it("returns err on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net")) as unknown as typeof fetch;
    const r = await submitToPrimeIndexer("k", { name: "x", urls: ["https://acme.com/a"] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe("pingPrimeIndexer", () => {
  it("no-ops when key is empty", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await pingPrimeIndexer("", ["https://acme.com/a"], "test");
    expect(r.submitted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when urls is empty", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await pingPrimeIndexer("k", [], "test");
    expect(r.submitted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a single project for ≤500 URLs", async () => {
    mockFetch(async () => new Response(JSON.stringify({ projectId: "proj_one" }), { status: 200 }));
    const urls = Array.from({ length: 250 }, (_, i) => `https://acme.com/p${i}`);
    const r = await pingPrimeIndexer("k", urls, "Acme 2026-05-07");
    expect(r.submitted).toBe(1);
    expect(r.ok).toBe(1);
    expect(r.projectIds).toEqual(["proj_one"]);
  });

  it("chunks > 500 URLs into multiple projects", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount += 1;
      return new Response(JSON.stringify({ projectId: `proj_${callCount}` }), { status: 200 });
    });
    const urls = Array.from({ length: 1200 }, (_, i) => `https://acme.com/p${i}`);
    const r = await pingPrimeIndexer("k", urls, "Acme");
    expect(r.submitted).toBe(3); // 500 + 500 + 200
    expect(r.ok).toBe(3);
    expect(r.projectIds).toEqual(["proj_1", "proj_2", "proj_3"]);
  });

  it("names chunks `name (n/total)` when chunked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ projectId: "x" }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const urls = Array.from({ length: 750 }, (_, i) => `https://acme.com/p${i}`);
    await pingPrimeIndexer("k", urls, "Site");
    const body0 = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    const body1 = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body0.name).toBe("Site (1/2)");
    expect(body1.name).toBe("Site (2/2)");
  });

  it("does NOT chunk-suffix the project name when only one chunk", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ projectId: "x" }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await pingPrimeIndexer("k", ["https://acme.com/a"], "Site");
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.name).toBe("Site");
  });
});
