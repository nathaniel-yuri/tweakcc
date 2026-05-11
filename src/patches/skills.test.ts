import { describe, it, expect } from 'vitest';
import { applySkills, SkillCustomization } from './skills';
import { PatchGroup } from './index';

const skill = (
  name: string,
  disabled: boolean,
  body = ''
): SkillCustomization => ({ name, disabled, body });

describe('applySkills', () => {
  it('neuters a disabled skill registration factory call', () => {
    const content =
      'function Bg4(){Gf({name:"simplify",userInvocable:!0,description:"x"})}';
    const { newContent, results } = applySkills(content, [
      skill('simplify', true),
    ]);
    expect(newContent).toBe(
      'function Bg4(){void({name:"simplify",userInvocable:!0,description:"x"})}'
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'simplify',
      name: 'simplify',
      group: PatchGroup.SKILLS,
      applied: true,
    });
  });

  it('matches a one-character bundler-renamed factory', () => {
    const content = 'sd4(),f({name:"update-config",userInvocable:!0})';
    const { newContent } = applySkills(content, [skill('update-config', true)]);
    expect(newContent).toBe(
      'sd4(),void({name:"update-config",userInvocable:!0})'
    );
  });

  it('matches a four-character bundler-renamed factory', () => {
    const content = ';q1Az({name:"keybindings-help",userInvocable:!1})';
    const { newContent } = applySkills(content, [
      skill('keybindings-help', true),
    ]);
    expect(newContent).toBe(
      ';void({name:"keybindings-help",userInvocable:!1})'
    );
  });

  it('handles hyphenated skill names without regex misinterpretation', () => {
    const content = 'Gf({name:"fewer-permission-prompts",userInvocable:!0})';
    const { newContent } = applySkills(content, [
      skill('fewer-permission-prompts', true),
    ]);
    expect(newContent).toBe(
      'void({name:"fewer-permission-prompts",userInvocable:!0})'
    );
  });

  it('does not neuter a `.method({name:...})` call (negative lookbehind)', () => {
    const content = 'registry.Gf({name:"simplify",userInvocable:!0})';
    const { newContent, results } = applySkills(content, [
      skill('simplify', true),
    ]);
    expect(newContent).toBe(content);
    expect(results[0]).toMatchObject({ applied: false, failed: true });
  });

  it('does not match a factory name longer than four chars', () => {
    // The locator caps the identifier at 4 chars (Bun's minified names sit in
    // the 1-3 char range); a longer name fails loud rather than mis-patching a
    // shorter substring of it.
    const content = 'x;prefixGf({name:"simplify",x:1})';
    const { newContent, results } = applySkills(content, [
      skill('simplify', true),
    ]);
    expect(newContent).toBe(content);
    expect(results[0]).toMatchObject({ applied: false, failed: true });
  });

  it('reports failed when the registration call is absent', () => {
    const content = 'function foo(){return 42}';
    const { newContent, results } = applySkills(content, [
      skill('simplify', true),
    ]);
    expect(newContent).toBe(content);
    expect(results[0]).toMatchObject({
      id: 'simplify',
      group: PatchGroup.SKILLS,
      applied: false,
      failed: true,
    });
  });

  it('skips an enabled skill', () => {
    const content = 'Gf({name:"simplify",userInvocable:!0})';
    const { newContent, results } = applySkills(content, [
      skill('simplify', false),
    ]);
    expect(newContent).toBe(content);
    expect(results[0]).toMatchObject({
      applied: false,
      skipped: true,
      details: 'enabled',
    });
  });

  it('flags an enabled skill that carries an unsupported body override', () => {
    const content = 'Gf({name:"simplify",userInvocable:!0})';
    const { results } = applySkills(content, [
      skill('simplify', false, 'a custom skill prompt body'),
    ]);
    expect(results[0]).toMatchObject({ applied: false, skipped: true });
    expect(results[0].details).toMatch(/not yet supported/);
  });

  it('applies multiple disabled skills in one pass', () => {
    const content =
      'Gf({name:"simplify",a:1});Hf({name:"update-config",b:2});Jf({name:"keybindings-help",c:3})';
    const { newContent, results } = applySkills(content, [
      skill('simplify', true),
      skill('update-config', true),
      skill('keybindings-help', true),
    ]);
    expect(newContent).toBe(
      'void({name:"simplify",a:1});void({name:"update-config",b:2});void({name:"keybindings-help",c:3})'
    );
    expect(results.every(r => r.applied)).toBe(true);
  });

  it('does not interpret `$` in the replacement string', () => {
    // Bun-minified skill object literals can contain `$&`-looking byte runs
    // after the comma; the replacer is a function, so `$&`/`$1` aren't
    // expanded into the result.
    const content = 'Gf({name:"simplify",x:"$&$1$$"})';
    const { newContent } = applySkills(content, [skill('simplify', true)]);
    expect(newContent).toBe('void({name:"simplify",x:"$&$1$$"})');
  });
});
