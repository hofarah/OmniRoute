"use client";

import { Input, Toggle } from "@/shared/components";

/** Per-connection input translation settings (fork feature, see open-sse/services/inputTranslation.ts). */
export interface InputTranslationFormValue {
  enabled: boolean;
  model: string;
  targetLanguage: string;
}

export const EMPTY_INPUT_TRANSLATION: InputTranslationFormValue = {
  enabled: false,
  model: "",
  targetLanguage: "",
};

export function inputTranslationFromProviderData(value: unknown): InputTranslationFormValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_INPUT_TRANSLATION };
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    model: typeof record.model === "string" ? record.model : "",
    targetLanguage: typeof record.targetLanguage === "string" ? record.targetLanguage : "",
  };
}

/** `null` clears the stored block (the PUT route merges `{ ...existing, ...incoming }`). */
export function normalizeInputTranslationForSave(
  value: InputTranslationFormValue
): { enabled: boolean; model: string; targetLanguage: string } | null {
  const model = value.model.trim();
  const targetLanguage = value.targetLanguage.trim();
  if (!value.enabled && !model && !targetLanguage) return null;
  return { enabled: value.enabled && !!model && !!targetLanguage, model, targetLanguage };
}

export default function InputTranslationEditor({
  value,
  onChange,
}: {
  value: InputTranslationFormValue;
  onChange: (next: InputTranslationFormValue) => void;
}) {
  const incomplete = value.enabled && (!value.model.trim() || !value.targetLanguage.trim());
  return (
    <div className="flex flex-col gap-3">
      <Toggle
        checked={value.enabled}
        onChange={(checked) => onChange({ ...value, enabled: checked })}
        label="Translate user input"
        description="Before a request is sent to this connection, user messages are translated into the target language by another model. Already-translated turns are cached and never re-translated. If translation fails the request fails."
      />
      {value.enabled && (
        <div className="flex flex-col gap-3 pl-2 border-l-2 border-border">
          <Input
            label="Translator model"
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            placeholder="openai/gpt-4o-mini"
            hint="Any model or combo OmniRoute can route (provider/model), e.g. an OpenAI-compatible or Anthropic connection."
          />
          <Input
            label="Target language"
            value={value.targetLanguage}
            onChange={(e) => onChange({ ...value, targetLanguage: e.target.value })}
            placeholder="German"
          />
          {incomplete && (
            <p className="text-xs text-red-500">
              Set both a translator model and a target language, otherwise translation stays off.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
