import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EndOfTurnDetector,
  QUIESCENCE_MS,
  STALL_MS,
  turnEndReason,
  type TurnEnd,
} from "../../tui/end-of-turn.js";
import type { TranscriptRecord } from "../../tui/transcript.js";
import { fixture } from "./fixture.js";

// claude-agent-tui's rule before its Code Mode patch: any terminal stop reason ends the turn.
function naiveIsTerminal(record: TranscriptRecord): boolean {
  return (
    record.type === "assistant" &&
    ["end_turn", "stop_sequence", "max_tokens"].includes(record.message?.stop_reason ?? "")
  );
}

describe("EndOfTurnDetector", () => {
  let ends: TurnEnd[];
  let stalls: Error[];
  let detector: EndOfTurnDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    ends = [];
    stalls = [];
    detector = new EndOfTurnDetector({
      onEnd: (end) => ends.push(end),
      onStall: (error) => stalls.push(error),
    });
    detector.begin();
  });

  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
  });

  it.each(["code-mode-haiku", "code-mode-sonnet"])(
    "ends a Code Mode turn at turn_duration, not at the REPL's virtual stop_sequence rows (%s)",
    (name) => {
      const records = fixture(name);
      const firstNaive = records.findIndex(naiveIsTerminal);
      // Stop at the last REPL inner call, before its tool_result row could cancel a wrong end.
      const lastVirtual = records.findLastIndex(
        (r) => r.isVirtual === true && r.type === "assistant",
      );
      // The naive rule picks a virtual `<synthetic>` row holding a REPL inner `tool_use`.
      expect(records[firstNaive]).toMatchObject({
        isVirtual: true,
        message: { model: "<synthetic>" },
      });

      for (const record of records.slice(0, lastVirtual + 1)) {
        detector.observe(record);
      }
      vi.advanceTimersByTime(QUIESCENCE_MS * 2);
      expect(ends).toEqual([]);

      for (const record of records.slice(lastVirtual + 1)) {
        detector.observe(record);
      }
      expect(ends).toEqual([{ reason: "turn_duration", record: records.at(-1) }]);
    },
  );

  it("would end run 4 early under the naive rule: its real end_turn comes after the quiescence wait", () => {
    const records = fixture("code-mode-haiku");
    const time = (i: number) => Date.parse(records[i].timestamp as string);
    const gap =
      time(records.findIndex((r) => turnEndReason(r) === "end_turn")) -
      time(records.findLastIndex((r) => naiveIsTerminal(r) && r.isVirtual === true));
    expect(gap).toBeGreaterThan(QUIESCENCE_MS);
  });

  it("ends a plain turn at turn_duration", () => {
    const records = fixture("plain-turn");
    records.forEach((record) => detector.observe(record));
    expect(ends).toEqual([{ reason: "turn_duration", record: records.at(-1) }]);
  });

  it.each([
    ["plain-turn", "end_turn"],
    ["api-error", "api_error"],
  ])("ends %s at its last %s row once quiet, with no turn_duration", (name, reason) => {
    const records = fixture(name).filter((r) => r.subtype !== "turn_duration");
    records.forEach((record) => detector.observe(record));
    vi.advanceTimersByTime(QUIESCENCE_MS - 1);
    expect(ends).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ends).toEqual([{ reason, record: records.findLast((r) => r.type === "assistant") }]);
  });

  it("keeps waiting while the terminal shows output after an end_turn", () => {
    const records = fixture("plain-turn").filter((r) => r.subtype !== "turn_duration");
    records.forEach((record) => detector.observe(record));
    vi.advanceTimersByTime(QUIESCENCE_MS - 1);
    detector.noteActivity(); // e.g. "running Stop hooks… 1/5"
    vi.advanceTimersByTime(QUIESCENCE_MS - 1);
    expect(ends).toEqual([]);
  });

  it("cancels an end_turn when the model goes on", () => {
    const records = fixture("plain-turn");
    const endTurn = records.findIndex((r) => turnEndReason(r) === "end_turn");
    records.slice(0, endTurn + 1).forEach((record) => detector.observe(record));
    // An assistant row after it, as after a blocking Stop hook.
    detector.observe(
      records.find((r) => r.message?.stop_reason === "tool_use") as TranscriptRecord,
    );
    vi.advanceTimersByTime(QUIESCENCE_MS * 2);
    expect(ends).toEqual([]);
  });

  it("never ends the parent turn on a sidechain end_turn", () => {
    const [prompt] = fixture("plain-turn").filter((r) => r.type === "user");
    detector.observe(prompt);
    detector.observe(fixture("sidechain-end")[0]);
    vi.advanceTimersByTime(QUIESCENCE_MS * 2);
    expect(ends).toEqual([]);
  });

  it("does not end the next turn on the last turn's late turn_duration", () => {
    const first = fixture("plain-turn");
    const late = first.at(-1);
    first.slice(0, -1).forEach((record) => detector.observe(record));
    vi.advanceTimersByTime(QUIESCENCE_MS);
    expect(ends.map((end) => end.reason)).toEqual(["end_turn"]);

    detector.begin();
    detector.observe(late as TranscriptRecord);
    const second = fixture("code-mode-haiku");
    second.forEach((record) => detector.observe(record));
    expect(ends.map((end) => end.record)).toEqual([expect.anything(), second.at(-1)]);
  });

  it("ends the turn at the interruption row the CLI writes after a declined tool permission", () => {
    // A REPL Write the user answered "No": no turn_duration and no end_turn follow.
    const records = fixture("rejected-turn");
    expect(records.at(-1)?.message?.content).toEqual([
      { type: "text", text: "[Request interrupted by user for tool use]" },
    ]);
    records.forEach((record) => detector.observe(record));
    vi.advanceTimersByTime(QUIESCENCE_MS - 1);
    expect(ends).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ends).toEqual([{ reason: "interrupted", record: records.at(-1) }]);
  });

  it("does not end the next turn on the last turn's late interruption row", () => {
    const interruption = fixture("rejected-turn").at(-1) as TranscriptRecord;
    detector.observe(interruption);
    vi.advanceTimersByTime(QUIESCENCE_MS * 2);
    expect(ends).toEqual([]);
  });

  it("waits on the user's answer to a dialog without a stall", () => {
    detector.waitOnUser(true);
    vi.advanceTimersByTime(STALL_MS * 2);
    expect(stalls).toEqual([]);
    detector.waitOnUser(false);
    vi.advanceTimersByTime(STALL_MS);
    expect(stalls).toHaveLength(1);
  });

  it("reports a stall when neither the transcript nor the terminal moves", () => {
    vi.advanceTimersByTime(STALL_MS - 1);
    detector.noteActivity();
    vi.advanceTimersByTime(STALL_MS - 1);
    expect(stalls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stalls).toHaveLength(1);
    expect(stalls[0].message).toContain("no progress for 120 s");
  });
});
