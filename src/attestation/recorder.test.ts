import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import { type AttestationRecord, recordAttestation } from "./recorder.js";

interface CapturedExec {
  sql: string;
  bound: unknown[];
}

function makeD1(): { binding: D1Database; calls: CapturedExec[] } {
  const calls: CapturedExec[] = [];
  const binding = {
    prepare(sql: string): D1PreparedStatement {
      let bound: unknown[] = [];
      const stmt: Partial<D1PreparedStatement> = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt as D1PreparedStatement;
        },
        run: (async () => {
          calls.push({ sql, bound });
          return { success: true };
        }) as D1PreparedStatement["run"],
      };
      return stmt as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { binding, calls };
}

const baseRecord: AttestationRecord = {
  client_id: "lantern-crest",
  proxy_domain: "lanterncrest.com",
  source_domain: "blog.lanterncrest.com",
  attested_by_email: "owner@lanterncrest.com",
  attested_at: "2026-01-15T10:00:00Z",
  attested_ip: "203.0.113.42",
  user_agent: "Mozilla/5.0 admin browser",
  scope: "full_site",
  scope_paths: null,
};

describe("recordAttestation", () => {
  it("issues an INSERT against the attestations table", async () => {
    const d1 = makeD1();
    await recordAttestation(baseRecord, { CONFIG_DB: d1.binding } as unknown as Env);
    expect(d1.calls).toHaveLength(1);
    expect(d1.calls[0]?.sql).toMatch(/INSERT INTO attestations/);
  });

  it("binds all 9 columns in the documented order", async () => {
    const d1 = makeD1();
    await recordAttestation(baseRecord, { CONFIG_DB: d1.binding } as unknown as Env);
    expect(d1.calls[0]?.bound).toEqual([
      "lantern-crest",
      "lanterncrest.com",
      "blog.lanterncrest.com",
      "owner@lanterncrest.com",
      "2026-01-15T10:00:00Z",
      "203.0.113.42",
      "Mozilla/5.0 admin browser",
      "full_site",
      null,
    ]);
  });

  it("encodes scope_paths as JSON when provided", async () => {
    const d1 = makeD1();
    await recordAttestation(
      { ...baseRecord, scope: "specified_paths", scope_paths: ["/blog", "/docs"] },
      { CONFIG_DB: d1.binding } as unknown as Env,
    );
    expect(d1.calls[0]?.bound[8]).toBe('["/blog","/docs"]');
  });

  it("propagates D1 write errors (no swallowing)", async () => {
    const failing: D1Database = {
      prepare(_sql: string): D1PreparedStatement {
        const stmt: Partial<D1PreparedStatement> = {
          bind() {
            return stmt as D1PreparedStatement;
          },
          run: (async () => {
            throw new Error("d1 timeout");
          }) as D1PreparedStatement["run"],
        };
        return stmt as D1PreparedStatement;
      },
    } as unknown as D1Database;
    await expect(
      recordAttestation(baseRecord, { CONFIG_DB: failing } as unknown as Env),
    ).rejects.toThrow(/d1 timeout/);
  });
});
