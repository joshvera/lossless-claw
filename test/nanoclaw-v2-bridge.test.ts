import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  adaptLcmToolForNanoclawV2,
  buildNanoclawV2SessionKey,
  isNanoclawV2SessionKey,
  mapNanoclawV2InboundToAgentMessage,
  mapNanoclawV2OutboundToAgentMessage,
  nanoclawV2InboundDbPath,
  nanoclawV2OutboundDbPath,
  parseNanoclawV2SessionKey,
  readNanoclawV2SessionMessages,
  resolveNanoclawV2Paths,
} from "../src/nanoclaw-v2-bridge.js";
import type { AnyAgentTool } from "../src/tools/common.js";

describe("nanoclaw v2 bridge", () => {
  it("resolves v2 paths and stable session keys", () => {
    const paths = resolveNanoclawV2Paths({ projectRoot: "/repo/nanoclaw" });
    expect(paths.dataDir).toBe("/repo/nanoclaw/data");
    expect(paths.centralDbPath).toBe("/repo/nanoclaw/data/v2.db");
    expect(paths.sessionsDir).toBe("/repo/nanoclaw/data/v2-sessions");

    const session = { agent_group_id: "ag main", id: "sess/1" };
    const key = buildNanoclawV2SessionKey(session);
    expect(key).toBe("nanoclaw:v2:ag%20main:sess%2F1");
    expect(isNanoclawV2SessionKey(key)).toBe(true);
    expect(parseNanoclawV2SessionKey(key)).toEqual(session);
    expect(nanoclawV2InboundDbPath(paths, session)).toBe("/repo/nanoclaw/data/v2-sessions/ag main/sess/1/inbound.db");
    expect(nanoclawV2OutboundDbPath(paths, session)).toBe("/repo/nanoclaw/data/v2-sessions/ag main/sess/1/outbound.db");
  });

  it("maps inbound and outbound rows into LCM agent messages without dropping raw metadata", () => {
    const inbound = mapNanoclawV2InboundToAgentMessage({
      id: "in-1",
      seq: 2,
      kind: "chat-sdk",
      timestamp: "2026-05-23T01:00:00.000Z",
      content: JSON.stringify({ text: "hello", sender: "Vera" }),
      platform_id: "platform-1",
      channel_type: "cli",
      thread_id: "thread-1",
      status: "completed",
      trigger: 1,
    });
    expect(inbound).toMatchObject({
      role: "user",
      content: "hello",
      details: {
        host: "nanoclaw-v2",
        source: "inbound",
        id: "in-1",
        kind: "chat-sdk",
        platformId: "platform-1",
      },
    });

    const outbound = mapNanoclawV2OutboundToAgentMessage({
      id: "out-1",
      seq: 3,
      in_reply_to: "in-1",
      kind: "chat",
      timestamp: "2026-05-23T01:00:01.000Z",
      content: JSON.stringify({ text: "hi back" }),
    });
    expect(outbound).toMatchObject({
      role: "assistant",
      content: "hi back",
      details: {
        host: "nanoclaw-v2",
        source: "outbound",
        inReplyTo: "in-1",
      },
    });
  });

  it("reads NanoClaw v2 inbound/outbound DBs in transcript order", () => {
    const root = join(tmpdir(), `lcm-nanoclaw-v2-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const inboundPath = join(root, "inbound.db");
      const outboundPath = join(root, "outbound.db");
      const inbound = new DatabaseSync(inboundPath);
      inbound.exec(`
        CREATE TABLE messages_in (
          id TEXT PRIMARY KEY,
          seq INTEGER,
          kind TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          status TEXT,
          process_after TEXT,
          recurrence TEXT,
          tries INTEGER,
          trigger INTEGER,
          platform_id TEXT,
          channel_type TEXT,
          thread_id TEXT,
          content TEXT NOT NULL,
          source_session_id TEXT,
          on_wake INTEGER
        );
      `);
      inbound.prepare("INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)")
        .run("in-1", 2, "chat", "2026-05-23T01:00:00.000Z", JSON.stringify({ text: "first" }));
      inbound.close();

      const outbound = new DatabaseSync(outboundPath);
      outbound.exec(`
        CREATE TABLE messages_out (
          id TEXT PRIMARY KEY,
          seq INTEGER,
          in_reply_to TEXT,
          timestamp TEXT NOT NULL,
          deliver_after TEXT,
          recurrence TEXT,
          kind TEXT NOT NULL,
          platform_id TEXT,
          channel_type TEXT,
          thread_id TEXT,
          content TEXT NOT NULL
        );
      `);
      outbound.prepare("INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)")
        .run("out-1", 4, "chat", "2026-05-23T01:00:01.000Z", JSON.stringify({ text: "second" }));
      outbound.close();

      const messages = readNanoclawV2SessionMessages({ inboundDbPath: inboundPath, outboundDbPath: outboundPath });
      expect(messages.map((m) => [m.source, m.message.role, m.message.content])).toEqual([
        ["inbound", "user", "first"],
        ["outbound", "assistant", "second"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adapts LCM tools to NanoClaw MCP definitions", async () => {
    const calls: unknown[] = [];
    const tool: AnyAgentTool = {
      name: "lcm_fake",
      description: "fake tool",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      async execute(toolCallId: string, params: Record<string, unknown>, context?: unknown) {
        calls.push({ toolCallId, params, context });
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as AnyAgentTool;

    const adapted = adaptLcmToolForNanoclawV2(tool, {
      sessionId: "sess-1",
      sessionKey: "nanoclaw:v2:ag:sess-1",
      toolCallIdPrefix: "test",
    });

    expect(adapted.tool).toMatchObject({
      name: "lcm_fake",
      description: "fake tool",
      inputSchema: { type: "object" },
    });
    await adapted.handler({ query: "flamingo" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      params: { query: "flamingo" },
      context: { sessionId: "sess-1", sessionKey: "nanoclaw:v2:ag:sess-1" },
    });
  });
});
