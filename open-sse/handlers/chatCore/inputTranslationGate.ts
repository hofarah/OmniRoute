/**
 * chatCore gate for the per-connection input translation feature
 * (open-sse/services/inputTranslation.ts).
 *
 * - Connection without `inputTranslation.enabled` → body unchanged (no work, no DB access).
 * - The translator's own self-loop request (marked with INPUT_TRANSLATION_SKIP_HEADER) is never
 *   translated, so a translator model that routes back to a translating connection cannot recurse.
 * - Translator failure → labelled 424 `input_translation_failed` error (user asked for "error",
 *   never a silent fallback to the original text). 424 deliberately avoids the 5xx statuses that
 *   trip the provider circuit breaker: the target provider did nothing wrong.
 */

import {
  applyInputTranslation,
  InputTranslationError,
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
    if (out.translated > 0 || out.fromCache > 0) {
      log?.info?.(
        "INPUT_TRANSLATION",
        `→ ${cfg.targetLanguage} via ${cfg.model}: ${out.translated} new, ${out.fromCache} cached`
      );
    }
    return { failed: false, body: out.body };
  } catch (error) {
    const reason =
      error instanceof InputTranslationError ? error.message : "unexpected translation error";
    log?.warn?.("INPUT_TRANSLATION", `failed: ${reason}`);
    return {
      failed: true,
      result: createErrorResult(
        424,
        `Input translation failed: ${reason}`,
        null,
        "input_translation_failed",
        "input_translation_error"
      ),
    };
  }
}
