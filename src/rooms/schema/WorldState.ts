import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room and what the others draw of them. Durable progress lives in
// Mongo (src/db.ts). To sync something new about a player, add a field here and accept it in a
// WorldRoom message (bounded in presence.ts).
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
    uid: t.string().default(""), // Bloxity user id ("" = guest): matches Bloxity chat messages to a player
    base: t.int16().default(-1), // the plot (client PLOTS index) this player owns, -1 = none
    // Presence (presence.ts, `pose` / `loadout` / `setAvatar` / `plot`): what the others draw.
    x: t.float32().default(0), // feet position, m
    y: t.float32().default(0),
    z: t.float32().default(0),
    yaw: t.float32().default(0), // heading, rad (PI = facing -Z)
    speed: t.float32().default(0), // ground speed, m/s (drives the run cycle)
    vy: t.float32().default(0), // vertical speed, m/s (jump / fall pose)
    grounded: t.boolean().default(true),
    knocked: t.boolean().default(false), // thrown by a guard / lying on the ground
    rod: t.string().default(""), // equipped rod / trail ids (client catalogs), "" = none
    trail: t.string().default(""),
    slot: t.uint8().default(0), // in hand: 0 = nothing, 1 = rod, 2 = bat, 3 = a backpack fish (`item`)
    item: t.string().default(""), // species id of the fish in hand when slot = 3, else ""
    hold: t.string().default(""), // species id of a fish just caught, carried overhead out of the lane, "" = none
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions, skin }, "" = default
    plot: t.string().default(""), // the player's plot snapshot JSON (fish in the pool, treadmill), "" = nothing yet
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
