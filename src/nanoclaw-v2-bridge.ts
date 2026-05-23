import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage, BootstrapResult } from "./openclaw-bridge.js";
import type { LcmContextEngine } from "./engine.js";
import type { LcmDependencies } from "./types.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createLcmDescribeTool } from "./tools/lcm-describe-tool.js";
import { createLcmGrepTool } from "./tools/lcm-grep-tool.js";

export type NanoclawV2Paths = {
  projectRoot: string;
  dataDir: string;
  centralDbPath: string;
  sessionsDir: string;
};

export type NanoclawV2Session = {
  id: string;
  agent_group_id: string;
  messaging_group_id?: string | null;
  thread_id?: string | null;
  agent_provider?: string | null;
  status?: string | null;
  container_status?: string | null;
  last_active?: string | null;
  created_at?: string | null;
};

export type NanoclawV2MessageInRow = {
  id: string;
  seq?: number | null;
  kind: string;
  timestamp: string;
  status?: string | null;
  process_after?: string | null;
  recurrence?: string | null;
  tries?: number | null;
  trigger?: number | null;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
  source_session_id?: string | null;
  on_wake?: number | null;
};

export type NanoclawV2MessageOutRow = {
  id: string;
  seq?: number | null;
  in_reply_to?: string | null;
  timestamp: string;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
};

export type NanoclawV2TranscriptMessage = {
  source: "inbound" | "outbound";
  row: NanoclawV2MessageInRow | NanoclawV2MessageOutRow;
  message: AgentMessage;
};

export type NanoclawV2TranscriptWriteResult = {
  sessionFile: string;
  sessionKey: string;
  messageCount: number;
};

export type NanoclawV2ReadFailure = {
  source: "sessions" | "inbound" | "outbound";
  dbPath: string;
  error: unknown;
};

export type NanoclawV2BootstrapResult = NanoclawV2TranscriptWriteResult & {
  session: NanoclawV2Session;
  bootstrap: BootstrapResult;
};

export type NanoclawV2BootstrapEngine = {
  bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult>;
};

export type NanoclawV2McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type NanoclawV2McpToolDefinition = {
  tool: NanoclawV2McpTool;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

export type NanoclawV2ReadErrorHandler = (
  failure: NanoclawV2ReadFailure
) => void;

export type NanoclawV2ToolAdapterContext = {
  sessionId?: string;
  sessionKey?: string;
  toolCallIdPrefix?: string;
};

export type CreateNanoclawV2RecallToolsInput = {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
};

export function resolveNanoclawV2Paths(
  input: {
    projectRoot?: string;
    dataDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): NanoclawV2Paths {
  const env = input.env ?? process.env;
  const projectRoot = resolve(
    input.projectRoot ?? env.NANOCLAW_PROJECT_ROOT ?? process.cwd()
  );
  const dataDir = resolve(
    input.dataDir ??
      env.NANOCLAW_DATA_DIR ??
      env.NANOCLAW_STATE_DIR ??
      join(projectRoot, "data")
  );
  return {
    projectRoot,
    dataDir,
    centralDbPath: join(dataDir, "v2.db"),
    sessionsDir: join(dataDir, "v2-sessions"),
  };
}

export function resolveNanoclawV2LcmStateDir(
  input: {
    projectRoot?: string;
    dataDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): string {
  const env = input.env ?? process.env;
  return resolve(
    env.LCM_NANOCLAW_STATE_DIR ??
      env.LCM_STATE_DIR ??
      join(resolveNanoclawV2Paths(input).dataDir, "lossless-claw")
  );
}

export function nanoclawV2SessionDir(
  paths: NanoclawV2Paths,
  session: Pick<NanoclawV2Session, "agent_group_id" | "id">
): string {
  const sessionsRoot = resolve(paths.sessionsDir);
  const sessionDir = resolve(sessionsRoot, session.agent_group_id, session.id);
  if (!isPathInsideDirectory(sessionDir, sessionsRoot)) {
    throw new Error(
      `NanoClaw v2 session path escapes sessionsDir: ${session.agent_group_id}/${session.id}`
    );
  }
  return sessionDir;
}

export function nanoclawV2InboundDbPath(
  paths: NanoclawV2Paths,
  session: Pick<NanoclawV2Session, "agent_group_id" | "id">
): string {
  return join(nanoclawV2SessionDir(paths, session), "inbound.db");
}

export function nanoclawV2OutboundDbPath(
  paths: NanoclawV2Paths,
  session: Pick<NanoclawV2Session, "agent_group_id" | "id">
): string {
  return join(nanoclawV2SessionDir(paths, session), "outbound.db");
}

export function buildNanoclawV2SessionKey(
  session: Pick<NanoclawV2Session, "agent_group_id" | "id">
): string {
  return `nanoclaw:v2:${encodeURIComponent(
    session.agent_group_id
  )}:${encodeURIComponent(session.id)}`;
}

export function parseNanoclawV2SessionKey(
  sessionKey: string
): Pick<NanoclawV2Session, "agent_group_id" | "id"> | null {
  const parts = sessionKey.split(":");
  if (parts.length !== 4 || parts[0] !== "nanoclaw" || parts[1] !== "v2") {
    return null;
  }
  const agentGroupId = safeDecodeURIComponent(parts[2] ?? "");
  const sessionId = safeDecodeURIComponent(parts[3] ?? "");
  if (!agentGroupId || !sessionId) {
    return null;
  }
  return { agent_group_id: agentGroupId, id: sessionId };
}

export function isNanoclawV2SessionKey(
  sessionKey: string | undefined
): boolean {
  return (
    typeof sessionKey === "string" &&
    parseNanoclawV2SessionKey(sessionKey) !== null
  );
}

export function nanoclawV2TranscriptFilePath(
  paths: Pick<NanoclawV2Paths, "dataDir">,
  session: Pick<NanoclawV2Session, "agent_group_id" | "id">,
  input: { lcmStateDir?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  const stateDir = resolveNanoclawV2LcmStateDir({
    dataDir: paths.dataDir,
    env: input.env,
  });
  return join(
    input.lcmStateDir ?? stateDir,
    "nanoclaw-v2-transcripts",
    encodePathSegment(session.agent_group_id),
    `${encodePathSegment(session.id)}.jsonl`
  );
}

export function writeNanoclawV2SessionTranscriptFile(input: {
  paths: NanoclawV2Paths;
  session: NanoclawV2Session;
  sessionFile?: string;
  lcmStateDir?: string;
  includeSystem?: boolean;
}): NanoclawV2TranscriptWriteResult {
  const sessionKey = buildNanoclawV2SessionKey(input.session);
  const sessionFile =
    input.sessionFile ??
    nanoclawV2TranscriptFilePath(input.paths, input.session, {
      lcmStateDir: input.lcmStateDir,
    });
  const readFailures: NanoclawV2ReadFailure[] = [];
  const transcript = readNanoclawV2SessionMessages({
    inboundDbPath: nanoclawV2InboundDbPath(input.paths, input.session),
    outboundDbPath: nanoclawV2OutboundDbPath(input.paths, input.session),
    includeSystem: input.includeSystem,
    onReadError: (failure) => readFailures.push(failure),
  });
  if (readFailures.length > 0) {
    throw new Error(
      `Refusing to overwrite NanoClaw v2 transcript mirror after ${readFailures.length} transient SQLite read failure(s); existing mirror left unchanged`
    );
  }
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeTranscriptJsonlAtomically(sessionFile, transcript);
  return { sessionFile, sessionKey, messageCount: transcript.length };
}

export async function bootstrapNanoclawV2Session(input: {
  lcm: NanoclawV2BootstrapEngine;
  paths: NanoclawV2Paths;
  session: NanoclawV2Session;
  sessionFile?: string;
  lcmStateDir?: string;
  includeSystem?: boolean;
}): Promise<NanoclawV2BootstrapResult> {
  const written = writeNanoclawV2SessionTranscriptFile(input);
  const bootstrap = await input.lcm.bootstrap({
    sessionId: input.session.id,
    sessionKey: written.sessionKey,
    sessionFile: written.sessionFile,
  });
  return { ...written, session: input.session, bootstrap };
}

export async function bootstrapNanoclawV2Sessions(input: {
  lcm: NanoclawV2BootstrapEngine;
  paths: NanoclawV2Paths;
  sessions?: NanoclawV2Session[];
  filter?: (session: NanoclawV2Session) => boolean;
  lcmStateDir?: string;
  includeSystem?: boolean;
}): Promise<NanoclawV2BootstrapResult[]> {
  const sessions =
    input.sessions ?? readNanoclawV2Sessions(input.paths.centralDbPath);
  const selected = input.filter ? sessions.filter(input.filter) : sessions;
  const results: NanoclawV2BootstrapResult[] = [];
  for (const session of selected) {
    results.push(
      await bootstrapNanoclawV2Session({
        lcm: input.lcm,
        paths: input.paths,
        session,
        lcmStateDir: input.lcmStateDir,
        includeSystem: input.includeSystem,
      })
    );
  }
  return results;
}

export function readNanoclawV2Sessions(
  centralDbPath: string,
  input: { onReadError?: NanoclawV2ReadErrorHandler } = {}
): NanoclawV2Session[] {
  if (!existsSync(centralDbPath)) {
    return [];
  }
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnlyDatabase(centralDbPath);
    if (!hasTable(db, "sessions")) {
      return [];
    }
    return db
      .prepare(
        `SELECT id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at
         FROM sessions
        ORDER BY COALESCE(last_active, created_at, '') DESC, id ASC`
      )
      .all() as NanoclawV2Session[];
  } catch (error) {
    return handleSqliteReadError({
      source: "sessions",
      dbPath: centralDbPath,
      error,
      onReadError: input.onReadError,
    });
  } finally {
    db?.close();
  }
}

export function readNanoclawV2SessionMessages(input: {
  inboundDbPath: string;
  outboundDbPath: string;
  includeSystem?: boolean;
  onReadError?: NanoclawV2ReadErrorHandler;
}): NanoclawV2TranscriptMessage[] {
  const inbound = readInboundRows(input.inboundDbPath, input.onReadError)
    .filter((row) => input.includeSystem !== false || row.kind !== "system")
    .map<NanoclawV2TranscriptMessage>((row) => ({
      source: "inbound",
      row,
      message: mapNanoclawV2InboundToAgentMessage(row),
    }));
  const outbound = readOutboundRows(input.outboundDbPath, input.onReadError)
    .filter((row) => input.includeSystem !== false || row.kind !== "system")
    .map<NanoclawV2TranscriptMessage>((row) => ({
      source: "outbound",
      row,
      message: mapNanoclawV2OutboundToAgentMessage(row),
    }));

  return [...inbound, ...outbound].sort(compareTranscriptMessages);
}

export function mapNanoclawV2InboundToAgentMessage(
  row: NanoclawV2MessageInRow
): AgentMessage {
  const parsed = parseJsonMaybe(row.content);
  return {
    role: inboundRole(row.kind),
    content: normalizeNanoclawV2Content(parsed),
    timestamp: timestampMillis(row.timestamp),
    details: {
      host: "nanoclaw-v2",
      source: "inbound",
      id: row.id,
      seq: row.seq ?? null,
      kind: row.kind,
      status: row.status ?? null,
      trigger: row.trigger ?? null,
      platformId: row.platform_id ?? null,
      channelType: row.channel_type ?? null,
      threadId: row.thread_id ?? null,
      sourceSessionId: row.source_session_id ?? null,
      rawContent: parsed,
    },
  };
}

export function mapNanoclawV2OutboundToAgentMessage(
  row: NanoclawV2MessageOutRow
): AgentMessage {
  const parsed = parseJsonMaybe(row.content);
  return {
    role: outboundRole(row.kind),
    content: normalizeNanoclawV2Content(parsed),
    timestamp: timestampMillis(row.timestamp),
    details: {
      host: "nanoclaw-v2",
      source: "outbound",
      id: row.id,
      seq: row.seq ?? null,
      kind: row.kind,
      inReplyTo: row.in_reply_to ?? null,
      platformId: row.platform_id ?? null,
      channelType: row.channel_type ?? null,
      threadId: row.thread_id ?? null,
      rawContent: parsed,
    },
  };
}

export function normalizeNanoclawV2Content(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeNanoclawV2Content(item))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "text",
      "markdown",
      "message",
      "prompt",
      "title",
      "fallbackText",
    ] as const) {
      const field = record[key];
      if (typeof field === "string" && field.trim()) {
        return field;
      }
    }
    if (Array.isArray(record.parts)) {
      return normalizeNanoclawV2Content(record.parts);
    }
    return JSON.stringify(record, null, 2);
  }
  return String(value);
}

export function adaptLcmToolForNanoclawV2(
  tool: AnyAgentTool,
  context: NanoclawV2ToolAdapterContext = {}
): NanoclawV2McpToolDefinition {
  const inputSchema = toolSchema(tool);
  return {
    tool: {
      name: tool.name,
      description: tool.description,
      inputSchema,
    },
    async handler(args) {
      const toolCallId = `${context.toolCallIdPrefix ?? "nanoclaw-v2"}-${
        tool.name
      }-${randomUUID()}`;
      const execute = tool.execute as unknown as (
        toolCallId: string,
        params: Record<string, unknown>,
        context?: { sessionId?: string; sessionKey?: string }
      ) => Promise<unknown>;
      return execute(toolCallId, args ?? {}, {
        sessionId: context.sessionId,
        sessionKey: context.sessionKey,
      });
    },
  };
}

export function createNanoclawV2RecallTools(
  input: CreateNanoclawV2RecallToolsInput
): NanoclawV2McpToolDefinition[] {
  const shared = {
    deps: input.deps,
    lcm: input.lcm,
    getLcm: input.getLcm,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
  };
  return [
    adaptLcmToolForNanoclawV2(createLcmGrepTool(shared), input),
    adaptLcmToolForNanoclawV2(createLcmDescribeTool(shared), input),
  ];
}

export function createNanoclawV2RecallInstructions(): string {
  return [
    "## Lossless recall tools",
    "",
    "NanoClaw v2 has lossless-claw recall tools available for compacted or older conversation history.",
    "Use `lcm_grep` to search messages and summaries by regex or full-text terms.",
    "Use `lcm_describe` with a returned message, summary, or file id to inspect exact stored detail.",
    "Do not assume older context is gone; search lossless-claw before saying you cannot remember prior conversation details.",
  ].join("\n");
}

function readInboundRows(
  dbPath: string,
  onReadError?: NanoclawV2ReadErrorHandler
): NanoclawV2MessageInRow[] {
  if (!existsSync(dbPath)) {
    return [];
  }
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnlyDatabase(dbPath);
    if (!hasTable(db, "messages_in")) {
      return [];
    }
    const columns = getTableColumns(db, "messages_in");
    const seqOrder = columns.has("seq")
      ? "COALESCE(seq, 0)"
      : "CAST(0 AS INTEGER)";
    const select = selectColumns(columns, [
      "id",
      "seq",
      "kind",
      "timestamp",
      "status",
      "process_after",
      "recurrence",
      "tries",
      "trigger",
      "platform_id",
      "channel_type",
      "thread_id",
      "content",
      "source_session_id",
      "on_wake",
    ]);
    return db
      .prepare(
        `SELECT ${select}
         FROM messages_in
        ORDER BY timestamp ASC, ${seqOrder} ASC, id ASC`
      )
      .all() as NanoclawV2MessageInRow[];
  } catch (error) {
    return handleSqliteReadError({
      source: "inbound",
      dbPath,
      error,
      onReadError,
    });
  } finally {
    db?.close();
  }
}

function readOutboundRows(
  dbPath: string,
  onReadError?: NanoclawV2ReadErrorHandler
): NanoclawV2MessageOutRow[] {
  if (!existsSync(dbPath)) {
    return [];
  }
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnlyDatabase(dbPath);
    if (!hasTable(db, "messages_out")) {
      return [];
    }
    const columns = getTableColumns(db, "messages_out");
    const seqOrder = columns.has("seq")
      ? "COALESCE(seq, 0)"
      : "CAST(0 AS INTEGER)";
    const select = selectColumns(columns, [
      "id",
      "seq",
      "in_reply_to",
      "timestamp",
      "deliver_after",
      "recurrence",
      "kind",
      "platform_id",
      "channel_type",
      "thread_id",
      "content",
    ]);
    return db
      .prepare(
        `SELECT ${select}
         FROM messages_out
        ORDER BY timestamp ASC, ${seqOrder} ASC, id ASC`
      )
      .all() as NanoclawV2MessageOutRow[];
  } catch (error) {
    return handleSqliteReadError({
      source: "outbound",
      dbPath,
      error,
      onReadError,
    });
  } finally {
    db?.close();
  }
}

function openReadOnlyDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

function writeTranscriptJsonlAtomically(
  sessionFile: string,
  transcript: NanoclawV2TranscriptMessage[]
): void {
  const sessionDir = dirname(sessionFile);
  const tempFile = join(
    sessionDir,
    `.${basename(sessionFile)}.${process.pid}.${randomUUID()}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempFile, "wx", 0o600);
    for (const entry of transcript) {
      writeSync(fd, `${JSON.stringify({ message: entry.message })}\n`);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempFile, sessionFile);
    fsyncDirectoryBestEffort(sessionDir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      unlinkSync(tempFile);
    } catch {
      // Temp cleanup is best-effort; never delete the existing mirror.
    }
    throw error;
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms do not allow fsync on directories. The file itself was fsynced.
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function handleSqliteReadError<T>(input: {
  source: NanoclawV2ReadFailure["source"];
  dbPath: string;
  error: unknown;
  onReadError?: NanoclawV2ReadErrorHandler;
}): T[] {
  if (!isRecoverableSqliteReadError(input.error) || !input.onReadError) {
    throw input.error;
  }
  input.onReadError({
    source: input.source,
    dbPath: input.dbPath,
    error: input.error,
  });
  return [];
}

function isRecoverableSqliteReadError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : "";
  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    code === "SQLITE_CORRUPT" ||
    code === "SQLITE_NOTADB"
  ) {
    return true;
  }
  const message = typeof record.message === "string" ? record.message : "";
  return /SQLITE_(BUSY|LOCKED|CORRUPT|NOTADB)|database is locked|database disk image is malformed|file is not a database/i.test(
    message
  );
}

function isPathInsideDirectory(
  candidatePath: string,
  rootPath: string
): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    )
    .get(tableName);
  return row !== undefined;
}

function selectColumns(
  columns: Set<string>,
  expectedColumns: string[]
): string {
  return expectedColumns
    .map((column) => (columns.has(column) ? column : `NULL AS ${column}`))
    .join(", ");
}

function getTableColumns(db: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name)
  );
}

function parseJsonMaybe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function timestampMillis(value: string): number | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function inboundRole(kind: string): string {
  if (kind === "system") {
    return "system";
  }
  return "user";
}

function outboundRole(kind: string): string {
  if (kind === "system") {
    return "system";
  }
  return "assistant";
}

function compareTranscriptMessages(
  left: NanoclawV2TranscriptMessage,
  right: NanoclawV2TranscriptMessage
): number {
  const leftTime = timestampMillis(left.row.timestamp) ?? 0;
  const rightTime = timestampMillis(right.row.timestamp) ?? 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const leftSeq = left.row.seq ?? 0;
  const rightSeq = right.row.seq ?? 0;
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }
  if (left.source !== right.source) {
    return left.source === "inbound" ? -1 : 1;
  }
  return left.row.id.localeCompare(right.row.id);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function toolSchema(tool: AnyAgentTool): Record<string, unknown> | undefined {
  const candidate =
    (tool as unknown as { parameters?: unknown; inputSchema?: unknown })
      .parameters ?? (tool as unknown as { inputSchema?: unknown }).inputSchema;
  return candidate && typeof candidate === "object"
    ? (candidate as Record<string, unknown>)
    : undefined;
}
