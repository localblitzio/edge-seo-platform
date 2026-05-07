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
