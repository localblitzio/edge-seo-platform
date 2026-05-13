/**
 * Active-integration registry for indexer services.
 *
 * Each entry pairs a secret-slot key (`SecretSlot.key` from
 * `slots.ts`) with a live submit function. Adding a new indexer is:
 *   1. Add slot to `slots.ts`
 *   2. Add submit module under `src/sitemap/<service>.ts`
 *   3. Add an entry here
 *
 * The Indexing admin page filters this registry by which keys are
 * currently bound — operators only see submit buttons for indexers
 * they've actually configured.
 *
 * Slots that exist in `slots.ts` but NOT here are "future"
 * integrations — keys can be pasted but no submit happens. That's
 * intentional: keeps the secret store ready for a service before its
 * client code lands.
 */

import { pingIndexNow } from "../sitemap/indexnow.js";
import { pingOmegaIndexer } from "../sitemap/omega-indexer.js";
import { pingPrimeIndexer } from "../sitemap/prime-indexer.js";
import { pingSinbyte } from "../sitemap/sinbyte.js";

/**
 * Result of a submission. `submitted` is the count of API calls
 * (chunks); `ok` and `failed` count successes/failures across them.
 * `message` is a short human-readable summary the UI surfaces in a
 * flash banner.
 */
export interface IndexerSubmitResult {
  ok: boolean;
  submitted: number;
  successes: number;
  failures: number;
  message: string;
}

/**
 * Per-indexer ping function. Takes the secret value, the URL list,
 * and a context object with whatever the indexer needs (currently
 * just `proxyDomain` — IndexNow uses it as the `host` field, Prime
 * uses it in the project name).
 */
export type IndexerPing = (
  key: string,
  urls: readonly string[],
  context: { proxyDomain: string },
) => Promise<IndexerSubmitResult>;

export interface IndexerEntry {
  /** The secret slot key (must exist in slots.ts). */
  slotKey: string;
  /** Short label for the UI button ("Submit to IndexNow"). */
  label: string;
  /**
   * Brand-ish background colour for the per-indexer Submit button on
   * the Indexing page. Each integration gets a distinct hue so
   * operators can tell at a glance which service a button targets.
   * Use a colour with WCAG-AA contrast against white text (#fff).
   */
  color: string;
  /** Live submit. */
  submit: IndexerPing;
}

export const ACTIVE_INDEXERS: readonly IndexerEntry[] = [
  {
    slotKey: "INDEXNOW_KEY",
    label: "IndexNow",
    color: "#2563eb", // blue — Microsoft/Bing-ish
    submit: async (key, urls, ctx) => {
      const r = await pingIndexNow(ctx.proxyDomain, key, urls);
      return {
        ok: r.failed === 0 && r.ok > 0,
        submitted: r.submitted,
        successes: r.ok,
        failures: r.failed,
        message:
          r.failed === 0
            ? `IndexNow: pinged ${urls.length} URL${urls.length === 1 ? "" : "s"} across ${r.ok} submission${r.ok === 1 ? "" : "s"}.`
            : `IndexNow: ${r.failed}/${r.submitted} submission${r.submitted === 1 ? "" : "s"} failed.`,
      };
    },
  },
  {
    slotKey: "PRIME_INDEXER_KEY",
    label: "Prime Indexer",
    color: "#ea580c", // orange — distinct from the blue accent
    submit: async (key, urls, ctx) => {
      const projectName = `${ctx.proxyDomain} ${new Date().toISOString()}`;
      const r = await pingPrimeIndexer(key, urls, projectName);
      return {
        ok: r.failed === 0 && r.ok > 0,
        submitted: r.submitted,
        successes: r.ok,
        failures: r.failed,
        message:
          r.failed === 0
            ? `Prime Indexer: created ${r.ok} project${r.ok === 1 ? "" : "s"} with ${urls.length} URL${urls.length === 1 ? "" : "s"} (project ids: ${r.projectIds.join(", ") || "?"}).`
            : `Prime Indexer: ${r.failed}/${r.submitted} project${r.submitted === 1 ? "" : "s"} failed to submit.`,
      };
    },
  },
  {
    slotKey: "SINBYTE_API_KEY",
    label: "Sinbyte",
    color: "#0d9488", // teal
    submit: async (key, urls, ctx) => {
      const batchName = `${ctx.proxyDomain} ${new Date().toISOString()}`;
      const r = await pingSinbyte(key, urls, batchName);
      return {
        ok: r.failed === 0 && r.ok > 0,
        submitted: r.submitted,
        successes: r.ok,
        failures: r.failed,
        message:
          r.failed === 0
            ? `Sinbyte: submitted ${r.ok} batch${r.ok === 1 ? "" : "es"} with ${urls.length} URL${urls.length === 1 ? "" : "s"} (method=tools, dripfeed enabled).`
            : `Sinbyte: ${r.failed}/${r.submitted} batch${r.submitted === 1 ? "" : "es"} failed to submit.`,
      };
    },
  },
  {
    slotKey: "OMEGA_INDEXER_KEY",
    label: "Omega Indexer",
    color: "#7c3aed", // purple
    submit: async (key, urls, ctx) => {
      const campaignName = `${ctx.proxyDomain} ${new Date().toISOString()}`;
      const r = await pingOmegaIndexer(key, urls, campaignName);
      return {
        ok: r.failed === 0 && r.ok > 0,
        submitted: r.submitted,
        successes: r.ok,
        failures: r.failed,
        message:
          r.failed === 0
            ? `Omega Indexer: submitted ${r.ok} campaign${r.ok === 1 ? "" : "s"} with ${urls.length} URL${urls.length === 1 ? "" : "s"}.`
            : `Omega Indexer: ${r.failed}/${r.submitted} campaign${r.submitted === 1 ? "" : "s"} failed to submit.`,
      };
    },
  },
];

/** Look up an indexer entry by slot key. Returns undefined when not registered. */
export function findIndexer(slotKey: string): IndexerEntry | undefined {
  return ACTIVE_INDEXERS.find((i) => i.slotKey === slotKey);
}

/** Per-indexer outcome — pairs the registry entry with the submit result. */
export interface ConfiguredIndexerResult {
  slotKey: string;
  label: string;
  result: IndexerSubmitResult;
}

/**
 * Fan out a URL list to every active indexer whose secret is bound,
 * in parallel. Returns one result per indexer that ran (skipped
 * indexers with unbound keys). Never throws — each submission is
 * independent and any error is captured in its `result.message`.
 *
 * Used by both the save-time auto-ping (`maybePingIndexers` in
 * app.ts, fire-and-forget — caller ignores results) AND the manual
 * "Reindex now" button on the Indexing page (renders results to the
 * operator).
 */
/**
 * Same as `pingAllConfiguredIndexers` but restricted to a subset of
 * slot keys the caller picked (e.g. operator-selected checkboxes at
 * embed-apply time). Unknown / unbound slot keys are skipped, NOT
 * errors. Use this when "submit to ALL indexers" is too expensive
 * and the operator wants to spend credits selectively.
 *
 * @param selectedSlotKeys subset of `slotKey` values to dispatch to;
 *   anything not in `ACTIVE_INDEXERS` is ignored.
 */
export async function pingSelectedIndexers(
  env: {
    CONFIG_KV: import("@cloudflare/workers-types").KVNamespace;
    CONFIG_DB: import("@cloudflare/workers-types").D1Database;
  },
  urls: readonly string[],
  context: { proxyDomain: string },
  selectedSlotKeys: readonly string[],
): Promise<ConfiguredIndexerResult[]> {
  const allowed = new Set(selectedSlotKeys);
  const { getSecret } = await import("./store.js");
  const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
  const indexers = ACTIVE_INDEXERS.filter((i) => allowed.has(i.slotKey));
  if (indexers.length === 0) return [];
  const keys = await Promise.all(indexers.map((i) => getSecret(sharedEnv, i.slotKey)));
  const tasks: Promise<ConfiguredIndexerResult | null>[] = [];
  for (let i = 0; i < indexers.length; i++) {
    const indexer = indexers[i];
    const key = keys[i];
    if (!indexer || !key) continue;
    tasks.push(
      indexer
        .submit(key, urls, context)
        .then(
          (result): ConfiguredIndexerResult => ({
            slotKey: indexer.slotKey,
            label: indexer.label,
            result,
          }),
        )
        .catch(
          (e): ConfiguredIndexerResult => ({
            slotKey: indexer.slotKey,
            label: indexer.label,
            result: {
              ok: false,
              submitted: 0,
              successes: 0,
              failures: 0,
              message: `${indexer.label}: threw — ${e instanceof Error ? e.message : String(e)}`,
            },
          }),
        ),
    );
  }
  const settled = await Promise.all(tasks);
  return settled.filter((r): r is ConfiguredIndexerResult => r !== null);
}

export async function pingAllConfiguredIndexers(
  env: {
    CONFIG_KV: import("@cloudflare/workers-types").KVNamespace;
    CONFIG_DB: import("@cloudflare/workers-types").D1Database;
  },
  urls: readonly string[],
  context: { proxyDomain: string },
): Promise<ConfiguredIndexerResult[]> {
  // Lazy import to avoid a circular dep with src/secrets/store.ts
  // (the store imports from sitemap modules transitively).
  const { getSecret } = await import("./store.js");
  const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
  const keys = await Promise.all(ACTIVE_INDEXERS.map((i) => getSecret(sharedEnv, i.slotKey)));
  const tasks: Promise<ConfiguredIndexerResult | null>[] = [];
  for (let i = 0; i < ACTIVE_INDEXERS.length; i++) {
    const indexer = ACTIVE_INDEXERS[i];
    const key = keys[i];
    if (!indexer || !key) continue;
    tasks.push(
      indexer
        .submit(key, urls, context)
        .then(
          (result): ConfiguredIndexerResult => ({
            slotKey: indexer.slotKey,
            label: indexer.label,
            result,
          }),
        )
        .catch(
          (e): ConfiguredIndexerResult => ({
            slotKey: indexer.slotKey,
            label: indexer.label,
            result: {
              ok: false,
              submitted: 0,
              successes: 0,
              failures: 0,
              message: `${indexer.label}: threw — ${e instanceof Error ? e.message : String(e)}`,
            },
          }),
        ),
    );
  }
  const settled = await Promise.all(tasks);
  return settled.filter((r): r is ConfiguredIndexerResult => r !== null);
}
