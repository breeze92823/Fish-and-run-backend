import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_STATS } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted client state (what `saveProgress` carries, see sanitize.ts). The client keeps
// nothing in the browser: this document is the player's only save.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  username?: string; // display name as of the last save
  money?: number; // the HUD's $ counter
  gems?: number;
  trained?: number; // trained speed stat (the plot treadmill; the trail multiplies it)
  treadmill?: number; // treadmill level, 1..LEVEL_MAX
  baseLevel?: number; // base level (client BASE.levels: pond slots + the plot's look), 1..LEVEL_MAX
  slots?: number; // active fish slots
  fish?: SavedFish[]; // the backpack, at most FISH_MAX
  rods?: string[]; // owned rod ids
  rod?: string; // the equipped rod (an owned one), "" = none
  trails?: string[]; // owned trail ids (client TRAILS)
  trail?: string; // the equipped trail (an owned one), "" = none
  unlocked?: string[]; // species ever caught (the index)
  claimed?: string[]; // species whose index reward was taken
  income?: number; // current $/s of the active fish (Offline Money = this x OFFLINE_RATE x seconds away)
  // Lifetime counters (leaderboards): written with $max, so a stale save never lowers them.
  caught?: number; // fish caught
  earned?: number; // money earned
  playtime?: number; // s with the game visible
  lastSeen?: number; // epoch ms of the last activity (the server stamps it: on load, on every save and when the player leaves)
  // Spin wheel (spin.ts): written only by the server's `spin` handler, never by saveProgress.
  spins?: number; // spins ready to use
  spinAt?: number; // epoch ms the next free spin arrives
  // Daily Reward (daily.ts): written by the server only, never by saveProgress.
  dailyDay?: number; // days unlocked this cycle
  dailyLast?: number; // UTC day index of the last unlock
  dailyClaimed?: number[]; // claimed day indexes this cycle
  version: number;
  updatedAt: Date;
}

// One backpack fish (client activeFish.js): its species (client FISH key), weight (kg), income
// ($/s while active), mutation ("" = none), and whether it is active / on the hotbar.
export interface SavedFish {
  species: string;
  weight: number;
  earn: number;
  mutation: string;
  equipped: boolean;
  hotbar: boolean;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      players.createIndex({ [stat]: -1 }).catch((err) => console.warn(`[db] index on ${stat} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
