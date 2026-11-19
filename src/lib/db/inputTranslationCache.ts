/**
 * inputTranslationCache.ts — persistence for per-connection input translation.
 *
 * Maps sha256(translator model + target language + original user text) → translated text, so a
 * user turn is translated exactly once: clients (Codex, Claude Code, …) resend the full original
 * history on every request and each earlier user turn is swapped for its cached translation
 * without a new translator call.
 *
 * Fork-only feature: the table is created lazily (CREATE TABLE IF NOT EXISTS) instead of through a
 * numbered migration so future upstream merges can never collide on a migration version.
 */

import { getDbInstance } from "./core";

let ensuredFor: unknown = null;

function ensureTable() {
  const db = getDbInstance();
  if (ensuredFor === db) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS input_translation_cache (
      cache_key TEXT PRIMARY KEY,
      translated TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_input_translation_cache_last_used
      ON input_translation_cache (last_used_at);
  `);
  ensuredFor = db;
  return db;
}

/** Returns key → translated text for every key that has a cached entry. */
export function getInputTranslations(keys: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (keys.length === 0) return result;
  const db = ensureTable();
  const select = db.prepare("SELECT translated FROM input_translation_cache WHERE cache_key = ?");
  const touch = db.prepare(
    "UPDATE input_translation_cache SET last_used_at = ? WHERE cache_key = ?"
  );
  const now = Date.now();
  for (const key of new Set(keys)) {
    const row = select.get(key) as { translated?: string } | undefined;
    if (row && typeof row.translated === "string") {
      result.set(key, row.translated);
      touch.run(now, key);
    }
  }
  return result;
}

export function setInputTranslations(entries: Array<{ key: string; translated: string }>): void {
  if (entries.length === 0) return;
  const db = ensureTable();
  const upsert = db.prepare(
    `INSERT INTO input_translation_cache (cache_key, translated, created_at, last_used_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET translated = excluded.translated,
       last_used_at = excluded.last_used_at`
  );
  const now = Date.now();
  const tx = db.transaction((rows: Array<{ key: string; translated: string }>) => {
    for (const row of rows) upsert.run(row.key, row.translated, now, now);
  });
  tx(entries);
}

/** Drops entries not used for `maxAgeMs` (default 90 days). Returns the number deleted. */
export function pruneInputTranslations(maxAgeMs = 90 * 24 * 60 * 60 * 1000): number {
  const db = ensureTable();
  const info = db
    .prepare("DELETE FROM input_translation_cache WHERE last_used_at < ?")
    .run(Date.now() - maxAgeMs);
  return Number(info.changes ?? 0);
}
