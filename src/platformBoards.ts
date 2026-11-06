import { DEV_ID_PREFIX, GUEST_ID_PREFIX, PLATFORM_BOARD_BATCH, PLATFORM_BOARD_EVERY_MS, PLATFORM_BOARDS } from "./constants.js";

// The boards on Bloxity's own trophy button: saved scores are queued here and reported in batches
// (`POST {BLOXITY_API_URL}/v1/leaderboards/hosted/{BLOXITY_GAME_ID}/report`, after the platform
// docs). A no-op unless deployed by Bloxity hosting (BLOXITY_REPORT_TOKEN + BLOXITY_GAME_ID), so safe
// locally. PLATFORM_BOARDS must match the client's LEADERBOARDS (config.js), which declares them too.
type Scores = Record<string, number>;

const queued = new Map<string, Scores>(); // user id -> the latest scores not reported yet

export function queueScores(userId: string, scores: Scores): void {
  if (!process.env.BLOXITY_REPORT_TOKEN || !userId || userId.startsWith(DEV_ID_PREFIX) || userId.startsWith(GUEST_ID_PREFIX)) return;
  queued.set(userId, { ...queued.get(userId), ...scores });
}

export async function reportScores(): Promise<void> {
  const token = process.env.BLOXITY_REPORT_TOKEN;
  const gameId = process.env.BLOXITY_GAME_ID;
  if (!token || !gameId || !queued.size) return;

  const scores: { board: string; userId: string; score: number }[] = [];
  for (const [userId, stats] of queued) {
    // Only `legion_` identities rank; a `#m...` suffix is stripped.
    const bare = userId.split("#")[0].replace(/^legion_/, "");
    for (const [board, value] of Object.entries(stats)) {
      if (Number.isFinite(value) && value > 0) scores.push({ board, userId: `legion_${bare}`, score: Math.floor(value) });
    }
    queued.delete(userId);
    if (scores.length >= PLATFORM_BOARD_BATCH - PLATFORM_BOARDS.length) break;
  }
  if (!scores.length) return;

  const api = (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
  try {
    const res = await fetch(`${api}/v1/leaderboards/hosted/${encodeURIComponent(gameId)}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ boards: PLATFORM_BOARDS, scores }),
      signal: AbortSignal.timeout(6000),
    });
    const body: { dropped?: unknown } | null = await res.json().catch((): null => null);
    if (body?.dropped) console.warn("[boards] dropped", body.dropped);
    if (!res.ok) console.warn("[boards] report failed", res.status);
  } catch (err) {
    console.warn("[boards] report failed", err);
  }
}

export function installPlatformBoards(): void {
  if (!process.env.BLOXITY_REPORT_TOKEN) return;
  setInterval(() => void reportScores(), PLATFORM_BOARD_EVERY_MS).unref();
}

// Test-only: forget what is queued.
export function __resetPlatformBoardsForTest(): void {
  queued.clear();
}
