import { readFileSync } from "node:fs";
import type { TranscriptRecord } from "../../tui/transcript.js";

/** The records of `fixtures/<name>.jsonl`: trimmed, redacted copies of real CLI transcripts. */
export function fixture(name: string): TranscriptRecord[] {
  return fixtureText(`${name}.jsonl`)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The text of `fixtures/<file>`. */
export function fixtureText(file: string): string {
  return readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
}
