import test from "node:test";
import assert from "node:assert/strict";

// Fork feature: `claude setup-token` connections are inference-only — every account endpoint
// (/api/oauth/usage, /api/claude_cli/bootstrap, org limit reset) answers 403, so OmniRoute must
// never call them automatically.

const { isClaudeSetupTokenConnection, isClaudeSetupTokenData, CLAUDE_SETUP_TOKEN_USAGE_MESSAGE } =
  await import("../../open-sse/services/claudeSetupToken.ts");
const { getUsageForProvider } = await import("../../open-sse/services/usage.ts");
const { readClaudeUsageLimitConfig } = await import("../../open-sse/services/claudeLowPriority.ts");
const { resolveAccountUUID } = await import("../../open-sse/executors/claudeIdentity.ts");

test("detects setup-token connections by marker or by an explicitly empty refresh token", () => {
  assert.equal(isClaudeSetupTokenData({ setupToken: true }), true);
  assert.equal(isClaudeSetupTokenData({}), false);
  assert.equal(
    isClaudeSetupTokenConnection({
      provider: "claude",
      providerSpecificData: { setupToken: true },
    }),
    true
  );
  assert.equal(
    isClaudeSetupTokenConnection({ provider: "claude", authType: "oauth", refreshToken: null }),
    true
  );
  assert.equal(
    isClaudeSetupTokenConnection({ provider: "claude", authType: "oauth", refreshToken: "" }),
    true
  );
});

test("never classifies a regular account as setup-token", () => {
  // Regular OAuth login: has a refresh token.
  assert.equal(
    isClaudeSetupTokenConnection({ provider: "claude", authType: "oauth", refreshToken: "rt" }),
    false
  );
  // Caller stripped the refreshToken field: unknown → must NOT disable quota.
  assert.equal(isClaudeSetupTokenConnection({ provider: "claude", authType: "oauth" }), false);
  assert.equal(
    isClaudeSetupTokenConnection({
      provider: "claude",
      authType: "oauth",
      refreshToken: undefined,
    }),
    false
  );
  // API-key Claude connections and other providers.
  assert.equal(
    isClaudeSetupTokenConnection({ provider: "claude", authType: "apikey", refreshToken: null }),
    false
  );
  assert.equal(
    isClaudeSetupTokenConnection({ provider: "codex", authType: "oauth", refreshToken: null }),
    false
  );
});

test("usage dispatcher returns the setup-token message without any network call", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("network must not be used");
  }) as typeof fetch;
  try {
    const result = await getUsageForProvider({
      id: "conn-1",
      provider: "claude",
      authType: "oauth",
      accessToken: "sk-ant-oat01-test",
      refreshToken: null,
      providerSpecificData: {},
    });
    assert.deepEqual(result, { message: CLAUDE_SETUP_TOKEN_USAGE_MESSAGE });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("auto limit reset is never armed for a setup-token connection", () => {
  assert.equal(readClaudeUsageLimitConfig({ autoLimitReset: true }).autoLimitReset, true);
  assert.equal(
    readClaudeUsageLimitConfig({ autoLimitReset: true, setupToken: true }).autoLimitReset,
    false
  );
});

test("account UUID resolution does not fetch bootstrap for a setup-token connection", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 403 });
  }) as typeof fetch;
  try {
    const uuid = resolveAccountUUID(
      { setupToken: true },
      "seed-setup-token-test",
      "sk-ant-oat01-x"
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.match(uuid, /^[0-9a-f-]{36}$/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
