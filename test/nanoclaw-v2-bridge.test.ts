import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  adaptLcmToolForNanoclawV2,
  bootstrapNanoclawV2Session,
  bootstrapNanoclawV2Sessions,
  buildNanoclawV2SessionKey,
  isNanoclawV2SessionKey,
  mapNanoclawV2InboundToAgentMessage,
  mapNanoclawV2OutboundToAgentMessage,
  nanoclawV2InboundDbPath,
  nanoclawV2OutboundDbPath,
  nanoclawV2SessionDir,
  nanoclawV2TranscriptFilePath,
  parseNanoclawV2SessionKey,
  readNanoclawV2SessionMessages,
  readNanoclawV2Sessions,
  writeNanoclawV2SessionTranscriptFile,
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
    expect(nanoclawV2InboundDbPath(paths, session)).toBe(
      "/repo/nanoclaw/data/v2-sessions/ag main/sess/1/inbound.db"
    );
    expect(nanoclawV2OutboundDbPath(paths, session)).toBe(
      "/repo/nanoclaw/data/v2-sessions/ag main/sess/1/outbound.db"
    );
  });

  it("rejects NanoClaw session paths that escape the sessions root", () => {
    const paths = resolveNanoclawV2Paths({ projectRoot: "/repo/nanoclaw" });

    expect(
      nanoclawV2SessionDir(paths, { agent_group_id: "ag", id: "sess" })
    ).toBe("/repo/nanoclaw/data/v2-sessions/ag/sess");
    expect(
      nanoclawV2SessionDir(paths, { agent_group_id: "..ag", id: "sess" })
    ).toBe("/repo/nanoclaw/data/v2-sessions/..ag/sess");
    expect(() =>
      nanoclawV2InboundDbPath(paths, {
        agent_group_id: "..",
        id: "outside",
      })
    ).toThrow(/escapes sessionsDir/);
    expect(() =>
      nanoclawV2OutboundDbPath(paths, {
        agent_group_id: "ag",
        id: "../../outside",
      })
    ).toThrow(/escapes sessionsDir/);
    expect(() =>
      nanoclawV2InboundDbPath(paths, {
        agent_group_id: "/tmp",
        id: "outside",
      })
    ).toThrow(/escapes sessionsDir/);
  });

  it("maps inbound and outbound rows into LCM agent messages without dropping raw metadata", () => {
    const inbound = mapNanoclawV2InboundToAgentMessage({
      id: "in-1",
      seq: 2,
      kind: "chat-sdk",
      timestamp: "2026-05-23T01:00:00.000Z",
      content: JSON.stringify({ text: "hello", sender: "Test User" }),
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
      inbound
        .prepare(
          "INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          "in-1",
          2,
          "chat",
          "2026-05-23T01:00:00.000Z",
          JSON.stringify({ text: "first" })
        );
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
      outbound
        .prepare(
          "INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          "out-1",
          4,
          "chat",
          "2026-05-23T01:00:01.000Z",
          JSON.stringify({ text: "second" })
        );
      outbound.close();

      const messages = readNanoclawV2SessionMessages({
        inboundDbPath: inboundPath,
        outboundDbPath: outboundPath,
      });
      expect(
        messages.map((m) => [m.source, m.message.role, m.message.content])
      ).toEqual([
        ["inbound", "user", "first"],
        ["outbound", "assistant", "second"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes NanoClaw sessions to LCM-compatible transcript files and bootstraps them", async () => {
    const root = join(
      tmpdir(),
      `lcm-nanoclaw-v2-bootstrap-${process.pid}-${Date.now()}`
    );
    mkdirSync(root, { recursive: true });
    try {
      const paths = resolveNanoclawV2Paths({ projectRoot: root });
      const lcmStateDir = join(root, "lcm-state");
      const session = { agent_group_id: "ag/main", id: "sess/1" };
      mkdirSync(join(paths.sessionsDir, session.agent_group_id, session.id), {
        recursive: true,
      });

      const inboundPath = nanoclawV2InboundDbPath(paths, session);
      const outboundPath = nanoclawV2OutboundDbPath(paths, session);
      const inbound = new DatabaseSync(inboundPath);
      inbound.exec(`
        CREATE TABLE messages_in (
          id TEXT PRIMARY KEY,
          seq INTEGER,
          kind TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);
      inbound
        .prepare(
          "INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          "in-1",
          2,
          "chat",
          "2026-05-23T01:00:00.000Z",
          JSON.stringify({ text: "first" })
        );
      inbound.close();

      const outbound = new DatabaseSync(outboundPath);
      outbound.exec(`
        CREATE TABLE messages_out (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);
      outbound
        .prepare(
          "INSERT INTO messages_out (id, timestamp, kind, content) VALUES (?, ?, ?, ?)"
        )
        .run(
          "out-1",
          "2026-05-23T01:00:01.000Z",
          "chat",
          JSON.stringify({ text: "second" })
        );
      outbound.close();

      const defaultPath = nanoclawV2TranscriptFilePath(paths, session, {
        lcmStateDir,
      });
      expect(defaultPath).toContain("nanoclaw-v2-transcripts");
      expect(defaultPath).not.toContain("ag/main/sess/1");

      const written = writeNanoclawV2SessionTranscriptFile({
        paths,
        session,
        lcmStateDir,
      });
      expect(written).toMatchObject({
        sessionFile: defaultPath,
        sessionKey: "nanoclaw:v2:ag%2Fmain:sess%2F1",
        messageCount: 2,
      });
      const lines = readFileSync(written.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        lines.map((line) => [line.message.role, line.message.content])
      ).toEqual([
        ["user", "first"],
        ["assistant", "second"],
      ]);

      const calls: unknown[] = [];
      const lcm = {
        async bootstrap(params: {
          sessionId: string;
          sessionKey?: string;
          sessionFile: string;
        }) {
          calls.push(params);
          return { bootstrapped: true, importedMessages: 2 };
        },
      };

      const bootstrapped = await bootstrapNanoclawV2Session({
        lcm,
        paths,
        session,
        lcmStateDir,
      });
      expect(bootstrapped.bootstrap).toEqual({
        bootstrapped: true,
        importedMessages: 2,
      });
      expect(calls).toEqual([
        {
          sessionId: "sess/1",
          sessionKey: "nanoclaw:v2:ag%2Fmain:sess%2F1",
          sessionFile: defaultPath,
        },
      ]);

      const all = await bootstrapNanoclawV2Sessions({
        lcm,
        paths,
        sessions: [session],
        lcmStateDir,
      });
      expect(all).toHaveLength(1);
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades recoverable SQLite read failures without overwriting an existing transcript mirror", () => {
    const root = join(
      tmpdir(),
      `lcm-nanoclaw-v2-read-failure-${process.pid}-${Date.now()}`
    );
    mkdirSync(root, { recursive: true });
    try {
      const paths = resolveNanoclawV2Paths({ projectRoot: root });
      const session = { agent_group_id: "ag", id: "sess" };
      mkdirSync(nanoclawV2SessionDir(paths, session), { recursive: true });

      const centralFailures: unknown[] = [];
      writeFileSync(paths.centralDbPath, "not a sqlite database", "utf8");
      expect(
        readNanoclawV2Sessions(paths.centralDbPath, {
          onReadError: (failure) => centralFailures.push(failure),
        })
      ).toEqual([]);
      expect(centralFailures).toHaveLength(1);
      expect(centralFailures[0]).toMatchObject({
        source: "sessions",
        dbPath: paths.centralDbPath,
      });

      const inboundPath = nanoclawV2InboundDbPath(paths, session);
      writeFileSync(inboundPath, "not a sqlite database", "utf8");
      const messageFailures: unknown[] = [];
      expect(
        readNanoclawV2SessionMessages({
          inboundDbPath: inboundPath,
          outboundDbPath: nanoclawV2OutboundDbPath(paths, session),
          onReadError: (failure) => messageFailures.push(failure),
        })
      ).toEqual([]);
      expect(messageFailures).toHaveLength(1);
      expect(messageFailures[0]).toMatchObject({
        source: "inbound",
        dbPath: inboundPath,
      });

      const sessionFile = join(root, "mirror.jsonl");
      const previousMirror = `${JSON.stringify({
        message: { role: "user", content: "previous" },
      })}\n`;
      writeFileSync(sessionFile, previousMirror, "utf8");

      expect(() =>
        writeNanoclawV2SessionTranscriptFile({
          paths,
          session,
          sessionFile,
        })
      ).toThrow(/Refusing to overwrite/);
      expect(readFileSync(sessionFile, "utf8")).toBe(previousMirror);
      expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual(
        []
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tolerates legacy NanoClaw session DBs without later optional columns", () => {
    const root = join(
      tmpdir(),
      `lcm-nanoclaw-v2-legacy-${process.pid}-${Date.now()}`
    );
    mkdirSync(root, { recursive: true });
    try {
      const inboundPath = join(root, "inbound.db");
      const outboundPath = join(root, "outbound.db");
      const inbound = new DatabaseSync(inboundPath);
      inbound.exec(`
        CREATE TABLE messages_in (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);
      inbound
        .prepare(
          "INSERT INTO messages_in (id, kind, timestamp, content) VALUES (?, ?, ?, ?)"
        )
        .run("legacy-in", "chat", "2026-05-23T01:00:00.000Z", "legacy hello");
      inbound.close();

      const outbound = new DatabaseSync(outboundPath);
      outbound.exec(`
        CREATE TABLE messages_out (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);
      outbound
        .prepare(
          "INSERT INTO messages_out (id, timestamp, kind, content) VALUES (?, ?, ?, ?)"
        )
        .run(
          "legacy-out",
          "2026-05-23T01:00:01.000Z",
          "chat",
          "legacy response"
        );
      outbound.close();

      const messages = readNanoclawV2SessionMessages({
        inboundDbPath: inboundPath,
        outboundDbPath: outboundPath,
      });
      expect(messages.map((m) => [m.row.id, m.message.content])).toEqual([
        ["legacy-in", "legacy hello"],
        ["legacy-out", "legacy response"],
      ]);
      expect(messages[0].message.details).toMatchObject({
        trigger: null,
        sourceSessionId: null,
      });
      expect(messages[1].message.details).toMatchObject({ inReplyTo: null });
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
      async execute(
        toolCallId: string,
        params: Record<string, unknown>,
        context?: unknown
      ) {
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
    await adapted.handler({ query: "heron" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      params: { query: "flamingo" },
      context: { sessionId: "sess-1", sessionKey: "nanoclaw:v2:ag:sess-1" },
    });
    expect(calls[1]).toMatchObject({
      params: { query: "heron" },
      context: { sessionId: "sess-1", sessionKey: "nanoclaw:v2:ag:sess-1" },
    });
    const ids = calls.map(
      (call) => (call as { toolCallId: string }).toolCallId
    );
    expect(ids[0]).toMatch(/^test-lcm_fake-/);
    expect(ids[1]).toMatch(/^test-lcm_fake-/);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
