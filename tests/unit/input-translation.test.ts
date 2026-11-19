import test from "node:test";
import assert from "node:assert/strict";

const {
  applyInputTranslation,
  collectUserTextSlots,
  resolveInputTranslationConfig,
  InputTranslationError,
} = await import("../../open-sse/services/inputTranslation.ts");
const { applyConnectionInputTranslation } =
  await import("../../open-sse/handlers/chatCore/inputTranslationGate.ts");

const CFG = { model: "openai/gpt-4o-mini", targetLanguage: "German", timeoutMs: 1000 };

function memoryCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: (keys: string[]) => {
      const out = new Map<string, string>();
      for (const k of keys) if (store.has(k)) out.set(k, store.get(k)!);
      return out;
    },
    set: (entries: Array<{ key: string; translated: string }>) => {
      for (const e of entries) store.set(e.key, e.translated);
    },
  };
}

function fakeTranslator() {
  const calls: string[] = [];
  const translate = async (text: string) => {
    calls.push(text);
    return `DE(${text})`;
  };
  return { calls, translate };
}

test("resolveInputTranslationConfig: off unless enabled with model + language", () => {
  assert.equal(resolveInputTranslationConfig(undefined), null);
  assert.equal(resolveInputTranslationConfig({}), null);
  assert.equal(
    resolveInputTranslationConfig({
      inputTranslation: { enabled: false, model: "m", targetLanguage: "German" },
    }),
    null
  );
  assert.equal(
    resolveInputTranslationConfig({ inputTranslation: { enabled: true, model: "m" } }),
    null
  );
  assert.deepEqual(
    resolveInputTranslationConfig({
      inputTranslation: { enabled: true, model: " m ", targetLanguage: " German " },
    }),
    { model: "m", targetLanguage: "German", timeoutMs: 60000 }
  );
});

test("collectUserTextSlots: only user text, all wire formats, skips injected context", () => {
  const chat = {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>ctx</system-reminder>" },
          { type: "text", text: "second" },
          { type: "image_url", image_url: { url: "x" } },
          { type: "tool_result", tool_use_id: "t", content: "result" },
        ],
      },
    ],
  };
  assert.deepEqual(
    collectUserTextSlots(chat).map((s) => s.text),
    ["hello", "second"]
  );

  const responses = {
    instructions: "sys",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions for /x" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>e</environment_context>" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
      { type: "function_call_output", call_id: "c", output: "out" },
      { role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ],
  };
  assert.deepEqual(
    collectUserTextSlots(responses).map((s) => s.text),
    ["fix the bug"]
  );

  assert.deepEqual(
    collectUserTextSlots({ input: "plain string input" }).map((s) => s.text),
    ["plain string input"]
  );

  const gemini = {
    contents: [
      { role: "user", parts: [{ text: "g1" }] },
      { role: "model", parts: [{ text: "m" }] },
    ],
  };
  assert.deepEqual(
    collectUserTextSlots(gemini).map((s) => s.text),
    ["g1"]
  );
});

test("applyInputTranslation: translates user turns, leaves the rest, never mutates input", async () => {
  const cache = memoryCache();
  const { calls, translate } = fakeTranslator();
  const body = {
    model: "gpt",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "a1" },
    ],
  };
  const original = structuredClone(body);
  const out = await applyInputTranslation(body, CFG, { translate, cache });
  assert.deepEqual(body, original, "caller body must not be mutated");
  assert.equal(out.translated, 1);
  assert.deepEqual(calls, ["first"]);
  assert.equal((out.body as typeof body).messages[1].content, "DE(first)");
  assert.equal((out.body as typeof body).messages[0].content, "sys");
  assert.equal((out.body as typeof body).messages[2].content, "a1");
});

test("applyInputTranslation: earlier user turns come from cache, only the new turn is translated", async () => {
  const cache = memoryCache();
  const { calls, translate } = fakeTranslator();

  await applyInputTranslation({ messages: [{ role: "user", content: "first" }] }, CFG, {
    translate,
    cache,
  });
  assert.deepEqual(calls, ["first"]);

  const turn2 = {
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "second" },
    ],
  };
  const out = await applyInputTranslation(turn2, CFG, { translate, cache });
  assert.deepEqual(calls, ["first", "second"], "first must not be translated again");
  assert.equal(out.translated, 1);
  assert.equal(out.fromCache, 1);
  const msgs = (out.body as typeof turn2).messages;
  assert.equal(msgs[0].content, "DE(first)");
  assert.equal(msgs[4].content, "DE(second)");

  // Already-translated text sent back is recognised (identity entry) — no new call.
  await applyInputTranslation({ messages: [{ role: "user", content: "DE(second)" }] }, CFG, {
    translate,
    cache,
  });
  assert.equal(calls.length, 2);
});

test("applyInputTranslation: cache is scoped by target language and model", async () => {
  const cache = memoryCache();
  const { calls, translate } = fakeTranslator();
  const body = { messages: [{ role: "user", content: "hi" }] };
  await applyInputTranslation(body, CFG, { translate, cache });
  await applyInputTranslation(body, { ...CFG, targetLanguage: "French" }, { translate, cache });
  await applyInputTranslation(body, { ...CFG, model: "other/model" }, { translate, cache });
  assert.equal(calls.length, 3);
});

test("applyInputTranslation: translator failure propagates", async () => {
  const translate = async () => {
    throw new InputTranslationError("boom");
  };
  await assert.rejects(
    applyInputTranslation({ messages: [{ role: "user", content: "x" }] }, CFG, {
      translate,
      cache: memoryCache(),
    }),
    InputTranslationError
  );
});

test("gate: no config → body untouched (same reference)", async () => {
  const body = { messages: [{ role: "user", content: "x" }] };
  const out = await applyConnectionInputTranslation({
    body,
    providerSpecificData: {},
    headers: null,
  });
  assert.equal(out.failed, false);
  assert.equal(out.failed === false && out.body, body);
});

test("gate: translator self-loop request (skip header) is never translated", async () => {
  const body = { messages: [{ role: "user", content: "x" }] };
  let called = false;
  const out = await applyConnectionInputTranslation({
    body,
    providerSpecificData: {
      inputTranslation: { enabled: true, model: "m", targetLanguage: "German" },
    },
    headers: new Headers({ "x-omniroute-input-translation": "skip" }),
    translate: async () => {
      called = true;
      return "t";
    },
  });
  assert.equal(called, false);
  assert.equal(out.failed === false && out.body, body);
});

test("gate: translator failure → 424 input_translation_failed error result", async () => {
  const out = await applyConnectionInputTranslation({
    body: { messages: [{ role: "user", content: "unique-text-for-gate-failure-test" }] },
    providerSpecificData: {
      inputTranslation: { enabled: true, model: "m", targetLanguage: "German" },
    },
    headers: null,
    cache: memoryCache(),
    translate: async () => {
      throw new InputTranslationError('translator model "m" returned HTTP 500');
    },
  });
  assert.equal(out.failed, true);
  if (out.failed) {
    assert.equal(out.result.status, 424);
    // chat.ts keys on this code to never cool down the target account for a translator failure.
    assert.equal(out.result.errorCode, "input_translation_failed");
    const json = await out.result.response.json();
    assert.match(JSON.stringify(json), /Input translation failed/);
  }
});
