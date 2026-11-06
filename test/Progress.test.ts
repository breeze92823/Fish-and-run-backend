import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { OFFLINE_MAX_SECONDS, OFFLINE_RATE } from "../src/constants.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// The messages every load sends besides the one a test looks at.
const quiet = (c: any, ...names: string[]) => {
  for (const n of ["leaderboard", "spins", "daily", ...names]) c.onMessage(n, () => {});
};

describe("progress", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends a saved player their progress and saves what they send back", async () => {
    const fish = [{ species: "black_moor", weight: 0.6, earn: 88, mutation: "gold", equipped: true, hotbar: true }];
    const fake = fakePlayers([
      { _id: "u1", money: 5000, trails: ["grey"], trail: "grey", fish, caught: 50, earned: 900, playtime: 600, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    let got: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    quiet(c);
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.money, 5000);
    assert.deepStrictEqual(got?.trails, ["grey"]);
    assert.strictEqual(got?.trail, "grey");
    assert.deepStrictEqual(got?.fish, fish);
    assert.ok(typeof got?.serverTime === "number");

    c.send("saveProgress", {
      money: 7000, gems: 3, trained: 12, treadmill: 2, baseLevel: 5, slots: 8, income: 96,
      rods: ["basic"], rod: "basic", unlocked: ["guppy"], claimed: [],
      caught: 40, earned: 1200, playtime: 500, hack: 1,
    });
    await sleep(150);
    const doc = fake.docs.get("u1")! as any;
    assert.deepStrictEqual([doc.money, doc.gems, doc.trained, doc.treadmill, doc.baseLevel, doc.slots, doc.income], [7000, 3, 12, 2, 5, 8, 96]);
    assert.strictEqual(doc.rod, "basic");
    assert.deepStrictEqual(doc.unlocked, ["guppy"]);
    assert.strictEqual(doc.caught, 50, "lifetime counters never go down ($max)");
    assert.strictEqual(doc.earned, 1200, "lifetime counters go up");
    assert.strictEqual(doc.playtime, 600);
    assert.deepStrictEqual(doc.fish, fish, "a save without the backpack leaves it alone");
    assert.strictEqual(doc.username, "Ann");
    assert.ok(doc.lastSeen >= Date.now() - 1000, "every save stamps lastSeen");
    assert.ok(!("hack" in doc));
  });

  it("turns the time away into Offline Money, once", async () => {
    const seen = Date.now() - 100_000;
    const fake = fakePlayers([
      { _id: "u5", money: 10, income: 40, lastSeen: seen, version: 1, updatedAt: new Date() },
      { _id: "u6", income: 5, lastSeen: Date.now() - 400 * 3600 * 1000, version: 1, updatedAt: new Date() },
      { _id: "u7", income: 5, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u5" });
    const d = await colyseus.connectTo(room, { userId: "u6" });
    const e = await colyseus.connectTo(room, { userId: "u7" });
    let got: any = null;
    let capped: any = null;
    let fresh: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    d.onMessage("progress", (m: any) => (capped = m));
    e.onMessage("progress", (m: any) => (fresh = m));
    for (const x of [c, d, e]) quiet(x);
    fake.release();
    await sleep(200);
    assert.ok(got.away >= 100 && got.away <= 103, "seconds away");
    assert.ok(got.offline >= 100 && got.offline <= 103, "income x OFFLINE_RATE x seconds away");
    assert.strictEqual(OFFLINE_RATE, 0.025, "client ECONOMY.offlineRate");
    assert.strictEqual(got.money, 10, "the server adds nothing itself");
    assert.ok(!("lastSeen" in got), "lastSeen is server-only");
    assert.strictEqual(capped.away, OFFLINE_MAX_SECONDS, "offline earnings are capped at a day");
    assert.strictEqual(capped.offline, Math.floor(5 * OFFLINE_RATE * OFFLINE_MAX_SECONDS));
    assert.deepStrictEqual([fresh.away, fresh.offline], [0, 0], "never seen: nothing to pay");
    assert.ok((fake.docs.get("u5") as any).lastSeen > seen + 99_000, "stamped on load, so it is counted once");
  });

  it("creates a new account's save and never saves a guest", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "new1" });
    let none = false;
    c.onMessage("noProgress", () => (none = true));
    quiet(c);
    fake.release();
    await sleep(150);
    assert.ok(none);
    c.send("saveProgress", { money: 10, caught: 1 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("new1")?.money, 10);
    assert.strictEqual(fake.docs.get("new1")?.caught, 1);

    const guest = await colyseus.connectTo(room, { userId: "guest-abc" });
    quiet(guest, "noProgress");
    await sleep(150);
    guest.send("saveProgress", { money: 99 });
    await sleep(150);
    assert.strictEqual(fake.docs.size, 1, "a guest is never written");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.signedIn, false);
    assert.strictEqual(room.state.players.get(c.sessionId)?.uid, "new1");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.uid, "");
  });

  it("loads the new identity when a guest signs in mid-session", async () => {
    const fake = fakePlayers([{ _id: "u2", money: 42, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-x" });
    let got: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    quiet(c, "noProgress");
    fake.release();
    await sleep(150);
    c.send("identify", { userId: "u2", username: "Bea" });
    await sleep(150);
    assert.strictEqual(got?.money, 42);
    assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, true);
    assert.strictEqual(room.state.players.get(c.sessionId)?.uid, "u2");
  });

  it("keeps saving off when the save could not be read", async () => {
    const fake = fakePlayers([{ _id: "u3", money: 1e9, version: 1, updatedAt: new Date() }]);
    (fake as any).findOne = async () => {
      await fake.gate;
      throw new Error("down");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u3" });
    let failed = false;
    c.onMessage("serverError", () => (failed = true));
    fake.release();
    await sleep(150);
    assert.ok(failed);
    c.send("saveProgress", { money: 0 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("u3")!.money, 1e9, "the unread save is never overwritten");
  });
});
