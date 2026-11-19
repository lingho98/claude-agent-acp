/**
 * The blocking screens the interactive CLI shows before it takes a prompt, read
 * from `ClaudePty`'s ANSI-stripped output.
 *
 * CLI 2.1.328 draws them as a select list with the cursor on "No" and no
 * option numbers:
 *
 *   ❯ No, exit
 *     Yes, I trust this folder
 *
 * so the answer is the arrow keys from the cursor to "Yes", then Enter. A
 * screen that blocks with no dialog known here is caught by `TuiEngine`'s
 * unknown-dialog watchdog.
 */

export type DialogKind = "trust" | "code-mode";

export type Dialog = {
  kind: DialogKind;
  /**
   * The keys that pick "Yes", or `undefined` when the cursor's place relative
   * to "Yes" can't be read. Never guessed: Enter on the default picks "No".
   */
  keys: string | undefined;
};

const YES_LABELS: Record<DialogKind, string> = {
  trust: "Yes, I trust this folder",
  "code-mode": "Yes, turn on Code Mode",
};

const CURSOR = "❯";
const DOWN = "\x1b[B";
/** A line break in the screen log: Ink often ends a line with `\r` and moves the cursor down. */
export const LINE_BREAK = /\r\n|\r|\n/;
/** Options a select list can have above "Yes"; more means the `❯` belongs to something else. */
const MAX_OPTIONS_ABOVE = 3;

/**
 * The dialog that `screen` shows last, if any. Pass only output received
 * after the last answer: the buffer is an append log, so a dismissed dialog's
 * text stays in it.
 */
export function detectDialog(screen: string): Dialog | undefined {
  let found: { kind: DialogKind; at: number } | undefined;
  for (const [kind, label] of Object.entries(YES_LABELS) as Array<[DialogKind, string]>) {
    const at = screen.lastIndexOf(label);
    if (at >= 0 && (!found || at > found.at)) {
      found = { kind, at };
    }
  }
  if (!found) {
    return undefined;
  }
  return { kind: found.kind, keys: keysToYes(screen.slice(0, found.at)) };
}

/**
 * Whether `screen` shows the prompt input box, a `❯` line between two rules:
 *
 *   ────────────────
 *   ❯  Try "how do I log an error?"
 *   ────────────────
 *
 * CLI 2.1.328 often ends these lines with `\r` and a cursor move, not `\n`.
 */
export function showsInputBox(screen: string): boolean {
  return /─{20,}[ \t]*[\r\n]+[ \t]*❯[^\r\n]*[\r\n]+[ \t]*─{20,}/.test(screen);
}

/** Arrow keys from the last `❯` in `before` (the text up to "Yes") down to "Yes", then Enter. */
function keysToYes(before: string): string | undefined {
  const cursor = before.lastIndexOf(CURSOR);
  if (cursor < 0) {
    return undefined;
  }
  // Each option is one line; the lines from the cursor up to "Yes" are the options above it.
  const above = before
    .slice(cursor + CURSOR.length)
    .split(LINE_BREAK)
    .slice(0, -1).length;
  if (above > MAX_OPTIONS_ABOVE) {
    return undefined;
  }
  return DOWN.repeat(above) + "\r";
}
