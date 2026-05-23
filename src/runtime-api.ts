import type { DatabaseSync } from "node:sqlite";

import { closeLcmConnection, createLcmDatabaseConnection, normalizePath } from "./db/connection.js";
import { resolveLcmConfigWithDiagnostics, type LcmConfig, type LcmConfigDiagnostics } from "./db/config.js";
import { LcmContextEngine } from "./engine.js";
import { createLcmDescribeTool } from "./tools/lcm-describe-tool.js";
import { createLcmGrepTool } from "./tools/lcm-grep-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import type { CallGatewayFn, CompleteFn, LcmDependencies, ResolveModelFn } from "./types.js";

export type LcmRuntimeLog = LcmDependencies["log"];

export type CreateLcmRuntimeInput = {
  /** Environment used for normal LCM_* config resolution. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Host/plugin config object used below environment values and above defaults. */
  pluginConfig?: Record<string, unknown>;
  /** Explicit database path override for embedders such as NanoClaw. */
  databasePath?: string;
  /** Explicit large-file sidecar directory override for embedders such as NanoClaw. */
  largeFilesDir?: string;
  /** Optional pre-opened DB connection. If omitted, the factory owns and closes the connection. */
  database?: DatabaseSync;
  /** Required for summarization/compaction; recall-only embedders may omit and get a fail-closed stub. */
  complete?: CompleteFn;
  /** Required for delegated expansion/subagents; recall-only embedders may omit and get a fail-closed stub. */
  callGateway?: CallGatewayFn;
  /** Optional model resolver for summarization. Defaults to configured provider/model or fails when used. */
  resolveModel?: ResolveModelFn;
  parseAgentSessionKey?: LcmDependencies["parseAgentSessionKey"];
  isSubagentSessionKey?: LcmDependencies["isSubagentSessionKey"];
  normalizeAgentId?: LcmDependencies["normalizeAgentId"];
  buildSubagentSystemPrompt?: LcmDependencies["buildSubagentSystemPrompt"];
  readLatestAssistantReply?: LcmDependencies["readLatestAssistantReply"];
  resolveAgentDir?: LcmDependencies["resolveAgentDir"];
  resolveSessionIdFromSessionKey?: LcmDependencies["resolveSessionIdFromSessionKey"];
  resolveSessionTranscriptFile?: LcmDependencies["resolveSessionTranscriptFile"];
  listStartupSessionFileCandidates?: LcmDependencies["listStartupSessionFileCandidates"];
  agentLaneSubagent?: string;
  log?: Partial<LcmRuntimeLog>;
};

export type LcmRuntime = {
  lcm: LcmContextEngine;
  deps: LcmDependencies;
  database: DatabaseSync;
  databasePath: string;
  config: LcmConfig;
  configDiagnostics: LcmConfigDiagnostics;
  close: () => void;
};

export function createLcmRuntime(input: CreateLcmRuntimeInput = {}): LcmRuntime {
  const { config, diagnostics } = resolveLcmConfigWithDiagnostics(input.env, input.pluginConfig);
  const resolvedConfig: LcmConfig = {
    ...config,
    ...(input.databasePath ? { databasePath: input.databasePath } : {}),
    ...(input.largeFilesDir ? { largeFilesDir: input.largeFilesDir } : {}),
  };
  const database = input.database ?? createLcmDatabaseConnection(resolvedConfig.databasePath);
  const ownsDatabase = !input.database;
  const deps = createRuntimeDependencies({ ...input, config: resolvedConfig, diagnostics });
  try {
    const lcm = new LcmContextEngine(deps, database);
    return {
      lcm,
      deps,
      database,
      databasePath: normalizePath(resolvedConfig.databasePath),
      config: resolvedConfig,
      configDiagnostics: diagnostics,
      close: () => {
        if (ownsDatabase) closeLcmConnection(database);
      },
    };
  } catch (err) {
    if (ownsDatabase) closeLcmConnection(database);
    throw err;
  }
}

export function createLcmRuntimeRecallTools(input: {
  runtime: Pick<LcmRuntime, "deps" | "lcm">;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool[] {
  return [
    createLcmGrepTool({
      deps: input.runtime.deps,
      lcm: input.runtime.lcm,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
    }),
    createLcmDescribeTool({
      deps: input.runtime.deps,
      lcm: input.runtime.lcm,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
    }),
  ];
}

function createRuntimeDependencies(input: CreateLcmRuntimeInput & {
  config: LcmConfig;
  diagnostics: LcmConfigDiagnostics;
}): LcmDependencies {
  const log = createRuntimeLog(input.log);
  return {
    config: input.config,
    configDiagnostics: input.diagnostics,
    complete: input.complete ?? failClosedComplete,
    callGateway: input.callGateway ?? failClosedGateway,
    resolveModel: input.resolveModel ?? createDefaultResolveModel(input.config),
    parseAgentSessionKey: input.parseAgentSessionKey ?? parseAgentSessionKey,
    isSubagentSessionKey:
      input.isSubagentSessionKey ?? ((sessionKey) => parseAgentSessionKey(sessionKey)?.suffix.startsWith("subagent:") ?? false),
    normalizeAgentId: input.normalizeAgentId ?? ((id) => id?.trim() || "main"),
    buildSubagentSystemPrompt:
      input.buildSubagentSystemPrompt ??
      ((params) => `You are a delegated LCM sub-agent at depth ${params.depth}/${params.maxDepth}.`),
    readLatestAssistantReply: input.readLatestAssistantReply ?? readLatestAssistantReply,
    resolveAgentDir: input.resolveAgentDir ?? (() => process.cwd()),
    resolveSessionIdFromSessionKey: input.resolveSessionIdFromSessionKey ?? (async () => undefined),
    resolveSessionTranscriptFile: input.resolveSessionTranscriptFile ?? (async () => undefined),
    listStartupSessionFileCandidates: input.listStartupSessionFileCandidates,
    agentLaneSubagent: input.agentLaneSubagent ?? "subagent",
    log,
  };
}

const failClosedComplete: CompleteFn = async () => ({
  content: [],
  error: {
    kind: "unavailable",
    message: "LCM runtime was created without a summarization completion provider.",
  },
});

const failClosedGateway: CallGatewayFn = async () => {
  throw new Error("LCM runtime was created without a gateway adapter.");
};

function createDefaultResolveModel(config: LcmConfig): ResolveModelFn {
  return (modelRef, providerHint) => {
    const model = (modelRef?.trim() || config.summaryModel.trim()).trim();
    if (!model) {
      throw new Error("No LCM model configured. Provide resolveModel or set LCM_SUMMARY_MODEL.");
    }
    return { provider: providerHint?.trim() || config.summaryProvider.trim() || "openai", model };
  };
}

function createRuntimeLog(log: Partial<LcmRuntimeLog> | undefined): LcmRuntimeLog {
  const noop = () => undefined;
  return {
    info: log?.info ?? noop,
    warn: log?.warn ?? noop,
    error: log?.error ?? noop,
    debug: log?.debug ?? noop,
  };
}

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const value = sessionKey.trim();
  if (!value.startsWith("agent:")) return null;
  const parts = value.split(":");
  if (parts.length < 3) return null;
  const agentId = parts[1]?.trim();
  const suffix = parts.slice(2).join(":").trim();
  return agentId && suffix ? { agentId, suffix } : null;
}

function readLatestAssistantReply(messages: unknown[]): string | undefined {
  for (const item of [...messages].reverse()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const content = record.content;
    return typeof content === "string" && content.trim() ? content : undefined;
  }
  return undefined;
}
