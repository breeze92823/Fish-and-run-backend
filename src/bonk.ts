import { BONK, FISH_WEIGHT_MAX } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Bat bonks: the rules the room checks before relaying a hit (WorldRoom `swing` / `giveFish`).
// Positions are the roster poses (client-reported, like all presence), so this only keeps a hit
// plausible: both players out in the lane, close enough, nobody hit twice in a row.

export type BonkRefusal = "self" | "gone" | "hub" | "far" | "busy" | "knocked" | "immune";

// Why `a` can't bonk `t` right now, or null when the hit stands. `immuneUntil` = when `t` may be hit again (ms).
export function bonkRefusal(a: PlayerState, t: PlayerState | undefined, now: number, immuneUntil = 0, self = false): BonkRefusal | null {
  if (self) return "self";
  if (!t) return "gone";
  if (!(a.z < BONK.laneZ) || !(t.z < BONK.laneZ)) return "hub"; // the hub is a safe zone
  if (a.knocked || a.hold || a.slot !== 2) return "busy"; // lying down, both hands on a catch, or no bat
  if (t.knocked) return "knocked";
  if (now < immuneUntil) return "immune";
  const d = Math.hypot(a.x - t.x, a.z - t.z);
  if (!(d <= BONK.range + BONK.slack) || Math.abs(a.y - t.y) > 4) return "far";
  return null;
}

// The unit direction the victim flies (attacker -> target, flat), +Z when they stand on each other.
export function bonkDirection(a: PlayerState, t: PlayerState): { x: number; z: number } {
  const dx = t.x - a.x;
  const dz = t.z - a.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) return { x: Math.sin(a.yaw), z: Math.cos(a.yaw) };
  return { x: Math.round((dx / d) * 1000) / 1000, z: Math.round((dz / d) * 1000) / 1000 };
}

// The stolen fish's weight as the victim reports it (`giveFish` { weight }), bounded; null if not a number.
export function giveWeight(msg: unknown): number | null {
  const w = (msg as { weight?: unknown })?.weight;
  if (typeof w !== "number" || !Number.isFinite(w)) return null;
  return Math.min(FISH_WEIGHT_MAX, Math.max(0, Math.round(w * 100) / 100));
}
