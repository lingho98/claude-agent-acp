import { inputString, resultText, textContent } from "../content.js";
import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseFacts } from "../facts.js";

/**
 * Code Mode's REPL: the model runs JavaScript that calls the other tools. Only
 * the interactive CLI has it (`src/tui/`). The code is the content, not the
 * title: a client that renders an `execute` call as a shell row (Paseo) shows
 * the title as its command line and the content as its body. The result keeps
 * the code above the output, since a result's content replaces the call's.
 */
export class ReplReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    return { title: "REPL", kind: "execute", display: codeContent(input) };
  }

  toolResult({ toolUse, result }: ToolResultContext): ToolResultFacts {
    return { content: [...codeContent(toolUse.input), ...(resultText(result).content ?? [])] };
  }

  errorResult(context: ToolResultContext): ToolResultFacts {
    return this.toolResult(context);
  }
}

function codeContent(input: unknown) {
  const code = inputString(input, "code");
  return code ? [textContent(`\`\`\`js\n${code}\n\`\`\``)] : [];
}
