// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { sanitize } from "../extensions/vcc-core/core/sanitize";

describe("sanitize", () => {
  it("strips ANSI escape codes", () => {
    expect(sanitize("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips CSI sequences with private parameter bytes", () => {
    expect(sanitize("\x1b[?25lhidden\x1b[?25h")).toBe("hidden");
    expect(sanitize("\x1b[?2004h")).toBe("");
  });

  it("strips CSI sequences with an intermediate byte", () => {
    expect(sanitize("a\x1b[1 qb")).toBe("ab");
    expect(sanitize("a\x1b[!pb")).toBe("ab");
  });

  it("strips OSC sequences terminated by BEL or ST", () => {
    expect(sanitize("\x1b]0;window title\x07payload")).toBe("payload");
    expect(sanitize("\x1b]0;window title\x1b\\payload")).toBe("payload");
  });

  it("leaves no residue for the shapes that previously leaked", () => {
    for (const raw of ["\x1b[?25l", "\x1b[1 q", "\x1b]0;title\x07"]) {
      expect(sanitize(raw)).toBe("");
    }
  });

  // An unterminated OSC introducer used to run to the next BEL anywhere later
  // in the string and delete everything in between — real output, not escape
  // residue. The payload class excludes newline so the removal stays on one line.
  it("does not delete real text when an OSC sequence is unterminated", () => {
    const out = sanitize("\x1b]0;prompt\nREAL OUTPUT LINE 1\nREAL OUTPUT LINE 2\n\x07AFTER");
    expect(out).toContain("REAL OUTPUT LINE 1");
    expect(out).toContain("REAL OUTPUT LINE 2");
    expect(out).toContain("AFTER");
  });

  it("still removes a same-line terminated OSC sequence", () => {
    expect(sanitize("\x1b]0;title\x07payload")).toBe("payload");
  });

  it("keeps ordinary brackets and question marks", () => {
    expect(sanitize("[1 q] and ?25l")).toBe("[1 q] and ?25l");
  });

  it("normalizes CRLF to LF", () => {
    expect(sanitize("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("strips bare CR", () => {
    expect(sanitize("a\rb")).toBe("a\nb");
  });

  it("strips control characters but preserves newlines and tabs", () => {
    expect(sanitize("a\x00b\tc\nd")).toBe("ab\tc\nd");
  });

  it("passes clean text unchanged", () => {
    expect(sanitize("hello world")).toBe("hello world");
  });

  // ECMA-48 parameter bytes are 0x30-0x3f (`:` included): colon-form SGR is what
  // modern terminals emit, and it used to survive as literal text.
  it("strips colon-form SGR parameters", () => {
    expect(sanitize("\x1b[38:2::255:0:0mred")).toBe("red");
    expect(sanitize("\x1b[4:3m")).toBe("");
    expect(sanitize("a\x1b[38:5:196mB\x1b[0m")).toBe("aB");
  });

  it("strips 8-bit C1 CSI introducers", () => {
    expect(sanitize("\x9b1;31mred")).toBe("red");
  });

  it("strips DCS/APC/PM/SOS string sequences", () => {
    expect(sanitize("\x1bP1;2|payload\x1b\\tail")).toBe("tail");
    expect(sanitize("\x1b_graphics;payload\x1b\\tail")).toBe("tail");
    expect(sanitize("\x1b^private\x1b\\ok")).toBe("ok");
    expect(sanitize("\x1bXignored\x1b\\ok")).toBe("ok");
    expect(sanitize("\x1bPpayload\x07x")).toBe("x");
  });

  it("strips C1 OSC introducers and their ST terminator", () => {
    expect(sanitize("\x1b]0;title\x9cbody")).toBe("body");
  });

  it("keeps the introducer text when a string sequence is unterminated", () => {
    expect(sanitize("\x1bPpayload\nnext line")).toBe("Ppayload\nnext line");
  });
});
