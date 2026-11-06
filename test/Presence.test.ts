import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { AVATAR_MAX_LEN, PLOT_MAX_LEN, POSE_BOUNDS, ROOM_MAX_CLIENTS } from "../src/constants.js";
import { assignBase } from "../src/presence.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("plot assignment", () => {
  it("prefers the asked plot when free, else the lowest free one", () => {
    assert.strictEqual(assignBase(new Set(), 5), 5);
    assert.strictEqual(assignBase(new Set([5]), 5), 0);
    assert.strictEqual(assignBase(new Set([0, 1]), undefined), 2);
    assert.strictEqual(assignBase(new Set(), ROOM_MAX_CLIENTS), 0, "out of range");
    assert.strictEqual(assignBase(new Set(), 1.5), 0, "not an integer");
    assert.strictEqual(assignBase(new Set(), "3"), 0, "not a number");
    assert.strictEqual(assignBase(new Set(Array.from({ length: ROOM_MAX_CLIENTS }, (_, i) => i)), 0), -1);
  });
});

describe("presence", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("seats as many players as the hub has plots and gives each its own", async () => {
    assert.strictEqual(ROOM_MAX_CLIENTS, 8, "client config.js PLOTS has 8 plots");
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", base: 2 });
    const b = await colyseus.connectTo(room, { userId: "guest-b", base: 2 }); // taken: gets the lowest free one
    const c = await colyseus.connectTo(room, { userId: "guest-c" });
    await sleep(50);
    const bases = [a, b, c].map((x) => room.state.players.get(x.sessionId)!.base);
    assert.deepStrictEqual(bases, [2, 0, 1]);
    assert.strictEqual(room.maxClients, ROOM_MAX_CLIENTS);
    await a.leave();
    await sleep(100);
    const d = await colyseus.connectTo(room, { userId: "guest-d", base: 2 });
    await sleep(50);
    assert.strictEqual(room.state.players.get(d.sessionId)!.base, 2, "a freed plot is handed out again");
  });

  it("keeps a reloading player's plot (their old session is still in its reconnect window)", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const old = await colyseus.connectTo(room, { userId: "u-reload", base: 3 });
    const other = await colyseus.connectTo(room, { userId: "guest-x", base: 3 });
    await sleep(50);
    assert.strictEqual(room.state.players.get(old.sessionId)!.base, 3);
    assert.notStrictEqual(room.state.players.get(other.sessionId)!.base, 3, "another player can't take it");
    const again = await colyseus.connectTo(room, { userId: "u-reload", base: 3 }); // the old one hasn't left yet
    await sleep(50);
    assert.strictEqual(room.state.players.get(again.sessionId)!.base, 3, "the same account gets its plot back");
    assert.strictEqual(room.state.players.has(old.sessionId), false, "the old session is evicted");
  });

  it("takes the pose, loadout and look from the join options", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {
      userId: "guest-a",
      pose: { x: 3, y: 0.5, z: -900, yaw: Math.PI, speed: 4, vy: 1, grounded: false, knocked: true },
      loadout: { rod: "basic", trail: "grey", slot: 3, item: "guppy", hold: "orca" },
      avatar: '{"equipped":{}}',
    });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.x, p.y, p.z, p.speed, p.vy, p.grounded, p.knocked], [3, 0.5, -900, 4, 1, false, true]);
    assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 1e-5);
    assert.deepStrictEqual([p.rod, p.trail, p.slot, p.item, p.hold], ["basic", "grey", 3, "guppy", "orca"]);
    assert.strictEqual(p.avatar, '{"equipped":{}}');
  });

  it("bounds poses and loadouts and relays them to the others", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("pose", { x: 1e9, y: "high", z: -1e12, yaw: 7, speed: -3, vy: 1e6, knocked: true, grounded: false });
    a.send("loadout", { rod: "Bad Id!", trail: "green", slot: 2, item: "", hold: "mahi_mahi" });
    a.send("setAvatar", { avatar: "x".repeat(AVATAR_MAX_LEN + 1) });
    await sleep(100);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.x, POSE_BOUNDS.xy);
    assert.strictEqual(p.y, 0, "a non-number is ignored");
    assert.strictEqual(p.z, -POSE_BOUNDS.xy);
    assert.ok(Math.abs(p.yaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-5, "yaw wrapped to -PI..PI");
    assert.strictEqual(p.speed, 0);
    assert.strictEqual(p.vy, POSE_BOUNDS.speed);
    assert.deepStrictEqual([p.knocked, p.grounded], [true, false]);
    assert.strictEqual(p.rod, "", "a malformed id is ignored");
    assert.deepStrictEqual([p.trail, p.slot, p.item, p.hold], ["green", 2, "", "mahi_mahi"]);
    assert.strictEqual(p.avatar, "", "an oversized look is ignored");

    a.send("loadout", { slot: 4, hold: "<script>" });
    a.send("loadout", { slot: 1.5 });
    a.send("loadout", { slot: -1 });
    await sleep(50);
    assert.strictEqual(p.slot, 2, "a slot outside 0..3 is ignored");
    assert.strictEqual(p.hold, "mahi_mahi", "a malformed hold is ignored");
    a.send("loadout", { slot: 0, hold: "" });
    await sleep(50);
    assert.deepStrictEqual([p.slot, p.hold], [0, ""]);

    // b's synced copy of the roster sees a's presence.
    const seen = (b.state as any).players.get(a.sessionId);
    assert.strictEqual(seen.trail, "green");
    assert.strictEqual(seen.x, POSE_BOUNDS.xy);
    assert.strictEqual(seen.knocked, true);
  });

  it("relays a player's plot snapshot, only as capped JSON", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    const snap = JSON.stringify({ t: 3, f: [["guppy", 0.4, "gold"], ["orca", 900, ""]] });
    a.send("plot", { plot: snap });
    await sleep(50);
    assert.strictEqual(p.plot, snap);
    a.send("plot", { plot: "not json" });
    a.send("plot", { plot: "[1]" });
    a.send("plot", { plot: JSON.stringify({ x: "y".repeat(PLOT_MAX_LEN) }) });
    await sleep(50);
    assert.strictEqual(p.plot, snap, "malformed or oversized snapshots are ignored");
  });
});
