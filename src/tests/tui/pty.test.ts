import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaudeArgs, buildClaudeEnv, ensureExecutable, promptPaste } from "../../tui/pty.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

describe("buildClaudeArgs", () => {
  it("passes the session id and the spawn-time settings", () => {
    expect(
      buildClaudeArgs({
        cwd: "/w",
        sessionId: SESSION_ID,
        model: "claude-haiku-5-5",
        permissionMode: "auto",
        settingsFile: "/s.json",
      }),
    ).toEqual([
      "--session-id",
      SESSION_ID,
      "--model",
      "claude-haiku-5-5",
      "--permission-mode",
      "auto",
      "--settings",
      "/s.json",
    ]);
  });

  it("resumes with --resume in place of --session-id", () => {
    expect(buildClaudeArgs({ cwd: "/w", sessionId: "unused", resume: SESSION_ID })).toEqual([
      "--resume",
      SESSION_ID,
    ]);
  });
});

describe("buildClaudeEnv", () => {
  it("drops the host's session variables and keeps the user's settings", () => {
    const env = buildClaudeEnv({
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_SESSION_ID: "parent",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      PASEO_AGENT_ID: "a",
      PASEO_WORKSPACE_ID: "w",
      CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      TERM: "dumb",
    });
    expect(env).toEqual({
      PATH: "/bin",
      CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      TERM: "xterm-256color",
    });
  });
});

describe("promptPaste", () => {
  it("wraps the prompt in one bracketed paste the text can't end early", () => {
    expect(promptPaste("a\nb\x1b[201~\rc")).toBe("\x1b[200~a\nb\rc\x1b[201~");
  });
});

describe("ensureExecutable", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tui-pty-"));
    file = path.join(dir, "spawn-helper");
    writeFileSync(file, "");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [0o644, 0o755],
    [0o700, 0o700],
  ])("makes a %o helper %o", async (before, after) => {
    chmodSync(file, before);
    await ensureExecutable(file);
    expect(statSync(file).mode & 0o777).toBe(after);
  });

  it("says how to fix a helper it can't chmod", async () => {
    await expect(ensureExecutable(path.join(dir, "missing"))).rejects.toThrow(
      `Run: chmod +x "${path.join(dir, "missing")}"`,
    );
  });
});
