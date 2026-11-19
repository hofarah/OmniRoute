"use client";

/**
 * Per-API-key token limits editor (fork feature).
 *
 * Lists the key's token budgets with current-window usage and lets the operator add/remove one.
 * Each budget counts total, input-only or output-only (output + reasoning) tokens, for the whole
 * key or one provider/model, and resets daily / weekly / monthly. Saves immediately through
 * /api/usage/token-limits — independent of the access form's Save button.
 */

import { useCallback, useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";

type TokenType = "total" | "input" | "output";
type ScopeType = "global" | "provider" | "model";
type ResetInterval = "daily" | "weekly" | "monthly";

interface TokenLimitRow {
  id: string;
  scopeType: ScopeType;
  scopeValue: string;
  tokenType?: TokenType;
  tokenLimit: number;
  resetInterval: ResetInterval;
  enabled: boolean;
  tokensUsed: number;
  remaining: number;
  nextResetAt: number;
}

const TOKEN_TYPE_OPTIONS = [
  { value: "input", label: "Input tokens" },
  { value: "output", label: "Output tokens" },
  { value: "total", label: "Total tokens (input + output)" },
];
const INTERVAL_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];
const SCOPE_OPTIONS = [
  { value: "global", label: "All models" },
  { value: "provider", label: "One provider" },
  { value: "model", label: "One model" },
];

const fmt = (n: number) => new Intl.NumberFormat().format(n);
const typeLabel = (t?: TokenType) =>
  t === "input" ? "Input" : t === "output" ? "Output" : "Total";

function scopeLabel(row: TokenLimitRow): string {
  if (row.scopeType === "global") return "all models";
  return `${row.scopeType} ${row.scopeValue}`;
}

type FetchResult = { limits: TokenLimitRow[] | null; error: string | null };

async function fetchLimits(apiKeyId: string): Promise<FetchResult> {
  try {
    const res = await fetch(`/api/usage/token-limits?apiKeyId=${encodeURIComponent(apiKeyId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || data?.error || "Failed to load");
    return { limits: Array.isArray(data.limits) ? data.limits : [], error: null };
  } catch (e) {
    return { limits: null, error: e instanceof Error ? e.message : "Failed to load token limits" };
  }
}

export default function TokenLimitsSection({ apiKeyId }: { apiKeyId: string }) {
  const [limits, setLimits] = useState<TokenLimitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tokenType, setTokenType] = useState<TokenType>("input");
  const [tokenLimit, setTokenLimit] = useState("");
  const [resetInterval, setResetInterval] = useState<ResetInterval>("daily");
  const [scopeType, setScopeType] = useState<ScopeType>("global");
  const [scopeValue, setScopeValue] = useState("");

  const apply = useCallback((result: FetchResult) => {
    if (result.limits) setLimits(result.limits);
    setError(result.error);
    setLoading(false);
  }, []);

  const load = useCallback(async () => apply(await fetchLimits(apiKeyId)), [apiKeyId, apply]);

  useEffect(() => {
    let cancelled = false;
    fetchLimits(apiKeyId).then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apiKeyId, apply]);

  const add = async () => {
    const parsed = Number.parseInt(tokenLimit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a token limit greater than zero.");
      return;
    }
    if (scopeType !== "global" && !scopeValue.trim()) {
      setError(`Enter the ${scopeType} this limit applies to.`);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/usage/token-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKeyId,
          tokenType,
          tokenLimit: parsed,
          resetInterval,
          scopeType,
          scopeValue: scopeType === "global" ? "" : scopeValue.trim(),
          enabled: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.error || "Failed to save");
      setTokenLimit("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save token limit");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/usage/token-limits?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete token limit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg border border-border bg-surface/40">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-text-main">Token limits</p>
        <p className="text-xs text-text-muted">
          Block this key once it uses more than a number of input, output or total tokens in a day,
          week or month. Output counts reasoning tokens too. Changes here save immediately.
        </p>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {loading ? (
        <p className="text-xs text-text-muted">Loading…</p>
      ) : limits.length === 0 ? (
        <p className="text-xs text-text-muted">No token limits set.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {limits.map((row) => {
            const pct =
              row.tokenLimit > 0 ? Math.min(100, (row.tokensUsed / row.tokenLimit) * 100) : 0;
            return (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 p-2 rounded border border-border"
              >
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <p className="text-sm text-text-main">
                    {typeLabel(row.tokenType)} · {fmt(row.tokenLimit)} / {row.resetInterval} ·{" "}
                    {scopeLabel(row)}
                  </p>
                  <div className="h-1.5 rounded bg-border overflow-hidden">
                    <div
                      className={`h-full ${pct >= 100 ? "bg-red-500" : "bg-primary"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-xs text-text-muted">
                    {fmt(row.tokensUsed)} used · {fmt(row.remaining)} left · resets{" "}
                    {new Date(row.nextResetAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void remove(row.id)}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border">
        <Select
          label="Count"
          options={TOKEN_TYPE_OPTIONS}
          value={tokenType}
          onChange={(e) => setTokenType(e.target.value as TokenType)}
        />
        <Input
          label="Limit (tokens)"
          type="number"
          min={1}
          step={1}
          value={tokenLimit}
          placeholder="1000000"
          onChange={(e) => setTokenLimit(e.target.value)}
        />
        <Select
          label="Resets"
          options={INTERVAL_OPTIONS}
          value={resetInterval}
          onChange={(e) => setResetInterval(e.target.value as ResetInterval)}
        />
        <Select
          label="Applies to"
          options={SCOPE_OPTIONS}
          value={scopeType}
          onChange={(e) => setScopeType(e.target.value as ScopeType)}
        />
        {scopeType !== "global" && (
          <Input
            label={scopeType === "provider" ? "Provider id" : "Model id"}
            value={scopeValue}
            placeholder={scopeType === "provider" ? "codex" : "gpt-6.1-sol"}
            onChange={(e) => setScopeValue(e.target.value)}
          />
        )}
      </div>
      <div>
        <Button size="sm" disabled={saving} onClick={() => void add()}>
          Add token limit
        </Button>
      </div>
    </div>
  );
}
