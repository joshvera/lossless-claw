import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { createLcmRuntime, createLcmRuntimeRecallTools } from "../src/runtime-api.js";

describe("public LCM runtime API", () => {
  it("creates a recall-capable runtime with fail-closed host adapters", async () => {
    const root = join(tmpdir(), `lcm-runtime-api-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const sessionFile = join(root, "session.jsonl");
      writeFileSync(
        sessionFile,
        [
          JSON.stringify({ message: { role: "user", content: "alpha recall needle" } }),
          JSON.stringify({ message: { role: "assistant", content: "beta response" } }),
        ].join("\n") + "\n",
        "utf8",
      );

      const runtime = createLcmRuntime({
        databasePath: join(root, "lcm.db"),
        largeFilesDir: join(root, "files"),
        env: { TZ: "UTC" },
        resolveSessionIdFromSessionKey: async () => "session-1",
      });
      try {
        const bootstrap = await runtime.lcm.bootstrap({
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          sessionFile,
        });
        expect(bootstrap.bootstrapped).toBe(true);

        const tools = createLcmRuntimeRecallTools({ runtime, sessionKey: "agent:main:main" });
        expect(tools.map((tool) => tool.name)).toEqual(["lcm_grep", "lcm_describe"]);

        const grepResult = await tools[0].execute("tool-call-1", {
          pattern: "alpha",
          mode: "full_text",
          scope: "messages",
          limit: 5,
        });
        expect(JSON.stringify(grepResult)).toContain("alpha recall needle");
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
