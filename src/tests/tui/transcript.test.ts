import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LineReader, TranscriptTail, type TranscriptRecord } from "../../tui/transcript.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

describe("LineReader", () => {
  it("holds a partial line, including a split multi-byte character, until its newline", () => {
    const reader = new LineReader();
    const bytes = Buffer.from('{"a":"❯"}\nnot json\n{"b":2}\n{"c"');
    const split = bytes.indexOf(Buffer.from("❯")) + 1; // inside the 3-byte character
    expect(reader.push(bytes.subarray(0, split))).toEqual([]);
    expect(reader.push(bytes.subarray(split))).toEqual([{ a: "❯" }, { b: 2 }]);
    expect(reader.push(Buffer.from(":3}\n"))).toEqual([{ c: 3 }]);
  });
});

describe("TranscriptTail", () => {
  let root: string;
  let records: TranscriptRecord[];
  const file = () => path.join(root, "-project", `${SESSION_ID}.jsonl`);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "tui-transcript-"));
    records = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a transcript created after it starts and reads what is appended", async () => {
    const tail = new TranscriptTail({
      sessionId: SESSION_ID,
      root,
      onRecord: (r) => records.push(r),
      onError: (error) => {
        throw error;
      },
    });
    await tail.poll();
    mkdirSync(path.dirname(file()));
    writeFileSync(file(), '{"type":"user"}\n{"type":"assi');
    await tail.poll();
    expect(records).toEqual([{ type: "user" }]);
    appendFileSync(file(), 'stant"}\n');
    await tail.poll();
    expect(records).toEqual([{ type: "user" }, { type: "assistant" }]);
  });

  it("skips what a resumed transcript already holds", async () => {
    mkdirSync(path.dirname(file()));
    writeFileSync(file(), '{"type":"user"}\n');
    const tail = new TranscriptTail({
      sessionId: SESSION_ID,
      root,
      fromEnd: true,
      onRecord: (r) => records.push(r),
      onError: (error) => {
        throw error;
      },
    });
    await tail.poll();
    appendFileSync(file(), '{"type":"assistant"}\n');
    await tail.poll();
    expect(records).toEqual([{ type: "assistant" }]);
  });
});
