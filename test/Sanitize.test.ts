import assert from "assert";

import { FISH_MAX, FISH_WEIGHT_MAX, LEVEL_MAX, MONEY_MAX, PLAY_SECONDS_MAX, SLOTS_MAX, SPECIES_MAX, STAT_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({
      money: 1e40, gems: -5, trained: 1e20, treadmill: 0, baseLevel: -3, slots: 7.9, income: NaN,
      caught: 3.7, earned: Infinity, playtime: 1e12, lastSeen: 5, spins: 9, dailyDay: 3, hack: "x",
    })!;
    assert.strictEqual(out.money, MONEY_MAX);
    assert.strictEqual(out.gems, 0);
    assert.strictEqual(out.trained, STAT_MAX);
    assert.strictEqual(out.treadmill, 1, "the treadmill starts at level 1");
    assert.strictEqual(out.baseLevel, 1, "the base starts at level 1");
    assert.strictEqual(out.slots, 7);
    assert.strictEqual(out.income, undefined);
    assert.strictEqual(out.caught, 3);
    assert.strictEqual(out.earned, undefined);
    assert.strictEqual(out.playtime, PLAY_SECONDS_MAX);
    for (const k of ["lastSeen", "spins", "dailyDay", "hack"]) assert.ok(!(k in out), `${k} is not the client's to write`);
    const hi = sanitizeProgress({ treadmill: 1e9, baseLevel: 1e9, slots: 1e9 })!;
    assert.deepStrictEqual([hi.treadmill, hi.baseLevel, hi.slots], [LEVEL_MAX, LEVEL_MAX, SLOTS_MAX]);
  });

  it("keeps well-formed fish, bounds them and drops malformed entries", () => {
    const out = sanitizeProgress({
      fish: [
        { species: "black_moor", weight: 0.6, earn: 88, mutation: "gold", equipped: true, hotbar: true },
        { species: "guppy", weight: 0.4, earn: 8, equipped: "yes" },
        { species: "Bad Id!", weight: 1, earn: 1 },
        { species: "orca", weight: "heavy", earn: 1 },
        { species: "orca", weight: 1, earn: NaN },
        { species: "orca", weight: 1, earn: 1, mutation: "<b>" },
        { species: "whale_shark", weight: 1e9, earn: 1e40, mutation: "" },
        "x",
        null,
      ],
    })!;
    assert.deepStrictEqual(out.fish, [
      { species: "black_moor", weight: 0.6, earn: 88, mutation: "gold", equipped: true, hotbar: true },
      { species: "guppy", weight: 0.4, earn: 8, mutation: "", equipped: false, hotbar: false },
      { species: "whale_shark", weight: FISH_WEIGHT_MAX, earn: MONEY_MAX, mutation: "", equipped: false, hotbar: false },
    ]);
    const many = Array.from({ length: FISH_MAX + 50 }, () => ({ species: "guppy", weight: 1, earn: 1 }));
    assert.strictEqual(sanitizeProgress({ fish: many })!.fish!.length, FISH_MAX);
    assert.deepStrictEqual(sanitizeProgress({ fish: "lots" })!.fish, []);
    assert.strictEqual(sanitizeProgress({})!.fish, undefined, "a save without the list leaves it alone");
  });

  it("keeps well-formed ids and only equips an owned rod / trail", () => {
    const out = sanitizeProgress({ rods: ["basic", "pro", "pro", "Bad Id!", 7], rod: "pro", trails: ["grey", "green"], trail: "galaxy" })!;
    assert.deepStrictEqual(out.rods, ["basic", "pro"]);
    assert.strictEqual(out.rod, "pro");
    assert.deepStrictEqual(out.trails, ["grey", "green"]);
    assert.strictEqual(out.trail, undefined, "an unowned trail is not equipped");
    assert.strictEqual(sanitizeProgress({ trails: ["grey"], trail: "" })!.trail, "", "\"\" = none");
    assert.strictEqual(sanitizeProgress({ rod: "pro" })!.rod, "pro", "without the list only the shape is checked");
    assert.strictEqual(sanitizeProgress({ rod: "Bad Id!" })!.rod, undefined);
  });

  it("bounds the species index lists", () => {
    const out = sanitizeProgress({ unlocked: ["guppy", "guppy", "orca", "Bad Id!", 3], claimed: ["guppy"] })!;
    assert.deepStrictEqual(out.unlocked, ["guppy", "orca"]);
    assert.deepStrictEqual(out.claimed, ["guppy"]);
    const lots = Array.from({ length: SPECIES_MAX + 10 }, (_, i) => `s${i}`);
    assert.strictEqual(sanitizeProgress({ unlocked: lots })!.unlocked!.length, SPECIES_MAX);
  });
});
