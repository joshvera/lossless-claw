export * from "./src/nanoclaw-v2-bridge.js";
export type { CreateLcmRuntimeInput, LcmRuntime } from "./src/runtime-api.js";
import type { CreateLcmRuntimeInput, LcmRuntime } from "./src/runtime-api.js";

type RuntimeApiModule = typeof import("./src/runtime-api.js");

async function loadRuntimeApi(): Promise<RuntimeApiModule> {
  return (await import("./plugin.js")) as RuntimeApiModule;
}

export async function createLcmRuntime(input: CreateLcmRuntimeInput = {}): Promise<LcmRuntime> {
  const runtimeApi = await loadRuntimeApi();
  return runtimeApi.createLcmRuntime(input);
}

export async function createLcmRuntimeRecallTools(
  input: Parameters<RuntimeApiModule["createLcmRuntimeRecallTools"]>[0],
): Promise<ReturnType<RuntimeApiModule["createLcmRuntimeRecallTools"]>> {
  const runtimeApi = await loadRuntimeApi();
  return runtimeApi.createLcmRuntimeRecallTools(input);
}
