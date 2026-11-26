import * as util from "node:util";

const Q = (fn) => {
  try {
    return fn();
  } catch {}
};

const overwrite = (obj, prop, val) => {
  Object.defineProperty(obj, prop, {
    value: val,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return obj;
};

const assign = (object, key, value) => {
  try {
    object[key] = value;
  } catch {
    Q(() => overwrite(object, key, value));
  }
  return object;
};

const assignAll = (target, ...srcs) => {
  for (const src of srcs) {
    for (const key in src) {
      assign(target, key, src[key]);
    }
    for (const key of Reflect.ownKeys(src)) {
      assign(target, key, src[key]);
    }
  }
  return target;
};

const flattenObject = (req) => {
  req = Object(req);
  const obj = {};
  for (const key in req) {
    if (typeof req[key] !== "function") {
      obj[key] = req[key];
    }
  }
  for (const key of Reflect.ownKeys(req)) {
    if (typeof req[key] !== "function") {
      obj[String(key)] = req[key];
    }
  }
  return obj;
};

const flattenArray = (arr) => {
  return assignAll({}, arr, ...arr.map(flattenObject));
};

const instanceOf = (value, constructor) =>
  Q(() => value instanceof constructor) || false;

const isString = (value) =>
  typeof value === "string" || instanceOf(value, String);

const isArray = (value) =>
  Q(() => Array.isArray(value) || instanceOf(value, Array)) || false;

const isObject = (value) => typeof value === "object" && value !== null;

const randId = () =>
  Q(() => crypto.randomUUID()) ?? String(Math.random()).replace("0.", "");

const stringify = (value) => {
  try {
    if (isString(value)) return String(value);
    return String(JSON.stringify(flattenObject(value)));
  } catch {
    try {
      return String(value);
    } catch {
      try {
        return String(util.inspect(value));
      } catch (e) {
        try {
          return String(e);
        } catch {
          return "";
        }
      }
    }
  }
};

const decoder = new TextDecoder();
const _decode = decoder.decode.bind(decoder);
const decode = bytes =>
  Q(() => _decode(bytes)) ??
  Q(() => _decode(new Uint8Array(bytes))) ??
  stringify(bytes);

const encoder = new TextEncoder();
const _encode = encoder.encode.bind(encoder);
const encode = text =>
  Q(() => !isString(text) ? new Uint8Array(text) : undefined) ??
  _encode(stringify(text));

function _parseTruncatedJSON(text) {
  text = stringify(text);

  const backslash = String.fromCharCode(92);
  const stack = [];
  let index = 0;
  let result;
  let hasRoot = false;

  function isWhitespace(char) {
    const code = char?.charCodeAt(0);
    return code === 32 || code === 9 || code === 13 || code === 10;
  }

  let contentEnd = text.length;
  while (contentEnd > 0 && isWhitespace(text[contentEnd - 1])) contentEnd--;
  if (text.endsWith("...", contentEnd)) {
    text = text.slice(0, contentEnd - 3);
  }

  function skipWhitespace() {
    while (index < text.length && isWhitespace(text[index])) {
      index++;
    }
  }

  function readString() {
    index++; // Opening quote.
    const chars = [];
    const escapes = {
      '"': '"',
      [backslash]: backslash,
      "/": "/",
      b: String.fromCharCode(8),
      f: String.fromCharCode(12),
      n: String.fromCharCode(10),
      r: String.fromCharCode(13),
      t: String.fromCharCode(9),
    };
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') return { value: chars.join(""), complete: true };
      if (char !== backslash) {
        chars.push(char);
        continue;
      }
      if (index === text.length) {
        chars.push(backslash);
        break;
      }
      const escape = text[index++];
      if (escape === "u") {
        let hex = "";
        for (let digit = 0; digit < 4; digit++) {
          if (index === text.length) {
            chars.push(backslash + "u" + hex);
            return { value: chars.join(""), complete: false };
          }
          if (!/[0-9a-fA-F]/.test(text[index])) break;
          hex += text[index++];
        }
        chars.push(String.fromCharCode(parseInt(hex.padStart(4, "0"), 16)));
      } else if (Object.hasOwn(escapes, escape)) {
        chars.push(escapes[escape]);
      } else {
        chars.push(backslash + escape);
      }
    }
    return { value: chars.join(""), complete: false };
  }

  function readToken() {
    const start = index;
    while (
      index < text.length &&
      !isWhitespace(text[index]) &&
      !'{}[],:"'.includes(text[index])
    ) {
      index++;
    }
    return text.slice(start, index);
  }

  function readScalar() {
    if (text[index] === '"') return readString().value;
    const token = readToken();
    if (token[0] === "t") return true;
    if (token[0] === "f") return false;
    if (token[0] === "n") return null;
    if (token === "-") return null;
    const number = parseFloat(token);
    return Number.isNaN(number) ? token : number;
  }

  function attach(value) {
    const parent = stack[stack.length - 1];
    if (!parent) {
      result = value;
      hasRoot = true;
    } else if (parent.kind === "array") {
      parent.value.push(value);
      parent.state = "separator";
    } else {
      // Assignment would invoke the inherited __proto__ setter.
      Object.defineProperty(parent.value, parent.key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      parent.state = "separator";
    }
  }

  while (true) {
    skipWhitespace();
    let frame = stack[stack.length - 1];
    if (index === text.length) {
      if (
        frame?.kind === "object" &&
        (frame.state === "colon" || frame.state === "value")
      ) {
        attach(null);
      }
      return result;
    }
    const char = text[index];

    // Either closer ends the current frame. Unmatched closers are ignored.
    if (char === "]" || char === "}") {
      if (
        frame?.kind === "object" &&
        (frame.state === "colon" || frame.state === "value")
      ) {
        attach(null);
      }
      stack.pop();
      index++;
      continue;
    }

    if (!frame && hasRoot && char !== "," && char !== ":") {
      if (result === null || typeof result !== "object") result = [result];
      frame = {
        kind: isArray(result) ? "array" : "object",
        value: result,
        state: "separator",
      };
      stack.push(frame);
    }

    if (char === ",") {
      if (
        frame?.kind === "object" &&
        (frame.state === "colon" || frame.state === "value")
      ) {
        attach(null);
      } else if (
        frame?.kind === "array" &&
        (frame.state === "first" || frame.state === "value")
      ) {
        attach(null);
      }
      if (frame) frame.state = frame.kind === "array" ? "value" : "key";
      index++;
      continue;
    }
    if (char === ":") {
      if (frame?.state === "colon") frame.state = "value";
      index++;
      continue;
    }

    if (frame?.state === "separator")
      frame.state = frame.kind === "array" ? "value" : "key";
    if (
      frame?.kind === "object" &&
      (frame?.state === "first" || frame?.state === "key")
    ) {
      // Structural openers in a key slot are literal one-character keys.
      frame.key =
        char === '"' ?
        readString().value :
        char === "{" || char === "[" ?
        text[index++] :
        readToken();
      frame.state = "colon";
      continue;
    }
    if (frame?.state === "colon") {
      frame.state = "value";
    }

    if (char === "{" || char === "[") {
      const value = char === "{" ? {} : [];
      attach(value);
      stack.push({
        kind: char === "{" ? "object" : "array",
        value,
        state: "first",
      });
      index++;
    } else {
      attach(readScalar());
    }
  }
}

function parseTruncatedJSON(text) {
  text = stringify(text);
  const json = _parseTruncatedJSON(text);
  if(isArray(json) && !text.trim().startsWith('[')){
    let obj = {};
    if(json.some(isArray)){
      obj = [];
    }
    for(const x of json){
      if(isArray(x)){
        for(const y of x){
          obj.push(y);
        }
      }else if(isObject(x)){
        for(const key in x){
          obj[key] = x[key];
        }
      }else{
        obj[x] = obj[x] ?? x;
      }
    }
    return obj;
  }
  return json;
}

const safeStatusText = (value) =>
  Q(() => {
    const bytes = encode(String(value)).slice(0, 200);
    const latin1 = String.fromCharCode(...bytes);
    const flat = JSON.stringify(latin1.replaceAll(/\s+/g, " "));
    return flat.replaceAll(String.fromCharCode(127), "DEL");
  }) ?? "";

const isNullish = (x) => x === null || x === undefined;

async function bestEffortResponse(response) {
  try {
    const originalResponse = response;
    if (!originalResponse.body) {
      return originalResponse;
    }
    const originalReader = Q(() => originalResponse.body.getReader());
    const resilientStream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await originalReader.read();

          if (done == true || (isNullish(done) && isNullish(value))) {
            Q(() => controller.close());
          } else {
            controller.enqueue(value);
          }
        } catch (streamError) {
          // A mid-stream network drop or timeout caught here!
          Q(() => controller.enqueue(encode(String(streamError))));
          console.warn(
            "Stream interrupted prematurely. Closing stream gracefully with partial data.",
            streamError,
          );

          Q(() => controller?.close?.()?.catch?.(() => {}));
        }
      },
      cancel(reason) {
        Q(() => originalReader?.cancel?.(reason)?.catch?.(() => {}));
      },
    });
    return new Response(resilientStream, {
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers: originalResponse.headers,
    });
  } catch (e) {
    return new Response(String(e), {
      status: 500,
      statusText: safeStatusText(e),
    });
  }
}

async function bestEffortFetch(input, init) {
  try {
    const originalResponse = await fetch(input, init);
    return await bestEffortResponse(originalResponse);
  } catch (e) {
    return new Response(String(e), {
      status: 500,
      statusText: safeStatusText(e),
    });
  }
}

async function $bytes(res) {
  const chunks = [];
  let reader;
  try {
    reader = res?.body?.getReader?.();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done == true || (isNullish(done) && isNullish(value))) {
          break;
        }
        chunks.push(value);
      }
    }
  } catch (e) {
    chunks.push(encode(String(e)));
  } finally {
    Q(() => reader?.releaseLock?.()?.catch?.(() => {}));
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

async function $text(res) {
  try {
    if (!res.body) {
      return res.statusText || "";
    }
    return decode(await $bytes(res));
  } catch (e) {
    return String(e);
  }
}

const toObj = (obj) => {
  if (isString(obj)) {
    obj = assignAll(Object(obj), Object(parseTruncatedJSON(obj)));
  }
  if (isArray(obj)) {
    return flattenArray(obj);
  }
  return Object(obj);
};

const toArr = (arr) => {
  if (!isArray(arr)) {
    if (isString(arr)) {
      return [assignAll(Object(arr), parseTruncatedJSON(arr))];
    }
    if (arr?.[Symbol.iterator]) {
      arr = [...arr].map(Object);
    } else {
      arr = [Object(arr)];
    }
  }
  return arr;
};

const fetchResponse = async (...args) => {
  try {
    return await bestEffortFetch(...args);
  } catch (e) {
    return new Response(String(e), {
      status: 500,
      statusText: safeStatusText(e),
    });
  }
};

// Stateless Chat Completions -> Gemini Live bridge. One session per request.
const ENDPOINT =
  "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODEL = "gemini-3.8-live";

class ApiError extends Error {
  constructor(status, message, param = null) {
    super(message);
    this.status = status;
    this.param = param;
  }
}

const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

function geminiKey(request) {
  const token = /^Bearer[ \t]+([^\s]+)$/i.exec(
    request?.headers?.get?.("Authorization") || "",
  )?.[1];
  return String(token);
}

async function readJson(message) {
  const text = await $text(message);
  return parseTruncatedJSON(text);
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !isArray(value);
const functionName = (value) => isString(value) && value.trim().length > 0;
const callId = functionName;

function textParts(content) {
  if (content == null) return [];
  if (isString(content)) return [{ text: content }];
  return toArr(content).map((part) => ({
    text: stringify(part?.text ?? part),
  }));
}

function numeric(value) {
  const number = parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
}

// Copy all tool data, including unknown schema keywords and defaults.
// No mutation, evaluation, reference resolution, or instance validation.
function toolData(value, param, wrapArguments = false) {
  if (isString(value)) {
    try {
      value = JSON.parse(value);
    } catch {
      value = parseTruncatedJSON(value, param);
    }
  }
  if (wrapArguments && !isPlainObject(value)) {
    value = { value };
  }

  function copy(value) {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    if (value === null || typeof value !== "object") return value;
    if (isArray(value)) return value.map(copy);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, copy(child)]),
    );
  }
  return copy(value);
}

function parametersSchema(value) {
  const schema = toolData(value, "tools");
  // Like translateRequest in chat-interactions, do not impose type:object or
  // rewrite schema keywords. Only non-schema roots use the empty-schema fallback.
  return isPlainObject(schema) || typeof schema === "boolean" ?
    schema : { type: "object", properties: {} };
}

function argumentsObject(value) {
  // Sibling defaults raw null/missing arguments, but preserves parsed JSON null.
  // Live functionCall.args is a Struct. Preserve nonobjects under a single key
  // rather than dropping array elements, false, zero, or recovered text.
  return toolData(value ?? {}, "messages", true);
}

const requestFields = new Set([
  "model", "messages", "tools", "tool_choice", "temperature", "top_p",
  "max_completion_tokens", "max_tokens", "stream", "stream_options", "n",
]);
const messageFields = new Set([
  "role", "content", "audio", "tool_calls", "function_call", "tool_call_id", "name",
]);
const toolFields = new Set(["type", "function"]);
const functionFields = new Set(["name", "description", "parameters"]);
const callFields = new Set(["id", "type", "function"]);
const callFunctionFields = new Set(["name", "arguments"]);
const partFields = new Set(["type", "text"]);
const privateField = /^(?:authorization|proxy_authorization|headers|cookies?|api_?key|gemini_api_key|access_token|refresh_token|token|password|secret|credentials|url|endpoint|timeout(?:_ms)?|signal)$/i;
const contextData = (value) => {
  if (isArray(value)) return value.map(contextData);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateField.test(key.replaceAll("-", "_")))
    .map(([key, child]) => [key, contextData(child)]));
};
const extraFields = (value, known) => contextData(Object.fromEntries(
  Object.entries(Object(value)).filter(([key]) => !known.has(key)),
));

export function translate(body) {
  body = Object(body);
  const extras = [];
  const collect = (source, value, known) => {
    const fields = extraFields(value, known);
    if (Object.keys(fields).length) extras.push({ source, fields });
  };
  // Without messages, the body itself is treated as message content.
  if (body.messages != null) collect("request", body, requestFields);
  const model = isString(body.model) ?
    body.model.trim().replace(/^models\//, "") || MODEL :
    MODEL;
  body.messages = toArr(body.messages ?? body);
  const declarations = [];
  if (body?.tools != null) {
    body.tools = toArr(body.tools).map(Object);
    for (const [index, tool] of body?.tools?.entries?.()??[]) {
      const fn = tool?.function;
      collect(`tools[${index}]`, tool, toolFields);
      collect(`tools[${index}].function`, fn, functionFields);
      const parametersJsonSchema = parametersSchema(fn?.parameters);
      declarations.push({
        name: fn?.name,
        ...(isString(fn?.description) ? {
          description: fn?.description,
        } : {}),
        parametersJsonSchema,
        behavior: "BLOCKING",
      });
    }
  }
  const turns = [];
  const instructions = [];
  const ids = new Set();
  const pending = new Map();
  let resolvedToolFollowup = false;
  const pendingAsText = () => {
    for (const turn of turns) {
      turn.parts = turn.parts.map((part) =>
        part.functionCall && pending.has(part.functionCall.id) ? {
          text: `tool_call:${stringify(part.functionCall)}`,
        } :
        part,
      );
    }
    pending.clear();
  };
  let messageIndex = 0;
  for (const originalMessage of toArr(body.messages ?? body ?? [])) {
    const source = `messages[${messageIndex}]`;
    if (isPlainObject(originalMessage)) {
      collect(source, originalMessage, messageFields);
      const content = originalMessage.content;
      for (const [index, part] of (isArray(content) ? content : [content]).entries()) {
        if (isPlainObject(part) && part.text != null)
          collect(`${source}.content[${index}]`, part, partFields);
      }
      for (const [index, call] of toArr(originalMessage.tool_calls ?? []).entries()) {
        collect(`${source}.tool_calls[${index}]`, call, callFields);
        collect(`${source}.tool_calls[${index}].function`, call?.function, callFunctionFields);
      }
    }
    messageIndex++;
    const message = { ...originalMessage };
    if (message?.function_call != null) {
      if (!message.tool_calls?.length) {
        message.tool_calls = [{
          id: `call_${randId()}`,
          type: "function",
          function: message?.function_call,
        }, ];
      }
      message.role = "assistant";
      delete message.function_call;
    }
    if (message.role === "function") {
      message.role = "tool";
    }
    if (
      !["system", "developer", "user", "assistant", "tool"].includes(
        message.role,
      )
    ) {
      message.role = "user";
    }
    if (message.audio != null) {
      message.content = [
          ...textParts(message.content),
          {
            text: `audio:${stringify(message.audio)}`,
          },
        ]
        .map((part) => part.text)
        .join("\n");
      delete message.audio;
    }

    message.tool_calls &&= toArr(message.tool_calls);

    if (message.role === "tool") {
      if (!callId(message.tool_call_id)) {
        const matches = [...pending].filter(
          ([, name]) => !functionName(message.name) || name === message.name,
        );
        if (matches.length === 1) message.tool_call_id = matches[0][0];
      }
      const name = pending.get(message.tool_call_id);
      resolvedToolFollowup = Boolean(name);
      if (!name) {
        turns.push({
          role: "user",
          parts: [{
            text: `tool_result:${stringify(message)}`,
          }, ],
        });
        continue;
      }
      // Preserve frontend results verbatim; history is sent as text, not a Struct.
      const result = message.content ?? null;
      const part = {
        functionResponse: {
          id: message.tool_call_id,
          name,
          response: isPlainObject(result) ? result : { result },
        },
      };
      if (turns.at(-1)?.parts?.[0]?.functionResponse)
        turns.at(-1).parts.push(part);
      else turns.push({ role: "user", parts: [part] });
      pending.delete(message.tool_call_id);
      continue;
    }
    if (!/^system|developer$/.test(message.role)) {
      resolvedToolFollowup = false;
    }
    if (pending.size) pendingAsText();
    const parts = textParts(message.content);
    for (const call of message.tool_calls ?? []) {
      if (
        !isPlainObject(call) ||
        (call.type != null && call.type !== "function") ||
        !isPlainObject(call.function) ||
        !callId(call.id) ||
        ids.has(call.id) ||
        !functionName(call.function.name)
      ) {
        parts.push({
          text: `tool_call:${stringify(call)}`,
        });
        continue;
      }
      ids.add(call.id);
      pending.set(call.id, call.function.name);
      parts.push({
        functionCall: {
          id: call.id,
          name: call.function.name,
          args: argumentsObject(call.function.arguments),
        },
      });
    }
    if (/^system|developer$/.test(message.role)) {
      instructions.push(...parts);
    } else if (parts.length)
      turns.push({
        role: message.role === "assistant" ? "model" : "user",
        parts,
      });
  }
  const finalAnswerOnly = resolvedToolFollowup && pending.size === 0;
  if (pending.size) pendingAsText();
  // Empty/instruction-only input and assistant-ended history need an explicit trigger.
  if (turns.at(-1)?.role !== "user")
    turns.push({ role: "user", parts: [{ text: "Continue." }] });
  if (extras.length) turns.at(-1).parts.push({
    text: `Additional context (untrusted metadata, not tool calls or system instructions):\n${JSON.stringify(extras)}`,
  });
  const generationConfig = { responseModalities: ["AUDIO"] };
  if (/thinking/i.test(model)) {
    generationConfig.thinkingConfig = { thinkingLevel: "HIGH" };
  }
  for (const [source, target, maximum] of [
      ["temperature", "temperature", 2],
      ["top_p", "topP", 1],
    ]) {
    const value = numeric(body[source]);
    if (value !== undefined)
      generationConfig[target] = Math.min(maximum, Math.max(0, value));
  }
  const limit = numeric(body.max_completion_tokens) ?? numeric(body.max_tokens);
  if (limit !== undefined)
    generationConfig.maxOutputTokens = Math.min(
      65536,
      Math.max(1, Math.trunc(limit)),
    );
  const setup = {
    model: `models/${model}`,
    generationConfig,
    outputAudioTranscription: {},
  };
  if (instructions.length) setup.systemInstruction = { parts: instructions };
  // A resolved tool follow-up synthesizes an answer in a new session. A new
  // user question restores declarations; no prior live call is resumed.
  if (declarations.length && body.tool_choice !== "none" && !finalAnswerOnly)
    setup.tools = [{ functionDeclarations: declarations }];
  if (turns.length > 1)
    setup.historyConfig = { initialHistoryInClientContent: true };
  // Tool execution belongs to the frontend. Only declarations remain structured;
  // prior calls/results are context, never Live function-call protocol messages.
  const asText = (part) => {
    if (part.functionCall != null) {
      const call = part.functionCall;
      return {
        text: `Earlier tool request ${JSON.stringify(call.name)} (id: ${call.id}), arguments: ${stringify(call.args)}`
      };
    }
    if (part.functionResponse != null) {
      const result = part.functionResponse;
      return {
        text: `Frontend tool ${JSON.stringify(result.name)} (id: ${result.id}) returned: ${stringify(result.response)}`
      };
    }
    return part;
  };
  (setup?.systemInstruction ?? {}).parts = toArr(setup?.systemInstruction?.parts ?? [])?.map?.(asText) ?? [];
  return {
    setup,
    turns: turns.map((turn) => ({
      ...turn,
      parts: turn.parts.map(asText)
    })),
    historyCallIds: [...ids],
  };
}

// One absolute deadline covers upgrade, body reads, setup, output and one retry.
// Dependencies remain injectable for lifecycle tests; production stays in this file.
export function createLiveWebSocketOperations({
  ENDPOINT, fetchResponse, ApiError, $text, stringify, isString,
  toArr, toObj, functionName, callId, randId, argumentsObject,
}) {
const kill = (controller, reason) => {
  reason = stringify(reason);
  Q(() => controller?.abort?.(reason));
  Q(() => controller?.cancel?.(reason)?.catch?.(() => {}));
  Q(() => controller?.close?.(reason));
};

async function completeLive(
  payload,
  apiKey,
  signal,
  timeoutMs = 30000,
  fetchImpl = fetchResponse,
) {
  const deadline = Date.now() + timeoutMs;
  const first = await completeLiveAttempt(payload, apiKey, signal, fetchImpl, deadline);
  const { unsupportedBlocking, ...result } = first;
  if (!unsupportedBlocking || signal.aborted || Date.now() >= deadline) return result;

  const asText = (part) =>
    part.functionCall != null ? { text: `tool_call:${stringify(part.functionCall)}` } :
    part.functionResponse != null ? { text: `tool_result:${stringify(part.functionResponse)}` } :
    part;
  const { tools, toolConfig, ...setup } = payload.setup;
  setup.systemInstruction = {
    ...setup.systemInstruction,
    parts: [
      ...(setup.systemInstruction?.parts ?? []).map(asText),
      {
        text: `Tools are unavailable in this session. Treat these definitions and tool history as text only; do not claim to execute tools.\nTool definitions:${stringify(tools ?? [])}`
      },
    ],
  };
  const retry = await completeLiveAttempt({
    ...payload,
    setup,
    turns: payload.turns.map(turn => ({
      ...turn,
      parts: turn.parts.map(asText)
    })),
    historyCallIds: [],
  }, apiKey, signal, fetchImpl, deadline);
  const { unsupportedBlocking: ignored, ...retriedResult } = retry;
  return retriedResult;
}

async function completeLiveAttempt(
  payload,
  apiKey,
  signal,
  fetchImpl,
  deadline = Date.now() + 30000,
) {
  const controller = new AbortController();
  const listeners = [];
  const beforeSetup = [];
  let settled = false;
  let socket;
  let text = "";
  let usage;
  let availableText = "";
  const partialResult = (error) => ({
    text: text.trim() ?
      text : availableText.trim() ?
      availableText : `error:${stringify(error)}`,
    usage,
    status: 200,
    finishReason: "stop",
  });
  let resolvePending;
  const cancelled = new Promise((resolve) => {
    resolvePending = resolve;
  });
  const abort = (error) => {
    if (settled) return;
    settled = true;
    resolvePending(partialResult(error));
    kill(controller);
  };
  const closeSocket = () => Q(() => socket?.close?.(1000, "Request finished"));
  const onAbort = () => abort(signal.reason ?? "Request aborted");
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => abort("Gemini Live deadline exceeded"), deadline - Date.now());
  const work = async () => {
    const response = await fetchImpl(ENDPOINT, {
      headers: {
        Upgrade: "websocket",
        "x-goog-api-key": apiKey,
      },
      signal: controller.signal,
    });
    socket = response.webSocket;
    if (settled) {
      Q(() => socket?.accept?.());
      closeSocket();
      return;
    }
    if (response.status !== 101 || !socket) {
      availableText = stringify(await $text(response));
      if (!availableText.trim())
        availableText =
        response.statusText ||
        stringify(Object.fromEntries(response.headers?.entries?.() ?? []));
      return partialResult(`HTTP ${response.status}`);
    }
    socket.binaryType = "arraybuffer";
    return await new Promise((resolve) => {
      let ready = false;
      const succeed = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const fail = (message) => {
        if (settled || controller?.signal?.aborted) return;
        succeed(partialResult(message));
      };
      const send = (message) => {
        if (settled) return false;
        try {
          socket.send(stringify(message));
          return !settled;
        } catch (error) {
          fail(error);
          return false;
        }
      };
      const onError = (event) => fail(event?.message || String(event));
      const onClose = (event) => {
        if (settled) return;
        const message = `Gemini Live closed before completion (code ${event?.code}). ${event?.reason || String(event)}`.trim();
        if (event?.code === 1007 || /BLOCKING function calls are not supported for this model/i.test(event?.reason)) {
          return succeed({
            ...partialResult(message),
            unsupportedBlocking: true
          });
        }
        fail(message);
      };
      const handleMessage = (event, replay = false) => {
        if (settled || controller.signal.aborted) return;
        try {
          const message = parseTruncatedJSON(
            isString(event.data) ? event.data : decode(event.data),
          );
          if (message.usageMetadata) usage = message.usageMetadata;
          if (
            !replay &&
            isString(message.serverContent?.outputTranscription?.text)
          )
            availableText += message.serverContent.outputTranscription.text;
          if (message.error) return fail(message.error ?? stringify(message));
          if (!ready && !message.setupComplete) {
            beforeSetup.push(event);
            return;
          }
          if (message.setupComplete && !ready) {
            ready = true;
            // HistoryConfig consumes clientContent without inference, even with
            // turnComplete:true. Close the seed, then send the current text turn.
            if (payload.setup.historyConfig?.initialHistoryInClientContent) {
              if (!send({
                clientContent: {
                  turns: payload.turns.slice(0, -1),
                  turnComplete: true
                },
              })) return;
              if (!send({
                realtimeInput: {
                  text: payload.turns.at(-1).parts.map(part => part.text).join("\n")
                },
              })) return;
            } else {
              if (!send({
                clientContent: {
                  turns: payload.turns,
                  turnComplete: true
                },
              })) return;
            }
            // Send input once, then process early frames in their arrival order.
            const queued = beforeSetup.splice(0);
            for (const earlyEvent of queued) {
              handleMessage(earlyEvent, true);
              if (settled || controller.signal.aborted) return;
            }
          }
          if (message.usageMetadata) usage = message.usageMetadata;
          if (message.toolCallCancellation) {
            text += `\ntoolCallCancellation:${stringify(message.toolCallCancellation)}\n`;
          }
          const content = message.serverContent;
          const embeddedCalls = [];
          for (const part of toArr(content?.modelTurn?.parts ?? [])) {
            if (part?.functionCall != null)
              embeddedCalls.push(part.functionCall);
            if (
              part?.inlineData &&
              !/^audio\/pcm(?:;|$)/i.test(part.inlineData.mimeType || "")
            ) {
              text += `inlineData:${stringify(part.inlineData)}\n`;
            }
            // Discard PCM audio and model text, which may contain thoughts or duplicate the transcript.
          }
          if (isString(content?.outputTranscription?.text))
            text += content.outputTranscription.text;
          if (message.toolCall || embeddedCalls.length) {
            const calls = [
              ...(message.toolCall ?
                toArr(message.toolCall.functionCalls) : []),
              ...embeddedCalls,
            ];
            const names = new Set(
              payload.setup.tools?.flatMap((tool) =>
                tool.functionDeclarations.map((fn) => fn.name),
              ) || [],
            );
            const ids = new Set(payload.historyCallIds || []);
            const toolCalls = [];
            for (const rawCall of calls) {
              const call = toObj(rawCall);
              const fn = toObj(call.function ?? call.functionCall ?? call);
              let name = stringify(fn.name ?? call.name ?? "").trim();
              if (!names.has(name)) {
                const matches = [...names].filter(
                  (candidate) =>
                  isString(candidate) &&
                  candidate.toLowerCase() === name.toLowerCase(),
                );
                if (name && matches.length === 1) name = matches[0];
                else if (!name) {
                  const available = [...names].filter(functionName);
                  name =
                    available.length === 1 ?
                    available[0] :
                    `unknown_tool_${toolCalls.length + 1}`;
                }
              }
              const baseId = callId(call.id) ?
                String(call.id) :
                `call_${randId()}`;
              let id = baseId;
              for (let suffix = 1; ids.has(id); suffix++)
                id = `${baseId}_${suffix}`;
              ids.add(id);
              toolCalls.push({
                id,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(
                    argumentsObject(fn.args ?? fn.arguments ?? call.args ?? {}),
                  ),
                },
              });
            }
            // Never execute calls or wait for a turn boundary: BLOCKING waits for
            // the client's result, which arrives in a separate HTTP request.
            return succeed({
              text: null,
              toolCalls,
              usage,
              finishReason: "tool_calls",
            });
          }
          if (!content) return;
          if (content.interrupted) {
            // Return partial output; the finally block closes the socket normally.
            return succeed({ text, usage, finishReason: "stop" });
          }
          // A turn boundary can precede further background processing in 3.8.
          if (
            content.turnComplete &&
            content.interactionStatus !== "IN_PROGRESS"
          ) {
            const reason = content.turnCompleteReason;
            const filtered =
              reason &&
              ![
                "TURN_COMPLETE_REASON_UNSPECIFIED",
                "NEED_MORE_INPUT",
                "MALFORMED_FUNCTION_CALL",
              ].includes(reason);
            // Return whatever was recovered, including an empty transcript.
            succeed({
              text: stringify(text ?? ""),
              usage,
              finishReason: filtered ? "content_filter" : "stop",
            });
          }
        } catch (e) {
          text += `\nerror:${stringify(e instanceof Error ? String(e) : e)}\n`;
        }
      };
      const onMessage = (event) => handleMessage(event);
      listeners.push(["error", onError], ["close", onClose], ["message", onMessage]);
      for (const [type, listener] of listeners)
        socket.addEventListener(type, listener);
      socket.accept();
      send({ setup: payload.setup });
    });
  };
  try {
    if (signal.aborted) onAbort();
    if (Date.now() >= deadline) abort("Gemini Live deadline exceeded");
    return await (settled ? cancelled : Promise.race([work(), cancelled]));
  } catch (error) {
    return partialResult(error);
  } finally {
    settled = true;
    Q(() => clearTimeout(timer));
    Q(() => signal?.removeEventListener?.("abort", onAbort));
    for (const [type, listener] of listeners)
      Q(() => socket?.removeEventListener?.(type, listener));
    beforeSetup.length = 0;
    kill(controller);
    closeSocket();
  }
}

return { completeLive, completeLiveAttempt };
}

export const { completeLive } = createLiveWebSocketOperations({
  ENDPOINT, fetchResponse, ApiError, $text, stringify, isString,
  toArr, toObj, functionName, callId, randId, argumentsObject,
});

const completion = (model, result) => ({
  id: `chatcmpl-${randId()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: result.text,
      ...(result.toolCalls ? { tool_calls: result.toolCalls } : {}),
    },
    finish_reason: result.finishReason,
    logprobs: null,
  }],
});

export default {
  async fetch(request, env) {
    try {
      const pathname = new URL(request?.url).pathname;
      const apiKey = geminiKey(request);
      if (pathname === "/v1/models" && request.method === "GET")
        return json({
          object: "list",
          data: [{
            id: MODEL,
            object: "model",
            created: 0,
            owned_by: "google",
          }, ],
        });
      const payload = translate(await readJson(request));
      const result = await completeLive(payload, apiKey, request.signal);
      const response = completion(payload.setup.model.slice("models/".length), result);
      const usage = result.usage;
      if ([usage?.promptTokenCount, usage?.responseTokenCount, usage?.totalTokenCount].every(Number.isInteger)) {
        response.usage = {
          prompt_tokens: usage.promptTokenCount,
          completion_tokens: usage.responseTokenCount,
          total_tokens: usage.totalTokenCount,
        };
      }
      // These statuses cannot carry a JSON body; retain the upstream code in metadata.
      const status = result.status ?? 200;
      if (status < 200 || [204, 205, 304].includes(status))
        response.upstream_status = status;
      return json(
        response,
        response.upstream_status === undefined ? status : 502,
      );
    } catch (error) {
      const status = error?.status ?? 500;
      return json(completion(MODEL, { text: stringify(error), finishReason: "stop" }), status);
    }
  },
};
