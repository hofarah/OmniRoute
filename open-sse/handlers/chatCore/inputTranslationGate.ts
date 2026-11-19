/**
 * chatCore gate for the per-connection input translation feature
 * (open-sse/services/inputTranslation.ts).
 *
 * - Connection without `inputTranslation.enabled` → body unchanged (no work, no DB access).
 * - The translator's own self-loop request (marked with INPUT_TRANSLATION_SKIP_HEADER) is never
 *   translated, so a translator model that routes back to a translating connection cannot recurse.
 * - Already-English text (English target) is sent as is, without a translator call.
 * - Translator failure is fail-open (operator decision): the affected text is sent unchanged and a
 *   warning is logged, instead of failing the request. The `failed: true` / 424
 *   `input_translation_failed` result is kept in the type for callers but no longer produced.
 */

import {
  applyInputTranslation,
  INPUT_TRANSLATION_SKIP_HEADER,
  INPUT_TRANSLATION_SKIP_VALUE,
  resolveInputTranslationConfig,
  type InputTranslationCacheStore,
  type TranslateFn,
} from "../../services/inputTranslation.ts";
import { createErrorResult } from "../../utils/error.ts";
import { getHeaderValueCaseInsensitive } from "./headers.ts";

type LoggerLike =
  | {
      info?: (...args: unknown[]) => void;
      warn?: (...args: unknown[]) => void;
    }
  | null
  | undefined;

export type InputTranslationGateResult<TBody> =
  { failed: true; result: ReturnType<typeof createErrorResult> } | { failed: false; body: TBody };

export async function applyConnectionInputTranslation<TBody>(args: {
  body: TBody;
  providerSpecificData: unknown;
  headers: Record<string, unknown> | Headers | null | undefined;
  log?: LoggerLike;
  translate?: TranslateFn;
  cache?: InputTranslationCacheStore;
}): Promise<InputTranslationGateResult<TBody>> {
  const { body, providerSpecificData, headers, log } = args;
  const cfg = resolveInputTranslationConfig(providerSpecificData);
  if (!cfg) return { failed: false, body };

  const marker = getHeaderValueCaseInsensitive(headers ?? null, INPUT_TRANSLATION_SKIP_HEADER);
  if ((marker || "").trim().toLowerCase() === INPUT_TRANSLATION_SKIP_VALUE) {
    return { failed: false, body };
  }

  try {
    const out = await applyInputTranslation(body, cfg, {
      translate: args.translate,
      cache: args.cache,
    });
    if (out.translated > 0 || out.fromCache > 0 || out.skippedEnglish > 0) {
      log?.info?.(
        "INPUT_TRANSLATION",
        `→ ${cfg.targetLanguage} via ${cfg.model}: ${out.translated} new, ${out.fromCache} cached, ${out.skippedEnglish} already English`
      );
    }
    if (out.failed > 0) {
      log?.warn?.(
        "INPUT_TRANSLATION",
        `failed for ${out.failed} segment(s), sent untranslated: ${out.failureReason ?? "unknown error"}`
      );
    }
    return { failed: false, body: out.body };
  } catch {
    // Unexpected (e.g. cache/DB) error: fail open with the original body.
    log?.warn?.("INPUT_TRANSLATION", "failed unexpectedly, request sent untranslated");
    return { failed: false, body };
  }
}
