import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it, vi } from "vitest";
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

  it("shows a REPL call that ended within its turn with its result's text, not the wrapper tags", () => {
    const { updates } = updatesOf(fixture("repl-output"));
    const [result] = callUpdates(updates, "toolu_015d69hs84ghGQTRzH7RrkQQ").slice(-1);
    expect(result).toMatchObject({ status: "completed" });
    const text = JSON.stringify(result);
    expect(text).toContain("bytes: 2");
    expect(text).not.toMatch(/<\/?(repl-output|tools-used-before-summary|result)>/);
  });

  it("fails a REPL call whose script threw, with the error unescaped, and drops its repeat", () => {
    const records = fixture("repl-error");
    const replError = "repl-error-8be964b9-26af-4bb2-bddd-babb6318f283";
    const { updates } = updatesOf(records);
    expect(callUpdates(updates, "toolu_0165tUGYo3KZ4Vqazo9bZ6YA").at(-1)).toMatchObject({
      status: "failed",
      content: [
        expect.anything(),
        {
          type: "content",
          content: {
            type: "text",
            text: expect.stringMatching(
              /ReferenceError: Buffer is not defined\n[\s\S]*in <anonymous>:/,
            ),
          },
        },
      ],
    });
    expect(callUpdates(updates, replError)).toEqual([]);
    // With no REPL call failed, the repeat is the only report of the error, and stays.
    expect(callUpdates(updatesOf(records.slice(-2)).updates, replError)).toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("fails a REPL call whose script threw before its dispatch was written, and drops its repeat", () => {
    // CLI 2.1.328 writes the settle event of a script that threw within ~50 ms before the call.
    const records = fixture("repl-error-fast");
    expect(records.map(({ type }) => type).slice(0, 3)).toEqual([
      "queue-operation",
      "assistant",
      "user",
    ]);
    const { updates } = updatesOf(records);
    const repl = callUpdates(updates, "toolu_015RoZf8jfr9hmrqVFteEV1N");
    expect(repl.filter((update) => "status" in update && update.status === "failed")).toEqual([
      expect.objectContaining({
        content: [
          codeBlock("throw new Error('boom <x>')"),
          {
            type: "content",
            content: { type: "text", text: expect.stringMatching(/^```\nError: boom <x>\n/) },
          },
        ],
      }),
    ]);
    expect(callUpdates(updates, "repl-error-0d088033-9dcd-416d-8e6e-27f14bbfa143")).toEqual([]);
  });

  it("shows a REPL call stopped by a declined permission without the wrapper tags", () => {
    const { updates } = updatesOf(fixture("repl-declined"));
    const repl = callUpdates(updates, "toolu_015MLah8fZ3GvLMfuR9CWyg3");
    expect(repl.at(-1)).toMatchObject({ status: "failed" });
    expect(JSON.stringify(repl.at(-1))).toContain("The user doesn't want to proceed");
    expect(JSON.stringify(updates)).not.toMatch(/<\/?(repl-output|error)>/);
  });

  it("fails a REPL call that ended within its turn with an error, and drops its repeat", () => {
    const [call, result] = fixture("repl-output");
    const replError = fixture("repl-error").slice(-2);
    const thrown = {
      ...result,
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_015d69hs84ghGQTRzH7RrkQQ",
            type: "tool_result",
            content:
              "<repl-output>\n<tools-used-before-summary>Read</tools-used-before-summary>\n<error>Error: boom</error>\n</repl-output>",
            is_error: false,
          },
        ],
      },
    };
    const { updates } = updatesOf([call, thrown, ...replError]);
    expect(callUpdates(updates, "toolu_015d69hs84ghGQTRzH7RrkQQ").at(-1)).toMatchObject({
      status: "failed",
      content: [
        expect.anything(),
        { type: "content", content: { type: "text", text: "```\nError: boom\n```" } },
      ],
    });
    expect(callUpdates(updates, "repl-error-8be964b9-26af-4bb2-bddd-babb6318f283")).toEqual([]);
  });

  it("replays a dropped repl-error result without logging it as untracked", () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const adapter = new TranscriptToAcp({ sessionId: "s", cwd: "<cwd>", logger });
    for (const record of fixture("repl-error")) {
      adapter.updates(record, { replay: true });
    }
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("undoes &amp; last in a settled eval's text", () => {
    const records = fixture("repl-error").map((record) =>
      record.type === "queue-operation" && typeof record.content === "string"
        ? {
            ...record,
            content: record.content.replace("&lt;anonymous&gt;", "&amp;lt;x&amp;gt; &quot;&#39;"),
          }
        : record,
    );
    const text = JSON.stringify(
      callUpdates(updatesOf(records).updates, "toolu_0165tUGYo3KZ4Vqazo9bZ6YA"),
    );
    expect(text).toContain(`in &lt;x&gt; \\"'`);
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
