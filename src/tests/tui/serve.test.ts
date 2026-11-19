import { type AnyMessage, client as acpClient, methods } from "@agentclientprotocol/sdk/unstable";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tuiProtocolRouter } from "../../serve.js";
import { TuiEngine } from "../../tui/engine.js";
import type { AgentHandle } from "../../v2/agent.js";

// A CLI that never draws anything, so a prompt waits in startup until it is cancelled.
vi.mock("node-pty", () => ({
  spawn: () => {
    let onExit: ((event: { exitCode: number }) => void) | undefined;
    return {
      pid: 4242,
      onData: () => {},
      onExit: (listener: typeof onExit) => (onExit = listener),
      write: () => {},
      kill: () => onExit?.({ exitCode: 0 }),
    };
  },
}));

describe("tuiProtocolRouter", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "tui-serve-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("refuses to serve ACP v2 alone", () => {
    expect(() => tuiProtocolRouter(undefined, () => {}, "v2")).toThrow(
      "CLAUDE_ACP_ENGINE=tui serves ACP v1 only",
    );
  });

  it("serves a v1 client with auto, and cancels the engine's turn when the prompt request is cancelled", async () => {
    const cancel = vi.spyOn(TuiEngine.prototype, "cancel");
    const enginePrompt = vi.spyOn(TuiEngine.prototype, "prompt");
    const toAgent = new TransformStream<AnyMessage, AnyMessage>();
    const toClient = new TransformStream<AnyMessage, AnyMessage>();
    let agent: AgentHandle | undefined;
    tuiProtocolRouter(undefined, (created) => (agent = created), "auto").connect({
      readable: toAgent.readable,
      writable: toClient.writable,
    });
    try {
      await acpClient({ name: "test-client" }).connectWith(
        { readable: toClient.readable, writable: toAgent.writable },
        async (client) => {
          const { agentInfo } = await client.request(methods.agent.initialize, {
            protocolVersion: 1,
            clientCapabilities: {},
          });
          expect(agentInfo?.title).toBe("Claude Agent (terminal)");
          const { sessionId } = await client.request(methods.agent.session.new, {
            cwd: configDir,
            mcpServers: [],
          });
          const controller = new AbortController();
          const prompt = client.request(
            methods.agent.session.prompt,
            { sessionId, prompt: [{ type: "text", text: "hi" }] },
            { cancellationSignal: controller.signal, stopWaitingOnCancel: true },
          );
          await vi.waitFor(() => expect(enginePrompt).toHaveBeenCalledWith("hi"));
          expect(cancel).not.toHaveBeenCalled();
          controller.abort();
          await expect(prompt).rejects.toMatchObject({ code: -32800 });
          await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
        },
      );
    } finally {
      await agent?.dispose();
    }
  });
});
