/**
 * Claude `setup-token` connections (fork feature).
 *
 * `claude setup-token` mints a 1-year OAuth token scoped to `user:inference` only: chat works, but
 * every account endpoint (`/api/oauth/usage`, `/api/claude_cli/bootstrap`, org limit reset)
 * answers 403. OmniRoute must therefore never call those endpoints automatically for such a
 * connection — the calls can only fail, and unexplained 403 traffic on an account is a ban risk.
 *
 * Detection:
 *  - `providerSpecificData.setupToken === true` — set when a setup token is imported;
 *  - or a Claude OAuth connection whose stored refresh token is explicitly empty (regular Claude
 *    OAuth logins always carry one). Only applied when the caller actually passed the
 *    `refreshToken` field, so a caller that strips it can never disable a normal account's quota.
 */

type ConnectionLike = {
  provider?: unknown;
  authType?: unknown;
  refreshToken?: unknown;
  providerSpecificData?: unknown;
};

export const CLAUDE_SETUP_TOKEN_USAGE_MESSAGE =
  "Claude setup-token connection: quota/usage is not available for this token type (inference-only scope), so it is not polled.";

export function isClaudeSetupTokenData(providerSpecificData: unknown): boolean {
  return (
    !!providerSpecificData &&
    typeof providerSpecificData === "object" &&
    (providerSpecificData as Record<string, unknown>).setupToken === true
  );
}

export function isClaudeSetupTokenConnection(
  connection: ConnectionLike | null | undefined
): boolean {
  if (!connection || connection.provider !== "claude") return false;
  if (isClaudeSetupTokenData(connection.providerSpecificData)) return true;
  if (connection.authType !== undefined && connection.authType !== "oauth") return false;
  if (!("refreshToken" in connection)) return false;
  const refresh = connection.refreshToken;
  return refresh === null || refresh === "" || (typeof refresh === "string" && !refresh.trim());
}
