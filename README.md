# Chat Completions to Gemini Live

https://chat-live.gemini-responses.workers.dev/

Cloudflare module Worker exposing `POST /v1/chat/completions` and `GET /v1/models`. Uses one AI Studio Live WebSocket session per request and returns one nonstream JSON completion. Requests audio output with output transcription, discards PCM audio chunks, and returns only the transcript. No audio reaches the client. Supports client-executed function tools; no Worker function execution, extended thinking, session reuse, or automatic retries. Audio generation and transfer still incur latency and applicable charges.

## Configuration

Deploy `worker.js` and `public/` with `wrangler.jsonc` to include the chat page. Pasting only `worker.js` into Cloudflare's Worker editor provides the API without the page. No Worker secret bindings are required. Each client supplies its own Gemini key as `Authorization: Bearer <key>`; the Worker strips the prefix and forwards it as `x-goog-api-key`. Missing/malformed bearer headers are rejected; Google validates the key. `/v1/models` only checks header format.

Run `bash deploy.sh` to log in to Cloudflare through your browser and deploy. Requires Node 22+ and npm; uses Wrangler 4 through npx. Optional `bash deploy.sh --smoke-test https://<worker-host>` also reads `GEMINI_API_KEY` from local `.env` and sends one short completion (may incur Google charges). `.env` is parsed as data, never sourced or uploaded. Its key is never a server-side fallback. Use `bash deploy.sh --dry-run` for local bundling without login or deployment. The script deliberately ignores Cloudflare API-token/key environment credentials so deployment uses browser OAuth.

Optional `TIMEOUT_MS`: total upstream deadline, default 180000; permitted 1000–600000. Client and intervening proxy timeouts must exceed it. Request upload is not included in this deadline.

Client settings:
- Base URL: `https://<worker-host>/v1`
- API key: your Google AI Studio API key
- Model: `gemini-3.8-live`
- Streaming: disabled

Request example:

```json
{
  "model": "gemini-3.8-live",
  "stream": false,
  "messages": [
    { "role": "system", "content": "Be concise." },
    { "role": "user", "content": "Explain WebSockets." }
  ]
}
```

Compatibility is deliberately permissive, not full OpenAI feature parity. Unknown request/message/declaration/call/text-part fields are ignored, never serialized into the prompt. This includes harness metadata, provider reasoning/signatures, `reasoning_effort`, `response_format`, `stop`, `seed`, `store`, `parallel_tool_calls`, and legacy request options `functions`/`function_call`. They have **no effect**, including no JSON-output or stop-sequence guarantee. Non-null legacy `message.function_call` is rejected rather than losing a historical call.

- String and text-part content is supported; extra text-part fields are ignored and an omitted/null part type defaults to text. Null/missing content and empty arrays yield no parts; empty messages are skipped. Unsupported image/audio/video/file parts, non-text content objects, and non-null `message.audio` are rejected, not treated as text. Reasoning/refusal/annotation metadata is not conversation text.
- System/developer messages anywhere outside an unresolved tool-call group are combined into system instructions in encounter order. History may start or end with an assistant. If no nonempty turns remain, or history ends with an assistant, an explicit user `Continue.` turn is appended. This requests a fresh reply, not assistant-prefix completion. Empty `messages` arrays are still rejected.
- `n` is ignored: exactly one choice is returned. Streaming is not implemented: omitted/null/false/0/`"false"` selects JSON; all other `stream` values, including true, are rejected.
- Finite numbers and numeric strings are accepted for sampling and token limits. `temperature` clamps to 0–2; `top_p` to 0–1. Token limits truncate to integers and clamp to 1–65536. A coercible `max_completion_tokens` wins over `max_tokens`; otherwise the latter is tried. Null, blank, boolean, object, and nonnumeric values are omitted/defaulted, not rejected.
- Model strings are trimmed and one leading `models/` is removed. Missing/null/blank/non-string models use `gemini-3.8-live`. Other strings pass through; Google decides model validity and availability.

Request limit: 1 MiB and 128 nesting levels (including ignored metadata). Aggregate upstream frame limit: 8 MiB, including base64 audio, metadata and thoughts. Audio is discarded frame by frame, but still counts toward this limit; long spoken replies may exceed it. Partial output is not returned on interruption, early close, timeout, or protocol error. Only `serverContent.outputTranscription.text` is collected; model text/thought parts are ignored to avoid duplicate output. Successful text turns without a transcript fail explicitly; tool-call completions may have null content. Usage is returned only when Google supplies counts before the final turn boundary; no estimated counts. Live does not expose the same finish-reason contract as Chat Completions: ordinary completion maps to `stop`, safety rejection to `content_filter`; token-limit truncation cannot reliably be distinguished.

No CORS headers are emitted; use server-side clients or the included same-origin chat page. Add Cloudflare rate limits and usage alerts before exposing it publicly. Request contents and secrets are not logged by this code.

## Client-executed function tools

Only the API client executes functions. The Worker forwards declarations, arguments and results as JSON data. It never evaluates code, fetches schema references, invokes functions, or enables Gemini built-in execution/search tools. The chat page has no tool execution UI.

1. Send `tools: [{"type":"function","function":{"name":"lookup_code","description":"Retrieve the code","parameters":{"type":"object","properties":{}}}}]` with your messages.
2. When `choices[0].finish_reason` is `tool_calls`, inspect `choices[0].message.tool_calls`. Each entry has `id`, `type:"function"`, and `function:{name,arguments}`; `arguments` is a JSON object **string**. The assistant's content is the transcript received before the calls, or null.
3. Your client validates arguments against its schema and authorization rules, obtains any required user approval, and executes the function. Never blindly execute model-provided code or arbitrary function names.
4. Append the returned assistant message unchanged, then one `{"role":"tool","tool_call_id":"<returned id>","content":"<result string>"}` per call. Send the full history and the same declarations in a new completion request. Results may arrive in any order within that group; all calls must have results before another message. Optional result `name` is ignored; the matched call ID supplies the authoritative function name.

Missing/null/empty `tools` means no declarations. Declarations require unique nonblank string names, preserved exactly without regex/length restrictions or renaming. There is no local input declaration/call count cap beyond body/data budgets. Omitted/null tool and call types default to function; explicit non-function types and malformed declaration/call containers are rejected. `strict` (including true) and extra metadata are ignored; no strict-schema guarantee is made. Non-string/null descriptions are omitted. Google may reject names, counts, or schemas it cannot support. **Schema conformance and safe execution remain the client's responsibility.**

Tool-data coercion follows `../chat-interactions/worker.js`: `translateRequest()` forwards parameter schemas without requiring `type:"object"`, accepts already-decoded arguments, and uses `parseTruncatedJSON()` for string arguments; `translateResponse()` serializes returned arguments. That sibling contains no test files. Here, valid JSON strings are parsed normally first; malformed tool-data strings use an adapted, bounded version of its recovery parser. Request bodies and WebSocket envelopes still require valid JSON.

- **Parameter schemas:** object and boolean roots are preserved as `parametersJsonSchema`, including omitted `type`, non-object types, unions, references, and unknown or malformed keywords. String schemas are decoded/recovered once. Missing/null parameters and decoded roots other than objects/booleans (including arrays, numbers, and strings) fall back to `{"type":"object","properties":{}}`; this deliberately discards those invalid schema roots. No schema keyword validation, reference fetching, or evaluation occurs. Google's schema restrictions still apply: a forwarded schema, including a boolean or non-object root, may fail upstream.
- **Arguments, history and upstream:** objects remain objects; raw missing/null values and empty/unrecoverable input with no recovered root become `{}`. Arrays and other decoded values are preserved under `{"value":...}` because Live `functionCall.args` requires an object. Thus `0` becomes `{"value":0}`, `false` becomes `{"value":false}`, and the string `"null"` becomes `{"value":null}` (unlike raw null). A JSON-encoded empty string becomes `{"value":""}`. No schema-based field mapping or nested-string parsing occurs. Returned arguments are always object JSON strings and replay without double wrapping. The `value` wrapper is a Live-specific adaptation, not behavior present in the sibling; clients must account for it before execution.
- **Lossy recovery:** missing object values and array gaps become null; truncated strings/containers retain recovered content; trailing `...` outside a closed JSON value is removed. Missing separators and mismatched closers are tolerated. Bare tokens starting with `t`, `f`, or `n` become true, false, or null; `-` becomes null; numeric prefixes use `parseFloat` (`12suffix` becomes 12). Duplicate keys keep the last value. Incomplete Unicode escapes at end of input remain literal; otherwise short/invalid Unicode hex is left-padded to four digits. Unknown escapes retain their backslash. Extra scalar roots become array elements; extra object entries are merged. Nonfinite numbers become null, matching JSON serialization in the sibling. These repairs can change meaning and cannot recover omitted data; inspect and validate calls before executing them.

Normalization copies data without mutating inputs and preserves prototype-named keys as inert own properties. Each schema or normalized argument object is bounded to 32 levels below its root and 4096 total JSON values, including arrays, scalar leaves, unknown keywords, and the argument wrapper. Recovery also has depth/value budgets, so heavily malformed data may hit a budget even if its final repaired tree is small. Excess complexity remains a 400 for client data or 502 for upstream calls; request/frame byte caps are unchanged. These are JSON-tree limits, not the former schema-node-only count.

`tool_choice:"auto"` (default) supplies declarations with Gemini `behavior:"BLOCKING"`. Exact `tool_choice:"none"` withholds declarations and rejects any unexpected upstream call. Every other value, including null, `required`, and named choices, falls back to auto: tool use is neither forced nor restricted to a named choice. Historical calls do not need current declarations; current upstream calls must still name a supplied declaration.

Call IDs must be nonblank strings unique across supplied history; IDs and function names are preserved exactly. Every result must match a preceding pending ID exactly once, and all calls must have results before any non-tool message or request end. Missing/unknown/duplicate IDs and incomplete groups are rejected before connecting. Calls belong only to assistant messages; null/empty `tool_calls` means no calls. JSON object result strings and already-decoded objects become `functionResponse.response` directly. Other valid JSON values and plain strings are wrapped as `{"result":value}`; missing/null results become `{"result":null}`. Result data is copied with the same complexity guard (including its temporary result wrapper); plain text is not repaired as arguments are. No call or result is silently dropped.

### Stateless replay, not session resumption

The Worker returns the **first complete Gemini `toolCall.functionCalls` batch immediately**, with `finish_reason:"tool_calls"`, then closes the socket. It does not wait for `turnComplete`, which would deadlock with blocking calls. All calls in that batch are returned, but later batches, audio, usage or cancellations on that closed session cannot be observed. Clients must enforce their own execution permissions, retry limits and idempotency.

In a persistent Gemini session, pending calls require `toolResponse.functionResponses` with matching IDs. This bridge deliberately does **not** send an old ID as a pending `toolResponse` on a new socket. Prior calls and frontend results are rendered as text, preserving IDs, names and result strings. Consecutive parallel results are grouped in one user turn. Fully resolved tool follow-ups omit native declarations; initial requests and new user questions retain them unless `tool_choice:"none"` is set. Tool-call completions return `content:null` without transcript preambles.

Multi-turn requests use `historyConfig.initialHistoryInClientContent:true`. After `setupComplete`, prior turns (excluding the final turn) are sent in `clientContent` with **`turnComplete:true`** to finish history loading. This does **not** trigger inference. The final turn's text parts, joined with newlines, are then sent once as `realtimeInput.text`. This includes frontend result text when the request ends in tool results. There is no duplicate latest turn or added tool-result continuation prompt. This is a fresh inference, **not an exact continuation of suspended model state**. No tool execution occurs in the Worker. Existing one-time fallback on close code 1007 removes declarations and retries within the original deadline.

Credentialed Developer API checks on 2026-11-13 verified a real `lookup_code` call followed by a second fresh session containing a harmless client-provided mock result. The bridge returned `tool_calls` first, then transcribed `The code you requested is ORCHID 739.` with `stop`; the code existed only in the tool result. Follow-up used `tool_choice:"none"`. A separate structured replay check with tools enabled returned `The code is ORCHID-739.`. These used Node WebSocket adapters, not deployed Workers; other models and complex schemas remain unverified. No real tool side effects were performed.

## Chat test page

Open `https://<worker-host>/`, enter your AI Studio API key, select a model, and send a message. Model defaults to `gemini-3.8-live`; blank chat input also uses that default. Use bare model IDs without `models/`. Changing models retains history; use Clear chat to start fresh. Other models must support this Live API audio/transcription protocol, including history seeding for multi-turn requests; compatibility is not guaranteed. The API defaults an omitted model to `gemini-3.8-live` and echoes the normalized model in completions. `/v1/models` lists only the default, not all Google models. The public page calls the same-origin authenticated API and retains successful chat history. Cancel stops the browser request; failed messages stay in the input for retry. Clear chat removes history. Key and messages are held only in page memory, never localStorage. Reload to discard them. The key is not read from `.env` or embedded in assets.

The page has a 200-second client deadline. Requests may incur Google charges; model availability caveat below still applies.

## Model availability caveat

Google Cloud documents `gemini-3.8-live` text input/output and lists thinking as unsupported. That does **not** prove the same model is available to an AI Studio key. This Worker targets the Gemini Developer API (`generativelanguage.googleapis.com`), **not** the Enterprise/Vertex endpoint. Credentialed tests on 2026-11-13 rejected both TEXT and combined TEXT/AUDIO modalities, but AUDIO with `outputAudioTranscription: {}` returned a transcript successfully. This bridge therefore explicitly uses audio transcription, not native text output. It never silently falls back to another model or GenerateContent.

The installed `.agents/skills/gemini-live-api` skill covers Enterprise/ADC; its endpoint/auth instructions are not used for this explicitly requested AI Studio integration.

Protocol handling waits for `setupComplete`. Single-turn requests use `clientContent.turnComplete:true`. Multi-turn requests set `historyConfig.initialHistoryInClientContent:true`, seed prior turns with `clientContent.turnComplete:true`, then send the final turn as `realtimeInput.text`. The history flag suppresses inference even when the seed ends with `turnComplete:true`; omitting realtime input caused the observed 120-second inactivity close (1008). Responses continue across `turnComplete` with `interactionStatus:IN_PROGRESS`, ending at a non-IN_PROGRESS turn boundary (including older servers that omit the status).

## Validation

Deployment verification (2026-11-23): `node --test worker.live.test.mjs` passed all four live scenarios (five tests including parent): models, simple text, conversation recall, and frontend tool-call/result roundtrip. Requests read `ENDPOINT_URL` and `GEMINI_API_KEY` from environment/local `.env`; full synthetic request/response bodies are printed, never the key.

`worker.retry.test.mjs` and `worker.text-history.test.mjs` pass all 10 tests, including history seeding that deliberately produces no mock response. Six focused protocol tests in `worker.test.mjs` also pass. Full local run: 21 passed, 20 failed. Legacy tests and validation descriptions below still assume strict rejection, bounds, thrown errors, and structured historical tool parts removed by earlier changes; they are not a description of the current permissive implementation. No strict checks were restored for this history fix.

Remaining request checks: bearer-header format; known route/method; `application/json` content type; present, valid UTF-8 JSON object body; 1 MiB/128-level body budgets; nonempty messages array and supported roles/text content; nonstream mode; function-tool containers and unique nonblank declaration names; assistant-only calls with unique nonblank IDs/names and complete ID-paired results. Tool schema/argument/result depth and value budgets remain. `TIMEOUT_MS` configuration bounds, abort/deadline cleanup, 8 MiB upstream budget, and protocol/error checks remain. Upstream batches still require 1–128 calls, unique IDs not reused from history, and currently declared names. No evaluation, reference fetching, or server tool execution is added.

Run `node --test worker.test.mjs` (modern Node with ES module syntax detection). Tests use WebSocket mocks; they do not prove deployed runtime or Google service compatibility.

Sources:
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-live
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-live
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/live-api
