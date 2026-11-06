import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import {
  BONK, EVENT_EVERY_MS, GUEST_ID_PREFIX, LEADERBOARD_EVERY_MS, NAME_MAX, OFFLINE_MAX_SECONDS, OFFLINE_RATE, PFP_MAX_LEN, RECONNECT_SECONDS, ROOM_MAX_CLIENTS, UID_MAX_LEN, UPDATE_AT_MS,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { accrue, rollWedge, spinStateFrom, type SpinState } from "../spin.js";
import { claimDaily, dailyFields, dailyView, readDaily, rollDaily, type DailyState } from "../daily.js";
import { applyAvatar, applyLoadout, applyPlot, applyPose, assignBase } from "../presence.js";
import { bonkDirection, bonkRefusal, giveWeight } from "../bonk.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { queueScores } from "../platformBoards.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username, pfp, avatar, pose,
 * loadout, base })`. At most ROOM_MAX_CLIENTS (= the hub's player plots) players: each owns one plot
 * (`PlayerState.base`). Loads and saves each signed-in player's progress (MongoDB, see db.ts) -- the
 * client keeps no save of its own, so this is the only place progress lives. The game is
 * client-authoritative: no gameplay rules live here, saves are only bounded (sanitize.ts). Full rooms
 * spill into a fresh one automatically (maxClients). The roster also carries what the others draw:
 * every player's pose, Bloxity look, rod / trail / what is in hand, and the plot snapshot.
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionId -> Spin wheel state (spin.ts), set once the session's save has been read. Kept for
  // guests and serverless sessions too (it then lasts the connection).
  private spinStates = new Map<string, SpinState>();
  // sessionId -> Daily Reward state (daily.ts), read with the save. Guests and serverless sessions
  // keep theirs here only (like the rest of their progress, it lasts the session).
  private dailies = new Map<string, DailyState>();
  // Bat bonks (bonk.ts): each session's last swing (ms), when it may be hit again (ms), and the
  // fish taken from it waiting for its weight (victim sessionId -> { by: attacker, species, at }).
  private lastSwing = new Map<string, number>();
  private immuneUntil = new Map<string, number>();
  private steals = new Map<string, { by: string; species: string; at: number }>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // Lifetime counters only ever go up ($max), so a stale or replayed save can't lower a leaderboard place.
      const { caught, earned, playtime, ...rest } = patch;
      const max: Record<string, number> = {};
      for (const [k, v] of Object.entries({ caught, earned, playtime })) if (v !== undefined) max[k] = v;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", lastSeen: Date.now(), updatedAt: new Date() },
            ...(Object.keys(max).length && { $max: max }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
        return;
      }
      // Bloxity's own trophy boards: the saved values (the lifetime ones only ever rise, 'best' mode).
      queueScores(userId, {
        ...(patch.income !== undefined && { income: patch.income }),
        ...(caught !== undefined && { caught }),
        ...(earned !== undefined && { earned }),
      });
    },
    // Claims Daily Reward day `msg.day` (0-based). The server decides: answers `dailyResult`
    // { ok, day, ...state }; the client only grants the reward on ok.
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const s = this.dailies.get(client.sessionId);
      const day = msg?.day;
      if (!s || !this.loaded.has(client.sessionId)) return client.send("dailyResult", { ok: false, day, reason: "loading" });
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s); // midnight passed while online
      if (!claimDaily(s, day)) return client.send("dailyResult", { ok: false, day, reason: "locked", ...dailyView(s) });
      if (!(await this.saveDaily(client.sessionId, s))) {
        s.claimed = s.claimed.filter((i) => i !== day); // not stored: not claimed
        return client.send("dailyResult", { ok: false, day, reason: "save", ...dailyView(s) });
      }
      client.send("dailyResult", { ok: true, day, ...dailyView(s) });
    },
    // The client's countdown reached the next UTC day: unlock it (server clock) and answer `daily`.
    dailyRefresh: (client: Client) => {
      const s = this.dailies.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return;
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s);
      client.send("daily", dailyView(s));
    },
    // Spin wheel: uses one spin and rolls the prize here, so the client can't choose it. Answers
    // `spinResult` { ok, id (SPIN_WEDGES id), spins, nextAt, serverTime } or { ok: false, reason }.
    spin: async (client: Client) => {
      const s = this.spinStates.get(client.sessionId);
      if (!s) return client.send("spinResult", { ok: false, reason: "loading" });
      const now = Date.now();
      accrue(s, now);
      if (s.spins < 1) return client.send("spinResult", { ok: false, reason: "none", ...this.spinView(s, now) });
      s.spins--;
      accrue(s, now); // dropping below the cap starts the free-spin clock
      const wedge = rollWedge();
      client.send("spinResult", { ok: true, id: wedge.id, ...this.spinView(s, now) });
      await this.saveSpins(client.sessionId, s);
    },
    // Presence (presence.ts): the sender's pose ~12x/s, its rod / trail / what is in hand and its
    // Bloxity look, relayed through the roster so everyone draws it in the world.
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    // The sender's plot (fish in the pool, treadmill) for the others to draw on its plot.
    plot: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPlot(p, msg);
    },
    // Bat swing (loadout slot 2): `swing` { target?: sessionId }. Everyone else sees the swing
    // (`swing` { id }); a hit that passes bonkRefusal (both out in the lane, close, nobody hit twice in
    // a row) goes to the whole room as `bonk` { by, to, x, z (flight direction), fish (species
    // stolen, "" = none), byName, toName }. The victim's client throws itself, drops its catch and
    // answers `giveFish` { weight }; the attacker's carries the fish home.
    swing: (client: Client, msg: unknown) => {
      const a = this.state.players.get(client.sessionId);
      if (!a) return;
      const now = Date.now();
      if (now - (this.lastSwing.get(client.sessionId) ?? 0) < BONK.cooldownMs) return;
      this.lastSwing.set(client.sessionId, now);
      this.broadcast("swing", { id: client.sessionId }, { except: client });
      const to = (msg as { target?: unknown })?.target;
      if (typeof to !== "string" || !to) return;
      const t = this.state.players.get(to);
      if (bonkRefusal(a, t, now, this.immuneUntil.get(to) ?? 0, to === client.sessionId) || !t) return;
      this.immuneUntil.set(to, now + BONK.immuneMs);
      const fish = t.hold;
      if (fish) this.steals.set(to, { by: client.sessionId, species: fish, at: now });
      t.hold = ""; // gone from their hands at once, so nobody else can take it on the way
      t.knocked = true;
      const dir = bonkDirection(a, t);
      this.broadcast("bonk", { by: client.sessionId, to, x: dir.x, z: dir.z, fish, byName: a.username || "Player", toName: t.username || "Player" });
    },
    // The bonked player's answer: the weight of the fish just taken, sent on to the attacker as
    // `gotFish` { species, weight, from }. Only for a steal made in the last BONK.giveMs.
    giveFish: (client: Client, msg: unknown) => {
      const s = this.steals.get(client.sessionId);
      const weight = giveWeight(msg);
      if (!s || weight === null) return;
      this.steals.delete(client.sessionId);
      if (Date.now() - s.at > BONK.giveMs) return;
      const attacker = this.clients.find((c) => c.sessionId === s.by);
      const from = this.state.players.get(client.sessionId)?.username || "Player";
      try {
        attacker?.send("gotFish", { species: s.species, weight, from });
      } catch {
        // Gone meanwhile.
      }
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: (client: Client, msg: { username?: string; userId?: string; pfp?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      if (typeof msg?.userId === "string") this.setUserId(client, p, msg.userId);
    },
  };

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads.
  onCreate() {
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
  }

  // `leaderboard` { boards: { income|caught|earned|playtime: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  onJoin(client: Client, options?: { username?: string; userId?: string; pfp?: string; pose?: unknown; loadout?: unknown; avatar?: string; base?: unknown }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // The player's own plot: the one they asked for if it is free, else the lowest free one. A plot
    // held by this same account's older session (a reload still inside its reconnect window) counts
    // as free: setUserId evicts that session right after, so a reload keeps its plot.
    const me = typeof options?.userId === "string" && !options.userId.startsWith(GUEST_ID_PREFIX) ? options.userId.slice(0, UID_MAX_LEN) : "";
    const taken = new Set<number>();
    this.state.players.forEach((o, sid) => {
      if (o.base >= 0 && !(me && this.userIds.get(sid) === me)) taken.add(o.base);
    });
    p.base = assignBase(taken, options?.base);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    this.state.players.set(client.sessionId, p);
    this.setUserId(client, p, typeof options?.userId === "string" ? options.userId : "");
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // The player is here now: offline time is counted from this moment on.
  private async stampSeen(sessionId: string, at: number) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: at } });
    } catch (err) {
      console.warn("[WorldRoom] stampSeen failed", err);
    }
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping: its plot is free again (it leaves the roster).
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.dailies.delete(sessionId);
    this.spinStates.delete(sessionId);
    this.lastSwing.delete(sessionId);
    this.immuneUntil.delete(sessionId);
    this.steals.delete(sessionId);
  }

  private spinView(s: SpinState, now: number) {
    return { spins: s.spins, nextAt: s.nextAt, serverTime: now };
  }

  // The spin fields go straight to Mongo (saveProgress never carries them).
  private async saveSpins(sessionId: string, s: SpinState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { spins: s.spins, spinAt: s.nextAt, updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
    } catch (err) {
      console.warn("[WorldRoom] saveSpins failed", err);
    }
  }

  // Stores a session's Daily Reward state. True when stored, or when there is nowhere to store it
  // (guest / no database: it lives in `dailies` for the session).
  private async saveDaily(sessionId: string, s: DailyState): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { ...dailyFields(s), updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveDaily failed", err);
      return false;
    }
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, UID_MAX_LEN);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    this.spinStates.delete(client.sessionId); // nor spins
    p.signedIn = !!userId;
    p.uid = userId;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    const spin = spinStateFrom(doc, now);
    this.spinStates.set(client.sessionId, spin);
    if (!doc) client.send("noProgress", { serverTime: now });
    else {
      // Offline Money: what the active fish earned while the player was away (income x OFFLINE_RATE x
      // time since last seen, capped). The client adds it; the stamp below makes sure it is counted only once.
      const away = doc.lastSeen ? Math.min(OFFLINE_MAX_SECONDS, Math.max(0, (now - doc.lastSeen) / 1000)) : 0;
      const offline = Math.floor((doc.income ?? 0) * OFFLINE_RATE * away);
      client.send("progress", { ...(sanitizeProgress(doc) ?? {}), offline, away: Math.floor(away), serverTime: now });
      await this.stampSeen(client.sessionId, now);
      // Left, or switched identity, during the stamp: that identity's own load answers instead.
      if (this.spinStates.get(client.sessionId) !== spin) return;
    }
    // HUD countdowns on the server clock: the client counts against serverTime, not its own clock.
    client.send("schedule", { eventEveryMs: EVENT_EVERY_MS, updateAt: UPDATE_AT_MS, serverTime: now });
    client.send("spins", this.spinView(spin, now));

    // Daily Reward: today's day unlocks on join (server clock), then the client gets the calendar.
    const daily = readDaily(doc);
    this.dailies.set(client.sessionId, daily);
    if (rollDaily(daily)) await this.saveDaily(client.sessionId, daily);
    if (this.dailies.get(client.sessionId) === daily) client.send("daily", dailyView(daily));
    void this.sendLeaderboard(client);
  }
}
