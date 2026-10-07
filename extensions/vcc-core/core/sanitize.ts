// @ts-nocheck
// CSI with private/intermediate parameter bytes (`\x1b[?25l`, `\x1b[1 q`) plus
// OSC (`\x1b]0;title\x07`, `\x1b]0;title\x1b\\`) and the other STRING
// sequences (DCS/APC/PM/SOS, `\x1bP…\x1b\\`). The narrow `[0-9;]*[A-Za-z]` form
// consumed only the escape and left `?25l` / `[1 q` / `]0;title` behind as
// ordinary summary text. CTRL_RE below is the backstop for anything this still
// misses.
//
// Parameter bytes for CSI are ECMA-48 0x30-0x3f — digits, `;`, `:`, `<`, `=`,
// `>`, `?` — so the class MUST include `:`: colon-form SGR
// (`\x1b[38:2::255:0:0m`, the form modern terminals emit) otherwise left
// `[38:2::255:0:0m` in the summary as literal text. The 8-bit C1 introducers
// (0x9b CSI, 0x9d OSC) are handled by the same two branches.
//
// The string-sequence payload class excludes NEWLINE as well as BEL/ESC: without
// that, an unterminated introducer ran to the next terminator anywhere later in
// the string and deleted every character in between — real output, not escape
// residue. Leaving the introducer in place is strictly better than eating the
// payload, and CTRL_RE still strips the escape itself.
const ANSI_RE = /\x1b\[[0-9:;?><!<= ]*[ -/]*[@-~]|\x9b[0-9:;?><!<= ]*[ -/]*[@-~]|\x1b[\x5dP\x5e_X][^\x07\x1b\n]*(?:\x07|\x1b\\|\x9c)|\x9d[^\x07\x1b\n]*(?:\x07|\x1b\\|\x9c)/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export const sanitize = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "").replace(CTRL_RE, "");
