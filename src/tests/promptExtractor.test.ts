import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const extractorPath = path.resolve(here, '../../tools/promptExtractor.js');
const localRequire = createRequire(import.meta.url);

const extractStrings = localRequire(extractorPath) as (
  filepath: string,
  minLength?: number
) => {
  prompts: Array<{
    pieces: string[];
    identifiers: number[];
    identifierMap: Record<string, string>;
  }>;
};

let fixtureDir: string;

const fixture = (name: string, source: string): string => {
  const p = path.join(fixtureDir, name);
  fs.writeFileSync(p, source);
  return p;
};

const joinedPieces = (prompts: ReturnType<typeof extractStrings>['prompts']) =>
  prompts.map(p => p.pieces.join(''));

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptExtractor-'));
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe('promptExtractor — structural floor captures', () => {
  it('captures `You are …` identity statements assigned to a hoisted var (R1b)', () => {
    const p = fixture(
      'identity.js',
      `var E$6 = "You are Claude Code, Anthropic's official CLI for Claude.";`
    );
    const out = joinedPieces(extractStrings(p).prompts);
    expect(out).toContain(
      "You are Claude Code, Anthropic's official CLI for Claude."
    );
  });

  it('captures `# Heading`-shaped array elements at HARD_FLOOR=12 (R1c)', () => {
    const p = fixture(
      'heading-in-array.js',
      `function PR5() {
         var H = [null, "Your responses should be short and concise.", "Always respond in English."].filter(Boolean);
         return ["# Tone and style", ...HB(H)].join("\\n");
       }`
    );
    const out = joinedPieces(extractStrings(p).prompts);
    expect(out).toContain('# Tone and style');
  });

  it('captures 50-119 char array bullets when they pass the signal filter (R1c)', () => {
    const p = fixture(
      'short-bullets.js',
      `function PR5() {
         var H = [
           "Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.",
           "Your responses should be short and concise."
         ].filter(Boolean);
         return ["# Tone and style", ...HB(H)].join("\\n");
       }`
    );
    const out = joinedPieces(extractStrings(p).prompts);
    expect(out).toContain(
      'Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.'
    );
  });

  it('captures short array-bullet template literals with interpolations (R1c)', () => {
    const p = fixture(
      'prefer-dedicated.js',
      `function jR5(BASH, TOOLS) {
         var z = [
           \`Prefer dedicated tools over \${BASH} when one fits (\${TOOLS}) — reserve \${BASH} for shell-only operations.\`,
           \`Use \${TASK} to plan and track work. Mark each task completed as soon as it's done; don't batch.\`,
           "You can call multiple tools in a single response."
         ].filter(Boolean);
         return ["# Using your tools", ...HB(z)].join("\\n");
       }`
    );
    const out = joinedPieces(extractStrings(p).prompts);
    expect(out.some(s => s.startsWith('Prefer dedicated tools over '))).toBe(
      true
    );
    expect(
      out.some(
        s => s.startsWith('Use ') && s.includes('Mark each task completed')
      )
    ).toBe(true);
    expect(out).toContain('# Using your tools');
  });

  it('captures `# Environment`-style short headings even with low space ratio', () => {
    const p = fixture(
      'env-header.js',
      `function envR5(bullets) {
         return ["# Environment", "You have been invoked in the following environment: ", ...HB(bullets)].join("\\n");
       }`
    );
    const out = joinedPieces(extractStrings(p).prompts);
    expect(out).toContain('# Environment');
  });

  it('does not capture short identity-style strings below the 30-char identity floor', () => {
    const p = fixture('short-identity.js', `var X = "You are here.";`);
    const out = joinedPieces(extractStrings(p).prompts);
    expect(out).not.toContain('You are here.');
  });

  it('does not capture obvious code-shaped short strings (looksLikeCode)', () => {
    const p = fixture(
      'codey.js',
      `function noisy() {
         var arr = ["return foo(); return bar();", "function inner() { return 1; }"];
         return ["# Heading", ...arr].join("\\n");
       }`
    );
    const out = joinedPieces(extractStrings(p).prompts);
    expect(out).not.toContain('return foo(); return bar();');
    expect(out).not.toContain('function inner() { return 1; }');
  });

  it('emits stable auto-id slugs for the new captures (slug derived from first 8 words)', () => {
    const p = fixture(
      'slug.js',
      `var E$6 = "You are Claude Code, Anthropic's official CLI for Claude.";`
    );
    const merged = execFileSync(
      process.execPath,
      [extractorPath, p, path.join(fixtureDir, 'slug.json')],
      { encoding: 'utf-8' }
    );
    expect(merged).toMatch(/Extracted/);
    const out = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, 'slug.json'), 'utf-8')
    );
    const ids = out.prompts.map((p: { id: string }) => p.id);
    expect(ids).toContain('you-are-claude-code-anthropics-official-cli-for');
  });
});

describe('promptExtractor — mergeWithExisting', () => {
  it('preserves canonical id across cooked-vs-raw Unicode-escape drift', () => {
    const p = fixture(
      'drift.js',
      'var X = `# Managed Agents \\u2014 Python\\nlong content here that exceeds the structural strong floor with sentences.`;'
    );
    const baselinePath = path.join(fixtureDir, 'drift.json');
    fs.writeFileSync(
      baselinePath,
      JSON.stringify({
        version: '2.0.0',
        prompts: [
          {
            name: 'Data: Managed Agents — Python',
            id: 'data-managed-agents-reference-python',
            description: 'desc',
            pieces: [
              '# Managed Agents — Python\nlong content here that exceeds the structural strong floor with sentences.',
            ],
            identifiers: [],
            identifierMap: {},
            version: '2.0.0',
          },
        ],
      })
    );
    execFileSync(process.execPath, [extractorPath, p, baselinePath], {
      encoding: 'utf-8',
    });
    const merged = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    const matched = merged.prompts.find(
      (q: { id: string }) => q.id === 'data-managed-agents-reference-python'
    );
    expect(matched).toBeDefined();
    expect(matched.name).toBe('Data: Managed Agents — Python');
  });
});
