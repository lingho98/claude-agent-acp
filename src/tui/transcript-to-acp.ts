/**
 * Turns the records of the interactive CLI's transcript into ACP session
 * updates. Message content goes through `toAcpNotifications`, the mapping of
 * the SDK engine; this module picks the records and follows Code Mode's
 * asynchronous REPL. The live turn and the `session/load` replay both use it.
 *
 * Code Mode (CLI 2.1.328) writes one REPL call as:
 *
 * 1. assistant `tool_use` REPL `{code}`: the call starts.
 * 2. user `tool_result` "(dispatched #N)" whose `toolUseResult` is
 *    `{asyncDispatched: true, evalId: N}`: the code runs on; the call stays in progress.
 * 3. `queue-operation` enqueue `<event kind="repl-eval" eval="N" status="settled"><result>…`:
 *    the code finished; the call completes with that result. A script that
 *    threw settles with an `<error>` in place of the `<result>`, and fails the
 *    call. The event escapes `<`, `>` and `&` in the text. A script that
 *    throws at once (19 and 23 ms in two captures) can settle before steps
 *    1 and 2 are written; the event then waits for its dispatch.
 * 4. The tools the code called, as `isVirtual` assistant/user pairs with
 *    `repl_…` ids. No field links them to their REPL call, so each is a tool
 *    call of its own. After a script threw, a `repl-error-…` pair repeats its
 *    error; it is dropped once the REPL call failed with that error.
 *
 * A REPL call that ends within its turn has no dispatch: its `tool_result`
 * holds `<repl-output><tools-used-before-summary>…</…><result>…</result></repl-output>`,
 * and the call shows the result's text. After a declined permission that
 * text is the first of the result's text blocks.
 *
 * Every other record (`mode`, `attachment`, `api-request`, the other
 * `system` rows, …) is dropped.
 */

import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { AcpClient } from "../acp-client.js";
import type { Logger } from "../logger.js";
import { stripLocalCommandMetadata } from "../message-filters.js";
import { messageIdForGrouping, toAcpNotifications, type ToolUseCache } from "../sdk-to-acp.js";
import type { TranscriptRecord } from "./transcript.js";

/** `toAcpNotifications` calls its client only from SDK hooks, which `registerHooks: false` turns off. */
const NO_CLIENT = {} as AcpClient;

export type TranscriptToAcpOptions = {
  sessionId: string;
  cwd: string;
  clientCapabilities?: ClientCapabilities;
  logger: Logger;
};

type ContentBlock = {
  type?: unknown;
  id?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
};

const REPL_ERROR_ID = "repl-error-";

export class TranscriptToAcp {
  private readonly toolUseCache: ToolUseCache = {};
  private readonly emittedToolCalls = new Set<string>();
  /** The REPL call of each eval that runs on, from "(dispatched #N)" to its settle event. */
  private readonly dispatched = new Map<number, string>();
  /** Settle events written before their eval's "(dispatched #N)", by eval number. */
  private readonly earlySettles = new Map<number, ReplEval>();
  /** REPL calls failed with a thrown error whose `repl-error-…` pair is still to drop. */
  private failedRepls = 0;
  /** The `repl-error-…` tool calls dropped, whose results are dropped too. */
  private readonly droppedReplErrors = new Set<string>();

  constructor(private readonly options: TranscriptToAcpOptions) {}

  /**
   * The updates of `record`. `replay`: the record is from the history of a
   * loaded session, which shows the user's prompts too.
   */
  updates(record: TranscriptRecord, { replay = false } = {}): SessionNotification[] {
    if (record.isSidechain === true) {
      return [];
    }
    switch (record.type) {
      case "assistant":
        return this.content(this.withoutReplError(record.message?.content), "assistant", {
          messageId: messageIdForGrouping(record),
          replay,
        });
      case "user":
        return this.user(record, replay);
      case "queue-operation":
        return this.settle(record, replay);
      case "system":
        return record.subtype === "turn_duration" ? this.endTurn() : [];
      default:
        return [];
    }
  }

  /**
   * Fails the tool calls still open: a REPL call whose code never settled,
   * or a call that a cancel cut off. Call it when a turn ends.
   */
  endTurn(): SessionNotification[] {
    const updates = [...this.emittedToolCalls].map((toolCallId): SessionNotification => ({
      sessionId: this.options.sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed" },
    }));
    this.emittedToolCalls.clear();
    this.dispatched.clear();
    this.earlySettles.clear();
    this.failedRepls = 0;
    this.droppedReplErrors.clear();
    for (const id of Object.keys(this.toolUseCache)) {
      delete this.toolUseCache[id];
    }
    return updates;
  }

  /**
   * `content` without a `repl-error-…` call that repeats the error a REPL
   * call already failed with. With no such REPL call, the `repl-error-…` call
   * may be the only report of the error, and stays.
   */
  private withoutReplError(content: unknown): unknown {
    if (!Array.isArray(content)) {
      return content;
    }
    return (content as ContentBlock[]).filter((block) => {
      const drop =
        this.failedRepls > 0 &&
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        block.id.startsWith(REPL_ERROR_ID);
      if (drop) {
        this.failedRepls--;
        this.droppedReplErrors.add(block.id as string);
      }
      return !drop;
    });
  }

  private user(record: TranscriptRecord, replay: boolean): SessionNotification[] {
    const content = record.message?.content;
    const blocks = Array.isArray(content)
      ? (content as ContentBlock[]).filter((block) => block?.type === "tool_result")
      : [];
    const results = blocks
      .filter((block) => !this.droppedReplErrors.delete(block.tool_use_id as string))
      .map((block) => this.withReplOutput(block));
    if (blocks.length > 0 && results.length === 0) {
      // The result of a dropped `repl-error-…` call. On replay the prompt branch below would
      // pass it to `toAcpNotifications`, which logs a result of an untracked call.
      return [];
    }
    if (results.length === 0) {
      // The user's prompt: the client sent it, so only a replay shows it.
      const text = replay && record.isMeta !== true ? stripLocalCommandMetadata(content) : null;
      return text === null ? [] : this.content(text, "user", { messageId: record.uuid, replay });
    }
    const dispatch = record.toolUseResult as
      { asyncDispatched?: unknown; evalId?: unknown } | undefined;
    const toolCallId = results[0].tool_use_id;
    if (
      results.length === 1 &&
      typeof toolCallId === "string" &&
      dispatch?.asyncDispatched === true &&
      typeof dispatch.evalId === "number"
    ) {
      const early = this.earlySettles.get(dispatch.evalId);
      if (early) {
        this.earlySettles.delete(dispatch.evalId);
        return this.settled(toolCallId, early, replay);
      }
      this.dispatched.set(dispatch.evalId, toolCallId);
      return [
        {
          sessionId: this.options.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" },
        },
      ];
    }
    return this.content(results, "user", { toolUseResult: record.toolUseResult, replay });
  }

  /** A settled REPL eval completes its call with the eval's result, or fails it. */
  private settle(record: TranscriptRecord, replay: boolean): SessionNotification[] {
    const event =
      record.operation === "enqueue" && typeof record.content === "string"
        ? replEvalEvent(record.content)
        : undefined;
    if (!event) {
      return [];
    }
    const toolUseId = this.dispatched.get(event.evalId);
    if (!toolUseId) {
      this.earlySettles.set(event.evalId, event);
      return [];
    }
    this.dispatched.delete(event.evalId);
    return this.settled(toolUseId, event, replay);
  }

  private settled(toolUseId: string, event: ReplEval, replay: boolean): SessionNotification[] {
    const isError = event.status !== "settled" || event.tag === "error";
    if (event.tag === "error") {
      this.failedRepls++;
    }
    const result = {
      type: "tool_result" as const,
      tool_use_id: toolUseId,
      content: event.output,
      is_error: isError,
    };
    return this.content([result], "user", { replay });
  }

  /** A REPL `tool_result` whose text is a `<repl-output>`, with the plain text of its result. */
  private withReplOutput(block: ContentBlock): ContentBlock {
    if (this.toolUseCache[block.tool_use_id as string]?.name !== "REPL") {
      return block;
    }
    if (Array.isArray(block.content)) {
      // A declined permission: `[{type: "text", text: "<repl-output>\n<error>The user doesn't
      // want to proceed…"}, {type: "text", text: "The user stopped this call…"}]`, is_error
      // set. No `repl-error-…` pair repeats it, so no failed REPL call is counted. The text
      // escapes `<`, `>` and `&`, as a settle event's does.
      const parts = (block.content as Array<{ type?: unknown; text?: unknown }>).map((part) => {
        const output =
          part?.type === "text" && typeof part.text === "string"
            ? replOutput(part.text)
            : undefined;
        return output ? { ...part, text: unescapeXml(output.text) } : part;
      });
      return { ...block, content: parts };
    }
    const output = typeof block.content === "string" ? replOutput(block.content) : undefined;
    if (!output) {
      return block;
    }
    if (output.tag === "error") {
      this.failedRepls++;
    }
    return {
      ...block,
      content: output.text,
      is_error: block.is_error === true || output.tag === "error",
    };
  }

  private content(
    content: unknown,
    role: "assistant" | "user",
    extra: { messageId?: string; toolUseResult?: unknown; replay: boolean },
  ): SessionNotification[] {
    if (typeof content !== "string" && !Array.isArray(content)) {
      return [];
    }
    return toAcpNotifications(
      content as string | ContentBlockParam[],
      role,
      this.options.sessionId,
      this.toolUseCache,
      NO_CLIENT,
      this.options.logger,
      {
        registerHooks: false,
        clientCapabilities: this.options.clientCapabilities,
        cwd: this.options.cwd,
        emittedToolCalls: this.emittedToolCalls,
        ...extra,
      },
    );
  }
}

type ReplEval = { evalId: number; status: string | undefined; output: string; tag?: string };

/**
 * The eval number, status, output and its tag (`result` or `error`) of a
 * `repl-eval` event, e.g.
 * `<event nonce="…" kind="repl-eval" eval="1" ms="1209" status="settled">\n<result>one.txt</result>\n</event>`.
 */
function replEvalEvent(text: string): ReplEval | undefined {
  const head = /^<event\b([^>]*)>/.exec(text);
  if (!head || attribute(head[1], "kind") !== "repl-eval") {
    return undefined;
  }
  const evalId = Number(attribute(head[1], "eval"));
  if (!Number.isInteger(evalId)) {
    return undefined;
  }
  const body = /<(\w+)>([\s\S]*)<\/\1>/.exec(text.slice(head[0].length));
  return {
    evalId,
    status: attribute(head[1], "status"),
    output: unescapeXml(body?.[2] ?? ""),
    tag: body?.[1],
  };
}

/**
 * The text of a `<repl-output>`'s `<result>` or `<error>`, without the
 * `<tools-used-before-summary>` line. Any other part stays as it is.
 */
function replOutput(text: string): { text: string; tag?: string } | undefined {
  const body = /^<repl-output>([\s\S]*)<\/repl-output>$/.exec(text.trim())?.[1];
  if (body === undefined) {
    return undefined;
  }
  const rest = body
    .replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/, "")
    .trim();
  const result = /^<(result|error)>([\s\S]*)<\/\1>$/.exec(rest);
  return result ? { text: result[2], tag: result[1] } : { text: rest };
}

/** `text` with XML's character escapes undone; `&amp;` last, so "&amp;lt;" stays "&lt;". */
function unescapeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
}
