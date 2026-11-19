// Fork feature: per-API-key token limits can count input, output or total tokens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-limits-type-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const tokenLimits = await import("../../src/lib/db/tokenLimits.ts");
const counter = await import("../../open-sse/services/tokenLimitCounter.ts");
const route = await import("../../src/app/api/usage/token-limits/route.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  counter.clearTokenLimitCache();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const flush = () => new Promise((r) => setTimeout(r, 30));

function limitFor(apiKeyId: string, tokenType: "input" | "output" | "total", tokenLimit: number) {
  return tokenLimits.upsertTokenLimit({
    apiKeyId,
    scopeType: "global",
    tokenType,
    tokenLimit,
    resetInterval: "daily",
  });
}

test("input, output and total limits for the same scope and window coexist", () => {
  limitFor("k1", "input", 1000);
  limitFor("k1", "output", 200);
  limitFor("k1", "total", 5000);
  const rows = tokenLimits.listTokenLimits("k1");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.tokenType).sort(), ["input", "output", "total"]);
});

test("re-saving the same type updates that limit instead of adding a row", () => {
  const first = limitFor("k1", "input", 1000);
  const second = limitFor("k1", "input", 3000);
  assert.equal(first.id, second.id);
  const rows = tokenLimits.listTokenLimits("k1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenLimit, 3000);
});

test("each limit is charged only its own token type (reasoning follows the billable rule)", async () => {
  const input = limitFor("k2", "input", 1_000_000);
  const output = limitFor("k2", "output", 1_000_000);
  const total = limitFor("k2", "total", 1_000_000);

  // Reasoning is a subset of output when reported below it: not added again.
  counter.recordTokenUsage("k2", "openai", "gpt-4o", { input: 100, output: 30, reasoning: 5 });
  await flush();
  assert.equal(tokenLimits.getWindowUsage(input), 100);
  assert.equal(tokenLimits.getWindowUsage(output), 30);
  assert.equal(tokenLimits.getWindowUsage(total), 130);

  // Reasoning above output = separate buckets: both count (same as computeBillableTokens).
  counter.recordTokenUsage("k2", "openai", "gpt-4o", { input: 0, output: 10, reasoning: 40 });
  await flush();
  assert.equal(tokenLimits.getWindowUsage(output), 80);
  assert.equal(tokenLimits.getWindowUsage(total), 180);
});

test("an output limit blocks the key once output tokens reach it", async () => {
  limitFor("k3", "input", 1_000_000);
  limitFor("k3", "output", 50);

  counter.recordTokenUsage("k3", "openai", "gpt-4o", { input: 10, output: 49 });
  await flush();
  assert.equal(counter.checkTokenLimits("k3", "openai", "gpt-4o"), null);

  counter.recordTokenUsage("k3", "openai", "gpt-4o", { input: 10, output: 1 });
  await flush();
  const breach = counter.checkTokenLimits("k3", "openai", "gpt-4o");
  assert.ok(breach);
  assert.equal(breach.tokenType, "output");
  assert.equal(breach.tokensUsed, 50);
});

test("legacy numeric totals only charge total limits", async () => {
  const input = limitFor("k4", "input", 1000);
  const total = limitFor("k4", "total", 1000);
  counter.recordTokenUsage("k4", "openai", "gpt-4o", 77);
  await flush();
  assert.equal(tokenLimits.getWindowUsage(input), 0);
  assert.equal(tokenLimits.getWindowUsage(total), 77);
});

test("an old table without token_type is rebuilt and keeps its limits as total", () => {
  const db = core.getDbInstance();
  // Recreate the pre-fork shape (migration 196) with one existing limit + counter.
  db.exec(`
    DROP TABLE IF EXISTS api_key_token_limits;
    CREATE TABLE api_key_token_limits (
      id TEXT PRIMARY KEY, api_key_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('model', 'provider', 'global')),
      scope_value TEXT NOT NULL DEFAULT '',
      token_limit INTEGER NOT NULL CHECK (token_limit > 0),
      reset_interval TEXT NOT NULL DEFAULT 'monthly' CHECK (reset_interval IN ('daily', 'weekly', 'monthly')),
      reset_time TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (api_key_id, scope_type, scope_value, reset_interval)
    );
    INSERT INTO api_key_token_limits (id, api_key_id, scope_type, scope_value, token_limit, reset_interval)
      VALUES ('old-1', 'k5', 'global', '', 4321, 'daily');
    INSERT INTO api_key_token_counters (limit_id, window_start, tokens_used) VALUES ('old-1', 'w', 9);
  `);
  // Force the next call to re-check the schema of this (same) DB instance.
  core.resetDbInstance();

  const rows = tokenLimits.listTokenLimits("k5");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "old-1");
  assert.equal(rows[0].tokenType, "total");
  assert.equal(rows[0].tokenLimit, 4321);
  const kept = core
    .getDbInstance()
    .prepare("SELECT tokens_used FROM api_key_token_counters WHERE limit_id = 'old-1'")
    .get() as { tokens_used: number } | undefined;
  assert.equal(kept?.tokens_used, 9);

  // The new uniqueness allows an input limit next to the migrated total one.
  limitFor("k5", "input", 10);
  assert.equal(tokenLimits.listTokenLimits("k5").length, 2);
});

test("POST /api/usage/token-limits accepts tokenType and GET returns it", async () => {
  const res = await route.POST(
    new Request("http://localhost/api/usage/token-limits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKeyId: "k6",
        scopeType: "global",
        tokenType: "output",
        tokenLimit: 500,
        resetInterval: "weekly",
      }),
    })
  );
  assert.equal(res.status, 200);
  const list = await route.GET(new Request("http://localhost/api/usage/token-limits?apiKeyId=k6"));
  const body = (await list.json()) as { limits: Array<{ tokenType: string; tokenLimit: number }> };
  assert.equal(body.limits.length, 1);
  assert.equal(body.limits[0].tokenType, "output");
  assert.equal(body.limits[0].tokenLimit, 500);
});
