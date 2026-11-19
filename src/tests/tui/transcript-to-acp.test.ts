import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it } from "vitest";
import { TranscriptToAcp } from "../../tui/transcript-to-acp.js";
import type { TranscriptRecord } from "../../tui/transcript.js";
import { fixture } from "./fixture.js";

const REPL_1 = "toolu_01BxW3LTQLSWmeoyax9wXD5c";
const REPL_2 = "toolu_01JME1uQi9s4TNrhX41EECME";
const INNER_1 = "repl_afa996a5-152c-43a2-9c8b-553885774538";
const CODE_1 = "const r = await $`ls -1 *.txt`.cwd('<cwd>').nothrow();\nr.output";

function updatesOf(records: TranscriptRecord[], replay = false) {
  const adapter = new TranscriptToAcp({ sessionId: "s", cwd: "<cwd>", logger: console });
  const updates = records.flatMap((record) => adapter.updates(record, { replay }));
  return {
    adapter,
    updates: updates.map((notification: SessionNotification) => notification.update),
  };
}

function callUpdates(updates: SessionNotification["update"][], toolCallId: string) {
  return updates.filter((update) => "toolCallId" in update && update.toolCallId === toolCallId);
}

const codeBlock = (code: string) => ({
  type: "content",
  content: { type: "text", text: `\`\`\`js\n${code}\n\`\`\`` },
});

describe("TranscriptToAcp", () => {
  it("shows a REPL call's code, keeps it in progress on dispatch and completes it on settle", () => {
    const { updates } = updatesOf(fixture("code-mode-haiku"));
    expect(callUpdates(updates, REPL_1)).toEqual([
      expect.objectContaining({
        sessionUpdate: "tool_call",
        title: "REPL",
        kind: "execute",
        status: "pending",
        content: [codeBlock(CODE_1)],
      }),
      { sessionUpdate: "tool_call_update", toolCallId: REPL_1, status: "in_progress" },
      expect.objectContaining({
        status: "completed",
        content: [
          codeBlock(CODE_1),
          { type: "content", content: { type: "text", text: "one.txt\nthree.txt\ntwo.txt" } },
        ],
      }),
    ]);
  });

  it("reports the tools a REPL call ran as tool calls of their own", () => {
    const { updates } = updatesOf(fixture("code-mode-haiku"));
    expect(callUpdates(updates, INNER_1)).toEqual([
      expect.objectContaining({
        sessionUpdate: "tool_call",
        title: "cd '<cwd>' && ls -1 *.txt",
        kind: "execute",
      }),
      expect.objectContaining({
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "```console\none.txt\nthree.txt\ntwo.txt\n```" },
          },
        ],
      }),
    ]);
    expect(JSON.stringify(updates)).not.toContain("parentToolUseId");
  });

  it("streams the agent's text and leaves out the user's prompt and the records the client doesn't see", () => {
    const records = fixture("code-mode-haiku");
    const { updates } = updatesOf(records);
    expect(updates.filter((update) => update.sessionUpdate === "user_message_chunk")).toEqual([]);
    expect(updates.at(-1)).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { text: expect.stringContaining("Total: 10 lines") },
    });
    const dropped = records.filter(
      (record) =>
        ["mode", "permission-mode", "repl-mode"].includes(record.type ?? "") ||
        (record.type === "queue-operation" && record.operation === "remove") ||
        record.subtype === "stop_hook_summary",
    );
    expect(dropped.length).toBeGreaterThan(0);
    expect(updatesOf(dropped).updates).toEqual([]);
  });

  it("shows the user's prompt on replay", () => {
    const { updates } = updatesOf(fixture("code-mode-haiku"), true);
    expect(updates.filter((update) => update.sessionUpdate === "user_message_chunk")).toEqual([
      expect.objectContaining({
        content: {
          type: "text",
          text: "Read-only: count lines of each .txt file here and reply with a short list.",
        },
      }),
    ]);
  });

  it("fails a REPL call that never settled when the turn ends", () => {
    const records = fixture("code-mode-haiku").filter(
      (record) => record.type !== "queue-operation" && record.isVirtual !== true,
    );
    const { updates } = updatesOf(records);
    expect(updates.filter((update) => "status" in update && update.status === "failed")).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: REPL_1, status: "failed" },
      { sessionUpdate: "tool_call_update", toolCallId: REPL_2, status: "failed" },
    ]);
  });

  it("closes nothing at the turn end when every call completed", () => {
    const { adapter, updates } = updatesOf(fixture("code-mode-sonnet"));
    expect(updates.filter((update) => "status" in update && update.status === "failed")).toEqual(
      [],
    );
    expect(adapter.endTurn()).toEqual([]);
  });

  it("fails a REPL call whose eval did not settle", () => {
    const records = fixture("code-mode-sonnet").map((record) =>
      record.type === "queue-operation" && typeof record.content === "string"
        ? {
            ...record,
            content: record.content
              .replace('status="settled"', 'status="error"')
              .replace(
                /<result>[\s\S]*<\/result>/,
                "<error>ReferenceError: x is not defined</error>",
              ),
          }
        : record,
    );
    const { updates } = updatesOf(records);
    expect(callUpdates(updates, "toolu_01WGxYEgNhS5Zty549XXtNsC").at(-1)).toMatchObject({
      status: "failed",
      content: [
        codeBlock("(await $`wc -l *.md`.nothrow()).output"),
        {
          type: "content",
          content: { type: "text", text: expect.stringContaining("ReferenceError") },
        },
      ],
    });
  });
});
