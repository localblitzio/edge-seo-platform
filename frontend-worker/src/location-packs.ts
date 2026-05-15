/**
 * Pre-baked DataForSEO location strings for our primary metros.
 *
 * Used by the Maps scrape form (one-click "Use this metro" buttons)
 * so operators don't have to retype + look up the canonical
 * `City,Region,Country` format every scrape. DataForSEO's geocoder
 * needs the full state + country names; abbreviations like "CA" or
 * "US" silently return 0 rows.
 *
 * Adding a third metro is intentionally just appending to this array
 * — no DB, no migration. Pull in a CRUD UI when we have ≥ 5 packs.
 */

export interface LocationPack {
  /** Stable id used by the UI hooks. */
  id: string;
  /** Operator-facing label shown on the button. */
  label: string;
  /** Each line is one DataForSEO `location_name` argument. */
  locations: readonly string[];
}

const SAN_DIEGO_COUNTY: readonly string[] = [
  "San Diego,California,United States",
  "Chula Vista,California,United States",
  "Oceanside,California,United States",
  "Escondido,California,United States",
  "Carlsbad,California,United States",
  "El Cajon,California,United States",
  "Vista,California,United States",
  "San Marcos,California,United States",
  "Encinitas,California,United States",
  "National City,California,United States",
  "La Mesa,California,United States",
  "Santee,California,United States",
  "Poway,California,United States",
  "Imperial Beach,California,United States",
  "Lemon Grove,California,United States",
  "Coronado,California,United States",
  "Solana Beach,California,United States",
  "Del Mar,California,United States",
  "La Jolla,California,United States",
  "Rancho Bernardo,California,United States",
];

const INDIANAPOLIS_METRO: readonly string[] = [
  "Indianapolis,Indiana,United States",
  "Carmel,Indiana,United States",
  "Fishers,Indiana,United States",
  "Noblesville,Indiana,United States",
  "Greenwood,Indiana,United States",
  "Lawrence,Indiana,United States",
  "Beech Grove,Indiana,United States",
  "Speedway,Indiana,United States",
  "Westfield,Indiana,United States",
  "Plainfield,Indiana,United States",
  "Avon,Indiana,United States",
  "Brownsburg,Indiana,United States",
  "Zionsville,Indiana,United States",
  "Franklin,Indiana,United States",
  "Mooresville,Indiana,United States",
  "McCordsville,Indiana,United States",
  "Whiteland,Indiana,United States",
  "Cumberland,Indiana,United States",
  "Pittsboro,Indiana,United States",
  "Bargersville,Indiana,United States",
];

export const LOCATION_PACKS: readonly LocationPack[] = [
  { id: "san-diego-county", label: "San Diego County (20)", locations: SAN_DIEGO_COUNTY },
  { id: "indianapolis-metro", label: "Indianapolis metro (20)", locations: INDIANAPOLIS_METRO },
];

/**
 * Look up a pack by id. Returns null when unknown — caller can show a
 * "pack not found" message but realistically the buttons in the form
 * always pass a known id.
 */
export function getLocationPack(id: string): LocationPack | null {
  return LOCATION_PACKS.find((p) => p.id === id) ?? null;
}
