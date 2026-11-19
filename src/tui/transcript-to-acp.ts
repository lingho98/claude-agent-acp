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
 *    the code finished; the call completes with that result.
 * 4. The tools the code called, as `isVirtual` assistant/user pairs with
 *    `repl_…` ids. No field links them to their REPL call, so each is a tool
 *    call of its own.
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

type ContentBlock = { type?: unknown; tool_use_id?: unknown };

export class TranscriptToAcp {
  private readonly toolUseCache: ToolUseCache = {};
  private readonly emittedToolCalls = new Set<string>();
  /** The REPL call of each eval that runs on, from "(dispatched #N)" to its settle event. */
  private readonly dispatched = new Map<number, string>();

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
        return this.content(record.message?.content, "assistant", {
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
    for (const id of Object.keys(this.toolUseCache)) {
      delete this.toolUseCache[id];
    }
    return updates;
  }

  private user(record: TranscriptRecord, replay: boolean): SessionNotification[] {
    const content = record.message?.content;
    const results = Array.isArray(content)
      ? (content as ContentBlock[]).filter((block) => block?.type === "tool_result")
      : [];
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
    const toolUseId = event && this.dispatched.get(event.evalId);
    if (!event || !toolUseId) {
      return [];
    }
    this.dispatched.delete(event.evalId);
    const result = {
      type: "tool_result" as const,
      tool_use_id: toolUseId,
      content: event.output,
      is_error: event.status !== "settled",
    };
    return this.content([result], "user", { replay });
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

/**
 * The eval number, status and output of a `repl-eval` event, e.g.
 * `<event nonce="…" kind="repl-eval" eval="1" ms="1209" status="settled">\n<result>one.txt</result>\n</event>`.
 */
function replEvalEvent(
  text: string,
): { evalId: number; status: string | undefined; output: string } | undefined {
  const head = /^<event\b([^>]*)>/.exec(text);
  if (!head || attribute(head[1], "kind") !== "repl-eval") {
    return undefined;
  }
  const evalId = Number(attribute(head[1], "eval"));
  if (!Number.isInteger(evalId)) {
    return undefined;
  }
  const body = /<(\w+)>([\s\S]*)<\/\1>/.exec(text.slice(head[0].length));
  return { evalId, status: attribute(head[1], "status"), output: body?.[2] ?? "" };
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
}
