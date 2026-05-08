/**
 * Per-site Bot activity page (`/app/clients/:id/bots`).
 *
 * Shows operators which bots are crawling each proxied site, grouped
 * by category (search engines / AI training / AI search / social /
 * monitoring / other). Powered by the `bot_hits` D1 table written
 * fire-and-forget by the proxy worker on every bot-classified
 * request.
 *
 * Data flow:
 *   proxy worker (recordBotHit) → bot_hits D1 table → loadBotHits
 *   → this page renders category summary + per-family table +
 *      24h hourly sparkline
 *
 * Pure read — no state mutations on this page.
 */

import { type BotHitRow, loadBotHits } from "../../src/observability/bot-hits.js";
import type { BotCategory } from "../../src/observability/logger.js";

import type { AppEnv, ClientRow } from "./app.js";
import { canSeeAllClients, esc } from "./app.js";
import type { User } from "./auth.js";

/* ─── Aggregation helpers ─── */

interface CategoryTotal {
  category: BotCategory;
  hits: number;
}

interface FamilyTotal {
  family: string;
  category: BotCategory;
  hits24h: number;
  hits7d: number;
}

const CATEGORY_LABELS: Record<BotCategory, string> = {
  "search-engine": "Search engines",
  "ai-training": "AI training crawlers",
  "ai-search": "AI answer-engines",
  social: "Social link previewers",
  monitoring: "Monitoring",
  "other-bot": "Other bots",
  human: "Human", // never appears in the table but completes the type
};

const CATEGORY_ORDER: BotCategory[] = [
  "search-engine",
  "ai-search",
  "ai-training",
  "social",
  "monitoring",
  "other-bot",
];

/** Hex colours for category badges + sparklines. Match the indexer-button palette where possible. */
const CATEGORY_COLORS: Record<BotCategory, string> = {
  "search-engine": "#2563eb", // blue
  "ai-search": "#7c3aed", // purple
  "ai-training": "#dc2626", // red — distinct from purple, signals training-data usage
  social: "#0d9488", // teal
  monitoring: "#71717a", // grey — operator-installed, low salience
  "other-bot": "#a16207", // amber
  human: "#71717a",
};

/**
 * Bucket hours since a given `now`. Returns a 0-indexed array where
 * index 0 = (now - hoursAgo) and index hoursAgo-1 = now-1. Used to
 * align rows from the D1 query into a fixed-length sparkline.
 */
function bucketSeries(rows: BotHitRow[], hoursAgo: number, now: number): Map<string, number[]> {
  const baseBucket = Math.floor(now / 1000 / 3600) - hoursAgo + 1;
  const series = new Map<string, number[]>();
  for (const row of rows) {
    const offset = row.bucket_hour - baseBucket;
    if (offset < 0 || offset >= hoursAgo) continue;
    const arr = series.get(row.bot_family) ?? new Array<number>(hoursAgo).fill(0);
    arr[offset] = (arr[offset] ?? 0) + row.hits;
    series.set(row.bot_family, arr);
  }
  return series;
}

/** Sum hits per (family, time-window) into a flat list for the table. */
function aggregateFamilies(rows7d: BotHitRow[], now: number): FamilyTotal[] {
  const byFamily = new Map<string, FamilyTotal>();
  const cutoff24h = Math.floor(now / 1000 / 3600) - 24 + 1;
  for (const row of rows7d) {
    const existing = byFamily.get(row.bot_family);
    if (existing) {
      existing.hits7d += row.hits;
      if (row.bucket_hour >= cutoff24h) existing.hits24h += row.hits;
    } else {
      byFamily.set(row.bot_family, {
        family: row.bot_family,
        category: row.bot_category as BotCategory,
        hits24h: row.bucket_hour >= cutoff24h ? row.hits : 0,
        hits7d: row.hits,
      });
    }
  }
  return Array.from(byFamily.values()).sort((a, b) => b.hits7d - a.hits7d);
}

function aggregateCategories(rows: BotHitRow[]): CategoryTotal[] {
  const byCat = new Map<BotCategory, number>();
  for (const row of rows) {
    const cat = row.bot_category as BotCategory;
    byCat.set(cat, (byCat.get(cat) ?? 0) + row.hits);
  }
  return CATEGORY_ORDER.map((category) => ({
    category,
    hits: byCat.get(category) ?? 0,
  }));
}

/* ─── Render ─── */

const BOTS_CSS = `
.bots-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.85rem;margin:1rem 0 1.5rem}
.bots-summary .stat{padding:.85rem 1rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);border-top:3px solid var(--accent)}
.bots-summary .stat .label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-muted);margin:0}
.bots-summary .stat .value{font-size:1.55rem;font-weight:700;margin:.2rem 0 0}
.bots-table{width:100%;border-collapse:collapse;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.bots-table th{background:var(--bg-sidebar,#f4f4f5);text-align:left;font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-muted);padding:.55rem .9rem;border-bottom:1px solid var(--border)}
.bots-table td{padding:.55rem .9rem;border-top:1px solid var(--border);vertical-align:middle}
.bots-table .bot-family{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88rem;font-weight:500}
.bots-table .num{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.cat-badge{display:inline-block;padding:.1rem .5rem;border-radius:9999px;font-size:.7rem;font-weight:600;color:#fff}
.spark{display:flex;align-items:flex-end;gap:1px;height:1.5rem;width:7rem}
.spark .bar{flex:1;min-height:1px;border-radius:1px}
.bots-empty{padding:2.5rem 2rem;text-align:center;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg-muted)}
.bots-empty p{margin:.25rem 0}
`;

function renderSparkline(series: number[], color: string): string {
  const max = Math.max(...series, 1);
  const bars = series
    .map((v) => {
      const pct = Math.max((v / max) * 100, 4);
      const opacity = v === 0 ? 0.18 : 1;
      return `<span class="bar" style="height:${pct}%;background:${color};opacity:${opacity}"></span>`;
    })
    .join("");
  return `<div class="spark" title="Hourly hits over the last 24h (max ${max})">${bars}</div>`;
}

function renderCategoryBadge(cat: BotCategory): string {
  return `<span class="cat-badge" style="background:${CATEGORY_COLORS[cat]}">${esc(CATEGORY_LABELS[cat])}</span>`;
}

export function renderBotActivityPage(opts: {
  client: ClientRow;
  rows7d: BotHitRow[];
  now: number;
}): string {
  const { client, rows7d, now } = opts;
  const cutoff24h = Math.floor(now / 1000 / 3600) - 24 + 1;
  const rows24h = rows7d.filter((r) => r.bucket_hour >= cutoff24h);

  const categoryTotals = aggregateCategories(rows24h);
  const families = aggregateFamilies(rows7d, now);
  const series24h = bucketSeries(rows24h, 24, now);

  const summaryCards = categoryTotals
    .map(
      (c) =>
        `<div class="stat" style="border-top-color:${CATEGORY_COLORS[c.category]}">
          <p class="label">${esc(CATEGORY_LABELS[c.category])}</p>
          <p class="value">${c.hits.toLocaleString()}</p>
        </div>`,
    )
    .join("");

  const tableRows = families.length
    ? families
        .map((f) => {
          const series = series24h.get(f.family) ?? new Array<number>(24).fill(0);
          return `<tr>
            <td><span class="bot-family">${esc(f.family)}</span></td>
            <td>${renderCategoryBadge(f.category)}</td>
            <td class="num">${f.hits24h.toLocaleString()}</td>
            <td class="num">${f.hits7d.toLocaleString()}</td>
            <td>${renderSparkline(series, CATEGORY_COLORS[f.category])}</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="5" style="text-align:center;padding:1.25rem;color:var(--fg-muted)">No bot hits recorded yet for this site.</td></tr>';

  const totals24h = rows24h.reduce((s, r) => s + r.hits, 0);

  const body =
    totals24h === 0 && rows7d.length === 0
      ? `<div class="bots-empty">
        <p><strong>No bot activity yet.</strong></p>
        <p>Bot hits are recorded as crawlers (Googlebot, GPTBot, Bingbot, ClaudeBot, etc.) request pages on this site.</p>
        <p class="small" style="margin-top:.75rem">If you've just deployed, check back after the first crawler visit — Google's first crawl typically takes minutes to hours, AI training crawlers daily/weekly.</p>
      </div>`
      : `<div class="bots-summary">${summaryCards}</div>
      <table class="bots-table">
        <thead>
          <tr>
            <th>Bot family</th>
            <th>Category</th>
            <th class="num">24h hits</th>
            <th class="num">7d hits</th>
            <th>24h sparkline</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <p class="small" style="margin-top:.65rem;color:var(--fg-muted)">Updated continuously. The proxy worker writes one D1 row per (bot family × hour) bucket, fire-and-forget so the user-facing response isn't slowed.</p>`;

  return `<style>${BOTS_CSS}</style>
<header class="page-header" style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">
  <div>
    <h2 style="margin:0">Bot activity — ${esc(client.client_id)}</h2>
    <p class="muted small" style="margin:.25rem 0 0">${esc(client.proxy_domain)}</p>
  </div>
  <a href="/app/clients/${esc(client.client_id)}" class="btn">← Back to site</a>
</header>
${body}`;
}

/* ─── Public entry ─── */

export async function loadBotActivityData(
  env: AppEnv,
  user: User,
  clientId: string,
): Promise<{ client: ClientRow; rows7d: BotHitRow[]; now: number } | null> {
  const sql = canSeeAllClients(user)
    ? "SELECT * FROM clients WHERE client_id = ?"
    : "SELECT * FROM clients WHERE client_id = ? AND owner_id = ?";
  const stmt = canSeeAllClients(user)
    ? env.CONFIG_DB.prepare(sql).bind(clientId)
    : env.CONFIG_DB.prepare(sql).bind(clientId, user.id);
  const client = await stmt.first<ClientRow>();
  if (!client) return null;
  // 7 days = 168 hours.
  const now = Date.now();
  const rows7d = await loadBotHits(
    env.CONFIG_DB as unknown as Parameters<typeof loadBotHits>[0],
    clientId,
    168,
    now,
  );
  return { client, rows7d, now };
}
