import assert from "assert";

import { __resetPlatformBoardsForTest, queueScores, reportScores } from "../src/platformBoards.js";

describe("Bloxity trophy boards", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetPlatformBoardsForTest();
    delete process.env.BLOXITY_REPORT_TOKEN;
    delete process.env.BLOXITY_GAME_ID;
  });

  it("reports queued scores as legion_ ids with the board definitions", async () => {
    process.env.BLOXITY_REPORT_TOKEN = "t";
    process.env.BLOXITY_GAME_ID = "fish-and-run";
    let sent: any = null;
    globalThis.fetch = (async (url: string, init: any) => ((sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization }), { ok: true, json: async () => ({}) })) as any;
    queueScores("abc#m1", { income: 12.9, caught: 0, earned: 500 });
    queueScores("dev-1", { income: 5 });
    queueScores("guest-1", { income: 5 });
    await reportScores();
    assert.ok(sent.url.endsWith("/v1/leaderboards/hosted/fish-and-run/report"));
    assert.strictEqual(sent.auth, "Bearer t");
    assert.deepStrictEqual(sent.body.scores, [
      { board: "income", userId: "legion_abc", score: 12 },
      { board: "earned", userId: "legion_abc", score: 500 },
    ]);
    assert.strictEqual(sent.body.boards[0].id, "income");
  });

  it("does nothing without a report token", async () => {
    let called = false;
    globalThis.fetch = (async () => ((called = true), { ok: true, json: async () => ({}) })) as any;
    queueScores("abc", { income: 1 });
    await reportScores();
    assert.strictEqual(called, false);
  });
});
