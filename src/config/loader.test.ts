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
