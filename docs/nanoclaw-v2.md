# NanoClaw v2 integration

`lossless-claw` exposes a NanoClaw v2 bridge alongside the existing OpenClaw plugin entry point. The bridge is host-adapter shaped: it reads NanoClaw v2 session records and per-session SQLite files, writes a lossless-claw-owned transcript mirror, and bootstraps LCM from that mirror without deleting, truncating, or rewriting NanoClaw data.

## Target interface

The bridge matches the NanoClaw v2 layout observed in `/Users/vera/github/finn` after the v2 update:

- central app DB: `data/v2.db`
- session folders: `data/v2-sessions/<agent_group_id>/<session_id>/`
- host-written inbound DB: `inbound.db` with `messages_in`
- container-written outbound DB: `outbound.db` with `messages_out`
- container MCP tools as `{ tool, handler }` definitions

The adapter opens NanoClaw DBs read-only and never performs maintenance deletion against NanoClaw's live DBs. The only files it writes are lossless-claw-owned transcript mirrors under `data/lossless-claw/nanoclaw-v2-transcripts/` by default, or under `LCM_NANOCLAW_STATE_DIR` / `LCM_STATE_DIR` when configured.

## Exported helpers

Import from the package root:

```ts
import {
  resolveNanoclawV2Paths,
  readNanoclawV2Sessions,
  readNanoclawV2SessionMessages,
  buildNanoclawV2SessionKey,
  nanoclawV2InboundDbPath,
  nanoclawV2OutboundDbPath,
  nanoclawV2TranscriptFilePath,
  writeNanoclawV2SessionTranscriptFile,
  bootstrapNanoclawV2Session,
  bootstrapNanoclawV2Sessions,
  createLcmRuntime,
  createLcmRuntimeRecallTools,
  createNanoclawV2RecallTools,
  createNanoclawV2RecallInstructions,
} from "@martian-engineering/lossless-claw";
```

Useful primitives:

- `resolveNanoclawV2Paths({ projectRoot })` resolves `data/v2.db` and `data/v2-sessions` paths. `NANOCLAW_PROJECT_ROOT`, `NANOCLAW_DATA_DIR`, or `NANOCLAW_STATE_DIR` can override defaults.
- `readNanoclawV2Sessions(centralDbPath)` lists central `sessions` rows without mutation.
- `readNanoclawV2SessionMessages({ inboundDbPath, outboundDbPath })` returns timestamp-sorted LCM `AgentMessage` projections from `messages_in` and `messages_out`.
- `buildNanoclawV2SessionKey(session)` creates stable LCM session keys shaped like `nanoclaw:v2:<agent_group_id>:<session_id>`.
- `writeNanoclawV2SessionTranscriptFile(...)` writes a JSONL transcript mirror in the same `{ message }` shape that the LCM engine already bootstraps from.
- `bootstrapNanoclawV2Session(...)` writes that transcript mirror and calls `lcm.bootstrap({ sessionId, sessionKey, sessionFile })`.
- `bootstrapNanoclawV2Sessions(...)` repeats that flow for the central `sessions` table or for a caller-provided session list.
- `createLcmRuntime(...)` creates a host-owned LCM database connection and engine using explicit host adapters.
- `createLcmRuntimeRecallTools(...)` returns package-native `lcm_grep` and `lcm_describe` tool objects for hosts that do not need NanoClaw MCP wrapping.
- `createNanoclawV2RecallTools(...)` adapts `lcm_grep` and `lcm_describe` into NanoClaw v2 MCP `{ tool, handler }` definitions.

## Suggested host wiring

A NanoClaw fork can create a host-owned LCM runtime, ingest all known sessions, and then expose recall tools to containers:

```ts
const paths = resolveNanoclawV2Paths({ projectRoot: process.cwd() });
const runtime = createLcmRuntime({
  databasePath: `${paths.dataDir}/lossless-claw/lcm.db`,
  largeFilesDir: `${paths.dataDir}/lossless-claw/files`,
  env: process.env,
  // Required before enabling write/compaction features:
  complete: hostLlmComplete,
  callGateway: hostGatewayCall,
  resolveSessionIdFromSessionKey: hostResolveSessionId,
  resolveSessionTranscriptFile: hostResolveTranscriptPath,
});

const results = await bootstrapNanoclawV2Sessions({
  lcm: runtime.lcm,
  paths,
  // Optional: omit system rows if your NanoClaw host does not want them in recall.
  includeSystem: false,
});

console.log(`Bootstrapped ${results.length} NanoClaw sessions into lossless-claw`);

const recallTools = createNanoclawV2RecallTools({
  deps: runtime.deps,
  lcm: runtime.lcm,
  sessionId: activeSession.id,
  sessionKey: buildNanoclawV2SessionKey(activeSession),
});
```

For a single active session, use the narrower helper:

```ts
const paths = resolveNanoclawV2Paths({ projectRoot: process.cwd() });
const session = readNanoclawV2Sessions(paths.centralDbPath)[0];

const result = await bootstrapNanoclawV2Session({
  lcm,
  paths,
  session,
});

console.log(result.sessionKey, result.sessionFile, result.bootstrap);
```

For agent recall, install the returned MCP definitions into NanoClaw's v2 tool registry and include `createNanoclawV2RecallInstructions()` in the composed agent instructions. Keep the LCM database host-owned; if a container needs direct access, mount it read-only and continue to route writes through the host.

## Runtime API safety contract

`createLcmRuntime` is intentionally explicit about host-owned capabilities:

- `databasePath` and `largeFilesDir` keep LCM state outside NanoClaw's live message DBs.
- `complete` is required for summarization/compaction. If omitted, the runtime fails closed for model-backed summarization rather than using hidden credentials.
- `callGateway` is required for delegated expansion/subagents. If omitted, delegated calls fail closed.
- `resolveSessionIdFromSessionKey` and `resolveSessionTranscriptFile` are host adapters; they should be implemented by NanoClaw against its typed session model.
- `runtime.close()` closes the factory-owned SQLite connection.

This API is enough for NanoClaw to wire live `lcm_grep` and `lcm_describe` safely after the host decides where MCP tools are registered and how active session identity is passed into containers.

## Current scope

This is a v2 bridge, not a full NanoClaw product module. It covers:

- v2 path/session identity helpers
- read-only transcript projection from `inbound.db`/`outbound.db`
- lossless-claw-owned transcript mirror writing for LCM bootstrap
- public host runtime factory for LCM engine/config instantiation
- one-session and all-session bootstrap helpers
- MCP-definition adaptation for recall tools
- tests for session keys, DB reads, row mapping, transcript writing, bootstrap wrapping, legacy DB tolerance, and tool wrapping

Context replacement, automatic post-turn compaction scheduling inside NanoClaw, `/lcm` command parity, and delegated `lcm_expand_query` sub-agent orchestration should be wired in a later NanoClaw host module once session ingestion and recall have been validated against live data.
