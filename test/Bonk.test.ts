import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { BONK } from "../src/constants.js";
import { giveWeight } from "../src/bonk.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("bat bonks", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  // Two players out in the lane, 2 m apart: a holds the bat, b carries an orca overhead.
  async function pair(bz = -30) {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "Ann", pose: { x: 0, y: 0, z: -30 }, loadout: { slot: 2, hold: "" } });
    const b = await colyseus.connectTo(room, { userId: "guest-b", username: "Bob", pose: { x: 2, y: 0, z: bz }, loadout: { slot: 1, hold: "orca" } });
    const bonks: any[] = [];
    const swings: any[] = [];
    const got: any[] = [];
    for (const c of [a, b]) {
      c.onMessage("bonk", (m) => bonks.push(m));
      c.onMessage("swing", (m) => swings.push(m));
    }
    a.onMessage("gotFish", (m) => got.push(m));
    await sleep(60);
    return { room, a, b, bonks, swings, got };
  }

  it("knocks a player in the lane and hands their fish to the attacker", async () => {
    const { room, a, b, bonks, swings, got } = await pair();
    a.send("swing", { target: b.sessionId });
    await sleep(80);
    assert.strictEqual(swings.length, 1, "only the others see the swing");
    assert.strictEqual(bonks.length, 2, "everyone sees the hit");
    const hit = bonks[0];
    assert.deepStrictEqual([hit.by, hit.to, hit.fish, hit.byName, hit.toName], [a.sessionId, b.sessionId, "orca", "Ann", "Bob"]);
    assert.ok(Math.abs(hit.x - 1) < 1e-3 && Math.abs(hit.z) < 1e-3, "flies away from the attacker");
    const pb = room.state.players.get(b.sessionId)!;
    assert.deepStrictEqual([pb.hold, pb.knocked], ["", true]);

    b.send("giveFish", { weight: 3.456 });
    await sleep(60);
    assert.deepStrictEqual(got, [{ species: "orca", weight: 3.46, from: "Bob" }]);
    b.send("giveFish", { weight: 9 });
    await sleep(60);
    assert.strictEqual(got.length, 1, "a fish is handed over once");
  });

  it("never lands a hit in the hub, out of range, on a knocked player or twice in a row", async () => {
    const hub = await pair(5); // b stands south of the finish line
    hub.a.send("swing", { target: hub.b.sessionId });
    await sleep(60);
    assert.strictEqual(hub.bonks.length, 0, "the hub is a safe zone");
    await colyseus.cleanup();

    const far = await pair(-30 - BONK.range - BONK.slack - 1);
    far.a.send("swing", { target: far.b.sessionId });
    await sleep(60);
    assert.strictEqual(far.bonks.length, 0, "too far away");
    await colyseus.cleanup();

    const { a, b, bonks } = await pair();
    a.send("swing", { target: b.sessionId });
    await sleep(BONK.cooldownMs + 50);
    b.send("pose", { knocked: false }); // stood up early: still immune
    await sleep(40);
    a.send("swing", { target: b.sessionId });
    await sleep(60);
    assert.strictEqual(bonks.length, 2, "one hit (seen by both), then immune");
  });

  it("needs the bat in hand, no catch overhead, and respects the swing cooldown", async () => {
    const { a, b, bonks, swings } = await pair();
    a.send("loadout", { slot: 1 });
    await sleep(40);
    a.send("swing", { target: b.sessionId });
    await sleep(BONK.cooldownMs + 50);
    assert.strictEqual(bonks.length, 0, "rod in hand");
    a.send("loadout", { slot: 2 });
    await sleep(40);
    a.send("swing", {});
    a.send("swing", { target: b.sessionId }); // inside the cooldown: dropped
    await sleep(60);
    assert.strictEqual(bonks.length, 0);
    assert.strictEqual(swings.length, 2, "the rod swing and the first bat swing reach b");
  });

  it("bounds the handed-over weight", () => {
    assert.strictEqual(giveWeight({ weight: -4 }), 0);
    assert.strictEqual(giveWeight({ weight: 1e9 }), 1e4);
    assert.strictEqual(giveWeight({ weight: "2" }), null);
    assert.strictEqual(giveWeight(null), null);
  });
});
