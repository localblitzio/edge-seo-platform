/**
 * Server-side ZIP extraction for static-site uploads.
 *
 * fflate's `unzipSync` runs synchronously over a Uint8Array. For the
 * site-bundle sizes we care about (typical landing-page exports are
 * 100KB–5MB), this fits well inside Workers' Bundled CPU 50ms budget.
 * `unzip` (async) exists but is more complex; the sync version is
 * sufficient and easier to reason about.
 *
 * Hard caps below are app-level, not platform limits — they exist to
 * stop accidental or malicious large uploads from exhausting Worker
 * resources before the proxy worker has a chance to refuse.
 */
import { unzipSync } from "fflate";

/**
 * Total compressed bundle ceiling. R2's per-object limit is 5 GB; this
 * is the practical "static site" ceiling (~hundred-page bundle with
 * images).
 */
export const ZIP_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/** Per-entry uncompressed ceiling. Catches a single huge image or video. */
export const ZIP_ENTRY_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Maximum number of entries. Stops zip-bomb shaped uploads (millions
 * of tiny files) from consuming all our R2 PUT budget.
 */
export const ZIP_MAX_ENTRIES = 500;

export interface ExtractedFile {
  /** Path within the zip, normalized: forward slashes, no leading `/`. */
  path: string;
  bytes: Uint8Array;
}

export interface ExtractResult {
  files: ExtractedFile[];
  totalBytes: number;
}

/**
 * Walk the zip and return a flat list of files. Directories are
 * skipped (fflate emits them as zero-byte entries with trailing `/`).
 *
 * Errors thrown:
 *   - "ZIP exceeds N bytes" — bundle too large
 *   - "ZIP exceeds N entries" — too many files
 *   - "ZIP entry exceeds N bytes" — single file too large
 *   - "ZIP entry path traversal" — `..`, leading `/`, or absolute path
 *   - "ZIP entry empty path" — defensive
 */
export function extractZip(input: Uint8Array): ExtractResult {
  if (input.byteLength > ZIP_MAX_BYTES) {
    throw new Error(`ZIP exceeds ${ZIP_MAX_BYTES} bytes (got ${input.byteLength}).`);
  }
  const entries = unzipSync(input);
  const names = Object.keys(entries);
  if (names.length > ZIP_MAX_ENTRIES) {
    throw new Error(`ZIP exceeds ${ZIP_MAX_ENTRIES} entries (got ${names.length}).`);
  }

  const files: ExtractedFile[] = [];
  let totalBytes = 0;
  for (const rawName of names) {
    const bytes = entries[rawName];
    if (!bytes) continue;
    // Directory entries in zip have a trailing `/` and zero bytes.
    if (rawName.endsWith("/") && bytes.byteLength === 0) continue;

    const normalized = normalizeZipPath(rawName);
    if (bytes.byteLength > ZIP_ENTRY_MAX_BYTES) {
      throw new Error(
        `ZIP entry "${normalized}" exceeds ${ZIP_ENTRY_MAX_BYTES} bytes (got ${bytes.byteLength}).`,
      );
    }
    totalBytes += bytes.byteLength;
    files.push({ path: normalized, bytes });
  }
  return { files, totalBytes };
}

/**
 * Normalize a zip-internal path:
 *   - Reject absolute paths and Windows drive prefixes
 *   - Normalize backslashes to forward slashes (Windows-zipped sites)
 *   - Reject any `..` segment or empty path
 *   - Strip a single leading `./`
 *
 * Returns the cleaned path. Throws on rejection.
 */
function normalizeZipPath(raw: string): string {
  const slashed = raw.replace(/\\/g, "/");
  if (!slashed) throw new Error("ZIP entry empty path");
  if (slashed.startsWith("/")) {
    throw new Error(`ZIP entry path traversal: absolute path "${raw}"`);
  }
  if (/^[A-Za-z]:/.test(slashed)) {
    throw new Error(`ZIP entry path traversal: Windows drive path "${raw}"`);
  }
  const stripped = slashed.startsWith("./") ? slashed.slice(2) : slashed;
  const segments = stripped.split("/").filter((s) => s !== "");
  if (segments.length === 0) throw new Error("ZIP entry empty path");
  for (const seg of segments) {
    if (seg === "..") throw new Error(`ZIP entry path traversal: ".." in "${raw}"`);
  }
  return segments.join("/");
}

/**
 * Map a file extension to a Content-Type. Covers the common static-
 * site asset types. Unknown extensions return undefined so the caller
 * can decide between octet-stream and rejection.
 */
export function contentTypeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext];
}

const MIME_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf",
  webm: "video/webm",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  map: "application/json; charset=utf-8",
};
