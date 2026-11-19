"use client";

/**
 * Token usage by API key (fork feature).
 *
 * One row per API key for the chosen period: requests, input tokens, output tokens, total and
 * cost, sortable, with totals and CSV export. Reads the lightweight per-key view of
 * /api/usage/analytics (view=apiKeys), so it does not run the full analytics report.
 */

import { useEffect, useMemo, useState } from "react";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";

interface ApiKeyRow {
  apiKey: string;
  apiKeyId: string | null;
  apiKeyName: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

type SortKey =
  "apiKeyName" | "requests" | "promptTokens" | "completionTokens" | "totalTokens" | "cost";

const RANGE_OPTIONS = [
  { value: "today", label: "Today (since 00:00 UTC)" },
  { value: "1d", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "ytd", label: "Year to date" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom dates" },
];

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "apiKeyName", label: "API key", numeric: false },
  { key: "requests", label: "Requests", numeric: true },
  { key: "promptTokens", label: "Input tokens", numeric: true },
  { key: "completionTokens", label: "Output tokens", numeric: true },
  { key: "totalTokens", label: "Total tokens", numeric: true },
  { key: "cost", label: "Cost (USD)", numeric: true },
];

const num = (n: number) => new Intl.NumberFormat().format(Math.round(n || 0));
const usd = (n: number) => `$${(n || 0).toFixed(2)}`;

function compact(n: number): string {
  const v = n || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function buildQuery(range: string, from: string, to: string): string | null {
  const params = new URLSearchParams({ view: "apiKeys" });
  if (range === "today") {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    params.set("range", "all");
    params.set("startDate", start.toISOString());
  } else if (range === "custom") {
    if (!from || !to) return null;
    params.set("range", "all");
    params.set("startDate", new Date(`${from}T00:00:00Z`).toISOString());
    params.set("endDate", new Date(`${to}T23:59:59.999Z`).toISOString());
  } else {
    params.set("range", range);
  }
  return `/api/usage/analytics?${params.toString()}`;
}

function toCsv(rows: ApiKeyRow[]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["API key,Requests,Input tokens,Output tokens,Total tokens,Cost (USD)"];
  for (const r of rows) {
    lines.push(
      [
        r.apiKeyName || r.apiKey,
        r.requests,
        r.promptTokens,
        r.completionTokens,
        r.totalTokens,
        (r.cost || 0).toFixed(6),
      ]
        .map(cell)
        .join(",")
    );
  }
  return lines.join("\n");
}

type FetchResult = { rows: ApiKeyRow[] | null; error: string | null };

async function fetchRows(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || data?.error || "Failed to load");
    return { rows: Array.isArray(data.byApiKey) ? data.byApiKey : [], error: null };
  } catch (e) {
    return { rows: null, error: e instanceof Error ? e.message : "Failed to load usage" };
  }
}

export default function TokenUsageReport() {
  const [range, setRange] = useState("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("totalTokens");
  const [sortDesc, setSortDesc] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  const url = buildQuery(range, from, to);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetchRows(url).then((result) => {
      if (cancelled) return;
      if (result.rows) setRows(result.rows);
      setError(result.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [url, reloadTick]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av || "").localeCompare(String(bv || ""));
      return sortDesc ? -cmp : cmp;
    });
    return copy;
  }, [rows, sortKey, sortDesc]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          requests: acc.requests + (r.requests || 0),
          promptTokens: acc.promptTokens + (r.promptTokens || 0),
          completionTokens: acc.completionTokens + (r.completionTokens || 0),
          totalTokens: acc.totalTokens + (r.totalTokens || 0),
          cost: acc.cost + (r.cost || 0),
        }),
        { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 }
      ),
    [rows]
  );

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(key !== "apiKeyName");
    }
  };

  const exportCsv = () => {
    const blob = new Blob([toCsv(sorted)], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `token-usage-by-api-key-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text-main">Token usage by API key</h1>
        <p className="text-sm text-text-muted">
          Input, output and total tokens per API key for the selected period. Click a column to
          sort.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Select
            label="Period"
            options={RANGE_OPTIONS}
            value={range}
            onChange={(e) => {
              setLoading(true);
              setRange(e.target.value);
            }}
          />
        </div>
        {range === "custom" && (
          <>
            <Input
              label="From"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
        <Button
          variant="outline"
          onClick={() => {
            setLoading(true);
            setReloadTick((t) => t + 1);
          }}
        >
          Refresh
        </Button>
        <Button variant="outline" disabled={rows.length === 0} onClick={exportCsv}>
          Export CSV
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {range === "custom" && !url && (
        <p className="text-sm text-text-muted">Pick a start and end date.</p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ["Input tokens", compact(totals.promptTokens)],
          ["Output tokens", compact(totals.completionTokens)],
          ["Total tokens", compact(totals.totalTokens)],
          ["Requests", num(totals.requests)],
        ].map(([label, value]) => (
          <div key={label} className="p-3 rounded-lg border border-border bg-surface/40">
            <p className="text-xs text-text-muted">{label}</p>
            <p className="text-lg font-semibold text-text-main">{value}</p>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface/60">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => onSort(c.key)}
                  className={`px-3 py-2 font-medium text-text-muted cursor-pointer select-none whitespace-nowrap ${
                    c.numeric ? "text-right" : "text-left"
                  }`}
                >
                  {c.label}
                  {sortKey === c.key ? (sortDesc ? " ▼" : " ▲") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-text-muted">
                  Loading…
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-text-muted">
                  No API key usage in this period.
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={r.apiKeyId || r.apiKey} className="border-t border-border">
                  <td className="px-3 py-2 text-text-main">{r.apiKeyName || r.apiKey}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(r.requests)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(r.promptTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(r.completionTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">
                    {num(r.totalTokens)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(r.cost)}</td>
                </tr>
              ))
            )}
          </tbody>
          {!loading && sorted.length > 0 && (
            <tfoot className="border-t-2 border-border font-medium">
              <tr>
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(totals.requests)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(totals.promptTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {num(totals.completionTokens)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{num(totals.totalTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{usd(totals.cost)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
