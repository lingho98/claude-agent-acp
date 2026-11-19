/**
 * The ACP v1 agent of the terminal engine, served when
 * `CLAUDE_ACP_ENGINE=tui` (see `serve.ts`). Each session runs the
 * interactive `claude` CLI through a {@link TuiEngine}, for what only the
 * terminal has (Code Mode). The SDK agent in `src/v1/` stays the default.
 *
 * It serves `initialize`, `session/new`, `session/load`, `session/close`,
 * `session/prompt` (text and resource links), `session/cancel`,
 * `session/set_mode` (`auto` or `default`, until the CLI starts) and
 * `session/set_config_option` (`model`, until the CLI starts). The CLI starts
 * at a session's first prompt, never at `session/new`: a client may open a
 * session only to read its options.
 *
 * A dialog the CLI asks the user (the folder-trust dialog, a tool permission
 * in the `default` mode) goes to the client as `session/request_permission`;
 * see `dialogs.ts` for the screens and options.
 */

import {
  agent as acpAgent,
  type AgentApp,
  type AgentContext,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk/unstable";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Logger } from "../logger.js";
import { DEFAULT_MODEL_ID } from "../session-config-ids.js";
import { MODEL_CONFIG_ID } from "../session-model.js";
import type { ChoiceOption, Dialog } from "./dialogs.js";
import { TuiEngine, type TuiEngineOptions } from "./engine.js";
import { TranscriptToAcp } from "./transcript-to-acp.js";
import { findTranscript, LineReader } from "./transcript.js";
import packageJson from "../../package.json" with { type: "json" };

/** The permission mode a session starts in. */
const DEFAULT_MODE = "auto";

/** The `--permission-mode` values the CLI is spawned with. */
const MODES: SessionModeState["availableModes"] = [
  {
    id: DEFAULT_MODE,
    name: "Auto",
    description: "Claude Code's auto mode: it decides which tool calls need your approval.",
  },
  {
    id: "default",
    name: "Default",
    description: "Claude Code asks before it edits files or runs commands.",
  },
];

/** The model choices: the CLI's own default and its aliases. Any model id the CLI takes is accepted too. */
const MODEL_CHOICES = [
  { value: DEFAULT_MODEL_ID, name: "Default", description: "The model Claude Code is set to use" },
  { value: "opus", name: "Opus" },
  { value: "sonnet", name: "Sonnet" },
  { value: "haiku", name: "Haiku" },
];

/** What the agent uses of a {@link TuiEngine}; tests pass their own. */
export type TuiEngineLike = Pick<TuiEngine, "prompt" | "cancel" | "dispose" | "stopped">;

type Turn = { cancelled: boolean; done: Promise<PromptResponse> };

type TuiSession = {
  id: string;
  cwd: string;
  model: string;
  /** The permission mode, passed as `--permission-mode` at spawn. */
  mode: string;
  /** Created at the first prompt, and again at the prompt after the CLI stopped. */
  engine: TuiEngineLike | undefined;
  adapter: TranscriptToAcp;
  /** The prompt in progress, or the cancelled one that still wraps up. */
  turn: Turn | undefined;
};

export class TuiAcpAgent {
  private readonly sessions = new Map<string, TuiSession>();
  private clientCapabilities: ClientCapabilities | undefined;

  constructor(
    private readonly client: Pick<AgentContext, "notify" | "request">,
    readonly logger: Logger = console,
    private readonly createEngine: (options: TuiEngineOptions) => TuiEngineLike = (options) =>
      new TuiEngine(options),
  ) {}

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        sessionCapabilities: { close: {} },
      },
      agentInfo: {
        name: packageJson.name,
        title: "Claude Agent (terminal)",
        version: packageJson.version,
      },
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.warnMcpServers(params.mcpServers);
    const session = this.openSession(randomUUID(), params.cwd);
    return { sessionId: session.id, modes: modes(session), configOptions: configOptions(session) };
  }

  /** Replays the session's transcript; the CLI resumes the session at the next prompt. */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.warnMcpServers(params.mcpServers);
    let file: string | undefined;
    try {
      file = findTranscript(params.sessionId);
    } catch (error) {
      throw RequestError.invalidParams(undefined, (error as Error).message);
    }
    if (!file) {
      throw RequestError.invalidParams(
        undefined,
        `Claude Code has no session ${params.sessionId}. Start a new session.`,
      );
    }
    await this.closeSession({ sessionId: params.sessionId });
    const session = this.openSession(params.sessionId, params.cwd);
    for (const record of new LineReader().push(readFileSync(file))) {
      await this.send(session.adapter.updates(record, { replay: true }));
    }
    await this.send(session.adapter.endTurn());
    return { modes: modes(session), configOptions: configOptions(session) };
  }

  /** Resolves once the session's CLI exited. */
  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const engine = this.sessions.get(params.sessionId)?.engine;
    this.sessions.delete(params.sessionId);
    await engine?.dispose();
    return {};
  }

  /**
   * Runs one turn. A prompt while a turn runs is refused; a prompt right after
   * a cancel waits for the cancelled turn to wrap up, then runs.
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.session(params.sessionId);
    const text = promptText(params.prompt);
    const previous = session.turn;
    if (previous && !previous.cancelled) {
      throw RequestError.invalidRequest(
        undefined,
        "A turn is already running in this session. Try again when the turn ends.",
      );
    }
    const turn: Turn = { cancelled: false, done: Promise.resolve({ stopReason: "end_turn" }) };
    turn.done = (async () => {
      // The cancelled turn's own prompt call reported its outcome; this one only waits for it.
      await previous?.done.catch(() => {});
      return this.runTurn(session, text, turn);
    })();
    session.turn = turn;
    try {
      return await turn.done;
    } finally {
      if (session.turn === turn) {
        session.turn = undefined;
      }
    }
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session?.turn) {
      session.turn.cancelled = true;
    }
    session?.engine?.cancel();
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.session(params.sessionId);
    if (!MODES.some(({ id }) => id === params.modeId)) {
      throw RequestError.invalidParams(
        undefined,
        `The terminal engine runs the ${MODES.map(({ id }) => `"${id}"`).join(" and ")} modes, not "${params.modeId}".`,
      );
    }
    if (session.engine && !session.engine.stopped && params.modeId !== session.mode) {
      // ponytail: Shift+Tab cycles the running CLI's mode, but the cycle's
      // order and the mode it lands on are the CLI's; set at spawn only.
      throw RequestError.invalidRequest(
        undefined,
        `The permission mode can't change once the session's Claude CLI runs; a mode change needs a new session.`,
      );
    }
    session.mode = params.modeId;
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.session(params.sessionId);
    if (params.configId !== MODEL_CONFIG_ID || typeof params.value !== "string") {
      throw RequestError.invalidParams(
        undefined,
        `The terminal engine has no option "${params.configId}" with value ${JSON.stringify(params.value)}.`,
      );
    }
    if (session.engine && !session.engine.stopped && params.value !== session.model) {
      // The CLI takes `--model` at spawn; a `/model` typed into the running CLI
      // could merge with a prompt, so the model is fixed once the CLI runs.
      throw RequestError.invalidRequest(
        undefined,
        `The model can't change once the session's Claude CLI runs. Start a new session to use ${params.value}.`,
      );
    }
    session.model = params.value;
    return { configOptions: configOptions(session) };
  }

  /** Resolves once every session's CLI exited. */
  async dispose(): Promise<void> {
    const engines = [...this.sessions.values()].map(({ engine }) => engine?.dispose());
    this.sessions.clear();
    await Promise.all(engines);
  }

  private async runTurn(session: TuiSession, text: string, turn: Turn): Promise<PromptResponse> {
    if (turn.cancelled) {
      return { stopReason: "cancelled" };
    }
    // A CLI that stopped after the last turn returned (a cancel during startup, an exit while idle).
    if (session.engine?.stopped) {
      session.engine = undefined;
    }
    const engine = (session.engine ??= this.startEngine(session));
    let tuiTurn;
    try {
      tuiTurn = engine.prompt(text);
    } catch (error) {
      throw RequestError.invalidRequest(undefined, (error as Error).message);
    }
    try {
      for await (const record of tuiTurn.records) {
        await this.send(session.adapter.updates(record));
      }
      const { stopReason } = await tuiTurn.done;
      return {
        stopReason:
          stopReason === "cancelled" || stopReason === "max_tokens" ? stopReason : "end_turn",
      };
    } catch (error) {
      throw RequestError.internalError(undefined, (error as Error).message);
    } finally {
      await this.send(session.adapter.endTurn());
      // A CLI that failed to start (an untrusted folder) or exited: the next prompt starts another.
      if (engine.stopped && session.engine === engine) {
        session.engine = undefined;
      }
    }
  }

  /** A CLI for `session`: it resumes the session once the CLI wrote its transcript. */
  private startEngine(session: TuiSession): TuiEngineLike {
    const resume = findTranscript(session.id) !== undefined;
    return this.createEngine({
      cwd: session.cwd,
      ...(resume ? { resume: session.id } : { sessionId: session.id }),
      ...(session.model !== DEFAULT_MODEL_ID ? { model: session.model } : {}),
      permissionMode: session.mode,
      askUser: (dialog, signal) => this.askUser(session, dialog, signal),
    });
  }

  /**
   * Sends `dialog` to the client as a permission request: the screen's
   * question as the title, the lines above its options as the content, one
   * permission option per screen option. Resolves the option the client
   * chose, or `undefined` when it cancelled. `signal` withdraws the request.
   */
  private async askUser(
    session: TuiSession,
    dialog: Dialog,
    signal: AbortSignal,
  ): Promise<ChoiceOption | undefined> {
    const request: RequestPermissionRequest = {
      sessionId: session.id,
      toolCall: {
        toolCallId: `dialog-${randomUUID()}`,
        title: dialog.question,
        kind: "other",
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: dialog.excerpt } }],
      },
      options: dialog.options.map(({ label, kind, row }) => ({
        optionId: String(row),
        name: label,
        kind,
      })),
    };
    try {
      const { outcome } = await this.client.request(
        methods.client.session.requestPermission,
        request,
        { cancellationSignal: signal, stopWaitingOnCancel: true },
      );
      return outcome.outcome === "selected"
        ? dialog.options.find(({ row }) => String(row) === outcome.optionId)
        : undefined;
    } catch (error) {
      if (!signal.aborted) {
        this.logger.error(
          `[claude-agent-acp] The permission request for "${dialog.question}" failed: ${(error as Error).message}`,
        );
      }
      return undefined;
    }
  }

  private openSession(id: string, cwd: string): TuiSession {
    const adapter = new TranscriptToAcp({
      sessionId: id,
      cwd,
      clientCapabilities: this.clientCapabilities,
      logger: this.logger,
    });
    const session = {
      id,
      cwd,
      model: DEFAULT_MODEL_ID,
      mode: DEFAULT_MODE,
      engine: undefined,
      adapter,
      turn: undefined,
    };
    this.sessions.set(id, session);
    return session;
  }

  private session(sessionId: string): TuiSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `No open session ${sessionId}. Start or load one first.`,
      );
    }
    return session;
  }

  private async send(updates: SessionNotification[]): Promise<void> {
    for (const update of updates) {
      await this.client.notify(methods.client.session.update, update);
    }
  }

  /** The CLI loads the user's own MCP servers; the client's are not passed to it yet. */
  private warnMcpServers(servers: readonly unknown[] | undefined): void {
    if (servers?.length) {
      this.logger.error(
        `[claude-agent-acp] The terminal engine ignores the ${servers.length} MCP server(s) the client passed.`,
      );
    }
  }
}

function modes(session: TuiSession): SessionModeState {
  return { currentModeId: session.mode, availableModes: MODES };
}

function configOptions(session: TuiSession): SessionConfigOption[] {
  const known = MODEL_CHOICES.some((choice) => choice.value === session.model);
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.model,
      options: known
        ? MODEL_CHOICES
        : [...MODEL_CHOICES, { value: session.model, name: session.model }],
    },
  ];
}

/** The prompt as the text the CLI gets. A resource link becomes its URI. */
function promptText(prompt: ContentBlock[]): string {
  return prompt
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "resource_link":
          return block.uri;
        default:
          throw RequestError.invalidParams(
            undefined,
            `The terminal engine takes text and resource links, not ${block.type} content.`,
          );
      }
    })
    .join("\n");
}

/** The ACP v1 surface of the terminal engine, for one connection. */
export function tuiAgentApp(
  logger: Logger | undefined,
  onAgent: (agent: TuiAcpAgent) => void,
): AgentApp {
  let agent!: TuiAcpAgent;
  return acpAgent({ name: "claude-code-acp-tui" })
    .onConnect((connection) => {
      agent = new TuiAcpAgent(connection.client, logger);
      onAgent(agent);
    })
    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      agent.setSessionConfigOption(ctx.params),
    )
    .onRequest(methods.agent.session.prompt, (ctx) => {
      const cancel = () => void agent.cancel({ sessionId: ctx.params.sessionId });
      ctx.signal.addEventListener("abort", cancel, { once: true });
      return agent
        .prompt(ctx.params)
        .finally(() => ctx.signal.removeEventListener("abort", cancel));
    })
    .onNotification(methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params));
}
