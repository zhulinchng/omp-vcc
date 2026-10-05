// @ts-nocheck
// CSI with private/intermediate parameter bytes (`\x1b[?25l`, `\x1b[1 q`) plus
// OSC (`\x1b]0;title\x07`, `\x1b]0;title\x1b\\`). The narrow
// `[0-9;]*[A-Za-z]` form consumed only the escape and left `?25l` / `[1 q` /
// `]0;title` behind as ordinary summary text. CTRL_RE below is the backstop for
// anything this still misses.
//
// The OSC payload class excludes NEWLINE as well as BEL/ESC: without that, an
// unterminated OSC introducer ran to the next BEL anywhere later in the string
// and deleted every character in between — real output, not escape residue.
// Leaving the introducer in place is strictly better than eating the payload,
// and CTRL_RE still strips the escape itself.
const ANSI_RE = /\x1b\[[0-9;?><!<= ]*[ -/]*[@-~]|\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export const sanitize = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "").replace(CTRL_RE, "");
