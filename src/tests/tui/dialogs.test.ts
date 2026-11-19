import { describe, expect, it } from "vitest";
import {
  detectDialog,
  keysFor,
  sameDialog,
  showsInputBox,
  type Dialog,
} from "../../tui/dialogs.js";
import { fixtureText } from "./fixture.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";

// CLI 2.1.328's screens as ClaudePty.screen() captured them (paths redacted).
const TRUST_SCREEN = fixtureText("trust-screen.txt");
// The `default` mode's permission dialogs for a Write and a Bash call, with the
// spinner rows the CLI keeps drawing under them. The Bash one holds an escape
// split across two output chunks and an option wrapped onto a second line.
const WRITE_SCREEN = fixtureText("tool-write-screen.txt");
const BASH_SCREEN = fixtureText("tool-bash-screen.txt");
// Built from the text quoted in the task; no capture of this dialog exists yet.
const CODE_MODE_SCREEN =
  "Code Mode is experimental.\n  ❯ No, start without it \n Yes, turn on Code Mode\n\n  Enter to confirm";

/** A Bash permission for a script of `lines` lines, each `echo line<n>`. */
function longBashScreen(lines: number, first = "echo line1"): string {
  const script = Array.from({ length: lines }, (_, i) => (i === 0 ? first : `echo line${i + 1}`));
  return (
    `${"─".repeat(60)}\r\n Bash command\r\n${script.map((line) => `   ${line} \r\n`).join("")}` +
    "   Runs a long script\r\n\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n\r\n" +
    " Esc to cancel · Tab to amend\r\n"
  );
}

function dialogOf(screen: string): Dialog {
  const dialog = detectDialog(screen);
  if (!dialog) {
    throw new Error("no dialog on the screen");
  }
  return dialog;
}

/** The keys that pick each option, by label. */
function keysByLabel(dialog: Dialog): Record<string, string | undefined> {
  return Object.fromEntries(
    dialog.options.map((option) => [option.label, keysFor(dialog, option)]),
  );
}

describe("detectDialog", () => {
  it("reads the trust dialog", () => {
    const dialog = dialogOf(TRUST_SCREEN);
    expect(dialog).toMatchObject({
      kind: "trust",
      question: "Quick safety check: Is this a project you created or one you trust?",
      cursor: 0,
      options: [
        { label: "No, exit", kind: "reject_once", row: 0 },
        { label: "Yes, I trust this folder", kind: "allow_once", row: 1 },
      ],
    });
    expect(dialog.excerpt).toMatch(/^Accessing workspace:\n<cwd>\n/);
    expect(keysByLabel(dialog)).toEqual({
      "No, exit": "\r",
      "Yes, I trust this folder": DOWN + "\r",
    });
  });

  it("reads the trust dialog with the \\r\\r\\n line ends of a live PTY", () => {
    const dialog = dialogOf(TRUST_SCREEN.replaceAll("\n", " \r\r\n"));
    expect(dialog).toMatchObject({ kind: "trust", cursor: 0 });
    expect(dialog.options.map(({ label }) => label)).toEqual([
      "No, exit",
      "Yes, I trust this folder",
    ]);
  });

  it.each([
    ["the Code Mode confirmation", CODE_MODE_SCREEN],
    ["lines that end with a carriage return", CODE_MODE_SCREEN.replaceAll("\n", "\r")],
  ])("reads %s", (_name, screen) => {
    const dialog = dialogOf(screen);
    expect(dialog).toMatchObject({ kind: "code-mode", cursor: 0 });
    expect(keysByLabel(dialog)).toEqual({
      "No, start without it": "\r",
      "Yes, turn on Code Mode": DOWN + "\r",
    });
  });

  it("reads a Write permission and leaves out its mode switch", () => {
    const dialog = dialogOf(WRITE_SCREEN);
    expect(dialog).toMatchObject({
      kind: "permission",
      question: "Do you want to create hello.txt?",
      cursor: 0,
      options: [
        { label: "Yes", kind: "allow_once", row: 0 },
        // Row 1, "Yes, and switch to accept edits…", is not offered.
        { label: "No", kind: "reject_once", row: 2 },
      ],
    });
    expect(dialog.excerpt).toBe("Create file\nhello.txt\n1 hi\nDo you want to create hello.txt ?");
    expect(keysByLabel(dialog)).toEqual({ Yes: "\r", No: DOWN.repeat(2) + "\r" });
  });

  it("reads a Bash permission with a wrapped option and a split escape", () => {
    const dialog = dialogOf(BASH_SCREEN);
    expect(dialog).toMatchObject({
      kind: "permission",
      question: "Do you want to proceed?",
      cursor: 0,
      options: [
        { label: "Yes", kind: "allow_once", row: 0 },
        {
          label:
            "Yes, and don't ask again for mkdir -p made and touch made/x.txt commands in <cwd-start> <cwd-end>",
          kind: "allow_always",
          row: 1,
        },
        // Row 2, "Yes, and switch to auto mode", is not offered.
        { label: "No", kind: "reject_once", row: 3 },
      ],
    });
    expect(dialog.excerpt).toContain("Bash command\n");
    expect(dialog.excerpt).toContain("mkdir -p made && touch made/x.txt\n");
    expect(dialog.excerpt).not.toContain("switch to");
    expect(dialog.options.map(({ label }) => label).join()).not.toContain("switch to");
    expect(keysFor(dialog, dialog.options[2])).toBe(DOWN.repeat(3) + "\r");
  });

  it("keeps every line of a long command up to the dialog's rule", () => {
    const lines = dialogOf(longBashScreen(16)).excerpt.split("\n");
    expect(lines).toHaveLength(19);
    expect(lines.slice(0, 2)).toEqual(["Bash command", "echo line1"]);
    expect(lines.at(-1)).toBe("Do you want to proceed?");
  });

  it("caps the lines above a dialog with no rule and counts the ones it leaves out", () => {
    const screen = Array.from({ length: 15 }, (_, i) => `note ${i + 1}`).join("\n");
    const dialog = dialogOf(`${screen}\n${CODE_MODE_SCREEN}`);
    const lines = dialog.excerpt.split("\n");
    expect(lines).toHaveLength(13);
    expect(lines.slice(0, 2)).toEqual(["… (4 more lines not shown)", "note 5"]);
    expect(lines.at(-1)).toBe("Code Mode is experimental.");
    // Drawn again under more log: another count of hidden lines, the same dialog.
    const redraw = dialogOf(`${screen}\nmore\n${screen}\n${CODE_MODE_SCREEN}`);
    expect(redraw.excerpt).toMatch(/^… \(20 more lines not shown\)\n/);
    expect(sameDialog(dialog, redraw)).toBe(true);
  });

  it("counts the keys from a cursor on another row", () => {
    // A redraw with the cursor on "No".
    const screen = BASH_SCREEN.replace("❯  1.", "   1.").replace("    4.  No", " ❯  4.  No");
    const dialog = dialogOf(screen);
    expect(dialog.cursor).toBe(3);
    expect(keysFor(dialog, dialog.options[0])).toBe(UP.repeat(3) + "\r");
    expect(keysFor(dialog, dialog.options[1])).toBe(UP.repeat(2) + "\r");
    expect(keysFor(dialog, dialog.options[2])).toBe("\r");
  });

  it("gives no keys when no cursor is on the list", () => {
    const dialog = dialogOf(TRUST_SCREEN.replace("❯ No, exit", "  No, exit"));
    expect(dialog.cursor).toBeUndefined();
    expect(dialog.options.map((option) => keysFor(dialog, option))).toEqual([undefined, undefined]);
  });

  it.each([
    ["the ready prompt", fixtureText("ready-screen.txt")],
    [
      "options that are not Yes or No",
      "Pick a theme\n ❯ 1. Dark\n   2. Light\n\n Enter to confirm",
    ],
    ["a list with no footer", "Do you want to make this edit?\n ❯ 1. Yes\n   2. No\n"],
    ["a list numbered from 2", "Proceed?\n ❯ 2. Yes\n   3. No\n\n Esc to cancel"],
    [
      "model output that quotes a dialog, above the input box",
      "⏺ The README says:\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n\n  Esc to cancel\n" +
        fixtureText("ready-screen.txt"),
    ],
    ["a dialog with text drawn after its footer", TRUST_SCREEN + "\n✻ Thinking…\n"],
  ])("finds no dialog on %s", (_name, screen) => {
    expect(detectDialog(screen)).toBeUndefined();
  });
});

describe("sameDialog", () => {
  it("matches a redraw and tells another dialog, command or cursor apart", () => {
    const bash = dialogOf(BASH_SCREEN);
    expect(sameDialog(bash, dialogOf(BASH_SCREEN))).toBe(true);
    expect(sameDialog(bash, dialogOf(WRITE_SCREEN))).toBe(false);
    const otherCommand = BASH_SCREEN.replace(
      "   mkdir -p made && touch made/x.txt \r",
      "   rm -rf made \r",
    );
    expect(sameDialog(bash, dialogOf(otherCommand))).toBe(false);
    const moved = BASH_SCREEN.replace("❯  1.", "   1.").replace("    4.  No", " ❯  4.  No");
    expect(sameDialog(bash, dialogOf(moved))).toBe(false);
    // Two long scripts that differ in their first line only.
    expect(sameDialog(dialogOf(longBashScreen(16)), dialogOf(longBashScreen(16, "rm -rf ~")))).toBe(
      false,
    );
  });
});

describe("showsInputBox", () => {
  it.each([
    ["the ready prompt", fixtureText("ready-screen.txt"), true],
    // As CLI 2.1.328 writes it: `\r` and a cursor move (a space once stripped) between lines.
    [
      "the ready prompt with carriage returns",
      `  ${"─".repeat(40)}\r  ❯  Try "how does <filepath> work?"\r   ${"─".repeat(40)}\r`,
      true,
    ],
    ["the trust dialog", TRUST_SCREEN, false],
    ["a prompt line with no rules", "  ❯  Try something\n", false],
  ])("reads %s", (_name, screen, shown) => {
    expect(showsInputBox(screen)).toBe(shown);
  });
});
