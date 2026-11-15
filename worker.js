// Stateless Chat Completions -> Gemini Live bridge. One session per request.
const ENDPOINT = "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
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
const invalid = (message, param) => {
  throw new ApiError(400, message, param);
};
const json = (value, status = 200) => Response.json(value, {
  status,
  headers: {
    "Cache-Control": "no-store"
  },
});

function geminiKey(request) {
  const token = /^Bearer[ \t]+([^\s]+)$/i.exec(request?.headers?.get?.("Authorization") || "")?.[1];
  return String(token);
}

async function readJson(request) {
  if (!request.body) invalid("Request body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", {
    fatal: true
  });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const {
        done,
        value
      } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new ApiError(413, "Request exceeds 1 MiB.");
      text += decoder.decode(value, {
        stream: true
      });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ApiError) throw error;
    invalid("Body must contain valid UTF-8 JSON.");
  } finally {
    reader.releaseLock();
  }
}

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const functionName = value => typeof value === "string" && value.trim().length > 0;
const callId = functionName;
// Bound even ignored metadata without recursion or forwarding it upstream.
function bodyDepth(value) {
  const stack = [
    [value, 0]
  ];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > 128) invalid("Request is too complex: nesting exceeds 128 levels.");
    if (node && typeof node === "object") {
      for (const child of Object.values(node)) stack.push([child, depth + 1]);
    }
  }
}

function textParts(content) {
  if (content == null) return [];
  if (typeof content === "string") return [{
    text: content
  }];
  if (Array.isArray(content) && content.every(part => object(part) &&
      (part.type == null || part.type === "text") && typeof part.text === "string")) {
    return content.map(part => ({
      text: part.text
    }));
  }
  invalid("Only string or text-part content is supported.", "messages");
}

function numeric(value) {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
// Adapted from chat-interactions/worker.js parseTruncatedJSON. Only tool data
// uses recovery; request bodies and WebSocket envelopes still require valid JSON.
function parseTruncatedJSON(text, param) {
  const stack = [];
  let index = 0;
  let result;
  let hasRoot = false;
  let count = 0;
  const whitespace = char => char !== undefined && " \t\r\n".includes(char);
  let contentEnd = text.length;
  while (contentEnd > 0 && whitespace(text[contentEnd - 1])) contentEnd--;
  if (text.endsWith("...", contentEnd)) text = text.slice(0, contentEnd - 3);

  function readString() {
    index++;
    const chars = [];
    const escapes = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t"
    };
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') break;
      if (char !== "\\") {
        chars.push(char);
        continue;
      }
      if (index === text.length) {
        chars.push("\\");
        break;
      }
      const escape = text[index++];
      if (escape === "u") {
        let hex = "";
        for (let digit = 0; digit < 4; digit++) {
          if (index === text.length) {
            chars.push("\\u" + hex);
            return chars.join("");
          }
          if (!/[0-9a-fA-F]/.test(text[index])) break;
          hex += text[index++];
        }
        chars.push(String.fromCharCode(parseInt(hex.padStart(4, "0"), 16)));
      } else chars.push(Object.hasOwn(escapes, escape) ? escapes[escape] : "\\" + escape);
    }
    return chars.join("");
  }

  function readToken() {
    const start = index;
    while (index < text.length && !whitespace(text[index]) && !'{}[],:"'.includes(text[index])) index++;
    return text.slice(start, index);
  }

  function readScalar() {
    if (text[index] === '"') return readString();
    const token = readToken();
    if (token[0] === "t") return true;
    if (token[0] === "f") return false;
    if (token[0] === "n" || token === "-") return null;
    const number = parseFloat(token);
    return Number.isNaN(number) ? token : number;
  }

  function attach(value) {
    if (++count > 4096) invalid("Function data is too complex.", param);
    const parent = stack.at(-1);
    if (!parent) {
      result = value;
      hasRoot = true;
    } else if (parent.kind === "array") {
      parent.value.push(value);
      parent.state = "separator";
    } else {
      // Preserve prototype-named keys as own data, never invoke setters.
      Object.defineProperty(parent.value, parent.key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
      parent.state = "separator";
    }
  }
  while (true) {
    if (stack.length > 33) invalid("Function data is too complex.", param);
    while (whitespace(text[index])) index++;
    let frame = stack.at(-1);
    if (index === text.length) {
      if (frame?.kind === "object" && ["colon", "value"].includes(frame.state)) attach(null);
      return result;
    }
    const char = text[index];
    if (char === "]" || char === "}") {
      if (frame?.kind === "object" && ["colon", "value"].includes(frame.state)) attach(null);
      stack.pop();
      index++;
      continue;
    }
    if (!frame && hasRoot && char !== "," && char !== ":") {
      if (result === null || typeof result !== "object") result = [result];
      frame = {
        kind: Array.isArray(result) ? "array" : "object",
        value: result,
        state: "separator"
      };
      stack.push(frame);
    }
    if (char === ",") {
      if (frame?.kind === "object" && ["colon", "value"].includes(frame.state)) attach(null);
      else if (frame?.kind === "array" && ["first", "value"].includes(frame.state)) attach(null);
      if (frame) frame.state = frame.kind === "array" ? "value" : "key";
      index++;
      continue;
    }
    if (char === ":") {
      if (frame?.state === "colon") frame.state = "value";
      index++;
      continue;
    }
    if (frame) {
      if (frame.state === "separator") frame.state = frame.kind === "array" ? "value" : "key";
      if (frame.kind === "object" && ["first", "key"].includes(frame.state)) {
        frame.key = char === '"' ? readString() : char === "{" || char === "[" ? text[index++] : readToken();
        frame.state = "colon";
        continue;
      }
      if (frame.state === "colon") frame.state = "value";
    }
    if (char === "{" || char === "[") {
      const value = char === "{" ? {} : [];
      attach(value);
      stack.push({
        kind: char === "{" ? "object" : "array",
        value,
        state: "first"
      });
      index++;
    } else attach(readScalar());
  }
}

// Bound and copy all tool data, including unknown schema keywords and defaults.
// No mutation, evaluation, reference resolution, or instance validation.
function toolData(value, param, wrapArguments = false) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = parseTruncatedJSON(value, param);
    }
  }
  if (wrapArguments) value = value === undefined ? {} : object(value) ? value : {
    value
  };
  let count = 0;

  function copy(value, depth) {
    if (++count > 4096 || depth > 32) invalid("Function data is too complex.", param);
    // JSON serialization in the sibling maps nonfinite numeric values to null.
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(child => copy(child, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child, depth + 1)]));
  }
  return copy(value, 0);
}

function parametersSchema(value) {
  const schema = toolData(value, "tools");
  // Like translateRequest in chat-interactions, do not impose type:object or
  // rewrite schema keywords. Only non-schema roots use the empty-schema fallback.
  return object(schema) || typeof schema === "boolean" ? schema : {
    type: "object",
    properties: {}
  };
}

function argumentsObject(value) {
  // Sibling defaults raw null/missing arguments, but preserves parsed JSON null.
  // Live functionCall.args is a Struct. Preserve nonobjects under a single key
  // rather than dropping array elements, false, zero, or recovered text.
  return toolData(value ?? {}, "messages", true);
}

export function translate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Expected a JSON object.");
  bodyDepth(body);
  const model = typeof body.model === "string" ? body.model.trim().replace(/^models\//, "") || MODEL : MODEL;
  if (body.stream != null && ![false, 0, "false"].includes(body.stream)) invalid("Only stream:false is supported.", "stream");
  // One completion is always returned; extra provider/request options are ignored.
  if (!Array.isArray(body.messages) || !body.messages.length) invalid("messages must be a nonempty array.", "messages");
  const declarations = [];
  const names = new Set();
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) invalid("tools must be an array or null.", "tools");
    for (const tool of body.tools) {
      if (!object(tool) || (tool.type != null && tool.type !== "function") || !object(tool.function)) invalid("Only function tools are supported.", "tools");
      const fn = tool.function;
      if (!functionName(fn.name) || names.has(fn.name)) invalid("Missing or duplicate function name.", "tools");
      const parametersJsonSchema = parametersSchema(fn.parameters);
      names.add(fn.name);
      declarations.push({
        name: fn.name,
        ...(typeof fn.description === "string" ? {
          description: fn.description
        } : {}),
        parametersJsonSchema,
        behavior: "BLOCKING"
      });
    }
  }
  const turns = [];
  const instructions = [];
  const ids = new Set();
  const pending = new Map();
  for (const message of body.messages) {
    if (!message || !["system", "developer", "user", "assistant", "tool"].includes(message.role)) invalid("Unsupported message role.", "messages");
    if (message.function_call != null) invalid("Legacy function_call history is not supported; use tool_calls.", "messages");
    if (message.audio != null) invalid("Audio message content is not supported.", "messages");
    if (message.tool_calls != null && (!Array.isArray(message.tool_calls) || (message.role !== "assistant" && message.tool_calls.length))) {
      invalid("tool_calls must be an assistant call array.", "messages");
    }
    if (message.role === "tool") {
      const name = pending.get(message.tool_call_id);
      if (!name) invalid("Tool result must match a pending call ID.", "messages");
      // ID is authoritative; optional provider name metadata cannot reroute it.
      let result = message.content ?? null;
      if (typeof result === "string") {
        try {
          result = JSON.parse(result);
        } catch {
          /* Plain text result. */
        }
      }
      result = toolData({
        result
      }, "messages").result;
      const part = {
        functionResponse: {
          id: message.tool_call_id,
          name,
          response: object(result) ? result : {
            result
          }
        }
      };
      if (turns.at(-1)?.parts[0]?.functionResponse) turns.at(-1).parts.push(part);
      else turns.push({
        role: "user",
        parts: [part]
      });
      pending.delete(message.tool_call_id);
      continue;
    }
    if (pending.size) invalid("All tool calls need results before the next message.", "messages");
    const parts = textParts(message.content);
    for (const call of message.tool_calls ?? []) {
      if (!object(call) || (call.type != null && call.type !== "function") || !object(call.function) ||
        !callId(call.id) || ids.has(call.id) || !functionName(call.function.name)) {
        invalid("Function calls need unique nonempty string IDs and names.", "messages");
      }
      ids.add(call.id);
      pending.set(call.id, call.function.name);
      parts.push({
        functionCall: {
          id: call.id,
          name: call.function.name,
          args: argumentsObject(call.function.arguments)
        }
      });
    }
    if (["system", "developer"].includes(message.role)) {
      instructions.push(...parts);
    } else if (parts.length) turns.push({
      role: message.role === "assistant" ? "model" : "user",
      parts
    });
  }
  if (pending.size) invalid("All tool calls need client results.", "messages");
  // Empty/instruction-only input and assistant-ended history need an explicit trigger.
  if (turns.at(-1)?.role !== "user") turns.push({
    role: "user",
    parts: [{
      text: "Continue."
    }]
  });
  const generationConfig = {
    responseModalities: ["AUDIO"]
  };
  for (const [source, target, maximum] of [
      ["temperature", "temperature", 2],
      ["top_p", "topP", 1]
    ]) {
    const value = numeric(body[source]);
    if (value !== undefined) generationConfig[target] = Math.min(maximum, Math.max(0, value));
  }
  const limit = numeric(body.max_completion_tokens) ?? numeric(body.max_tokens);
  if (limit !== undefined) generationConfig.maxOutputTokens = Math.min(65536, Math.max(1, Math.trunc(limit)));
  const setup = {
    model: `models/${model}`,
    generationConfig,
    outputAudioTranscription: {}
  };
  if (instructions.length) setup.systemInstruction = {
    parts: instructions
  };
  // none is enforced by withholding declarations, not an unverified toolConfig.
  if (declarations.length && body.tool_choice !== "none") setup.tools = [{
    functionDeclarations: declarations
  }];
  if (turns.length > 1) setup.historyConfig = {
    initialHistoryInClientContent: true
  };
  return {
    setup,
    turns,
    historyCallIds: [...ids]
  };
}

export async function completeLive(payload, apiKey, signal, timeoutMs = 180000, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const controller = new AbortController();
  let socket;
  let timer;
  let onAbort;
  let rejectPending;
  const cancelled = new Promise((_, reject) => {
    rejectPending = reject;
  });
  const abort = error => {
    controller.abort();
    rejectPending(error);
  };
  onAbort = () => abort(new ApiError(499, "Client disconnected."));
  signal.addEventListener("abort", onAbort, {
    once: true
  });
  timer = setTimeout(() => abort(new ApiError(504, "Gemini Live request timed out.")), timeoutMs);
  const work = async () => {
    if (signal.aborted) throw new ApiError(499, "Client disconnected.");
    const response = await fetchImpl(ENDPOINT, {
      headers: {
        Upgrade: "websocket",
        "x-goog-api-key": apiKey
      },
      redirect: "manual",
      signal: controller.signal,
    });
    socket = response.webSocket;
    if (controller.signal.aborted) {
      if (socket) {
        socket.accept();
        socket.close(1000, "Cancelled");
      }
      throw new ApiError(504, "Gemini Live request cancelled.");
    }
    if (response.status !== 101 || !socket) {
      await response.body?.cancel();
      throw new ApiError(response.status === 429 ? 429 : 502, `Gemini Live handshake failed (HTTP ${response.status}). Check API key and model availability.`);
    }
    socket.binaryType = "arraybuffer";
    return await new Promise((resolve, reject) => {
      let ready = false;
      let bytes = 0;
      let text = "";
      let usage;
      let settled = false;
      const succeed = result => {
        settled = true;
        resolve(result);
      };
      const fail = message => {
        settled = true;
        reject(new ApiError(502, message));
      };
      socket.addEventListener("error", () => fail("Gemini Live WebSocket error."));
      socket.addEventListener("close", event => fail(`Gemini Live closed before completion (code ${event.code}).`));
      socket.addEventListener("message", event => {
        if (settled || controller.signal.aborted) return;
        try {
          bytes += typeof event.data === "string" ? new TextEncoder().encode(event.data).byteLength : event.data.byteLength;
          if (bytes > MAX_UPSTREAM) return fail("Gemini Live response exceeds 8 MiB.");
          const message = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder("utf-8", {
            fatal: true
          }).decode(event.data));
          if (message.error) return fail("Gemini Live rejected the request. Check model access and setup compatibility.");
          if (message.setupComplete) {
            if (ready) return fail("Duplicate Gemini Live setup acknowledgement.");
            ready = true;
            if (payload.turns.length > 1) {
              const last = payload.turns.at(-1);
              const toolResults = last.parts.some(part => part.functionResponse);
              // Old call IDs are history, not pending calls in this new socket.
              // Seed complete structured results; trigger a new inference explicitly.
              socket.send(JSON.stringify({
                clientContent: {
                  turns: toolResults ? payload.turns : payload.turns.slice(0, -1),
                  turnComplete: false
                }
              }));
              socket.send(JSON.stringify({
                realtimeInput: {
                  text: toolResults ?
                    "Continue from the supplied tool results and answer the preceding request." : last.parts.map(part => part.text).join("\n")
                }
              }));
            } else {
              socket.send(JSON.stringify({
                clientContent: {
                  turns: payload.turns,
                  turnComplete: true
                }
              }));
            }
          }
          if (message.usageMetadata) usage = message.usageMetadata;
          if (message.toolCallCancellation) return fail("Gemini Live cancelled a tool call.");
          if (message.toolCall) {
            const calls = message.toolCall.functionCalls;
            const names = new Set(payload.setup.tools?.flatMap(tool => tool.functionDeclarations.map(fn => fn.name)) || []);
            const ids = new Set(payload.historyCallIds || []);
            if (!ready || !Array.isArray(calls) || !calls.length || calls.length > 128) return fail("Invalid Gemini Live tool call.");
            const toolCalls = [];
            for (const call of calls) {
              if (!object(call) || !callId(call.id) || ids.has(call.id) || !names.has(call.name)) return fail("Invalid Gemini Live tool call.");
              ids.add(call.id);
              toolCalls.push({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(argumentsObject(call.args))
                }
              });
            }
            // Never execute calls or wait for a turn boundary: BLOCKING waits for
            // the client's result, which arrives in a separate HTTP request.
            return succeed({
              text: text || null,
              toolCalls,
              usage,
              finishReason: "tool_calls"
            });
          }
          const content = message.serverContent;
          if (!content) return;
          if (!ready) return fail("Gemini Live sent content before setup completed.");
          if (content.interrupted) return fail("Gemini Live generation was interrupted.");
          for (const part of content.modelTurn?.parts || []) {
            if (part.functionCall || (part.inlineData && !/^audio\/pcm(?:;|$)/i.test(part.inlineData.mimeType || ""))) {
              return fail("Unexpected non-audio output.");
            }
            // Discard audio without decoding or accumulating it. Model text is
            // not the transcript and may duplicate it or contain thoughts.
          }
          if (typeof content.outputTranscription?.text === "string") text += content.outputTranscription.text;
          // A turn boundary can precede further background processing in 3.8.
          if (content.turnComplete && content.interactionStatus !== "IN_PROGRESS") {
            const reason = content.turnCompleteReason;
            if (reason === "MALFORMED_FUNCTION_CALL") return fail("Gemini Live produced a malformed function call.");
            const filtered = reason && !["TURN_COMPLETE_REASON_UNSPECIFIED", "NEED_MORE_INPUT"].includes(reason);
            if (!text.trim() && !filtered) return fail("Gemini Live completed without an output transcript.");
            succeed({
              text,
              usage,
              finishReason: filtered ? "content_filter" : "stop"
            });
          }
        } catch {
          fail("Invalid Gemini Live response.");
        }
      });
      socket.accept();
      socket.send(JSON.stringify({
        setup: payload.setup
      }));
    });
  };
  try {
    return await Promise.race([work(), cancelled]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "Unable to connect to Gemini Live.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
    if (socket) {
      try {
        socket.close(1000, "Request finished");
      } catch {
        /* Already closed. */
      }
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      const pathname = new URL(request.url).pathname;
      if (!["/v1/chat/completions", "/v1/models"].includes(pathname)) throw new ApiError(404, "Not found.");
      const apiKey = geminiKey(request);
      if (pathname === "/v1/models" && request.method === "GET") return json({
        object: "list",
        data: [{
          id: MODEL,
          object: "model",
          created: 0,
          owned_by: "google"
        }]
      });
      if (pathname !== "/v1/chat/completions" || request.method !== "POST") throw new ApiError(405, "Method not allowed.");
      const payload = translate(await readJson(request));
      const timeout = Number(env.TIMEOUT_MS || 180000);
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) throw new ApiError(503, "TIMEOUT_MS must be 1000..600000.");
      const result = await completeLive(payload, apiKey, request.signal, timeout);
      const response = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: payload.setup.model.slice("models/".length),
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: result.text,
            ...(result.toolCalls ? {
              tool_calls: result.toolCalls
            } : {})
          },
          finish_reason: result.finishReason,
          logprobs: null
        }],
      };
      const u = result.usage;
      if (u && [u.promptTokenCount, u.responseTokenCount, u.totalTokenCount].every(Number.isInteger)) {
        response.usage = {
          prompt_tokens: u.promptTokenCount,
          completion_tokens: u.responseTokenCount,
          total_tokens: u.totalTokenCount
        };
      }
      return json(response);
    } catch (error) {
      const known = error instanceof ApiError;
      const status = known ? error.status : 500;
      return json({
        error: {
          message: known ? error.message : "Internal server error.",
          type: status < 500 ? "invalid_request_error" : "server_error",
          param: known ? error.param : null,
          code: null
        }
      }, status);
    }
  },
};
