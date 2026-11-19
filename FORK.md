# Fork: terminal engine for Code Mode

This fork of [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) adds an opt-in terminal engine (`src/tui/`). It runs each ACP session in the interactive `claude` CLI inside a pseudo-terminal (node-pty), so ACP clients such as Paseo can use Claude Code's Code Mode. Code Mode runs only in the interactive CLI, never through the Agent SDK.

The SDK engine stays the default: unless `CLAUDE_ACP_ENGINE` is exactly `tui`, `src/serve.ts` serves the upstream protocol router. The fork's other shared changes are the `REPL` tool-call reporter (`src/tool-calls/reporters/repl.ts`) and the optional `node-pty` dependency.

## Enable

Set both variables on the adapter process:

- `CLAUDE_ACP_ENGINE=tui` selects the terminal engine.
- `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` turns on Code Mode in the CLI. The adapter passes it through to `claude` unchanged.

Run the adapter as `node dist/index.js` from a clone. The compiled single-file binary (`npm run build:binary`) can't load node-pty's native addon, so the terminal engine fails there. The engine spawns `claude` from `PATH`, so the Claude Code CLI must be installed and signed in.

## Install

```sh
git clone https://github.com/lingho98/claude-agent-acp.git
cd claude-agent-acp
git checkout v0.108.1-tui.1
npm ci
npm run build
```

The package has no `prepare` script and `dist/` is not committed, so `npm install github:lingho98/claude-agent-acp#v0.108.1-tui.1` installs no build. Use the clone.

## Paseo provider

Add a custom provider under `agents.providers` in `~/.paseo/config.json` (the id must match `^[a-z][a-z0-9-]*$`):

```json
{
  "agents": {
    "providers": {
      "claude-code-mode": {
        "extends": "acp",
        "label": "Claude (Code Mode)",
        "command": ["node", "/absolute/path/to/claude-agent-acp/dist/index.js"],
        "env": {
          "CLAUDE_ACP_ENGINE": "tui",
          "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "1"
        },
        "models": [
          { "id": "default", "label": "Default", "isDefault": true },
          { "id": "opus", "label": "Opus" },
          { "id": "sonnet", "label": "Sonnet" },
          { "id": "haiku", "label": "Haiku" }
        ]
      }
    }
  }
}
```

The model ids are the ones the engine advertises. `default` uses the model Claude Code is set to; the others are passed to the CLI as `--model <alias>`. Then run `paseo reload`.

## Behaviour

- **REPL rows.** A Code Mode REPL call shows as an `execute` row with the JavaScript as its body and the result's text below it. It stays in progress until the eval settles, then completes, or fails with the error when the script threw. The tool calls the code makes appear as rows of their own.
- **Dialogs become prompts.** The folder-trust dialog and tool permission screens go to the client as permission requests (approve or deny in the chat), titled with the tool and the question, e.g. "Bash command: Do you want to proceed?", and showing every line of the command. The bridge never accepts the trust dialog itself: declining it fails the prompt and names the folder, and cancelling the request ends the turn as cancelled. Every decline is one Esc, never arrow keys. If the CLI shows a different dialog while you are asked (or the asked one was only model output quoting a dialog), the engine declines what is on screen and fails the turn. Paseo's per-agent Auto Accept toggle answers these requests too, so with it on, a folder gets trusted without asking. The Code Mode dialog is the one screen the engine answers itself ("Yes").
- **Modes.** `auto` (the default, Claude Code's auto mode) and `default` (asks before edits and commands). Both are passed to the CLI as `--permission-mode`.
- **Starts at the first prompt.** `session/new` starts no CLI. Mode and model can change until the first prompt; after that a change is refused and needs a new session.
- **Cancel** interrupts the turn. A dialog open at that moment is declined with Esc. A prompt sent right after a cancel waits for the cancelled turn to wrap up.
- **Resume.** `session/load` replays the session's transcript, and the next prompt starts the CLI with `--resume`.
- **Stopped CLI.** If the CLI exits between turns, or the transcript can't be read, the next prompt starts a new one on the same session.

## Limits

- Tested on macOS only. Linux is untested: node-pty is an optional dependency and 1.1.0 ships no Linux prebuilds, so if it failed to install, run `npm install node-pty` (it builds from source and needs a C++ toolchain). Windows is not supported.
- MCP servers the client sends are ignored (a warning is logged). The CLI uses the user's own MCP config.
- Prompts take text and resource links only (a link becomes its URI). Images and embedded resources are refused.
- ACP v1 only. A v2 client is negotiated down to v1, and `CLAUDE_AGENT_ACP_PROTOCOL=v2` fails at startup.
- Paseo 0.16.1 shows DEFAULT MODE `default` in `paseo provider ls` for any custom ACP provider, since it reads no default mode from the agent; sessions still start in `auto`. `paseo permit ls` shows no description for ACP permission requests; the request's title is in the TOOL column.
- An unrecognised blocking screen fails the turn once the screen and transcript stay unchanged for 30 s. Any CLI output restarts that timer, so while the spinner keeps redrawing it never fires, and the turn hangs until you cancel.
- Dialog and turn-end detection rely on the screen text and transcript records of Claude Code CLI 2.1.328. A CLI release that changes them can break the engine.
- npm 11 may skip node-pty's install script, which leaves its `spawn-helper` without the execute bit. The engine makes it executable at first spawn.

## Versions and syncing upstream

Fork releases are tagged `v<upstream-base>-tui.<n>`, for example `v0.108.1-tui.1` on upstream 0.108.1. The package name stays `@agentclientprotocol/claude-agent-acp`, which keeps upstream merges clean. The release jobs in `publish.yml` (release-please, npm publish and preview, binary upload, registry update) are guarded on `github.repository == 'agentclientprotocol/claude-agent-acp'`, so on this fork they skip. CI (`ci.yml`, including its binary build) runs as usual.

To sync:

```sh
git remote add upstream https://github.com/agentclientprotocol/claude-agent-acp.git  # once
git fetch upstream
git merge upstream/main
```

Then set the version to the new upstream base with `-tui.1` (`npm version <base>-tui.1 --no-git-tag-version`), and bump `-tui.<n>` for each later fork release on the same base.

## Attribution

Parts of `src/tui/` are derived from [zeo-workspace/claude-agent-tui](https://github.com/zeo-workspace/claude-agent-tui) (Apache-2.0). See [NOTICE](NOTICE) for the files and copyright.
