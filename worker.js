import * as util from "node:util";
import { createLiveWebSocketOperations } from "./worker.websocket-review.js";

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

const flattenRequest = (req) => {
  return {
    ...flattenObject(req),
    ...Object.fromEntries(req.headers.entries()),
    ...Object.fromEntries(new URL(req.url).searchParams.entries()),
  };
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
      if (char === '"')
        return {
          value: chars.join(""),
          complete: true,
        };
      if (char !== backslash) {
        chars.push(
          char.charCodeAt(0) < 0x20 ?
          String.fromCharCode(char.charCodeAt(0)) :
          char,
        );
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
            return {
              value: chars.join(""),
              complete: false,
            };
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
    return {
      value: chars.join(""),
      complete: false,
    };
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
          const {
            done,
            value
          } = await originalReader.read();

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
        const {
          done,
          value
        } = await reader.read();
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

const tryB64 = (str) => {
  try {
    str = str.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
    return Uint8Array.from(
      atob(str.padEnd(Math.ceil(str.length / 4) * 4, "=")),
      (char) => char.charCodeAt(0),
    );
  } catch {
    return encode(str);
  }
};

const concat = (parts) => {
  const outputs = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let output = 0;
  for (const part of parts)
    (outputs.set(part, output), (output += part.length));
  return outputs;
};

const base64ToBytes = (x) =>
  instanceOf(x, Uint8Array) ?
  x :
  concat(
    stringify(x)
    .split(/([\w+/=-]{4,})/)
    .map((s, i) => (i % 2 ? tryB64(s) : encode(s))),
  );

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
const MAX_BODY = 1024 * 1024;
const MAX_UPSTREAM = 8 * 1024 * 1024;

class ApiError extends Error {
  constructor(status, message, param = null) {
    super(message);
    this.status = status;
    this.param = param;
  }
}

const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });

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
// Bound even ignored metadata without recursion or forwarding it upstream.
function bodyDepth(value) {
  const stack = [
    [value, 0]
  ];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node && typeof node === "object") {
      for (const child of Object.values(node)) {
        stack.push([child, depth + 1]);
      }
    }
  }
}

function textParts(content) {
  if (content == null) return [];
  if (isString(content))
    return [{
      text: content,
    }, ];
  return toArr(content).map((part) => ({
    text: stringify(part?.text ?? part),
  }));
}

function numeric(value) {
  const number = parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
}

// Bound and copy all tool data, including unknown schema keywords and defaults.
// No mutation, evaluation, reference resolution, or instance validation.
function toolData(value, param, wrapArguments = false) {
  if (isString(value)) {
    try {
      value = JSON.parse(value);
    } catch {
      value = parseTruncatedJSON(value, param);
    }
  }
  if (wrapArguments) {
    value = {
      ...Object(value),
      ...{
        value
      }
    };
  }

  let count = 0;

  function copy(value, depth) {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    if (value === null || typeof value !== "object") return value;
    if (isArray(value)) return value.map((child) => copy(child, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        copy(child, depth + 1),
      ]),
    );
  }
  return copy(value, 0);
}

function parametersSchema(value) {
  const schema = toolData(value, "tools");
  // Like translateRequest in chat-interactions, do not impose type:object or
  // rewrite schema keywords. Only non-schema roots use the empty-schema fallback.
  return isPlainObject(schema) || typeof schema === "boolean" ?
    schema : {
      type: "object",
      properties: {},
    };
}

function argumentsObject(value) {
  // Sibling defaults raw null/missing arguments, but preserves parsed JSON null.
  // Live functionCall.args is a Struct. Preserve nonobjects under a single key
  // rather than dropping array elements, false, zero, or recovered text.
  return toolData(value ?? {}, "messages", true);
}

export function translate(body) {
  body = Object(body);
  bodyDepth(body);
  const model = isString(body.model) ?
    body.model.trim().replace(/^models\//, "") || MODEL :
    MODEL;
  body.messages = toArr(body.messages ?? body);
  const declarations = [];
  const names = new Set();
  if (body?.tools != null) {
    body.tools = toArr(body.tools).map(Object);
    for (const tool of body.tools) {
      const fn = tool?.function;
      const parametersJsonSchema = parametersSchema(fn?.parameters);
      names.add(fn?.name);
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
  for (const originalMessage of toArr(body.messages ?? body ?? [])) {
    const message = {
      ...originalMessage,
    };
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
          response: isPlainObject(result) ?
            result : {
              result,
            },
        },
      };
      if (turns.at(-1)?.parts?.[0]?.functionResponse)
        turns.at(-1).parts.push(part);
      else
        turns.push({
          role: "user",
          parts: [part],
        });
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
    turns.push({
      role: "user",
      parts: [{
        text: "Continue.",
      }, ],
    });
  const generationConfig = {
    responseModalities: ["AUDIO"],
  };
  if (/thinking/i.test(model)) {
    generationConfig.thinkingConfig = {
      thinkingLevel: "HIGH"
    };
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
  if (instructions.length)
    setup.systemInstruction = {
      parts: instructions,
    };
  // A resolved tool follow-up synthesizes an answer in a new session. A new
  // user question restores declarations; no prior live call is resumed.
  if (declarations.length && body.tool_choice !== "none" && !finalAnswerOnly)
    setup.tools = [{
      functionDeclarations: declarations,
    }, ];
  if (turns.length > 1)
    setup.historyConfig = {
      initialHistoryInClientContent: true,
    };
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

export const { completeLive } = createLiveWebSocketOperations({
  ENDPOINT, fetchResponse, ApiError, $text, stringify, isString,
  toArr, toObj, functionName, callId, randId, argumentsObject,
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
      const result = await completeLive(
        payload,
        apiKey,
        request.signal,
      );
      const response = {
        id: `chatcmpl-${randId()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: payload.setup.model.slice("models/".length),
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: result.text,
            ...(result.toolCalls ? {
              tool_calls: result.toolCalls,
            } : {}),
          },
          finish_reason: result.finishReason,
          logprobs: null,
        }, ],
      };
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
        response.upstream_status  ??= 502,
      );
    } catch (error) {
      const status = error?.status ?? 500;
      return json({
          id: `chatcmpl-${randId()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: MODEL,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: stringify(error),
            },
            finish_reason: "stop",
            logprobs: null,
          }, ],
        },
        status,
      );
    }
  },
};
