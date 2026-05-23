# NanoClaw v2 integration

`lossless-claw` now exposes a NanoClaw v2 bridge alongside the existing OpenClaw plugin entry point. The bridge is intentionally host-adapter shaped: it maps NanoClaw v2 session records and per-session SQLite files into LCM's existing engine/tool contracts without deleting, truncating, or rewriting NanoClaw data.

## Target interface

The bridge matches the NanoClaw v2 layout observed in `/Users/vera/github/finn` after the v2 update:

- central app DB: `data/v2.db`
- session folders: `data/v2-sessions/<agent_group_id>/<session_id>/`
- host-written inbound DB: `inbound.db` with `messages_in`
- container-written outbound DB: `outbound.db` with `messages_out`
- container MCP tools as `{ tool, handler }` definitions

The adapter reads those DBs through read-only opens when available and never performs maintenance deletion against NanoClaw's live DBs.

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
  createNanoclawV2RecallTools,
  createNanoclawV2RecallInstructions,
} from "@martian-engineering/lossless-claw";
```

Useful primitives:

- `resolveNanoclawV2Paths({ projectRoot })` resolves `data/v2.db` and `data/v2-sessions` paths. `NANOCLAW_PROJECT_ROOT`, `NANOCLAW_DATA_DIR`, or `NANOCLAW_STATE_DIR` can override defaults.
- `readNanoclawV2Sessions(centralDbPath)` lists central `sessions` rows without mutation.
- `readNanoclawV2SessionMessages({ inboundDbPath, outboundDbPath })` returns timestamp-sorted LCM `AgentMessage` projections from `messages_in` and `messages_out`.
- `buildNanoclawV2SessionKey(session)` creates stable LCM session keys shaped like `nanoclaw:v2:<agent_group_id>:<session_id>`.
- `createNanoclawV2RecallTools(...)` adapts `lcm_grep` and `lcm_describe` into NanoClaw v2 MCP `{ tool, handler }` definitions.

## Suggested host wiring

A NanoClaw fork can ingest a session by resolving its paths and bootstrapping the existing LCM engine with mapped messages:

```ts
const paths = resolveNanoclawV2Paths({ projectRoot: process.cwd() });
const [session] = readNanoclawV2Sessions(paths.centralDbPath);
const sessionKey = buildNanoclawV2SessionKey(session);
const transcript = readNanoclawV2SessionMessages({
  inboundDbPath: nanoclawV2InboundDbPath(paths, session),
  outboundDbPath: nanoclawV2OutboundDbPath(paths, session),
});

await lcm.bootstrap({
  sessionId: session.id,
  sessionKey,
  messages: transcript.map((entry) => entry.message),
});
```

For agent recall, install the returned MCP definitions into NanoClaw's v2 tool registry and include `createNanoclawV2RecallInstructions()` in the composed agent instructions. Keep the LCM database host-owned; if a container needs direct access, mount it read-only and continue to route writes through the host.

## Current scope

This is a v2 interface port, not a full NanoClaw product module. It covers:

- v2 path/session identity helpers
- read-only transcript projection from `inbound.db`/`outbound.db`
- MCP-definition adaptation for recall tools
- tests for session keys, DB reads, row mapping, and tool wrapping

Context replacement, automatic post-turn compaction scheduling inside NanoClaw, `/lcm` command parity, and delegated `lcm_expand_query` sub-agent orchestration should be wired in a later NanoClaw host module once session ingestion and recall have been validated against live data.
