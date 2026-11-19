import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TuiEngine } from "../../tui/engine.js";
import type { TranscriptRecord } from "../../tui/transcript.js";

// Spawns the real `claude` on PATH with Code Mode. Set TUI_SMOKE_PARENT to a
// folder the CLI already trusts; elsewhere the engine answers the trust dialog.
describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("TuiEngine (real CLI)", () => {
  it("runs a Code Mode turn through the REPL tool to its end", { timeout: 240_000 }, async () => {
    const cwd = mkdtempSync(path.join(process.env.TUI_SMOKE_PARENT ?? tmpdir(), "tui-smoke-"));
    writeFileSync(path.join(cwd, "one.txt"), "a\n");
    writeFileSync(path.join(cwd, "two.txt"), "a\nb\n");
    const engine = new TuiEngine({
      cwd,
      model: "claude-haiku-5-5",
      permissionMode: "auto",
      env: { ...process.env, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" },
    });
    const exited = new Promise((resolve) => engine.once("exit", resolve));
    try {
      const turn = engine.prompt(
        "Read-only: count the lines of each .txt file here and reply with a short list. Do not edit anything.",
      );
      const records: TranscriptRecord[] = [];
      for await (const record of turn.records) {
        records.push(record);
      }
      const result = await turn.done;

      expect(["turn_duration", "end_turn"]).toContain(result.stopReason);
      const toolUses = records.flatMap((r) =>
        r.type === "assistant" && Array.isArray(r.message?.content) ? r.message.content : [],
      );
      expect(toolUses).toContainEqual(expect.objectContaining({ type: "tool_use", name: "REPL" }));
    } finally {
      engine.dispose();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
