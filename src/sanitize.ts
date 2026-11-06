import {
  MONEY_MAX, STAT_MAX, PLAY_SECONDS_MAX, OWNED_MAX, ID_PATTERN, LEVEL_MAX, SLOTS_MAX, FISH_MAX, FISH_WEIGHT_MAX, SPECIES_MAX,
} from "./constants.js";
import type { PlayerDoc, SavedFish } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// Catalog ids (rods, trails, species): slug strings, no duplicates, bounded count.
export function sanitizeIds(raw: unknown, max = OWNED_MAX): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isId))].slice(0, max);
}

// The backpack: { species, weight, earn, mutation, equipped, hotbar } each, at most FISH_MAX. An entry
// without a species id, with a non-number weight / earn or a malformed mutation is dropped.
export function sanitizeFish(raw: unknown): SavedFish[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedFish[] = [];
  for (const f of raw) {
    if (out.length >= FISH_MAX) break;
    if (!isObject(f) || !isId(f.species) || !finite(f.weight) || !finite(f.earn)) continue;
    const mutation = f.mutation ?? "";
    if (mutation !== "" && !isId(mutation)) continue;
    out.push({
      species: f.species,
      weight: clampNum(f.weight, FISH_WEIGHT_MAX),
      earn: clampNum(f.earn, MONEY_MAX),
      mutation: mutation as string,
      equipped: f.equipped === true,
      hotbar: f.hotbar === true,
    });
  }
  return out;
}

// One owned list + its equipped id. The equipped one must be owned ("" = none); when this save
// doesn't carry the list, trust the id's shape only.
function ownedPair(raw: Record<string, unknown>, out: Partial<PlayerDoc>, listKey: "rods" | "trails", idKey: "rod" | "trail") {
  if (raw[listKey] !== undefined) out[listKey] = sanitizeIds(raw[listKey]);
  const id = raw[idKey];
  const owned = out[listKey];
  if (id === "") out[idKey] = "";
  else if (isId(id) && (!owned || owned.includes(id))) out[idKey] = id;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save (and its leaderboard places).
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.money)) out.money = clampNum(raw.money, MONEY_MAX);
  if (finite(raw.gems)) out.gems = clampNum(raw.gems, MONEY_MAX);
  if (finite(raw.trained)) out.trained = clampNum(raw.trained, STAT_MAX);
  if (finite(raw.treadmill)) out.treadmill = clampInt(raw.treadmill, LEVEL_MAX, 1);
  if (finite(raw.baseLevel)) out.baseLevel = clampInt(raw.baseLevel, LEVEL_MAX, 1);
  if (finite(raw.slots)) out.slots = clampInt(raw.slots, SLOTS_MAX);
  if (finite(raw.income)) out.income = clampNum(raw.income, MONEY_MAX);
  if (finite(raw.caught)) out.caught = clampInt(raw.caught, STAT_MAX);
  if (finite(raw.earned)) out.earned = clampNum(raw.earned, MONEY_MAX);
  if (finite(raw.playtime)) out.playtime = clampInt(raw.playtime, PLAY_SECONDS_MAX);
  if (raw.fish !== undefined) out.fish = sanitizeFish(raw.fish);
  if (raw.unlocked !== undefined) out.unlocked = sanitizeIds(raw.unlocked, SPECIES_MAX);
  if (raw.claimed !== undefined) out.claimed = sanitizeIds(raw.claimed, SPECIES_MAX);

  ownedPair(raw, out, "rods", "rod");
  ownedPair(raw, out, "trails", "trail");
  return out;
}
