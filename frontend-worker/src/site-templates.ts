/**
 * Programmatic SEO — Phase A foundation.
 *
 * Three primitives:
 *   - SiteTemplate   — reusable HTML with `{{placeholders}}` and a
 *                      path pattern. Mustache-flavored: `{{key}}`
 *                      (escaped), `{{{key}}}` (raw HTML), and
 *                      `{{#if key}}...{{/if}}` (conditional).
 *   - SiteDataSource — tabular data fed into the template (CSV
 *                      upload, inline editor, or Phase B scrape).
 *   - GeneratedPage  — one row per rendered page; tracks R2 key +
 *                      content hash for idempotent re-renders.
 *
 * Target modes:
 *   - `pages_in_client` — generated pages append as `custom_page`
 *     routes inside one target client. Good for deep-page coverage
 *     on a single brand.
 *   - `client_per_row`  — each row becomes its own new single-page
 *     client. Good for agency-scale site networks.
 *
 * Render engine is hand-rolled (no Mustache library — Workers
 * dependency bloat). Tiny, predictable, no eval.
 *
 * Phase B (DataForSEO auto-scrape) and Phase C (LLM enrichment) add
 * to this; the data model below is forward-compatible with both.
 */

import type { AppEnv, ClientRow, FlashMessage } from "./app.js";
import { canSeeAllClients, customPageMatch, customPageStorageKey, fnvHash } from "./app.js";
import type { User } from "./auth.js";

/* ─── Constants + types ─── */

export type TemplateKind = "pages_in_client" | "client_per_row";
export const TEMPLATE_KINDS: readonly TemplateKind[] = ["pages_in_client", "client_per_row"];

export type DataSourceKind = "csv" | "inline" | "dataforseo_business_listings" | "dataforseo_serp";
export const DATA_SOURCE_KINDS: readonly DataSourceKind[] = [
  "csv",
  "inline",
  "dataforseo_business_listings",
  "dataforseo_serp",
];

const MAX_NAME_LENGTH = 200;
const MAX_HTML_LENGTH = 200_000; // 200KB plenty for any single page template
const MAX_ROWS_PER_DATA_SOURCE = 500;
const MAX_PATH_PATTERN_LENGTH = 512;

export interface PlaceholderInfo {
  /** Variable name as it appears inside `{{...}}` (without helpers). */
  name: string;
  /** Where this placeholder is used: in HTML body, in path pattern, or both. */
  usage: "body" | "path" | "both";
  /** Set true when reached through `{{{name}}}` (raw HTML allowed). */
  raw: boolean;
}

export type CrossLinkStrategy =
  | "none"
  | "same_category_nearby_cities"
  | "same_city_other_categories";
export const CROSS_LINK_STRATEGIES: readonly CrossLinkStrategy[] = [
  "none",
  "same_category_nearby_cities",
  "same_city_other_categories",
];

export interface SiteTemplateRow {
  id: number;
  owner_id: number;
  name: string;
  kind: TemplateKind;
  html_template: string;
  path_pattern: string;
  /** JSON string holding PlaceholderInfo[] (auto-detected at save time). */
  placeholder_schema: string;
  /** JSON string for Phase C LLM spec, or null. */
  llm_enrichment_spec: string | null;
  /** B.5 cross-linking strategy. `none` disables. */
  cross_link_strategy: CrossLinkStrategy;
  /** B.5 max cross-links per page. 0 disables even when strategy is set. */
  cross_link_count: number;
  created_at: string;
  updated_at: string;
}

export type DataSourceRowsData = Array<Record<string, string>>;

export interface SiteDataSourceRow {
  id: number;
  owner_id: number;
  name: string;
  source_kind: DataSourceKind;
  /** JSON: string[] of column names. */
  columns: string;
  /** JSON: DataSourceRowsData. */
  rows: string;
  /** JSON of scrape params, or null. */
  source_config: string | null;
  llm_enrichment_status: "none" | "pending" | "complete" | "error";
  /** Async scrape state (Phase B.2). `none` for CSV/inline sources. */
  scrape_status: "none" | "running" | "done" | "error";
  scrape_progress_total: number;
  scrape_progress_done: number;
  /** ISO timestamp; null means never written yet. */
  scrape_progress_updated_at: string | null;
  /** JSON `Array<{location, rows_returned, error}>` accumulated as the job runs. */
  scrape_per_location: string;
  scrape_error: string | null;
  /** B.6 reviews scrape state. `none` when no reviews fetch has run. */
  reviews_status: "none" | "running" | "done" | "error";
  reviews_progress_total: number;
  reviews_progress_done: number;
  reviews_progress_updated_at: string | null;
  reviews_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface GeneratedPageRow {
  id: number;
  template_id: number;
  data_source_id: number;
  client_id: string;
  row_index: number;
  generated_path: string;
  content_hash: string;
  r2_key: string;
  llm_cost_usd: number | null;
  created_at: string;
}

/* ─── Template validation + placeholder detection ─── */

export interface TemplateInput {
  name: string;
  kind: TemplateKind;
  html_template: string;
  path_pattern: string;
  cross_link_strategy: CrossLinkStrategy;
  cross_link_count: number;
}

/**
 * Validate the template form. `html_template` must contain at least
 * one `{{placeholder}}` — otherwise the operator is producing N
 * identical pages, which has no programmatic SEO value and would
 * trip our anti-spam guard.
 */
export function validateTemplateInput(
  raw: Record<string, string>,
): { ok: true; value: TemplateInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const name = (raw.name ?? "").trim();
  if (name.length === 0) errors.push("name is required");
  if (name.length > MAX_NAME_LENGTH) errors.push(`name must be ≤ ${MAX_NAME_LENGTH} chars`);

  const kindRaw = (raw.kind ?? "").trim();
  let kind: TemplateKind = "pages_in_client";
  if (!(TEMPLATE_KINDS as readonly string[]).includes(kindRaw)) {
    errors.push(`kind must be one of: ${TEMPLATE_KINDS.join(", ")}`);
  } else {
    kind = kindRaw as TemplateKind;
  }

  const html = (raw.html_template ?? "").trim();
  if (html.length === 0) {
    errors.push("html_template is required");
  } else if (html.length > MAX_HTML_LENGTH) {
    errors.push(`html_template must be ≤ ${MAX_HTML_LENGTH} chars`);
  } else if (extractPlaceholders(html, "body").length === 0) {
    errors.push(
      "html_template must contain at least one {{placeholder}} — without it every rendered page would be identical",
    );
  }

  const pathPattern = (raw.path_pattern ?? "").trim();
  if (pathPattern.length === 0) {
    errors.push("path_pattern is required");
  } else if (pathPattern.length > MAX_PATH_PATTERN_LENGTH) {
    errors.push(`path_pattern must be ≤ ${MAX_PATH_PATTERN_LENGTH} chars`);
  } else if (!pathPattern.startsWith("/")) {
    errors.push("path_pattern must start with /");
  }

  const strategyRaw = (raw.cross_link_strategy ?? "none").trim();
  let cross_link_strategy: CrossLinkStrategy = "none";
  if ((CROSS_LINK_STRATEGIES as readonly string[]).includes(strategyRaw)) {
    cross_link_strategy = strategyRaw as CrossLinkStrategy;
  } else {
    errors.push(`cross_link_strategy must be one of: ${CROSS_LINK_STRATEGIES.join(", ")}`);
  }
  const countRaw = Number.parseInt((raw.cross_link_count ?? "0").trim(), 10);
  const cross_link_count = Number.isFinite(countRaw) ? Math.max(0, Math.min(50, countRaw)) : 0;

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      kind,
      html_template: html,
      path_pattern: pathPattern,
      cross_link_strategy,
      cross_link_count,
    },
  };
}

/**
 * Pull every `{{...}}` (or `{{{...}}}`) reference out of a template
 * string and return a stable list of placeholders. Handles helper
 * calls (`{{slugify city}}`) by extracting the variable name only —
 * helper kind is normalized away.
 *
 * Pure — exercised by unit tests.
 */
export function extractPlaceholders(template: string, usage: "body" | "path"): PlaceholderInfo[] {
  const seen = new Map<string, PlaceholderInfo>();
  // Pattern catches:
  //   {{name}}, {{{name}}}, {{#if name}}, {{slugify name}}, {{lower name}}
  // Excludes `{{/if}}` closers.
  const re =
    /\{\{(?<triple>\{)?\s*(?<directive>[#/])?\s*(?<helperOrName>\w+)(?:\s+(?<arg>\w+))?\s*\}?\}\}/g;
  let m: RegExpExecArray | null = re.exec(template);
  while (m !== null) {
    const directive = m.groups?.directive;
    if (directive === "/") {
      // Closing `{{/if}}` — not a placeholder.
      m = re.exec(template);
      continue;
    }
    const helperOrName = m.groups?.helperOrName ?? "";
    const arg = m.groups?.arg;
    // Variable name: helper call → `arg`; plain reference → `helperOrName`.
    const name = arg ?? helperOrName;
    if (!name || name === "if") {
      m = re.exec(template);
      continue;
    }
    const raw = Boolean(m.groups?.triple);
    const existing = seen.get(name);
    if (existing) {
      // Merge usage if same name shows up in another context.
      if (existing.usage !== usage) existing.usage = "both";
      if (raw) existing.raw = true;
    } else {
      seen.set(name, { name, usage, raw });
    }
    m = re.exec(template);
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Merge body + path placeholder lists into a single schema.
 * Placeholders that appear in both get usage="both".
 */
export function buildPlaceholderSchema(
  htmlTemplate: string,
  pathPattern: string,
): PlaceholderInfo[] {
  const body = extractPlaceholders(htmlTemplate, "body");
  const path = extractPlaceholders(pathPattern, "path");
  const map = new Map<string, PlaceholderInfo>();
  for (const p of body) map.set(p.name, p);
  for (const p of path) {
    const existing = map.get(p.name);
    if (existing) {
      existing.usage = "both";
      if (p.raw) existing.raw = true;
    } else {
      map.set(p.name, p);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/* ─── Render engine ─── */

/** HTML-escape (entity-encode) text. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Slug from arbitrary text: lowercase, replace non-alphanumeric runs
 * with `-`, trim leading/trailing `-`. URL-safe + Google-friendly.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "") // strip combining marks
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const HELPERS: Record<string, (v: string) => string> = {
  slugify,
  lower: (v) => v.toLowerCase(),
  upper: (v) => v.toUpperCase(),
};

/**
 * Render a Mustache-flavored template with a row's data.
 *
 * Syntax:
 *   {{key}}            HTML-escaped substitution
 *   {{{key}}}          Raw substitution (operator opt-in)
 *   {{helper key}}     Apply helper (slugify, lower, upper) — output
 *                      is HTML-escaped after the helper runs.
 *   {{#if key}}...{{/if}}   Conditional: rendered when key is truthy
 *                            (non-empty string).
 *
 * Pure — exercised by unit tests.
 *
 * Missing keys substitute as empty string. No template crash for
 * missing fields; the renderer is permissive so generation doesn't
 * fail when a data-source row has a sparse column.
 */
export function renderTemplate(
  template: string,
  row: Record<string, string>,
  extras: Record<string, ReadonlyArray<Record<string, string>>> = {},
): string {
  // Process `{{#each name}}...{{/each}}` blocks first. The body is
  // re-rendered per item with item fields merged on top of the parent
  // row so an outer `{{city}}` is visible inside the loop.
  let out = template.replace(
    /\{\{#each\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/each\s*\}\}/g,
    (_match, name: string, body: string) => {
      const arr = extras[name];
      if (!arr || arr.length === 0) return "";
      return arr.map((item) => renderTemplate(body, { ...row, ...item }, extras)).join("");
    },
  );

  // Then conditionals: strip whole `{{#if k}}...{{/if}}` blocks.
  out = out.replace(
    /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/if\s*\}\}/g,
    (_match, key: string, body: string) => {
      const v = row[key];
      return v && v.trim().length > 0 ? body : "";
    },
  );

  // Triple-brace raw substitution: {{{key}}}
  out = out.replace(/\{\{\{\s*(\w+)\s*\}\}\}/g, (_match, key: string) => row[key] ?? "");

  // Double-brace with helper: {{helper key}}
  out = out.replace(/\{\{\s*(\w+)\s+(\w+)\s*\}\}/g, (_match, helperName: string, key: string) => {
    const helper = HELPERS[helperName];
    const raw = row[key] ?? "";
    if (!helper) return htmlEscape(raw); // unknown helper → pretend bare reference
    return htmlEscape(helper(raw));
  });

  // Double-brace bare reference: {{key}}
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => htmlEscape(row[key] ?? ""));

  return out;
}

/**
 * Render the path pattern with row data, then slugify the FULL final
 * path (so spaces and special chars in raw substitutions still get
 * cleaned). Ensures leading `/`.
 *
 * Pure — tested.
 */
export function renderPath(pattern: string, row: Record<string, string>): string {
  const raw = renderTemplate(pattern, row);
  // Path-render decodes the HTML-escape since &amp; etc. don't belong
  // in URLs. Then strip pre-existing slashes for re-slugify.
  const decoded = raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Split on `/`, slugify each segment, rejoin — preserves the
  // operator's intentional path structure.
  const segments = decoded
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => slugify(s));
  return `/${segments.join("/")}`;
}

/**
 * Render a single row's full HTML output as it would appear after a
 * real Generate run — including cross_links and the has_* sentinels
 * the templates depend on. Used by the operator preview routes so
 * "what I see in the iframe" matches "what would land in R2" exactly
 * (modulo R2 write side-effects).
 *
 * Pure — tested via integration; no DB / no network. Operators reach
 * it via `/app/templates/:id/preview?ds=X&row=N`.
 */
export function renderRowPreview(
  template: SiteTemplateRow,
  dataSource: SiteDataSourceRow | null,
  rowIndex: number,
): string {
  const rows = dataSource ? safeJsonParse<DataSourceRowsData>(dataSource.rows, []) : [];
  const row = rows[rowIndex] ?? {};
  // For preview we don't know the eventual subdomain — use a placeholder
  // zone matching the staging convention so URLs in cross-links look
  // plausible.
  const previewZone = "preview.localsitestage.us";
  const previewSlug = `preview-t${template.id}-r${rowIndex}`;
  const crossLinks = buildCrossLinks(
    rows,
    row,
    previewSlug,
    template.cross_link_strategy,
    template.cross_link_count,
    template.path_pattern,
    previewZone,
    template.id,
  );
  const rowWithSentinels = {
    ...row,
    has_cross_links: crossLinks.length > 0 ? "1" : "",
    has_reviews: typeof row.reviews_json === "string" && row.reviews_json.length > 2 ? "1" : "",
  };
  return renderTemplate(template.html_template, rowWithSentinels, {
    cross_links: crossLinks,
  });
}

/* ─── Cross-link generator (B.5) ─── */

export interface CrossLink {
  /** Link text (defaults to row.title). */
  title: string;
  /** Relative path on the generated client — same `path_pattern` rendering as the source row. */
  url: string;
  /** Short context line, e.g. "Carlsbad, California". Useful for hovers. */
  context: string;
  /** Index signature — required by `renderTemplate`'s extras type. */
  [key: string]: string;
}

/**
 * Build the cross-link list for one row, based on the chosen strategy.
 * The result is meant to feed `extras.cross_links` when rendering the
 * template — operators reference it via `{{#each cross_links}}...{{/each}}`.
 *
 * Pure — exercised by unit tests. Empty array when:
 *   - strategy is `none`
 *   - count is 0
 *   - the data source has fewer than `count + 1` rows (need at least
 *     one OTHER row to link to)
 */
export function buildCrossLinks(
  allRows: ReadonlyArray<Record<string, string>>,
  currentRow: Record<string, string>,
  currentSlug: string,
  strategy: CrossLinkStrategy,
  count: number,
  pathPattern: string,
  zone: string,
  templateId: number,
): CrossLink[] {
  if (strategy === "none" || count <= 0 || allRows.length < 2) return [];

  const others = allRows
    .map((row, idx) => ({ row, idx }))
    .filter((entry) => {
      // Skip the current row by matching on title + address (best stable key).
      const t = entry.row.title ?? "";
      if (
        t === (currentRow.title ?? "") &&
        (entry.row.address ?? "") === (currentRow.address ?? "") &&
        t.length > 0
      ) {
        return false;
      }
      return true;
    });

  let candidates: typeof others;
  if (strategy === "same_category_nearby_cities") {
    const myCategory = primaryCategory(currentRow.categories);
    candidates = others.filter(
      (entry) =>
        primaryCategory(entry.row.categories) === myCategory && entry.row.city !== currentRow.city,
    );
    candidates = sortByDistance(candidates, currentRow);
  } else {
    // same_city_other_categories
    const myCategory = primaryCategory(currentRow.categories);
    candidates = others.filter(
      (entry) =>
        entry.row.city === currentRow.city && primaryCategory(entry.row.categories) !== myCategory,
    );
    // No distance sort needed — same city.
  }

  // Slot-in fill: if nothing matched, fall back to "any other row" so
  // pages with sparse data still get internal links.
  if (candidates.length === 0) {
    candidates = others;
    candidates = sortByDistance(candidates, currentRow);
  }

  return candidates.slice(0, count).map((entry) => {
    const otherSlug = deriveSlug(entry.row, templateId, entry.idx);
    const renderedPath = renderPath(pathPattern, entry.row);
    void currentSlug; // reserved for future intra-client linking
    return {
      title: entry.row.title || "(untitled)",
      url: `https://${otherSlug}.${zone}${renderedPath}`,
      context: [entry.row.city, entry.row.state].filter((s) => s && s.length > 0).join(", "),
    };
  });
}

function primaryCategory(categories: string | undefined): string {
  return (categories ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
}

function sortByDistance<T extends { row: Record<string, string> }>(
  arr: T[],
  current: Record<string, string>,
): T[] {
  const myLat = Number.parseFloat(current.latitude ?? "");
  const myLng = Number.parseFloat(current.longitude ?? "");
  if (!Number.isFinite(myLat) || !Number.isFinite(myLng)) {
    // No lat/lng → alphabetical by title as a stable fallback.
    return [...arr].sort((a, b) => (a.row.title ?? "").localeCompare(b.row.title ?? ""));
  }
  return [...arr]
    .map((entry) => {
      const lat = Number.parseFloat(entry.row.latitude ?? "");
      const lng = Number.parseFloat(entry.row.longitude ?? "");
      const d =
        Number.isFinite(lat) && Number.isFinite(lng)
          ? haversineKm(myLat, myLng, lat, lng)
          : Number.POSITIVE_INFINITY;
      return { entry, d };
    })
    .sort((a, b) => a.d - b.d)
    .map((x) => x.entry);
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Derive the same client_id slug that `executeGenerateClientPerRow`
 * uses, so cross-link URLs match the actual generated subdomains.
 * Stays in sync with `deriveClientIdFromRow` below.
 */
function deriveSlug(row: Record<string, string>, templateId: number, rowIndex: number): string {
  const firstNonEmpty = Object.values(row).find((v) => v.trim().length > 0) ?? "row";
  const base = slugify(firstNonEmpty).slice(0, 50);
  const suffix = `-t${templateId}-r${rowIndex}`;
  return `${base}${suffix}`.slice(0, 63);
}

/* ─── Pure similarity check (anti-spam guardrail) ─── */

/**
 * Compute character-level Jaccard similarity between two strings via
 * trigram overlap. Returns a number between 0 (totally different)
 * and 1 (identical). Used at render time to warn when generated
 * pages are too similar to each other.
 *
 * Pure — tested. Trigram-based is robust to small word substitutions
 * (a generic "plumbers in Springfield" template will score very
 * high cross-row; rich varied rows score lower).
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const trigrams = (s: string): Set<string> => {
    const out = new Set<string>();
    const t = ` ${s.toLowerCase().replace(/\s+/g, " ")} `;
    for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
    return out;
  };
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersect = 0;
  for (const t of A) if (B.has(t)) intersect++;
  const union = A.size + B.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/* ─── CRUD: templates ─── */

export async function loadVisibleTemplates(env: AppEnv, user: User): Promise<SiteTemplateRow[]> {
  const sql = canSeeAllClients(user)
    ? "SELECT * FROM site_templates ORDER BY name"
    : "SELECT * FROM site_templates WHERE owner_id = ? ORDER BY name";
  const stmt = env.CONFIG_DB.prepare(sql);
  const bound = canSeeAllClients(user) ? stmt : stmt.bind(user.id);
  const r = await bound.all<SiteTemplateRow>();
  return r.results ?? [];
}

export async function loadVisibleTemplate(
  env: AppEnv,
  user: User,
  id: number,
): Promise<SiteTemplateRow | null> {
  const sql = canSeeAllClients(user)
    ? "SELECT * FROM site_templates WHERE id = ?"
    : "SELECT * FROM site_templates WHERE id = ? AND owner_id = ?";
  const stmt = env.CONFIG_DB.prepare(sql);
  const bound = canSeeAllClients(user) ? stmt.bind(id) : stmt.bind(id, user.id);
  return bound.first<SiteTemplateRow>();
}

/* ─── CRUD: data sources ─── */

export async function loadVisibleDataSources(
  env: AppEnv,
  user: User,
): Promise<SiteDataSourceRow[]> {
  const sql = canSeeAllClients(user)
    ? "SELECT * FROM site_data_sources ORDER BY name"
    : "SELECT * FROM site_data_sources WHERE owner_id = ? ORDER BY name";
  const stmt = env.CONFIG_DB.prepare(sql);
  const bound = canSeeAllClients(user) ? stmt : stmt.bind(user.id);
  const r = await bound.all<SiteDataSourceRow>();
  return r.results ?? [];
}

export async function loadVisibleDataSource(
  env: AppEnv,
  user: User,
  id: number,
): Promise<SiteDataSourceRow | null> {
  const sql = canSeeAllClients(user)
    ? "SELECT * FROM site_data_sources WHERE id = ?"
    : "SELECT * FROM site_data_sources WHERE id = ? AND owner_id = ?";
  const stmt = env.CONFIG_DB.prepare(sql);
  const bound = canSeeAllClients(user) ? stmt.bind(id) : stmt.bind(id, user.id);
  return bound.first<SiteDataSourceRow>();
}

/* ─── CSV parser ─── */

/**
 * Minimal CSV parser supporting:
 *   - Double-quoted fields (including embedded commas)
 *   - Doubled `""` to escape a literal quote inside a quoted field
 *   - CRLF and LF line endings
 *   - First row treated as header
 *
 * Returns `{ columns, rows }` where `rows` is an array of objects
 * keyed by header column. Empty cells become empty strings.
 *
 * Pure — exercised by unit tests.
 */
export function parseCsv(csv: string): { columns: string[]; rows: DataSourceRowsData } {
  const lines = parseCsvLines(csv);
  if (lines.length === 0) return { columns: [], rows: [] };
  const firstLine = lines[0] ?? [];
  const columns = firstLine.map((c) => c.trim()).filter((c) => c.length > 0);
  const rows: DataSourceRowsData = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i] ?? [];
    if (cells.length === 0 || (cells.length === 1 && cells[0] === "")) continue;
    const row: Record<string, string> = {};
    for (let c = 0; c < columns.length; c++) {
      const colName = columns[c];
      if (!colName) continue;
      row[colName] = (cells[c] ?? "").trim();
    }
    rows.push(row);
  }
  return { columns, rows };
}

function parseCsvLines(csv: string): string[][] {
  const out: string[][] = [];
  let line: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i++; // skip the doubled quote
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      line.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      // End of line; if \r\n, skip the \n on next iter
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      line.push(cell);
      out.push(line);
      line = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  // Trailing cell / line (file didn't end with newline)
  if (cell.length > 0 || line.length > 0) {
    line.push(cell);
    out.push(line);
  }
  return out;
}

/* ─── Render pipeline (template × data → R2 + config_json) ─── */

export interface RenderTarget {
  /** Mode: append pages to existing client OR create new clients per row. */
  mode: TemplateKind;
  /** When mode=pages_in_client: the client to append pages to. */
  client_id?: string;
  /** When mode=client_per_row: the zone to host new clients under. */
  zone?: string;
}

export interface GenerateResult {
  row_index: number;
  client_id: string;
  generated_path: string;
  status: "created" | "updated" | "unchanged" | "skipped" | "error";
  message?: string;
  /** Similarity to the highest-similar previously-rendered row in this batch. */
  max_similarity?: number;
}

/**
 * Plan rendered output WITHOUT executing it. Used by the preview
 * page so the operator can sanity-check before committing R2 writes.
 *
 * Returns per-row generated paths + the first 1000 chars of each
 * rendered HTML for the operator to eyeball. Also returns the
 * worst-case trigram similarity between any two rendered pages, for
 * an anti-spam warning.
 */
export interface RenderPlan {
  rows: Array<{
    row_index: number;
    generated_path: string;
    html_preview: string;
    html_full_length: number;
  }>;
  max_similarity: number;
  /** True when similarity > 0.7 — UI shows a warning. */
  similarity_warn: boolean;
}

export function planRender(template: SiteTemplateRow, dataSource: SiteDataSourceRow): RenderPlan {
  const rows = safeJsonParse<DataSourceRowsData>(dataSource.rows, []);
  const renderedHtml: string[] = [];
  const out: RenderPlan["rows"] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const html = renderTemplate(template.html_template, row);
    const path = renderPath(template.path_pattern, row);
    renderedHtml.push(html);
    out.push({
      row_index: i,
      generated_path: path,
      html_preview: html.slice(0, 1000),
      html_full_length: html.length,
    });
  }
  // Worst-case pairwise similarity (O(N²) — fine for ≤500 rows).
  let max = 0;
  for (let i = 0; i < renderedHtml.length; i++) {
    for (let j = i + 1; j < renderedHtml.length; j++) {
      const a = renderedHtml[i];
      const b = renderedHtml[j];
      if (a === undefined || b === undefined) continue;
      const s = trigramSimilarity(a, b);
      if (s > max) max = s;
    }
  }
  return { rows: out, max_similarity: max, similarity_warn: max > 0.7 };
}

/**
 * Execute the render plan against a target.
 *
 * For `pages_in_client` mode:
 *   - Loads the target client's config_json
 *   - For each row: render HTML + path → write to R2 → append/replace
 *     a `custom_page` route in the client's routing array (idempotent
 *     by exact path-anchor regex match)
 *   - Saves the mutated config_json + primes KV
 *   - Records each rendered page in `generated_pages` for re-render
 *     bookkeeping
 *
 * For `client_per_row` mode:
 *   - For each row: create a new client row (or upsert an existing
 *     one based on a deterministic client_id derived from the row),
 *     each with a single `custom_page` route at `/`
 *   - R2 write + audit per client
 *
 * Returns one GenerateResult per row.
 *
 * Phase A v1: synchronous, single batch. Future phases may make this
 * a background job for very large data sources.
 */
export async function executeGenerate(
  env: AppEnv,
  user: User,
  template: SiteTemplateRow,
  dataSource: SiteDataSourceRow,
  target: RenderTarget,
): Promise<GenerateResult[]> {
  const rows = safeJsonParse<DataSourceRowsData>(dataSource.rows, []);
  if (rows.length === 0) return [];
  if (rows.length > MAX_ROWS_PER_DATA_SOURCE) {
    return [
      {
        row_index: 0,
        client_id: target.client_id ?? "",
        generated_path: "",
        status: "error",
        message: `Data source has ${rows.length} rows; hard cap is ${MAX_ROWS_PER_DATA_SOURCE}. Split into multiple sources.`,
      },
    ];
  }
  if (!env.CONTENT_R2) {
    return [
      {
        row_index: 0,
        client_id: target.client_id ?? "",
        generated_path: "",
        status: "error",
        message: "CONTENT_R2 binding not configured",
      },
    ];
  }
  if (target.mode === "pages_in_client") {
    return executeGeneratePagesInClient(
      env as AppEnv & { CONTENT_R2: R2Bucket },
      user,
      template,
      dataSource,
      rows,
      target,
    );
  }
  return executeGenerateClientPerRow(
    env as AppEnv & { CONTENT_R2: R2Bucket },
    user,
    template,
    dataSource,
    rows,
    target,
  );
}

async function executeGeneratePagesInClient(
  env: AppEnv & { CONTENT_R2: R2Bucket },
  user: User,
  template: SiteTemplateRow,
  dataSource: SiteDataSourceRow,
  rows: DataSourceRowsData,
  target: RenderTarget,
): Promise<GenerateResult[]> {
  if (!target.client_id) {
    return [
      {
        row_index: 0,
        client_id: "",
        generated_path: "",
        status: "error",
        message: "pages_in_client mode requires target.client_id",
      },
    ];
  }
  // Load target client
  const client = await env.CONFIG_DB.prepare("SELECT * FROM clients WHERE client_id = ?")
    .bind(target.client_id)
    .first<ClientRow>();
  if (!client) {
    return [
      {
        row_index: 0,
        client_id: target.client_id,
        generated_path: "",
        status: "error",
        message: `Target client ${target.client_id} not found`,
      },
    ];
  }
  let configObj: Record<string, unknown>;
  try {
    configObj = JSON.parse(client.config_json);
  } catch (e) {
    return [
      {
        row_index: 0,
        client_id: target.client_id,
        generated_path: "",
        status: "error",
        message: `Bad config_json: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
  const routing = Array.isArray(configObj.routing)
    ? (configObj.routing as Array<Record<string, unknown>>)
    : [];

  const results: GenerateResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const html = renderTemplate(template.html_template, row);
    const path = renderPath(template.path_pattern, row);
    if (path === "/") {
      results.push({
        row_index: i,
        client_id: target.client_id,
        generated_path: path,
        status: "skipped",
        message: "Refusing to overwrite client root (`/`) — pick a different path pattern",
      });
      continue;
    }
    const r2Key = customPageStorageKey(target.client_id, path);
    const contentHash = fnvHash(html);

    // Has this been rendered before for the same (template, ds, row, client)?
    const prior = await env.CONFIG_DB.prepare(
      `SELECT * FROM generated_pages
       WHERE template_id = ? AND data_source_id = ? AND row_index = ? AND client_id = ?`,
    )
      .bind(template.id, dataSource.id, i, target.client_id)
      .first<GeneratedPageRow>();

    let status: GenerateResult["status"] = "created";
    if (prior && prior.content_hash === contentHash) {
      status = "unchanged";
    } else {
      // Write to R2
      try {
        await env.CONTENT_R2.put(r2Key, html, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
          customMetadata: {
            uploaded_by: user.email,
            uploaded_at: new Date().toISOString(),
            template_id: String(template.id),
            data_source_id: String(dataSource.id),
            row_index: String(i),
          },
        });
      } catch (e) {
        results.push({
          row_index: i,
          client_id: target.client_id,
          generated_path: path,
          status: "error",
          message: `R2 write failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      status = prior ? "updated" : "created";

      // Upsert custom_page route
      const matchRegex = customPageMatch(path);
      const existingIdx = routing.findIndex(
        (r) => typeof r.match === "string" && r.match === matchRegex,
      );
      const route = {
        match: matchRegex,
        type: "custom_page",
        custom_page_key: target.client_id,
        origin_auth: { type: "none" },
      };
      if (existingIdx >= 0) {
        routing[existingIdx] = route;
      } else {
        // Prepend so custom routes precede any wildcard proxy.
        routing.unshift(route);
      }

      // Upsert generated_pages row
      if (prior) {
        await env.CONFIG_DB.prepare(
          `UPDATE generated_pages
             SET content_hash = ?, r2_key = ?, generated_path = ?
           WHERE id = ?`,
        )
          .bind(contentHash, r2Key, path, prior.id)
          .run();
      } else {
        await env.CONFIG_DB.prepare(
          `INSERT INTO generated_pages
             (template_id, data_source_id, client_id, row_index, generated_path, content_hash, r2_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(template.id, dataSource.id, target.client_id, i, path, contentHash, r2Key)
          .run();
      }
    }

    results.push({
      row_index: i,
      client_id: target.client_id,
      generated_path: path,
      status,
    });
  }

  // Save mutated config_json + prime KV (once per client, not per row).
  configObj.routing = routing;
  const newJson = JSON.stringify(configObj);
  try {
    await env.CONFIG_DB.prepare(
      "UPDATE clients SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ?",
    )
      .bind(newJson, target.client_id)
      .run();
    await env.CONFIG_KV.put(`config:${target.client_id}`, newJson);
  } catch (e) {
    results.push({
      row_index: -1,
      client_id: target.client_id,
      generated_path: "",
      status: "error",
      message: `Config save failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return results;
}

async function executeGenerateClientPerRow(
  env: AppEnv & { CONTENT_R2: R2Bucket },
  user: User,
  template: SiteTemplateRow,
  dataSource: SiteDataSourceRow,
  rows: DataSourceRowsData,
  target: RenderTarget,
): Promise<GenerateResult[]> {
  if (!target.zone) {
    return [
      {
        row_index: 0,
        client_id: "",
        generated_path: "",
        status: "error",
        message: "client_per_row mode requires target.zone",
      },
    ];
  }
  const results: GenerateResult[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    // Deterministic client_id: slug of first non-empty cell in the row
    // — gives stable IDs across re-renders. Operator can rename later.
    const slug = deriveClientIdFromRow(row, template, i);
    const proxyDomain = `${slug}.${target.zone}`;

    const crossLinks = buildCrossLinks(
      rows,
      row,
      slug,
      template.cross_link_strategy,
      template.cross_link_count,
      template.path_pattern,
      target.zone ?? "",
      template.id,
    );
    // `has_cross_links` sentinel lets templates conditionally render
    // the cross-link card with `{{#if has_cross_links}}...{{/if}}`.
    const rowWithSentinels = {
      ...row,
      has_cross_links: crossLinks.length > 0 ? "1" : "",
    };
    const html = renderTemplate(template.html_template, rowWithSentinels, {
      cross_links: crossLinks,
    });
    const path = renderPath(template.path_pattern, row);
    const r2Key = customPageStorageKey(slug, path);
    const contentHash = fnvHash(html);

    // Check if this generated_page already exists
    const prior = await env.CONFIG_DB.prepare(
      `SELECT * FROM generated_pages
       WHERE template_id = ? AND data_source_id = ? AND row_index = ? AND client_id = ?`,
    )
      .bind(template.id, dataSource.id, i, slug)
      .first<GeneratedPageRow>();

    if (prior && prior.content_hash === contentHash) {
      results.push({
        row_index: i,
        client_id: slug,
        generated_path: path,
        status: "unchanged",
      });
      continue;
    }

    // Write R2
    try {
      await env.CONTENT_R2.put(r2Key, html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          uploaded_by: user.email,
          uploaded_at: new Date().toISOString(),
          template_id: String(template.id),
          data_source_id: String(dataSource.id),
          row_index: String(i),
        },
      });
    } catch (e) {
      results.push({
        row_index: i,
        client_id: slug,
        generated_path: path,
        status: "error",
        message: `R2 write failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    // Upsert client row (or update its config)
    const existing = await env.CONFIG_DB.prepare("SELECT * FROM clients WHERE client_id = ?")
      .bind(slug)
      .first<ClientRow>();
    if (existing) {
      // Just update its config_json + KV
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(existing.config_json);
      } catch {
        cfg = {};
      }
      const routing = Array.isArray(cfg.routing)
        ? (cfg.routing as Array<Record<string, unknown>>)
        : [];
      const matchRegex = customPageMatch(path);
      const idx = routing.findIndex((r) => typeof r.match === "string" && r.match === matchRegex);
      const route = {
        match: matchRegex,
        type: "custom_page",
        custom_page_key: slug,
        origin_auth: { type: "none" },
      };
      if (idx >= 0) routing[idx] = route;
      else routing.unshift(route);
      cfg.routing = routing;
      const newJson = JSON.stringify(cfg);
      await env.CONFIG_DB.prepare(
        "UPDATE clients SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ?",
      )
        .bind(newJson, slug)
        .run();
      await env.CONFIG_KV.put(`config:${slug}`, newJson);
    } else {
      // Create fresh client row with a single custom_page route.
      const config = {
        client_id: slug,
        proxy_domain: proxyDomain,
        source_domain: proxyDomain,
        mode: "subdomain_proxy",
        authorization: {
          attested_by_email: user.email,
          attested_at: new Date().toISOString(),
          attested_ip: "0.0.0.0",
          scope: "full_site",
          expires_at: null,
        },
        status: "active",
        routing: [
          {
            match: customPageMatch(path),
            type: "custom_page",
            custom_page_key: slug,
            origin_auth: { type: "none" },
          },
        ],
        redirects: { static: [], patterns: [], conditional: [] },
        canonicals: [
          {
            match: "^/.*",
            strategy: { type: "self" },
            sync_og_url: true,
            sync_twitter_url: true,
            sync_jsonld_url: true,
          },
        ],
        schema_injections: [],
        link_rewrites: [],
        element_removals: [],
        content_injections: [],
        text_rewrites: [],
        meta_rewrites: [],
        indexation: [{ match: "^/.*", robots: "index,follow", additional_directives: [] }],
        caching: [
          { match: "^/.*", ttl_seconds: 600, cache_key_includes_cookies: [], bypass_on_cookie: [] },
        ],
        forms: [],
        seed_paths: [path],
        ingest_upstream_sitemap: false,
        schema_version: 1,
      };
      const newJson = JSON.stringify(config);
      try {
        await env.CONFIG_DB.prepare(
          `INSERT INTO clients (client_id, proxy_domain, source_domain, status, config_json, schema_version, owner_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(slug, proxyDomain, proxyDomain, "active", newJson, 1, user.id)
          .run();
        await env.CONFIG_KV.put(`config:${slug}`, newJson);
        await env.CONFIG_KV.put(`domain:${proxyDomain}`, slug);
      } catch (e) {
        results.push({
          row_index: i,
          client_id: slug,
          generated_path: path,
          status: "error",
          message: `Client create failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
    }

    // Upsert generated_pages row
    if (prior) {
      await env.CONFIG_DB.prepare(
        `UPDATE generated_pages
           SET content_hash = ?, r2_key = ?, generated_path = ?
         WHERE id = ?`,
      )
        .bind(contentHash, r2Key, path, prior.id)
        .run();
    } else {
      await env.CONFIG_DB.prepare(
        `INSERT INTO generated_pages
           (template_id, data_source_id, client_id, row_index, generated_path, content_hash, r2_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(template.id, dataSource.id, slug, i, path, contentHash, r2Key)
        .run();
    }

    results.push({
      row_index: i,
      client_id: slug,
      generated_path: path,
      status: existing ? "updated" : "created",
    });
  }
  return results;
}

/**
 * Derive a DNS-safe client_id from a row. Strategy:
 *   - Pick the first non-empty cell value
 *   - Append the row index for uniqueness within the data source
 *   - slugify + truncate to RFC 1035 label limit (63 chars)
 *
 * Stable across re-renders for the same (template, data_source, row_index).
 */
function deriveClientIdFromRow(
  row: Record<string, string>,
  template: SiteTemplateRow,
  rowIndex: number,
): string {
  const firstNonEmpty = Object.values(row).find((v) => v.trim().length > 0) ?? "row";
  const base = slugify(firstNonEmpty).slice(0, 50);
  const suffix = `-t${template.id}-r${rowIndex}`;
  return `${base}${suffix}`.slice(0, 63);
}

function safeJsonParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/* ─── CSRF + flash helpers (used by route handlers in another module) ─── */

export function checkCsrf(request: Request, url: URL): Response | null {
  const expected = `${url.protocol}//${url.host}`;
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === expected ? null : new Response("CSRF: Origin mismatch", { status: 403 });
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const ref = new URL(referer);
      return ref.host === url.host && ref.protocol === url.protocol
        ? null
        : new Response("CSRF: Referer mismatch", { status: 403 });
    } catch {
      return new Response("CSRF: invalid Referer", { status: 403 });
    }
  }
  return new Response("CSRF: missing Origin and Referer", { status: 403 });
}

export function flashRedirect(location: string, flash: FlashMessage): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, { status: 303, headers: { location: target } });
}
