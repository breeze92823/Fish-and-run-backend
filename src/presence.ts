import { AVATAR_MAX_LEN, ID_PATTERN, PLOT_MAX_LEN, POSE_BOUNDS, ROOM_MAX_CLIENTS } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world (client remote players).
// Relayed through the roster as sent, only bounded here -- like the rest of the game it is
// client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// `pose` { x, y, z, yaw, speed, vy, grounded, knocked }: the feet position (m), heading (rad), ground
// speed (m/s), vertical speed (m/s), on the ground, and thrown by a guard / lying on the ground.
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xy, b.xy);
  if (finite(m.y)) p.y = clamp(m.y, -b.y, b.y);
  if (finite(m.z)) p.z = clamp(m.z, -b.xy, b.xy);
  if (finite(m.yaw)) p.yaw = wrap(m.yaw);
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
  if (finite(m.vy)) p.vy = clamp(m.vy, -b.speed, b.speed);
  if (typeof m.grounded === "boolean") p.grounded = m.grounded;
  if (typeof m.knocked === "boolean") p.knocked = m.knocked;
}

// `loadout` { rod, trail, slot, item, hold }: the equipped rod / trail ids, what is in hand (`slot`
// 0 = nothing, 1 = rod, 2 = bat, 3 = the backpack fish `item`) and the fish just caught carried
// overhead (`hold`). Ids are "" (none) or ID_PATTERN slugs.
export function applyLoadout(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  for (const key of ["rod", "trail", "item", "hold"] as const) {
    const v = m[key];
    if (v === "" || isId(v)) p[key] = v as string;
  }
  if (Number.isInteger(m.slot) && (m.slot as number) >= 0 && (m.slot as number) <= 3) p.slot = m.slot as number;
}

// `setAvatar` { avatar }: the Bloxity look as an opaque JSON string ("" = default), length-capped.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = (msg as { avatar?: unknown })?.avatar;
  if (typeof a === "string" && a.length <= AVATAR_MAX_LEN) p.avatar = a;
}

// `plot` { plot }: the sender's plot snapshot as a JSON object string (length-capped, must parse as an
// object): the other players draw it on that player's plot.
export function applyPlot(p: PlayerState, msg: unknown): void {
  const s = (msg as { plot?: unknown })?.plot;
  if (typeof s !== "string" || s.length > PLOT_MAX_LEN) return;
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) p.plot = s;
  } catch {
    // Not JSON: ignored.
  }
}

// The lowest player plot (0..ROOM_MAX_CLIENTS-1) nobody in the room owns, preferring `want` when it
// is free. -1 only when the room is somehow over its seat count.
export function assignBase(taken: Set<number>, want: unknown): number {
  if (Number.isInteger(want) && (want as number) >= 0 && (want as number) < ROOM_MAX_CLIENTS && !taken.has(want as number)) return want as number;
  for (let i = 0; i < ROOM_MAX_CLIENTS; i++) if (!taken.has(i)) return i;
  return -1;
}
