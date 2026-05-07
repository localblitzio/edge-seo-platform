import type {
  D1Database,
  D1PreparedStatement,
  KVNamespace,
  KVNamespacePutOptions,
} from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import {
  type SecretRow,
  deleteSecret,
  getAllSlotValues,
  getSecret,
  listSecretRows,
  maskSecret,
  setSecret,
} from "./store.js";

interface KvCall {
  key: string;
  value: string;
  options?: KVNamespacePutOptions | undefined;
}

function makeKv(initial: Record<string, string> = {}): {
  binding: KVNamespace;
  store: Map<string, string>;
  puts: KvCall[];
  deletes: string[];
} {
  const store = new Map<string, string>(Object.entries(initial));
  const puts: KvCall[] = [];
  const deletes: string[] = [];
  const binding = {
    get: async (key: string): Promise<string | null> => store.get(key) ?? null,
    put: async (key: string, value: string, options?: KVNamespacePutOptions): Promise<void> => {
      store.set(key, value);
      puts.push({ key, value, options });
    },
    delete: async (key: string): Promise<void> => {
      store.delete(key);
      deletes.push(key);
    },
  } as unknown as KVNamespace;
  return { binding, store, puts, deletes };
}

function makeD1(initial: SecretRow[] = []): {
  binding: D1Database;
  rows: SecretRow[];
} {
  const rows: SecretRow[] = [...initial];
  const binding = {
    prepare: (sql: string): D1PreparedStatement => {
      let bound: unknown[] = [];
      const stmt: Partial<D1PreparedStatement> = {
        bind: (...args: unknown[]) => {
          bound = args;
          return stmt as D1PreparedStatement;
        },
        first: async <T>(): Promise<T | null> => {
          if (sql.startsWith("SELECT value FROM secrets WHERE key")) {
            const k = bound[0];
            const row = rows.find((r) => r.key === k);
            return (row ? { value: row.value } : null) as T | null;
          }
          return null;
        },
        run: (async () => {
          if (sql.startsWith("INSERT INTO secrets")) {
            const [k, v, updatedAt, email] = bound as [string, string, number, string];
            const existing = rows.findIndex((r) => r.key === k);
            const next: SecretRow = {
              key: k,
              value: v,
              updated_at: updatedAt,
              updated_by_email: email,
            };
            if (existing >= 0) rows[existing] = next;
            else rows.push(next);
          } else if (sql.startsWith("DELETE FROM secrets")) {
            const k = bound[0];
            const idx = rows.findIndex((r) => r.key === k);
            if (idx >= 0) rows.splice(idx, 1);
          }
          return { success: true, meta: {} };
        }) as D1PreparedStatement["run"],
        all: (async () => {
          if (sql.startsWith("SELECT key, value, updated_at, updated_by_email FROM secrets")) {
            const sorted = [...rows].sort((a, b) => a.key.localeCompare(b.key));
            return { results: sorted, success: true, meta: {} };
          }
          return { results: [], success: true, meta: {} };
        }) as D1PreparedStatement["all"],
      };
      return stmt as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { binding, rows };
}

function makeEnv(kv: KVNamespace, db: D1Database, envFallback: Record<string, string> = {}): Env {
  return {
    CONFIG_KV: kv,
    CONFIG_DB: db,
    ...envFallback,
  } as unknown as Env;
}

describe("getSecret", () => {
  it("returns the value from KV when present", async () => {
    const kv = makeKv({ "secret:INDEXNOW_KEY": "kv-value" });
    const d1 = makeD1();
    const env = makeEnv(kv.binding, d1.binding);
    expect(await getSecret(env, "INDEXNOW_KEY")).toBe("kv-value");
  });

  it("falls back to D1 on KV miss + writes through to KV", async () => {
    const kv = makeKv();
    const d1 = makeD1([
      { key: "INDEXNOW_KEY", value: "d1-value", updated_at: 1, updated_by_email: "a@b.c" },
    ]);
    const env = makeEnv(kv.binding, d1.binding);
    expect(await getSecret(env, "INDEXNOW_KEY")).toBe("d1-value");
    // Write-through: KV now has it.
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]?.key).toBe("secret:INDEXNOW_KEY");
    expect(kv.puts[0]?.value).toBe("d1-value");
    expect(kv.puts[0]?.options?.expirationTtl).toBe(60);
  });

  it("falls back to env (legacy worker secret) on KV+D1 miss", async () => {
    const kv = makeKv();
    const d1 = makeD1();
    const env = makeEnv(kv.binding, d1.binding, { INDEXNOW_KEY: "legacy-value" });
    expect(await getSecret(env, "INDEXNOW_KEY")).toBe("legacy-value");
    // env-fallback path doesn't write through to KV (it's not authoritative).
    expect(kv.puts).toHaveLength(0);
  });

  it("returns null when unset across all tiers", async () => {
    const kv = makeKv();
    const d1 = makeD1();
    const env = makeEnv(kv.binding, d1.binding);
    expect(await getSecret(env, "INDEXNOW_KEY")).toBeNull();
  });

  it("treats empty string env value as unset (avoids returning placeholder bindings)", async () => {
    const kv = makeKv();
    const d1 = makeD1();
    const env = makeEnv(kv.binding, d1.binding, { INDEXNOW_KEY: "" });
    expect(await getSecret(env, "INDEXNOW_KEY")).toBeNull();
  });

  it("KV value beats D1 + env (cache is authoritative within TTL)", async () => {
    const kv = makeKv({ "secret:INDEXNOW_KEY": "kv-value" });
    const d1 = makeD1([
      { key: "INDEXNOW_KEY", value: "d1-value", updated_at: 1, updated_by_email: null },
    ]);
    const env = makeEnv(kv.binding, d1.binding, { INDEXNOW_KEY: "env-value" });
    expect(await getSecret(env, "INDEXNOW_KEY")).toBe("kv-value");
  });

  it("falls back to env when D1 throws (e.g. table missing during migration window)", async () => {
    const kv = makeKv();
    // D1 binding whose `first()` throws — simulates pre-migration error.
    const failingD1 = {
      prepare: (_sql: string): D1PreparedStatement => {
        const stmt: Partial<D1PreparedStatement> = {
          bind: () => stmt as D1PreparedStatement,
          first: async () => {
            throw new Error("no such table: secrets");
          },
        };
        return stmt as D1PreparedStatement;
      },
    } as unknown as D1Database;
    const env = makeEnv(kv.binding, failingD1, { INDEXNOW_KEY: "env-fallback" });
    expect(await getSecret(env, "INDEXNOW_KEY")).toBe("env-fallback");
  });
});

describe("setSecret", () => {
  it("writes to D1 and KV in parallel for a known slot", async () => {
    const kv = makeKv();
    const d1 = makeD1();
    const env = makeEnv(kv.binding, d1.binding);
    const result = await setSecret(env, "INDEXNOW_KEY", "new-value", "admin@example.com");
    expect(result).toEqual({ ok: true });
    expect(d1.rows).toHaveLength(1);
    expect(d1.rows[0]?.key).toBe("INDEXNOW_KEY");
    expect(d1.rows[0]?.value).toBe("new-value");
    expect(d1.rows[0]?.updated_by_email).toBe("admin@example.com");
    expect(kv.store.get("secret:INDEXNOW_KEY")).toBe("new-value");
  });

  it("trims whitespace from the value", async () => {
    const kv = makeKv();
    const d1 = makeD1();
    const env = makeEnv(kv.binding, d1.binding);
    await setSecret(env, "INDEXNOW_KEY", "  trimmed  \n", "admin@example.com");
    expect(d1.rows[0]?.value).toBe("trimmed");
  });

  it("rejects an unknown slot key", async () => {
    const kv = makeKv();
    const d1 = makeD1();
    const env = makeEnv(kv.binding, d1.binding);
    const result = await setSecret(env, "BOGUS_KEY", "value", "admin@example.com");
    expect(result).toEqual({ ok: false, error: "Unknown secret key: BOGUS_KEY" });
    expect(d1.rows).toHaveLength(0);
    expect(kv.store.size).toBe(0);
  });

  it("treats empty/whitespace value as a delete", async () => {
    const kv = makeKv({ "secret:INDEXNOW_KEY": "old" });
    const d1 = makeD1([
      { key: "INDEXNOW_KEY", value: "old", updated_at: 1, updated_by_email: null },
    ]);
    const env = makeEnv(kv.binding, d1.binding);
    const result = await setSecret(env, "INDEXNOW_KEY", "   ", "admin@example.com");
    expect(result).toEqual({ ok: true });
    expect(d1.rows).toHaveLength(0);
    expect(kv.store.has("secret:INDEXNOW_KEY")).toBe(false);
  });

  it("UPSERTs over an existing row", async () => {
    const kv = makeKv();
    const d1 = makeD1([
      { key: "INDEXNOW_KEY", value: "old", updated_at: 1, updated_by_email: "old@x.com" },
    ]);
    const env = makeEnv(kv.binding, d1.binding);
    await setSecret(env, "INDEXNOW_KEY", "new", "new@x.com");
    expect(d1.rows).toHaveLength(1);
    expect(d1.rows[0]?.value).toBe("new");
    expect(d1.rows[0]?.updated_by_email).toBe("new@x.com");
  });
});

describe("deleteSecret", () => {
  it("removes the row and KV cache entry", async () => {
    const kv = makeKv({ "secret:INDEXNOW_KEY": "value" });
    const d1 = makeD1([
      { key: "INDEXNOW_KEY", value: "value", updated_at: 1, updated_by_email: null },
    ]);
    const env = makeEnv(kv.binding, d1.binding);
    await deleteSecret(env, "INDEXNOW_KEY");
    expect(d1.rows).toHaveLength(0);
    expect(kv.store.has("secret:INDEXNOW_KEY")).toBe(false);
    expect(kv.deletes).toContain("secret:INDEXNOW_KEY");
  });

  it("is idempotent (deleting an unset key is a no-op)", async () => {
    const kv = makeKv();
    const d1 = makeD1();
    const env = makeEnv(kv.binding, d1.binding);
    await expect(deleteSecret(env, "INDEXNOW_KEY")).resolves.toBeUndefined();
  });
});

describe("getAllSlotValues", () => {
  it("returns a map of every known slot to its current value", async () => {
    const kv = makeKv({ "secret:INDEXNOW_KEY": "key-value" });
    const d1 = makeD1();
    const env = makeEnv(kv.binding, d1.binding);
    const all = await getAllSlotValues(env);
    expect(all.INDEXNOW_KEY).toBe("key-value");
    expect(all.GSC_SERVICE_ACCOUNT_JSON).toBeNull();
  });
});

describe("listSecretRows", () => {
  it("returns all rows sorted by key", async () => {
    const d1 = makeD1([
      { key: "GSC_SERVICE_ACCOUNT_JSON", value: "{}", updated_at: 2, updated_by_email: "b@x.com" },
      { key: "INDEXNOW_KEY", value: "abc", updated_at: 1, updated_by_email: "a@x.com" },
    ]);
    const kv = makeKv();
    const env = makeEnv(kv.binding, d1.binding);
    const rows = await listSecretRows(env);
    expect(rows.map((r) => r.key)).toEqual(["GSC_SERVICE_ACCOUNT_JSON", "INDEXNOW_KEY"]);
  });
});

describe("maskSecret", () => {
  it("returns (not set) for null/empty", () => {
    expect(maskSecret(null)).toBe("(not set)");
    expect(maskSecret("")).toBe("(not set)");
  });

  it("fully masks values 8 chars or shorter", () => {
    expect(maskSecret("abc")).toBe("•••");
    expect(maskSecret("12345678")).toBe("••••••••");
  });

  it("shows last 4 chars for longer values", () => {
    expect(maskSecret("0123456789ab")).toBe("••••••••89ab");
    expect(maskSecret("supersecretvalue1234")).toBe("••••••••••••••••1234");
  });
});
