import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';
import chalk from 'chalk';
import { SKILLS_DIR } from '../config';
import { debug } from '../utils';
import { PatchResult, PatchGroup } from './index';

/**
 * A built-in skill customization, parsed from a `<name>.md` file in
 * ~/.tweakcc/skills/. The file format mirrors system-prompts/<id>.md: an
 * HTML-comment YAML frontmatter block followed by an optional body.
 *
 * Frontmatter:
 *   disabled: true   neuter the skill's registration call so it never enters
 *                    the global skill table (no /skills entry, no system
 *                    reminder line, no /context metadata budget).
 *
 * The body is reserved for a future per-skill prompt override (body swap on
 * the skill's invocation text) and is currently ignored.
 */
export interface SkillCustomization {
  name: string;
  disabled: boolean;
  body: string;
}

/**
 * Result of applying skill customizations.
 */
export interface SkillsResult {
  newContent: string;
  results: PatchResult[];
}

/**
 * Parses a single skill markdown file (HTML-comment frontmatter + body).
 */
const parseSkillMarkdown = (
  markdown: string
): { disabled: boolean; body: string } => {
  const parsed = matter(markdown, {
    delimiters: ['<!--', '-->'],
  });
  return {
    // Only the literal boolean true disables; absent/falsy/string => enabled.
    disabled: parsed.data?.disabled === true,
    body: parsed.content ?? '',
  };
};

/**
 * Loads skill customizations from ~/.tweakcc/skills/<name>.md.
 *
 * @param skillFilter - If provided, only skills whose name is in this list are
 *   loaded (mirrors --patches semantics for system prompts). null/undefined
 *   loads every <name>.md present in the directory.
 * @returns the parsed skill customizations (empty array if the directory does
 *   not exist).
 */
export const loadSkills = async (
  skillFilter?: string[] | null
): Promise<SkillCustomization[]> => {
  let entries: string[];
  try {
    entries = await fs.readdir(SKILLS_DIR);
  } catch {
    // No skills directory => nothing to do.
    return [];
  }

  const skills: SkillCustomization[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -'.md'.length);
    if (skillFilter && !skillFilter.includes(name)) continue;
    let markdown: string;
    try {
      markdown = await fs.readFile(path.join(SKILLS_DIR, entry), 'utf8');
    } catch (error) {
      console.error(`Failed to read skill file ${entry}:`, error);
      continue;
    }
    const { disabled, body } = parseSkillMarkdown(markdown);
    skills.push({ name, disabled, body });
  }
  return skills;
};

/**
 * Escapes regex metacharacters in a literal string.
 */
const escapeRegExpLiteral = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Applies skill customizations to cli.js content.
 *
 * For `disabled: true` skills: locate the skill's registration factory call
 * `<factory>({name:"<skill>",...})` and rewrite the leading factory identifier
 * to `void`, turning it into `void({name:"<skill>",...})`. The argument object
 * literal is still constructed (so any bundler-captured closure references stay
 * live) but the registration helper is never invoked. `void` is exactly 4
 * characters, and `<factory>(` is reused as `void(`'s parenthesis, so paren
 * balance is preserved.
 *
 * The factory identifier is bundler-renamed on every CC bump (e.g. `Gf` in
 * 2.1.136), so the locator anchors on the stable `name:"<skill>"` API contract
 * rather than the factory name: `[A-Za-z_$][A-Za-z0-9_$]{0,3}\(\{name:"<skill>",`,
 * with a negative lookbehind so it never picks up a `.method(...)` call or the
 * tail of a longer identifier.
 *
 * For `disabled: false` (or unset) skills with a body, a per-skill prompt
 * override (body swap) is not yet implemented and reported as skipped.
 *
 * @param content - The current cli.js content.
 * @param skills - The skill customizations to apply.
 * @returns SkillsResult with modified content and per-skill results.
 */
export const applySkills = (
  content: string,
  skills: SkillCustomization[]
): SkillsResult => {
  const results: PatchResult[] = [];

  for (const skill of skills) {
    if (!skill.disabled) {
      results.push({
        id: skill.name,
        name: skill.name,
        group: PatchGroup.SKILLS,
        applied: false,
        skipped: true,
        details: skill.body.trim()
          ? 'enabled (per-skill body override not yet supported)'
          : 'enabled',
      });
      continue;
    }

    debug(`Disabling built-in skill: ${skill.name}`);
    const locator = new RegExp(
      `(?<![\\w$.])([A-Za-z_$][A-Za-z0-9_$]{0,3})\\(\\{name:"${escapeRegExpLiteral(skill.name)}",`,
      'g'
    );
    const first = locator.exec(content);
    locator.lastIndex = 0;

    if (!first) {
      console.log(
        chalk.yellow(
          `Could not find registration call for built-in skill "${skill.name}" in cli.js`
        )
      );
      results.push({
        id: skill.name,
        name: skill.name,
        group: PatchGroup.SKILLS,
        applied: false,
        failed: true,
        details:
          'registration call not found — re-tune the skill-neuter locator for this CC version',
      });
      continue;
    }

    const factoryName = first[1];
    const replacement = `void({name:"${skill.name}",`;
    const before = content;
    content = content.replace(locator, () => replacement);
    const applied = before !== content;

    if (!applied) {
      results.push({
        id: skill.name,
        name: skill.name,
        group: PatchGroup.SKILLS,
        applied: false,
        failed: true,
        details: 'registration call located but rewrite produced no change',
      });
      continue;
    }

    debug(`Neutered ${factoryName}({name:"${skill.name}",...}) registration`);
    results.push({
      id: skill.name,
      name: skill.name,
      group: PatchGroup.SKILLS,
      applied: true,
      details: chalk.green(
        `disabled (neutered ${factoryName}(...) registration)`
      ),
    });
  }

  return { newContent: content, results };
};
