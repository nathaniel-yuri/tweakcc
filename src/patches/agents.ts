import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';
import chalk from 'chalk';
import { AGENTS_DIR } from '../config';
import { debug } from '../utils';
import { PatchResult, PatchGroup } from './index';

/**
 * A built-in agent customization, parsed from a `<agentType>.md` file in
 * ~/.tweakcc/agents/. The file format mirrors skills/<name>.md: an HTML-comment
 * YAML frontmatter block followed by an optional body.
 *
 * Frontmatter:
 *   disabled: true   drop this agent from the built-in active set so it never
 *                    enters /agents, the Agent-tool subagent_type list, or the
 *                    per-agent metadata budget visible in /context.
 *
 * The basename is the runtime `agentType` ("claude-code-guide",
 * "statusline-setup", "Explore", "Plan", "general-purpose", …) — distinct from
 * system-prompts/agent-prompt-*.md, which body-swap an agent's *invoked* system
 * prompt rather than removing its registration. Same relationship as
 * skills/<name>.md vs system-prompts/skill-*.md.
 *
 * The body is reserved for a future per-agent system-prompt override and is
 * currently ignored.
 */
export interface AgentCustomization {
  name: string;
  disabled: boolean;
  body: string;
}

/**
 * Result of applying agent customizations.
 */
export interface AgentsResult {
  newContent: string;
  results: PatchResult[];
}

/**
 * Parses a single agent markdown file (HTML-comment frontmatter + body).
 */
const parseAgentMarkdown = (
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
 * Loads agent customizations from ~/.tweakcc/agents/<agentType>.md.
 *
 * @param agentFilter - If provided, only agents whose name is in this list are
 *   loaded (mirrors --skills / --patches semantics). null/undefined loads every
 *   <agentType>.md present in the directory.
 * @returns the parsed agent customizations (empty array if the directory does
 *   not exist).
 */
export const loadAgents = async (
  agentFilter?: string[] | null
): Promise<AgentCustomization[]> => {
  let entries: string[];
  try {
    entries = await fs.readdir(AGENTS_DIR);
  } catch {
    // No agents directory => nothing to do.
    return [];
  }

  const agents: AgentCustomization[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -'.md'.length);
    if (agentFilter && !agentFilter.includes(name)) continue;
    let markdown: string;
    try {
      markdown = await fs.readFile(path.join(AGENTS_DIR, entry), 'utf8');
    } catch (error) {
      console.error(`Failed to read agent file ${entry}:`, error);
      continue;
    }
    const { disabled, body } = parseAgentMarkdown(markdown);
    agents.push({ name, disabled, body });
  }
  return agents;
};

/**
 * Escapes regex metacharacters in a literal string.
 */
const escapeRegExpLiteral = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Applies agent customizations to cli.js content.
 *
 * For `disabled: true` agents: rewrite CC's built-in-agents active-set builder
 * (the function that opens with `if(...CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS...)`
 * — named `bUH` in 2.1.136) so its trailing `return <arr>}` becomes
 * `return <arr>.filter(_TW_a=>!["<name>",…].includes(_TW_a.agentType))}`. That
 * removes the named agents from the array regardless of how each was added
 * (array-literal `[vs,caK]` member or `.push(...)`'d member), so they vanish
 * from `activeAgents` / `allAgents` everywhere downstream — no /agents entry,
 * no Agent-tool subagent_type listing, no per-agent metadata budget.
 *
 * The locator anchors on the string literal `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`
 * (never minifier-renamed — it's an env-var name) at the head of the builder,
 * captures the array variable from `let <v>=[`, and requires the trailing
 * `return <v>}` to use that same variable. The `_TW_a` arrow parameter — an
 * identifier the minifier would never emit — makes a downstream build-time
 * verification grep unambiguous.
 *
 * A user-config `~/.claude/agents/<name>.md` (source `userSettings`) overrides a
 * same-`agentType` built-in but cannot remove one, so this binary rewrite is the
 * only way to drop a built-in agent from the active set.
 *
 * For `disabled: false` (or unset) agents with a body, a per-agent prompt
 * override (body swap) is not yet implemented and reported as skipped.
 *
 * @param content - The current cli.js content.
 * @param agents - The agent customizations to apply.
 * @returns AgentsResult with modified content and per-agent results.
 */
export const applyAgents = (
  content: string,
  agents: AgentCustomization[]
): AgentsResult => {
  const results: PatchResult[] = [];

  // Enabled agents (and agents carrying an unsupported body) — passthrough.
  for (const agent of agents) {
    if (agent.disabled) continue;
    results.push({
      id: agent.name,
      name: agent.name,
      group: PatchGroup.AGENTS,
      applied: false,
      skipped: true,
      details: agent.body.trim()
        ? 'enabled (per-agent body override not yet supported)'
        : 'enabled',
    });
  }

  const disabledNames = agents.filter(a => a.disabled).map(a => a.name);
  if (disabledNames.length === 0) {
    return { newContent: content, results };
  }

  debug(`Disabling built-in agents: ${disabledNames.join(', ')}`);

  const failAll = (detail: string): AgentsResult => {
    for (const name of disabledNames) {
      results.push({
        id: name,
        name,
        group: PatchGroup.AGENTS,
        applied: false,
        failed: true,
        details: detail,
      });
    }
    return { newContent: content, results };
  };

  // Locate CC's built-in-agents active-set builder by its env-var-name head,
  // capture the array variable, and require a matching `return <v>}` tail.
  const locator =
    /CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS[\s\S]{0,80}return\[\];let ([\w$]+)=\[[\s\S]*?return \1\}/;
  const m = locator.exec(content);

  if (!m) {
    console.log(
      chalk.yellow(
        "Could not find CC's built-in-agents builder in cli.js — re-tune the locator in src/patches/agents.ts"
      )
    );
    return failAll(
      'built-in-agents builder not found — re-tune the agent locator for this CC version'
    );
  }

  const arrVar = m[1];
  const filterExpr = `${arrVar}.filter(_TW_a=>!${JSON.stringify(disabledNames)}.includes(_TW_a.agentType))`;
  const tailRe = new RegExp(`return ${escapeRegExpLiteral(arrVar)}\\}$`);
  // Function replacer: agent names flow into JSON.stringify, so a name with `$`
  // must not be reinterpreted as a `$&`/`$1`/`$$` replacement pattern.
  const rewrittenSpan = m[0].replace(tailRe, () => `return ${filterExpr}}`);

  if (rewrittenSpan === m[0]) {
    return failAll(
      'built-in-agents builder located but rewrite produced no change'
    );
  }

  const before = content;
  content =
    content.slice(0, m.index) +
    rewrittenSpan +
    content.slice(m.index + m[0].length);

  if (before === content) {
    return failAll('rewrite produced no change');
  }

  for (const name of disabledNames) {
    results.push({
      id: name,
      name,
      group: PatchGroup.AGENTS,
      applied: true,
      details: chalk.green('disabled (filtered from the built-in active set)'),
    });
  }

  debug(
    `Filtered ${disabledNames.length} agent(s) from ${arrVar} (bUH-style builder)`
  );
  return { newContent: content, results };
};
