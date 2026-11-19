/**
 * The blocking choice screens the interactive CLI shows, read from
 * `ClaudePty`'s ANSI-stripped output. CLI 2.1.328 draws two shapes, both
 * above a footer line that starts with "Enter to confirm" or "Esc to cancel":
 *
 *   the trust and Code Mode dialogs,     a tool permission,
 *   no numbers, cursor on "No":          numbered, cursor on "1.":
 *
 *     ❯ No, exit                           Do you want to proceed?
 *     Yes, I trust this folder             ❯ 1. Yes
 *                                            2. Yes, and don't ask again for mkdir commands in
 *     Enter to confirm · Esc to cancel          /work
 *                                            3. Yes, and switch to auto mode
 *                                            4. No
 *
 *                                          Esc to cancel · Tab to amend
 *
 * An option is picked with the arrow keys from the cursor's row, then Enter;
 * Esc declines (see {@link DECLINE}). The footer is the last thing a dialog
 * draws: text after it other than a spinner redraw, such as the input box
 * below model output that quotes a dialog, means no dialog. A screen whose
 * options are not all "Yes…" or "No…" is not read as a dialog. `TuiEngine` fails startup on it after 60 s, and a turn once screen
 * and transcript stay unchanged for 30 s.
 */

import type { PermissionOptionKind } from "@agentclientprotocol/sdk/unstable";
import { stripAnsi } from "./pty.js";

export type DialogKind = "trust" | "code-mode" | "permission";

/** The ACP permission option kinds a screen option maps to. */
export type ChoiceKind = Exclude<PermissionOptionKind, "reject_always">;

export type ChoiceOption = {
  label: string;
  kind: ChoiceKind;
  /** The option's row in the list on screen, counting rows {@link Dialog.options} leaves out. */
  row: number;
};

export type Dialog = {
  kind: DialogKind;
  /** The screen's question, e.g. "Do you want to proceed?". */
  question: string;
  /** The screen lines above the options, e.g. the command a tool permission names. */
  excerpt: string;
  options: ChoiceOption[];
  /**
   * The row of the `❯` cursor, or `undefined` when it can't be read. Never
   * guessed: Enter on the wrong row picks another answer.
   */
  cursor: number | undefined;
};

const CURSOR = "❯";
/**
 * The key that declines a dialog. CLI 2.1.328 rejects a tool permission on
 * Esc, and exits on it at the trust dialog. Never arrow keys: they move from
 * the cursor of the dialog the user was asked about, which may not be the one
 * on screen.
 */
export const DECLINE = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
/**
 * A line break in the screen log: Ink often ends a line with `\r` and moves
 * the cursor down, and the PTY writes a `\n` as `\r\n`, so one break can be `\r\r\n`.
 */
export const LINE_BREAK = /\r*\n|\r/;
const FOOTER = /^(Enter to confirm|Esc to cancel)\b/;
/** A numbered option's first line; a line that doesn't match continues the option above. */
const NUMBERED = /^(❯ )?(\d+)\. (.*)$/;
/** An unnumbered option's line. */
const PLAIN_OPTION = /^(❯ ?)?(Yes|No)\b/;
/**
 * A line the CLI may write after a dialog's footer: a spinner or timer
 * redraw, e.g. "⏺", "4" or "· 2s". No letters, no rule, no input box `❯`.
 */
const SPINNER_REDRAW = /^[^\p{L}─❯]*(\d+s[^\p{L}─❯]*)?$/u;
/** A rule across the screen: the top of a tool permission dialog. */
const RULE = /^─{10,}$/;
/** Lines {@link Dialog.excerpt} takes at most. */
const EXCERPT_LINES = 12;
/** Lines of one option list at most; more means the footer belongs to something else. */
const MAX_OPTION_LINES = 12;

/**
 * The dialog that `screen` shows last, if any. Pass only output received
 * after the last answer: the buffer is an append log, so a dismissed dialog's
 * text stays in it.
 */
export function detectDialog(screen: string): Dialog | undefined {
  // Stripped again: an escape split across two output chunks survives `ClaudePty`'s per-chunk strip.
  const lines = stripAnsi(screen)
    .split(LINE_BREAK)
    .map((line) => line.replace(/\s+/g, " ").trim());
  const footer = lines.findLastIndex((line) => FOOTER.test(line));
  let end = footer - 1;
  while (end >= 0 && !lines[end]) {
    end--;
  }
  if (
    footer < 0 ||
    end < 0 ||
    !lines.slice(footer + 1).every((line) => SPINNER_REDRAW.test(line))
  ) {
    return undefined;
  }
  const list = NUMBERED.test(lines[end]) ? numberedList(lines, end) : plainList(lines, end);
  if (!list) {
    return undefined;
  }
  const kinds = list.rows.map(({ label }) => optionKind(label));
  if (
    kinds.includes(undefined) ||
    !kinds.includes("reject_once") ||
    !kinds.some((kind) => kind?.startsWith("allow"))
  ) {
    return undefined;
  }
  const cursors = list.rows.flatMap(({ cursor }, row) => (cursor ? [row] : []));
  const excerpt = excerptAbove(lines, list.start);
  const options = list.rows.flatMap(({ label }, row) => {
    const kind = kinds[row];
    // ponytail: mode-switch options hidden until the agent advertises those modes.
    return kind === "mode" || kind === undefined ? [] : [{ label, kind, row }];
  });
  return {
    kind: dialogKind(options),
    question: question(excerpt),
    excerpt: excerpt.join("\n"),
    options,
    cursor: cursors.length === 1 ? cursors[0] : undefined,
  };
}

/** Whether `a` and `b` are one dialog drawn twice: the same question, options and cursor. */
export function sameDialog(a: Dialog, b: Dialog): boolean {
  return (
    a.question === b.question &&
    a.cursor === b.cursor &&
    a.options.length === b.options.length &&
    a.options.every(({ label }, i) => label === b.options[i].label)
  );
}

/** Arrow keys from the cursor's row to `option`'s, then Enter; `undefined` when the cursor can't be read. */
export function keysFor(dialog: Dialog, option: ChoiceOption): string | undefined {
  if (dialog.cursor === undefined) {
    return undefined;
  }
  const moves = option.row - dialog.cursor;
  return (moves >= 0 ? DOWN.repeat(moves) : UP.repeat(-moves)) + "\r";
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

type Row = { label: string; cursor: boolean };
type OptionList = { start: number; rows: Row[] };

/** The numbered options ending at line `end`, from "1." on; a wrapped option spans lines. */
function numberedList(lines: string[], end: number): OptionList | undefined {
  let start = end;
  while (
    start >= 0 &&
    end - start < MAX_OPTION_LINES &&
    lines[start].match(NUMBERED)?.[2] !== "1"
  ) {
    if (!lines[start]) {
      return undefined;
    }
    start--;
  }
  if (start < 0 || end - start >= MAX_OPTION_LINES) {
    return undefined;
  }
  const rows: Row[] = [];
  for (const line of lines.slice(start, end + 1)) {
    const match = line.match(NUMBERED);
    if (match && Number(match[2]) === rows.length + 1) {
      rows.push({ label: match[3], cursor: match[1] !== undefined });
    } else {
      rows[rows.length - 1].label += ` ${line}`;
    }
  }
  return { start, rows };
}

/** The unnumbered options ending at line `end`: one per line, each a "Yes…" or "No…". */
function plainList(lines: string[], end: number): OptionList | undefined {
  let start = end + 1;
  while (start > 0 && PLAIN_OPTION.test(lines[start - 1]) && end - start < MAX_OPTION_LINES) {
    start--;
  }
  const rows = lines.slice(start, end + 1).map((line) => ({
    label: line.startsWith(CURSOR) ? line.slice(CURSOR.length).trim() : line,
    cursor: line.startsWith(CURSOR),
  }));
  if (rows.length < 2) {
    return undefined;
  }
  return { start, rows };
}

/** "No…" rejects; "Yes…" allows, always when it says "don't ask again"; "mode" switches the permission mode. */
function optionKind(label: string): ChoiceKind | "mode" | undefined {
  if (/^No\b/.test(label)) {
    return "reject_once";
  }
  if (!/^Yes\b/.test(label)) {
    return undefined;
  }
  if (/\bswitch to\b/i.test(label)) {
    return "mode";
  }
  return /don't ask again|\balways\b/i.test(label) ? "allow_always" : "allow_once";
}

function dialogKind(options: ChoiceOption[]): DialogKind {
  const labels = options.map(({ label }) => label);
  if (labels.includes("Yes, I trust this folder")) {
    return "trust";
  }
  return labels.includes("Yes, turn on Code Mode") ? "code-mode" : "permission";
}

/**
 * The lines that are not blank above line `start`, up to a rule or
 * {@link EXCERPT_LINES}. Dashed box edges are dropped, and so are tips: they
 * point at the mode-switch options the dialog leaves out.
 */
function excerptAbove(lines: string[], start: number): string[] {
  const excerpt: string[] = [];
  for (let i = start - 1; i >= 0 && excerpt.length < EXCERPT_LINES && !RULE.test(lines[i]); i--) {
    if (lines[i] && !/^(╌+$|Tip:)/.test(lines[i])) {
      excerpt.unshift(lines[i]);
    }
  }
  return excerpt;
}

/** The last excerpt line that asks something, up to its "?"; else the last line. */
function question(excerpt: string[]): string {
  const asking = excerpt.findLast((line) => line.includes("?"));
  if (!asking) {
    return excerpt.at(-1) ?? "Claude Code asks you to choose";
  }
  return asking.slice(0, asking.lastIndexOf("?")).trimEnd() + "?";
}
