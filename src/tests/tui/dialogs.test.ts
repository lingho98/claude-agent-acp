import { describe, expect, it } from "vitest";
import { detectDialog, showsInputBox } from "../../tui/dialogs.js";
import { fixtureText } from "./fixture.js";

const DOWN = "\x1b[B";

// CLI 2.1.328's trust dialog as ClaudePty.screen() captured it (path redacted).
const TRUST_SCREEN = fixtureText("trust-screen.txt");

describe("detectDialog", () => {
  it.each([
    ["the captured trust dialog", TRUST_SCREEN, { kind: "trust", keys: DOWN + "\r" }],
    // Built from the text quoted in the task; no capture of this dialog exists yet.
    [
      "the Code Mode confirmation",
      "Code Mode is experimental.\n  ❯ No, start without it \n Yes, turn on Code Mode\n\n  Enter to confirm",
      { kind: "code-mode", keys: DOWN + "\r" },
    ],
    [
      "a redraw with the cursor on Yes",
      TRUST_SCREEN + "\n    No, exit \n  ❯ Yes, I trust this folder\n",
      { kind: "trust", keys: "\r" },
    ],
    [
      "lines that end with a carriage return",
      "Code Mode is experimental.\r  ❯ No, start without it \r Yes, turn on Code Mode\r",
      { kind: "code-mode", keys: DOWN + "\r" },
    ],
    ["no cursor before Yes", "Yes, I trust this folder", { kind: "trust", keys: undefined }],
    [
      "a cursor too far above Yes",
      "❯ prompt\n\n\n\n\n Yes, turn on Code Mode",
      { kind: "code-mode", keys: undefined },
    ],
  ])("reads %s", (_name, screen, dialog) => {
    expect(detectDialog(screen)).toEqual(dialog);
  });

  it("finds no dialog on the ready prompt", () => {
    const ready = fixtureText("ready-screen.txt");
    expect(detectDialog(ready)).toBeUndefined();
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
