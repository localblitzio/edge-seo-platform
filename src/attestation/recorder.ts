/**
 * Authorization attestation recorder. Spec: docs/tech-spec.md §6.8.
 *
 * Append-only insert into the D1 `attestations` table. Never updates,
 * never deletes — the table is the audit trail backing PRD §6.1's
 * authorization workflow. The admin UI (Phase 2) reads from here.
 */

import type { Env } from "../env.js";

export interface AttestationRecord {
  client_id: string;
  proxy_domain: string;
  source_domain: string;
  attested_by_email: string;
  attested_at: string;
  attested_ip: string;
  user_agent: string;
  scope: "full_site" | "specified_paths";
  scope_paths: string[] | null;
}

const INSERT_SQL = `INSERT INTO attestations
  (client_id, proxy_domain, source_domain, attested_by_email,
   attested_at, attested_ip, user_agent, scope, scope_paths_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Record an attestation. Append-only.
 *
 * `scope_paths` is encoded as JSON in the `scope_paths_json` column
 * to keep the schema simple — the admin UI parses it back.
 *
 * @param record the attestation payload
 * @param env Worker bindings (CONFIG_DB)
 * @returns void
 * @throws on D1 write failure (the caller's error policy decides what
 *   to do; do NOT swallow — a missing attestation is a compliance gap)
 */
export async function recordAttestation(record: AttestationRecord, env: Env): Promise<void> {
  const scopePathsJson = record.scope_paths === null ? null : JSON.stringify(record.scope_paths);
  await env.CONFIG_DB.prepare(INSERT_SQL)
    .bind(
      record.client_id,
      record.proxy_domain,
      record.source_domain,
      record.attested_by_email,
      record.attested_at,
      record.attested_ip,
      record.user_agent,
      record.scope,
      scopePathsJson,
    )
    .run();
}
