import { describe, it, expect } from 'vitest';
import { applyAgents, AgentCustomization } from './agents';
import { PatchGroup } from './index';

const agent = (
  name: string,
  disabled: boolean,
  body = ''
): AgentCustomization => ({ name, disabled, body });

// A minimal stand-in for CC's built-in-agents builder (the `bUH` function in
// 2.1.136): the env-var-name head, an array literal, a couple of `.push(...)`d
// members, and a `return <arr>}` tail.
const builder = (arrVar = 'H'): string =>
  `function bUH(){if(EH(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS)&&E6())return[];let ${arrVar}=[vs,caK];if(BY$())${arrVar}.push(Vs,ne$);if(process.env.CLAUDE_CODE_ENTRYPOINT!=="sdk-ts")${arrVar}.push(QaK);return ${arrVar}}`;

describe('applyAgents', () => {
  it('filters disabled agents out of the built-in active-set builder', () => {
    const content = `x;${builder()};y`;
    const { newContent, results } = applyAgents(content, [
      agent('claude-code-guide', true),
      agent('statusline-setup', true),
    ]);
    expect(newContent).toBe(
      `x;function bUH(){if(EH(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS)&&E6())return[];let H=[vs,caK];if(BY$())H.push(Vs,ne$);if(process.env.CLAUDE_CODE_ENTRYPOINT!=="sdk-ts")H.push(QaK);return H.filter(_TW_a=>!["claude-code-guide","statusline-setup"].includes(_TW_a.agentType))};y`
    );
    expect(results).toHaveLength(2);
    expect(results.every(r => r.applied && r.group === PatchGroup.AGENTS)).toBe(
      true
    );
    expect(results.map(r => r.id).sort()).toEqual([
      'claude-code-guide',
      'statusline-setup',
    ]);
  });

  it('handles a single disabled agent', () => {
    const { newContent, results } = applyAgents(builder(), [
      agent('claude-code-guide', true),
    ]);
    expect(newContent).toContain(
      'return H.filter(_TW_a=>!["claude-code-guide"].includes(_TW_a.agentType))}'
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'claude-code-guide',
      group: PatchGroup.AGENTS,
      applied: true,
    });
  });

  it('preserves disable-list (glob) order', () => {
    const { newContent } = applyAgents(builder(), [
      agent('statusline-setup', true),
      agent('claude-code-guide', true),
    ]);
    expect(newContent).toContain(
      'return H.filter(_TW_a=>!["statusline-setup","claude-code-guide"].includes(_TW_a.agentType))}'
    );
  });

  it('captures a bundler-renamed array variable', () => {
    const { newContent } = applyAgents(builder('q$1'), [
      agent('statusline-setup', true),
    ]);
    expect(newContent).toContain(
      'return q$1.filter(_TW_a=>!["statusline-setup"].includes(_TW_a.agentType))}'
    );
  });

  it('skips an enabled agent (passthrough)', () => {
    const content = builder();
    const { newContent, results } = applyAgents(content, [
      agent('Explore', false),
    ]);
    expect(newContent).toBe(content);
    expect(results[0]).toMatchObject({
      id: 'Explore',
      group: PatchGroup.AGENTS,
      applied: false,
      skipped: true,
      details: 'enabled',
    });
  });

  it('flags an enabled agent that carries an unsupported body override', () => {
    const { results } = applyAgents(builder(), [
      agent('Plan', false, 'a custom agent prompt body'),
    ]);
    expect(results[0]).toMatchObject({ applied: false, skipped: true });
    expect(results[0].details).toMatch(/not yet supported/);
  });

  it('mixes enabled passthrough with a disabled rewrite', () => {
    const { newContent, results } = applyAgents(builder(), [
      agent('general-purpose', false),
      agent('claude-code-guide', true),
    ]);
    expect(newContent).toContain(
      'return H.filter(_TW_a=>!["claude-code-guide"].includes(_TW_a.agentType))}'
    );
    expect(results).toHaveLength(2);
    const byId = Object.fromEntries(results.map(r => [r.id, r]));
    expect(byId['general-purpose']).toMatchObject({
      skipped: true,
      applied: false,
    });
    expect(byId['claude-code-guide']).toMatchObject({ applied: true });
  });

  it('reports failed when the builder is absent', () => {
    const content = 'function foo(){return 42}';
    const { newContent, results } = applyAgents(content, [
      agent('claude-code-guide', true),
    ]);
    expect(newContent).toBe(content);
    expect(results[0]).toMatchObject({
      id: 'claude-code-guide',
      group: PatchGroup.AGENTS,
      applied: false,
      failed: true,
    });
  });

  it('reports failed when the trailing return uses a different variable', () => {
    // The locator requires the `return <v>}` tail to use the same variable
    // captured from `let <v>=[`; a mismatch must fail loud, not mis-patch.
    const content =
      'function bUH(){if(EH(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS)&&E6())return[];let H=[vs];return G}';
    const { newContent, results } = applyAgents(content, [
      agent('claude-code-guide', true),
    ]);
    expect(newContent).toBe(content);
    expect(results[0]).toMatchObject({ applied: false, failed: true });
  });

  it('does not interpret `$` in an agent name as a replacement pattern', () => {
    const { newContent } = applyAgents(builder(), [
      agent('we$rd-$&-name', true),
    ]);
    expect(newContent).toContain(
      'return H.filter(_TW_a=>!["we$rd-$&-name"].includes(_TW_a.agentType))}'
    );
  });

  it('returns content unchanged with no agents', () => {
    const content = builder();
    const { newContent, results } = applyAgents(content, []);
    expect(newContent).toBe(content);
    expect(results).toHaveLength(0);
  });

  it('returns content unchanged when all agents are enabled', () => {
    const content = builder();
    const { newContent, results } = applyAgents(content, [
      agent('Explore', false),
      agent('Plan', false),
    ]);
    expect(newContent).toBe(content);
    expect(results.every(r => r.skipped)).toBe(true);
  });
});
