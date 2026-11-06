// Keep in step with the client's src/config.js by hand (a contract change goes in both projects).

// Players per room = the number of player plots in the client's hub (config.js PLOTS: 3 west + 3
// south + 2 east). Every player owns one plot, so a room never holds more players than plots.
// The deploy workflow reads this line and sends it to Legion as `roomSize` (valid range 2-100).
export const ROOM_MAX_CLIENTS = 8;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// The Bloxity user id (`uid` in the roster): lets a client match a Bloxity chat message to a player.
export const UID_MAX_LEN = 128;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw, and the pose
// bounds (|x|, |z| up to `xy` m: the lane runs to z = -975; y up to `y` m; speed in m/s).
export const AVATAR_MAX_LEN = 3000;
// A player's plot snapshot (the fish swimming in its pool, treadmill level: client NET.plotFish),
// relayed as a JSON string.
export const PLOT_MAX_LEN = 4000;
export const POSE_BOUNDS = { xy: 2000, y: 200, speed: 400 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules.
export const MONEY_MAX = 1e33; // money, gems, income, lifetime earnings, a fish's $/s
export const STAT_MAX = 1e15; // trained speed, fish caught
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year
export const LEVEL_MAX = 100; // treadmill level (client TREADMILL.levels)
export const SLOTS_MAX = 100; // active fish slots (client FISH_SLOTS.max, with slack)
export const OWNED_MAX = 64; // owned rods / trails (client catalogs, with slack)
// The backpack (client activeFish.js): at most FISH_MAX fish, each up to FISH_WEIGHT_MAX kg.
export const FISH_MAX = 1000;
export const FISH_WEIGHT_MAX = 1e4;
// Species ids in the index: unlocked (ever caught) and claimed (index reward taken).
export const SPECIES_MAX = 512;

// Offline Money (client ECONOMY.offlineRate): while away, the active fish earn this share of their
// online rate, for at most OFFLINE_MAX_SECONDS.
export const OFFLINE_RATE = 0.025;
export const OFFLINE_MAX_SECONDS = 24 * 60 * 60;

// Daily Reward (client DAILY.days): days in one calendar cycle.
export const DAILY_DAYS = 7;

// Spin wheel (client SPIN in config.js; spin.ts): one free spin every SPIN_EVERY_MS, stored up
// to SPIN_CAP; a new player starts with SPIN_START. SPINS_MAX bounds a saved count.
export const SPIN_EVERY_MS = 15 * 60 * 1000;
export const SPIN_CAP = 5;
export const SPIN_START = 1;
export const SPINS_MAX = 1e6;
// The wedges' prizes and odds (weights in %). Ids match the client's SPIN.wedges; the client
// decides what each prize is, the server only which one is won.
export const SPIN_WEDGES = [
  { id: "doubleWins", weight: 35 },
  { id: "wins50", weight: 25 },
  { id: "luck", weight: 35 },
  { id: "wins250", weight: 4.9 },
  { id: "hugePet", weight: 0.1 },
] as const;

// Leaderboards (leaderboard.ts; client hub LEADERBOARD board): the saved doc fields ranked, rows per
// board and how often the lists are re-read and re-sent.
export const LEADERBOARD_STATS = ["income", "caught", "earned", "playtime"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Ids from the client's catalogs (rods, trails, fish species, mutations): slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";

// HUD countdowns (client hud.js): "Next event in ..." repeats every EVENT_EVERY_MS on the server's
// UTC clock (aligned to the epoch, so every player and every reload sees the same time left);
// "UPDATE IN ..." counts down to UPDATE_AT_MS. Both are sent in the `schedule` message.
export const EVENT_EVERY_MS = 5 * 60 * 60 * 1000;
export const UPDATE_AT_MS = Date.parse("2026-11-13T17:00:00Z");

// Bloxity's own trophy boards (platformBoards.ts; the client's LEADERBOARDS in config.js declares
// the same ones): how often scores are reported and the most in one call. Cash/s first: the portal
// opens on it. `stat` is the saved PlayerDoc field a board reports.
export const PLATFORM_BOARD_EVERY_MS = 30 * 1000;
export const PLATFORM_BOARD_BATCH = 200;
export const PLATFORM_BOARDS = [
  { id: "income", label: "Most Cash/s", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "caught", label: "Most Fish Caught", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "earned", label: "Most Cash Earned", order: "desc", mode: "best", format: "compact", reset: "none" },
] as const;
export const DEV_ID_PREFIX = "dev-";

// Bat bonks (bonk.ts; client BAT in config.js): a player swinging the bat (loadout slot 2) knocks
// another player flying and steals the fish they carry overhead -- only out in the run lane, never
// in the hub (the hub is z >= 0, the lane z < 0). The server checks the roster poses: both in the
// lane (z < laneZ), within `range` m plus `slack` for the poses' latency, the attacker not knocked
// or carrying, the target not knocked, not hit in the last `immuneMs`, the attacker's last swing
// at least `cooldownMs` ago. The victim then hands the stolen fish's weight over (`giveFish`)
// within `giveMs`.
export const BONK = { laneZ: -0.5, range: 4.2, slack: 3, cooldownMs: 550, immuneMs: 600000, shieldMs: 300000, giveMs: 4000 } as const;
