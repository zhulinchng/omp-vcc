// @ts-nocheck
/** Shared skill-tag collapse utilities */

const SKILL_TAG_RE = /^-?\s*<skill\s+name="([^"]+)"/;
const SKILL_CLOSE_RE = /^-?\s*<\/skill>/;

/** Collapse skill tags in an array of lines — dedup by name, drop all content inside block */
export const collapseSkillLines = (lines: string[]): string[] => {
  const result: string[] = [];
  const seenSkills = new Set<string>();
  let insideSkill = false;

  for (const line of lines) {
    const skillMatch = line.match(SKILL_TAG_RE);
    if (skillMatch) {
      insideSkill = true;
      const name = skillMatch[1];
      if (!seenSkills.has(name)) {
        seenSkills.add(name);
        result.push(`[skill: ${name}]`);
      }
      continue;
    }
    if (insideSkill) {
      if (SKILL_CLOSE_RE.test(line)) insideSkill = false;
      continue;
    }
    result.push(line);
  }
  return result;
};

/** Collapse <skill name="X" ...>...</skill> blocks in raw text.
 *  The `$` alternative means an UNTERMINATED opening tag consumes everything to
 *  the end of the input. That is right for a whole injected block (brief.ts),
 *  but wrong per line — see `collapseSkillTagsInLine`. */
const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?(?:<\/skill>|$)/g;
export const collapseSkillText = (text: string): string =>
  text.replace(SKILL_BLOCK_RE, (_, name) => `[skill: ${name}]`);

/** A CLOSED block anywhere in a line: collapse the tag and its body. */
const LINE_SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g;
/** Any remaining bare tag: collapse it alone and keep the surrounding text. */
const LINE_SKILL_TAG_RE = /<\/?skill(?:\s+name="([^"]+)")?[^>]*>/g;

/**
 * Line-scoped counterpart of `collapseSkillText`, for the writers that collapse
 * a single user line. An unterminated `<skill name=...>` must NOT consume the
 * rest of the line: the tail after the tag is usually the actual instruction
 * (`always run the <skill name="lint"> checks before committing`), and
 * `collapseSkillText` would silently delete it. A closed block still drops its
 * body, which is the injected-context shape.
 */
export const collapseSkillTagsInLine = (line: string): string =>
  line
    .replace(LINE_SKILL_BLOCK_RE, (_, name) => `[skill: ${name}]`)
    .replace(LINE_SKILL_TAG_RE, (_, name) => (name ? `[skill: ${name}]` : ""));
