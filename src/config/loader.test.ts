import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
  KVNamespace,
  KVNamespacePutOptions,
} from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";

import { validLanternCrestConfig } from "../../tests/fixtures/configs/index.js";
import type { Env } from "../env.js";
import { ConfigNotFoundError, ConfigValidationError } from "../lib/errors.js";
import { loadConfig } from "./loader.js";

interface KvCall {
  key: string;
  value: string;
  options?: KVNamespacePutOptions | undefined;
}

interface MockKv {
  binding: KVNamespace;
  store: Map<string, string>;
  puts: KvCall[];
}

function makeKv(initial: Record<string, string> = {}): MockKv {
  const store = new Map<string, string>(Object.entries(initial));
  const puts: KvCall[] = [];
  const binding = {
    get: async (key: string): Promise<string | null> => store.get(key) ?? null,
    put: async (key: string, value: string, options?: KVNamespacePutOptions): Promise<void> => {
      store.set(key, value);
      puts.push({ key, value, options });
    },
    delete: async (key: string): Promise<void> => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { binding, store, puts };
}

interface MockD1 {
  binding: D1Database;
  rows: Array<{ proxy_domain: string; client_id: string; config_json: string }>;
}

function makeD1(rows: MockD1["rows"]): MockD1 {
  const binding = {
    prepare: (_sql: string): D1PreparedStatement => {
      let bound: unknown[] = [];
      const stmt: Partial<D1PreparedStatement> = {
        bind: (...args: unknown[]) => {
          bound = args;
          return stmt as D1PreparedStatement;
        },
        first: async <T>(): Promise<T | null> => {
          const proxyDomain = bound[0];
          const row = rows.find((r) => r.proxy_domain === proxyDomain);
          return (row ?? null) as T | null;
        },
      };
      return stmt as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { binding, rows };
}

function makeCtx(): { ctx: ExecutionContext; settled: Promise<unknown[]> } {
  const promises: Promise<unknown>[] = [];
  let resolveSettled: (v: unknown[]) => void;
  const settled = new Promise<unknown[]>((resolve) => {
    resolveSettled = resolve;
  });
  const ctx = {
    waitUntil: (p: Promise<unknown>): void => {
      promises.push(p);
      // Resolve `settled` once all currently-tracked promises complete.
      Promise.all(promises).then((vals) => resolveSettled(vals));
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, settled };
}

function makeEnv(kv: KVNamespace, db: D1Database): Env {
  return {
    CONFIG_KV: kv,
    CONFIG_DB: db,
  } as unknown as Env;
}

const VALID_JSON = JSON.stringify(validLanternCrestConfig());
const HOST = "lanterncrest.com";
const CLIENT_ID = "lantern-crest";

describe("loadConfig — KV cache hit", () => {
  it("returns the parsed config without touching D1 when both KV keys hit", async () => {
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: VALID_JSON,
    });
    const d1Spy = vi.fn();
    const d1 = {
      prepare: (sql: string) => {
        d1Spy(sql);
        throw new Error("D1 should not be queried on KV hit");
      },
    } as unknown as D1Database;
    const { ctx } = makeCtx();

    const config = await loadConfig(HOST, makeEnv(kv.binding, d1), ctx);

    expect(config.client_id).toBe(CLIENT_ID);
    expect(d1Spy).not.toHaveBeenCalled();
    expect(kv.puts).toHaveLength(0);
  });
});

describe("loadConfig — D1 fallback and write-through", () => {
  it("falls back to D1 when KV is cold, returns config, writes through to KV", async () => {
    const kv = makeKv();
    const d1 = makeD1([{ proxy_domain: HOST, client_id: CLIENT_ID, config_json: VALID_JSON }]);
    const { ctx, settled } = makeCtx();

    const config = await loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx);
    await settled;

    expect(config.client_id).toBe(CLIENT_ID);
    const domainPut = kv.puts.find((p) => p.key === `domain:${HOST}`);
    const configPut = kv.puts.find((p) => p.key === `config:${CLIENT_ID}`);
    if (!domainPut || !configPut) throw new Error("expected write-through");
    expect(domainPut.options?.expirationTtl).toBe(60);
    expect(configPut.options?.expirationTtl).toBe(60);
  });

  it("falls back to D1 when KV-domain hits but KV-config is missing", async () => {
    const kv = makeKv({ [`domain:${HOST}`]: CLIENT_ID });
    const d1 = makeD1([{ proxy_domain: HOST, client_id: CLIENT_ID, config_json: VALID_JSON }]);
    const { ctx, settled } = makeCtx();

    const config = await loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx);
    await settled;

    expect(config.client_id).toBe(CLIENT_ID);
  });
});

describe("loadConfig — failure modes", () => {
  it("throws ConfigNotFoundError when neither KV nor D1 has the host", async () => {
    const kv = makeKv();
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    await expect(
      loadConfig("unknown.example", makeEnv(kv.binding, d1.binding), ctx),
    ).rejects.toThrow(ConfigNotFoundError);
  });

  it("throws ConfigValidationError when the stored config is not valid JSON", async () => {
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: "{not json",
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    await expect(loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx)).rejects.toThrow(
      ConfigValidationError,
    );
  });

  it("throws ConfigValidationError when stored config fails Zod schema", async () => {
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: JSON.stringify({ client_id: "x", schema_version: 1 }),
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    await expect(loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx)).rejects.toThrow(
      ConfigValidationError,
    );
  });

  it("throws ConfigValidationError when stored config fails load-time invariants", async () => {
    const cfg = validLanternCrestConfig() as Record<string, unknown>;
    (cfg.routing as Array<Record<string, unknown>>) = [
      {
        match: "(a+)+$",
        type: "proxy",
        origin: "https://x.example",
        origin_auth: { type: "none" },
      },
    ];
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: JSON.stringify(cfg),
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    await expect(loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx)).rejects.toThrow(
      /nested quantifier/,
    );
  });

  it("does NOT write through to KV when D1 has an invalid config", async () => {
    const kv = makeKv();
    const d1 = makeD1([{ proxy_domain: HOST, client_id: CLIENT_ID, config_json: "{not json" }]);
    const { ctx } = makeCtx();

    await expect(loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx)).rejects.toThrow(
      ConfigValidationError,
    );
    expect(kv.puts).toHaveLength(0);
  });
});

describe("loadConfig — link-project placements merge (Slice 2B)", () => {
  it("appends placement content_injections to the parsed config", async () => {
    const placementsEnvelope = {
      compiled_at: "2026-05-07T00:00:00Z",
      content_injections: [
        {
          match: "^/.*",
          selector: "body",
          position: "append",
          html: '<div data-lp-placement="1"><a href="https://xyz.com">visit</a></div>',
        },
      ],
    };
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: VALID_JSON,
      [`placements:${CLIENT_ID}`]: JSON.stringify(placementsEnvelope),
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    const config = await loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx);
    const operatorRuleCount = JSON.parse(VALID_JSON).content_injections?.length ?? 0;
    expect(config.content_injections).toHaveLength(operatorRuleCount + 1);
    // Placement rule appears AFTER operator rules so HTMLRewriter applies
    // it last (defensive against operator rules that target the same
    // selector and want first-attached precedence).
    expect(config.content_injections[operatorRuleCount]?.selector).toBe("body");
    expect(config.content_injections[operatorRuleCount]?.position).toBe("append");
  });

  it("returns the config unchanged when placements KV is absent", async () => {
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: VALID_JSON,
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    const config = await loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx);
    const operatorRuleCount = JSON.parse(VALID_JSON).content_injections?.length ?? 0;
    expect(config.content_injections).toHaveLength(operatorRuleCount);
  });

  it("skips merge silently when placements JSON is corrupt (defensive)", async () => {
    // A malformed placements entry must not break HTML serving — we'd
    // rather lose the link injection than 500 the request. The admin
    // write path validates before writing so this only happens via
    // direct KV edits.
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: VALID_JSON,
      [`placements:${CLIENT_ID}`]: "{not json",
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    const config = await loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx);
    const operatorRuleCount = JSON.parse(VALID_JSON).content_injections?.length ?? 0;
    expect(config.content_injections).toHaveLength(operatorRuleCount);
  });

  it("filters out malformed placement entries while keeping valid ones", async () => {
    const placementsEnvelope = {
      compiled_at: "2026-05-07T00:00:00Z",
      content_injections: [
        { match: "^/.*", selector: "body", position: "append", html: "<a>good</a>" },
        // Missing required fields — should be skipped.
        { selector: "body", position: "append" },
        { match: 123, selector: "body", position: "append", html: "<a>bad</a>" },
        { match: "^/$", selector: "body", position: "append", html: "<a>also good</a>" },
      ],
    };
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: VALID_JSON,
      [`placements:${CLIENT_ID}`]: JSON.stringify(placementsEnvelope),
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    const config = await loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx);
    const operatorRuleCount = JSON.parse(VALID_JSON).content_injections?.length ?? 0;
    expect(config.content_injections).toHaveLength(operatorRuleCount + 2);
  });

  it("merges placements on the D1 fallback path too (cold KV)", async () => {
    const placementsEnvelope = {
      compiled_at: "2026-05-07T00:00:00Z",
      content_injections: [
        { match: "^/.*", selector: "body", position: "append", html: "<a>via D1</a>" },
      ],
    };
    // Only the placements key is in KV; config + domain come from D1.
    const kv = makeKv({
      [`placements:${CLIENT_ID}`]: JSON.stringify(placementsEnvelope),
    });
    const d1 = makeD1([{ proxy_domain: HOST, client_id: CLIENT_ID, config_json: VALID_JSON }]);
    const { ctx, settled } = makeCtx();

    const config = await loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx);
    await settled;
    const operatorRuleCount = JSON.parse(VALID_JSON).content_injections?.length ?? 0;
    expect(config.content_injections).toHaveLength(operatorRuleCount + 1);
  });
});

describe("loadConfig — cluster_links merge (Slice C: cluster cross-linking)", () => {
  it("appends cluster_links content_injections alongside placements", () => {
    const placementsEnvelope = {
      compiled_at: "2026-05-07T00:00:00Z",
      content_injections: [
        {
          match: "^/.*",
          selector: "body",
          position: "append",
          html: '<a data-test="placement">placement</a>',
        },
      ],
    };
    const clusterLinksEnvelope = {
      compiled_at: "2026-05-07T00:00:00Z",
      content_injections: [
        {
          match: "^/.*",
          selector: "body",
          position: "append",
          html: '<div data-cluster-related="1">cluster</div>',
        },
      ],
    };
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: VALID_JSON,
      [`placements:${CLIENT_ID}`]: JSON.stringify(placementsEnvelope),
      [`cluster_links:${CLIENT_ID}`]: JSON.stringify(clusterLinksEnvelope),
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    return loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx).then((config) => {
      const operatorRuleCount = JSON.parse(VALID_JSON).content_injections?.length ?? 0;
      // Operator rules first, then placement rule, then cluster_links rule.
      expect(config.content_injections).toHaveLength(operatorRuleCount + 2);
      // Last rule is the cluster-link entry (HTMLRewriter applies in
      // attach order — adding cluster-link entries last means they
      // run AFTER placement rules, which is the documented ordering).
      const last = config.content_injections[config.content_injections.length - 1];
      expect(last?.html).toContain("data-cluster-related");
    });
  });

  it("merges cluster_links even when placements is absent", () => {
    const clusterLinksEnvelope = {
      compiled_at: "2026-05-07T00:00:00Z",
      content_injections: [
        {
          match: "^/.*",
          selector: "body",
          position: "append",
          html: '<div data-cluster-related="1">cluster</div>',
        },
      ],
    };
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: VALID_JSON,
      [`cluster_links:${CLIENT_ID}`]: JSON.stringify(clusterLinksEnvelope),
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    return loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx).then((config) => {
      const operatorRuleCount = JSON.parse(VALID_JSON).content_injections?.length ?? 0;
      expect(config.content_injections).toHaveLength(operatorRuleCount + 1);
      const last = config.content_injections[config.content_injections.length - 1];
      expect(last?.html).toContain("data-cluster-related");
    });
  });

  it("returns the config unchanged when both placements + cluster_links are absent", () => {
    const kv = makeKv({
      [`domain:${HOST}`]: CLIENT_ID,
      [`config:${CLIENT_ID}`]: VALID_JSON,
    });
    const d1 = makeD1([]);
    const { ctx } = makeCtx();

    return loadConfig(HOST, makeEnv(kv.binding, d1.binding), ctx).then((config) => {
      const operatorRuleCount = JSON.parse(VALID_JSON).content_injections?.length ?? 0;
      expect(config.content_injections).toHaveLength(operatorRuleCount);
    });
  });
});
