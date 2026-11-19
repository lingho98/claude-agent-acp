// Portions derived from claude-agent-tui (src/jsonl.ts), https://github.com/zeo-workspace/claude-agent-tui,
// Copyright 2026 lucascouts, Apache-2.0. Modified: lookup by directory scan, polling tail, byte-safe decoding.

/**
 * Follows the transcript the interactive CLI writes for a session,
 * `<config>/projects/<project>/<session-id>.jsonl`. The CLI creates it at the
 * session's first interaction, not at startup.
 */

import { existsSync, readdirSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isSessionId, projectsRoot } from "../paths.js";

/** One transcript line, as the CLI writes it. */
export type TranscriptRecord = {
  type?: string;
  subtype?: string;
  uuid?: string;
  isSidechain?: boolean;
  isVirtual?: boolean;
  isApiErrorMessage?: boolean;
  message?: { model?: string; stop_reason?: string | null; content?: unknown };
  [key: string]: unknown;
};

const POLL_MS = 100;

/** The transcript of `sessionId` under `root`, or `undefined` while the CLI has not created it. */
export function findTranscript(sessionId: string, root = projectsRoot()): string | undefined {
  if (!isSessionId(sessionId)) {
    throw new Error(`Not a session id: ${sessionId}`);
  }
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined; // No session has run under this config directory yet.
    }
    throw error;
  }
  return projects
    .map((project) => path.join(root, project, `${sessionId}.jsonl`))
    .find((file) => existsSync(file));
}

/**
 * Splits appended bytes into complete JSON lines. The text after the last
 * newline waits for the rest of its line; a line that is not JSON is skipped.
 */
export class LineReader {
  private readonly decoder = new StringDecoder("utf8");
  private partial = "";

  push(chunk: Buffer): TranscriptRecord[] {
    const lines = (this.partial + this.decoder.write(chunk)).split("\n");
    this.partial = lines.pop() ?? "";
    const records: TranscriptRecord[] = [];
    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        // A corrupt line; the CLI writes one record per line, so the next is unaffected.
      }
    }
    return records;
  }
}

export type TranscriptTailOptions = {
  sessionId: string;
  onRecord: (record: TranscriptRecord) => void;
  /** A read failed; the tail has stopped. */
  onError: (error: Error) => void;
  /** Skip what the file already holds when the tail finds it (a resumed session). */
  fromEnd?: boolean;
  root?: string;
};

/**
 * Polls for the transcript, then reads what is appended to it.
 *
 * ponytail: polls every 100 ms; `fs.watch` can't watch a file that doesn't exist yet. Switch if latency matters.
 */
export class TranscriptTail {
  private file: string | undefined;
  private offset = 0;
  private readonly reader = new LineReader();
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private stopped = false;

  constructor(private readonly options: TranscriptTailOptions) {}

  start(): void {
    this.timer ??= setInterval(
      () =>
        this.poll().catch((error) => {
          this.stop();
          this.options.onError(error);
        }),
      POLL_MS,
    );
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads what was appended since the last poll; the timer {@link start} sets calls it. */
  async poll(): Promise<void> {
    if (this.reading || this.stopped) {
      return;
    }
    this.reading = true;
    try {
      await this.read();
    } finally {
      this.reading = false;
    }
  }

  private async read(): Promise<void> {
    if (!this.file) {
      this.file = findTranscript(this.options.sessionId, this.options.root);
      if (!this.file) {
        return;
      }
      if (this.options.fromEnd) {
        this.offset = (await stat(this.file)).size;
      }
    }
    const size = (await stat(this.file)).size;
    if (size <= this.offset) {
      return;
    }
    const handle = await open(this.file, "r");
    try {
      const buffer = Buffer.alloc(size - this.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      for (const record of this.reader.push(buffer.subarray(0, bytesRead))) {
        if (this.stopped) {
          return;
        }
        this.options.onRecord(record);
      }
    } finally {
      await handle.close();
    }
  }
}
