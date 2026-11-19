// Portions derived from claude-agent-tui (src/engine-pty.ts),
// https://github.com/zeo-workspace/claude-agent-tui, Copyright 2026 lucascouts,
// Apache-2.0. Modified: direct argv spawn, lazy node-pty, screen buffer, interrupt.

/**
 * The interactive `claude` CLI in a pseudo-terminal, for features the Agent
 * SDK cannot reach (Code Mode runs only in an interactive terminal).
 *
 * Mac and Linux only: node-pty's Windows backend (ConPTY) is not supported in
 * v0.1, and on Linux node-pty must be built from source (see `loadNodePty`).
 * node-pty is imported lazily on the first spawn, so the SDK engine and
 * `build:binary` never load the native module.
 */

import { existsSync, constants as fsConstants } from "node:fs";
import { access, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { IPty } from "node-pty";

export const PTY_COLS = 120;
export const PTY_ROWS = 40;
/** Lines of ANSI-stripped output {@link ClaudePty.screen} keeps (at most this many full-width lines). */
export const SCREEN_LINES = 200;

/** Delay between the pasted prompt and the `\r` that submits it. */
const SUBMIT_DELAY_MS = 200;
/** How long `interrupt()` waits after `\x03` before escalating with Esc. */
const INTERRUPT_ESCALATE_MS = 1000;

/**
 * Session variables an agent host (Claude Code, the Agent SDK, Paseo) sets
 * for its own process. Inherited by the child CLI they make it refuse to start
 * (`CLAUDECODE`), label its transcript as another entrypoint, or attach it to
 * the parent's session socket. `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` is kept.
 */
const INHERITED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
  "CLAUDE_CODE_ARTIFACT",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "PASEO_WORKSPACE_ID",
];

export type ClaudePtyOptions = {
  cwd: string;
  /** The session id, passed as `--session-id`. Ignored when `resume` is set. */
  sessionId: string;
  /** A session id to continue with `--resume`; the CLI keeps that id. */
  resume?: string;
  /** Set at spawn: a later `/model` write merged with the first prompt in claude-agent-tui. */
  model?: string;
  permissionMode?: string;
  settingsFile?: string;
  /** The CLI to run. Default: `claude` on `PATH`. */
  executable?: string;
  env?: Record<string, string | undefined>;
};

/** The CLI arguments for an interactive session. */
export function buildClaudeArgs(options: ClaudePtyOptions): string[] {
  const args = options.resume ? ["--resume", options.resume] : ["--session-id", options.sessionId];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.settingsFile) {
    args.push("--settings", options.settingsFile);
  }
  return args;
}

/** `base` without the {@link INHERITED_SESSION_VARS} or `PASEO_AGENT_*`, with a terminal `TERM`. */
export function buildClaudeEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      !INHERITED_SESSION_VARS.includes(key) &&
      !key.startsWith("PASEO_AGENT_")
    ) {
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  return env;
}

/**
 * Makes node-pty's `spawn-helper` executable. npm installs it without the
 * execute bit when it skips node-pty's install scripts (npm 11 asks before it
 * runs a dependency's scripts), and every spawn then fails with
 * `posix_spawnp failed`.
 */
export async function ensureExecutable(file: string): Promise<void> {
  try {
    await access(file, fsConstants.X_OK);
    return;
  } catch {
    // Not executable (or missing): try to fix it below.
  }
  try {
    await chmod(file, 0o755);
  } catch (error) {
    throw new Error(
      `node-pty's spawn helper ${file} is not executable and chmod failed (${(error as Error).message}). ` +
        `Run: chmod +x "${file}"`,
      { cause: error },
    );
  }
}

let nodePty: Promise<typeof import("node-pty")> | undefined;

function loadNodePty(): Promise<typeof import("node-pty")> {
  nodePty ??= (async () => {
    let mod: typeof import("node-pty");
    try {
      mod = await import("node-pty");
    } catch (error) {
      nodePty = undefined;
      // ponytail: no node-gyp handling for Linux in v0.1; node-pty 1.1.0 ships prebuilds for macOS and Windows only.
      throw new Error(
        `Could not load node-pty (${(error as Error).message}). On Linux it has no prebuilt binary: ` +
          "build it with `npm rebuild node-pty`, or allow its install script.",
        { cause: error },
      );
    }
    const prebuilds = path.join(
      path.dirname(createRequire(import.meta.url).resolve("node-pty")),
      "..",
      "prebuilds",
      `${process.platform}-${process.arch}`,
    );
    const helper = path.join(prebuilds, "spawn-helper");
    // A source build (`build/Release/`, no prebuilds) makes its own executable helper.
    if (existsSync(helper)) {
      await ensureExecutable(helper).catch((error) => {
        nodePty = undefined;
        throw error;
      });
    }
    return mod;
  })();
  return nodePty;
}

// Cursor moves, colors, OSC titles, charset and keypad switches.
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g;

/** `chunk` without escape sequences. Each sequence becomes a space: Ink draws gaps with cursor moves. */
export function stripAnsi(chunk: string): string {
  return chunk.replace(ANSI, " ");
}

/** The bytes that submit `text`: a bracketed paste, so newlines don't submit early. */
export function promptPaste(text: string): string {
  // A `\x1b[201~` inside the text would end the paste and type the rest as keys.
  return `\x1b[200~${text.replaceAll("\x1b[201~", "")}\x1b[201~`;
}

/** The interactive CLI in a PTY, with the recent output kept as text. */
export class ClaudePty {
  /** Bumped on every output chunk; what was received after a mark is {@link screenSince}. */
  private received = 0;
  private dataListeners: Array<(chunk: string) => void> = [];
  private exitListeners: Array<(exitCode: number) => void> = [];
  private escalation: ReturnType<typeof setTimeout> | undefined;
  private log = "";
  exited = false;

  private constructor(private readonly pty: IPty) {
    pty.onData((chunk) => {
      // Ink waits for answers to cursor-position and device-attribute queries.
      if (chunk.includes("\x1b[6n")) {
        pty.write("\x1b[1;1R");
      }
      if (chunk.includes("\x1b[c") || chunk.includes("\x1b[0c")) {
        pty.write("\x1b[?62;c");
      }
      this.append(stripAnsi(chunk));
      for (const listener of this.dataListeners) {
        listener(chunk);
      }
    });
    pty.onExit(({ exitCode }) => {
      this.exited = true;
      clearTimeout(this.escalation);
      for (const listener of this.exitListeners) {
        listener(exitCode);
      }
    });
  }

  static async spawn(options: ClaudePtyOptions): Promise<ClaudePty> {
    const { spawn } = await loadNodePty();
    const pty = spawn(options.executable ?? "claude", buildClaudeArgs(options), {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: options.cwd,
      env: buildClaudeEnv(options.env),
    });
    return new ClaudePty(pty);
  }

  get pid(): number {
    return this.pty.pid;
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (exitCode: number) => void): void {
    this.exitListeners.push(listener);
  }

  /** The last {@link SCREEN_LINES} lines of output. An append log, not a rendered screen: redraws repeat text. */
  screen(): string {
    return this.log.split(/\r?\n/).slice(-SCREEN_LINES).join("\n");
  }

  /** A mark for {@link screenSince}. */
  mark(): number {
    return this.received;
  }

  /** Output received after `mark`, capped at what {@link screen} still holds. */
  screenSince(mark: number): string {
    return this.log.slice(Math.max(0, this.log.length - (this.received - mark)));
  }

  write(data: string): void {
    if (!this.exited) {
      this.pty.write(data);
    }
  }

  /**
   * Types `text` as one prompt and submits it. A leading Ctrl+U clears what
   * the input box holds: the CLI restores an interrupted prompt there, and it
   * would merge with this one.
   */
  sendPrompt(text: string): void {
    this.write("\x15");
    this.write(promptPaste(text));
    setTimeout(() => this.write("\r"), SUBMIT_DELAY_MS);
  }

  /**
   * Stops the running turn with Ctrl+C, then with Esc if `stillRunning()`
   * after a second. Never a second Ctrl+C: two in quick succession exit the CLI.
   */
  interrupt(stillRunning: () => boolean): void {
    if (this.escalation) {
      return;
    }
    this.write("\x03");
    this.escalation = setTimeout(() => {
      this.escalation = undefined;
      if (stillRunning()) {
        this.write("\x1b");
      }
    }, INTERRUPT_ESCALATE_MS);
  }

  dispose(): void {
    clearTimeout(this.escalation);
    if (!this.exited) {
      this.pty.kill();
    }
  }

  private append(text: string): void {
    this.received += text.length;
    this.log = (this.log + text).slice(-SCREEN_LINES * PTY_COLS);
  }
}
