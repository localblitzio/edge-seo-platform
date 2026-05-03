/**
 * Data layer for the local inspector.
 * Reads Miniflare's local persistence directly via node:sqlite — no
 * shell-out to wrangler, no Cloudflare API calls.
 *
 * Layout (Miniflare 3 default at .wrangler/state/v3/):
 *   d1/miniflare-D1DatabaseObject/<hash>.sqlite           — Worker D1
 *   kv/miniflare-KVNamespaceObject/<hash>.sqlite          — KV index
 *   kv/<namespace_id>/blobs/<blob_id>                     — KV value blobs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PATHS = {
  d1Dir: join(PROJECT_ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject"),
  kvIndexDir: join(PROJECT_ROOT, ".wrangler", "state", "v3", "kv", "miniflare-KVNamespaceObject"),
  kvBlobsRoot: join(PROJECT_ROOT, ".wrangler", "state", "v3", "kv"),
};

function findFirstSqlite(dir) {
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite"));
  return file ? join(dir, file) : null;
}

function findKvBlobsDir() {
  if (!existsSync(PATHS.kvBlobsRoot)) return null;
  // The namespace-id directory sits next to `miniflare-KVNamespaceObject/`.
  const candidates = readdirSync(PATHS.kvBlobsRoot).filter(
    (name) => name !== "miniflare-KVNamespaceObject",
  );
  for (const c of candidates) {
    const blobsDir = join(PATHS.kvBlobsRoot, c, "blobs");
    if (existsSync(blobsDir)) return blobsDir;
  }
  return null;
}

/** Whether seed has been applied (D1 sqlite exists). */
export function isSeeded() {
  return findFirstSqlite(PATHS.d1Dir) !== null;
}

/** Read all D1 tables we know about. Safe to call on a missing/empty store. */
export function readD1() {
  const path = findFirstSqlite(PATHS.d1Dir);
  if (!path) return { clients: [], attestations: [], audit_log: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const clients = db.prepare("SELECT * FROM clients ORDER BY client_id").all();
    const attestations = tryAll(
      db,
      "SELECT * FROM attestations ORDER BY id DESC LIMIT 200",
    );
    const audit_log = tryAll(
      db,
      "SELECT * FROM audit_log ORDER BY id DESC LIMIT 200",
    );
    const form_submissions = tryAll(
      db,
      "SELECT * FROM form_submissions ORDER BY id DESC LIMIT 100",
    );
    return { clients, attestations, audit_log, form_submissions };
  } finally {
    db.close();
  }
}

function tryAll(db, sql) {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

/** Parsed config for a single client (or null). */
export function readClient(clientId) {
  const path = findFirstSqlite(PATHS.d1Dir);
  if (!path) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT * FROM clients WHERE client_id = ?")
      .get(clientId);
    if (!row) return null;
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(String(row.config_json));
    } catch (e) {
      parseError = e.message;
    }
    return { ...row, parsed_config: parsed, parse_error: parseError };
  } finally {
    db.close();
  }
}

/** All KV entries with metadata. Values are NOT eagerly read. */
export function listKv() {
  const path = findFirstSqlite(PATHS.kvIndexDir);
  if (!path) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT key, blob_id, expiration, metadata FROM _mf_entries ORDER BY key")
      .all();
    return rows;
  } finally {
    db.close();
  }
}

/** Read a single KV value by key. Returns null on miss. */
export function readKvValue(key) {
  const path = findFirstSqlite(PATHS.kvIndexDir);
  if (!path) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  let blobId;
  try {
    const row = db
      .prepare("SELECT blob_id FROM _mf_entries WHERE key = ?")
      .get(key);
    blobId = row?.blob_id;
  } finally {
    db.close();
  }
  if (!blobId) return null;
  const blobsDir = findKvBlobsDir();
  if (!blobsDir) return null;
  const blobPath = join(blobsDir, String(blobId));
  if (!existsSync(blobPath)) return null;
  return readFileSync(blobPath, "utf8");
}
