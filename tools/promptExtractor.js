#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const parser = require('@babel/parser');

// Floors for the structured (short) path. Tuned so the legacy >=500 path's
// behaviour is unchanged and the new path catches array-bullet / return-arg /
// heading-var prompt prose without an avalanche of minified-code noise.
const HARD_FLOOR = 12;            // absolute minimum any prompt prose plausibly has.
const STRUCT_FLOOR_STRONG = 40;   // R1 / R1b heading: result of a function (return/concise-arrow) or `var X = "# …"` literal.
const STRUCT_FLOOR_WEAK = 120;    // R1c: element of an array literal that looks prompt-ish.
const VAR_INIT_FLOOR = 250;       // R1b fallback: non-heading `var X = "…"` long enough to be a prompt.

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Cheap noise filter applied only on the structured (short) path. Never on
// the legacy >=500 path — real prompts like the hooks-configuration README
// are JSON-heavy and would false-positive on `{}();=<>` density. Cost of a
// false-positive here is a missed prompt (not a wrong baseline); add the
// exception to the explicit include list in validateInput if needed.
function looksLikeCode(s) {
  if (/=>|\bfunction\s*\(|\bconst |\blet |\bvar |\breturn /.test(s)) return true;
  const punctRatio = ((s.match(/[{}();=<>]/g) || []).length) / s.length;
  return punctRatio > 0.08;
}

// Walk up past `cond ? x : y` / `a && b` / `(a, b)` wrappers — none of which
// change where the value structurally lands. Returns the first non-transparent
// ancestor frame `{node, key, index}`, or null at the AST root.
function climbTransparent(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.node.type === 'ConditionalExpression' && (a.key === 'consequent' || a.key === 'alternate')) continue;
    if (a.node.type === 'LogicalExpression' && (a.key === 'left' || a.key === 'right')) continue;
    if (
      a.node.type === 'SequenceExpression' &&
      a.key === 'expressions' &&
      a.index === a.node.expressions.length - 1
    ) continue;
    return a;
  }
  return null;
}

// True if `arr` (an ArrayExpression) looks like a prompt-content array vs an
// arbitrary config array. Catches bullet lists fed to `bm()` / `join("\n")` /
// spreads / etc.
function looksLikePromptArray(arr, ancestors) {
  // Length of an element that might be a prompt bullet — uses node source
  // span for TemplateLiteral (close enough; the actual cooked length differs
  // only by the `${id}` → `id-value` swap which is rarely material here).
  const elementLen = n =>
    n.type === 'StringLiteral' ? n.value.length :
    n.type === 'TemplateLiteral' ? (n.end - n.start) : 0;

  const elementHeading = n => {
    if (n.type === 'StringLiteral') return /^#{1,6}\s/.test(n.value);
    if (n.type === 'TemplateLiteral' && n.quasis.length > 0) {
      return /^#{1,6}\s/.test(n.quasis[0].value.cooked || n.quasis[0].value.raw || '');
    }
    return false;
  };

  let longCount = 0;
  let hasHeading = false;
  for (const el of arr.elements) {
    if (!el) continue;
    // Unwrap `cond ? bullet : null` / `a && bullet` / `(side, bullet)` so a
    // conditionally-gated bullet still counts toward the heuristic.
    let val = el;
    while (val) {
      if (val.type === 'StringLiteral' || val.type === 'TemplateLiteral') break;
      if (val.type === 'ConditionalExpression') {
        const cT = val.consequent.type, aT = val.alternate.type;
        if (cT === 'StringLiteral' || cT === 'TemplateLiteral') { val = val.consequent; break; }
        if (aT === 'StringLiteral' || aT === 'TemplateLiteral') { val = val.alternate;  break; }
        val = null; break;
      }
      if (val.type === 'LogicalExpression') {
        const lT = val.left.type, rT = val.right.type;
        if (lT === 'StringLiteral' || lT === 'TemplateLiteral') { val = val.left;  break; }
        if (rT === 'StringLiteral' || rT === 'TemplateLiteral') { val = val.right; break; }
        val = null; break;
      }
      val = null; break;
    }
    if (!val) continue;
    if (elementLen(val) >= STRUCT_FLOOR_WEAK) longCount++;
    if (elementHeading(val)) hasHeading = true;
  }
  if (hasHeading || longCount >= 2) return true;

  // The array is consumed as a list (spread, .join/.flatMap/.map/.filter, or
  // any call argument). Climb past transparent wrappers — `(cond?[bullet]:[])`
  // / `(a && [bullet])` / `(side, [bullet])` — so we recognise the consumer.
  // Together with the bullet check above, this is a necessary-not-sufficient
  // gate — without it we'd catch e.g. tuple-style `[code, message]` arrays.
  const consumer = climbTransparent(ancestors);
  if (!consumer) return false;
  if (consumer.node.type === 'SpreadElement' && consumer.key === 'argument') return true;
  if (consumer.node.type === 'MemberExpression' && consumer.key === 'object') return true;
  if (consumer.node.type === 'CallExpression' && consumer.key === 'arguments') return true;
  return false;
}

// Decide whether `value` (a StringLiteral.value or a TemplateLiteral's
// fullContent) sits in a structurally-recognised "prompt slot", and if so
// what floor + signal requirement applies.
function classifyStructural(value, ancestors) {
  const top = climbTransparent(ancestors);
  if (!top) return { structured: false };
  const { node, key } = top;

  // R1 — value flows to a function's result: `return …` or concise-arrow body.
  if (node.type === 'ReturnStatement' && key === 'argument') {
    return { structured: true, floor: STRUCT_FLOOR_STRONG, requireSignal: false };
  }
  if (node.type === 'ArrowFunctionExpression' && key === 'body') {
    return { structured: true, floor: STRUCT_FLOOR_STRONG, requireSignal: false };
  }

  // R1b — `var X = "…"` / `var X = \`…\``. Heading-shaped strings (so e.g.
  // hN5 / SN5 / RN5 section-headers) get the strong floor; long non-heading
  // var-inits still get in but only at VAR_INIT_FLOOR; short non-heading
  // var-inits stay out (E$6 = "You are Claude Code, …" is the canonical
  // miss, listed as a residual gap).
  if (node.type === 'VariableDeclarator' && key === 'init') {
    if (/^#{1,6}\s/.test(value)) return { structured: true, floor: STRUCT_FLOOR_STRONG, requireSignal: false };
    if (value.length >= VAR_INIT_FLOOR) return { structured: true, floor: VAR_INIT_FLOOR, requireSignal: true };
    return { structured: false };
  }

  // R1c — element of a prompt-ish array literal. climbTransparent collapses
  // `cond ? bullet : null` / `a && bullet` / `(side, bullet)` wrappers so
  // conditionally-gated bullets (most of # Session-specific guidance / # Using
  // your tools) land here too.
  if (node.type === 'ArrayExpression' && key === 'elements') {
    if (looksLikePromptArray(node, ancestors.slice(0, -1))) {
      return { structured: true, floor: STRUCT_FLOOR_WEAK, requireSignal: true };
    }
  }

  // R1d — `{content: "…"}` property value. Used by CC's `z8({content:…,
  // isMeta:!0})` system-reminder constructor (and a handful of other
  // dispatchers). Narrow to a literal property named `content`; the floor +
  // signal requirement keep error-object `{message:…}`-style noise out.
  if (
    node.type === 'ObjectProperty' &&
    key === 'value' &&
    node.key &&
    ((node.key.type === 'Identifier' && node.key.name === 'content') ||
     (node.key.type === 'StringLiteral' && node.key.value === 'content'))
  ) {
    return { structured: true, floor: STRUCT_FLOOR_WEAK, requireSignal: true };
  }

  return { structured: false };
}

function validateInput(text, opts = {}) {
  const {
    minLength = 500,
    structured = false,
    structFloor = STRUCT_FLOOR_STRONG,
    requireSignal = true,
  } = opts;
  if (!text || typeof text !== 'string') return false;

  // ////////////////
  // What to include.
  // ////////////////

  // Context about Git status
  if (text.startsWith('This is the git status')) return true;

  // Include the system reminder accompanying every Read tool.
  if (text.includes('Whenever you read a file, you should consider whether it')) return true;

  // Another prompt smaller then 500 characters that should be included
  if (text.includes('IMPORTANT: Assist with authorized security testing'))
    return true;

  // ////////////////
  // What to exclude.
  // ////////////////

  // In one specific case, some of the TUI code shows up in the prompts files.  Exclude it.
  if (text.includes('.dim("Note:')) return false;

  // CLI help text for `claude mcp add` is not a prompt - it's user-facing documentation.
  if (text.startsWith('Add an MCP server to Claude Code.')) return false;

  // Skip the warning about keybindings when connecting to a remote server.
  if (text.includes('Cannot install keybindings from a remote')) return false;

  // Zod-i18n validation error templates land in `case "…": return \`…\`` arms
  // (R1) but are not prompts. The non-English prefixes are stable across CC
  // versions because they're table-driven; if Zod adds a locale, extend here.
  if (/^(Cha\\xEEne|Cadena|Cadeia|Angka|String tidak|Neveljaven|N\\xFAmero|Stringa|Ung\\xFCltige|Nieprawid|تع|テキ|字|不有效)/.test(text)) return false;

  // OTel metrics-SDK view-conflict error templates: short ${.field}-laden
  // bullets that R1 catches on the return arm. Not prompts.
  if (/^\s*-\s+(create|use) (a |unit |valueType |the |that |whose )/.test(text) && /\$\{\.[a-z]/.test(text)) return false;

  // Debug-log templates ("[debug] failed to collect auth state: ${}").
  if (/^\[(debug|warn|info|error|trace)\]\s/.test(text)) return false;

  if (text.length < HARD_FLOOR) return false;

  // ── anti-noise hard rejects (apply to ALL paths) ──────────────────────────
  const first10 = text.substring(0, 10);
  if (first10.startsWith('AGFzbQ') || /^[A-Z0-9+/=]{10}$/.test(first10)) {
    return false;
  }

  const sample = text.substring(0, 500);
  const words = sample.split(/\s+/).filter(w => w.length > 0);

  if (words.length === 0) return false;

  const uppercaseWords = words.filter(
    w => w === w.toUpperCase() && /[A-Z]/.test(w)
  );
  const uppercaseRatio = uppercaseWords.length / words.length;
  if (uppercaseRatio > 0.6) return false;

  const avgWordLength =
    words.reduce((sum, w) => sum + w.length, 0) / words.length;
  if (avgWordLength > 15) return false;

  const spaceCount = (sample.match(/\s/g) || []).length;
  const spaceRatio = spaceCount / sample.length;
  if (spaceRatio < 0.1) return false;

  const lowerText = text.toLowerCase();
  const hasSentences = /[.!?]\s+[A-Z\(]/.test(text);

  // ── (1) legacy long path — byte-identical to the original validateInput. ──
  const hasYou = lowerText.includes('you');
  const hasAI = lowerText.includes('ai') || lowerText.includes('assistant');
  const hasInstruct =
    lowerText.includes('must') ||
    lowerText.includes('should') ||
    lowerText.includes('always');
  if (text.length >= minLength && (hasYou || hasAI || hasInstruct) && hasSentences) {
    return true;
  }

  // ── (2) structured short path (new). ──────────────────────────────────────
  if (structured && text.length >= structFloor && /[.!?:;]/.test(text) && !looksLikeCode(text)) {
    if (!requireSignal) return true;
    const hasKeyword = /\byou\b|\byour\b|assistant|\bmust\b|\bshould\b|\balways\b|\bnever\b|don'?t|do not|\bprefer\b|\bavoid\b|\buse\b/.test(lowerText);
    if (hasKeyword || hasSentences || /^#{1,6}\s/.test(text)) return true;
  }

  return false;
}

function extractStrings(filepath, minLength = 500) {
  const code = fs.readFileSync(filepath, 'utf-8');

  const ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const stringData = [];

  // Mutating shared ancestor stack — push before descending, pop after — so
  // each maybePush call reads the visited node's actual parent. O(1) per node
  // (a `.concat([…])` on a ~14 MB AST would be O(depth) per node).
  const ancestors = [];

  const traverse = node => {
    if (!node || typeof node !== 'object') return;

    // Extract string literals
    if (node.type === 'StringLiteral') {
      const c = classifyStructural(node.value, ancestors);
      if (validateInput(node.value, {
        minLength,
        structured: c.structured,
        structFloor: c.floor,
        requireSignal: c.requireSignal,
      })) {
        stringData.push({
          name: '',
          id: '',
          description: '',
          pieces: [node.value],
          identifiers: [],
          identifierMap: {},
          start: node.start,
          end: node.end,
        });
      }
    }

    // Extract template literals
    if (node.type === 'TemplateLiteral') {
      const { expressions } = node;

      // Extract the entire template content directly from source (excluding backticks)
      const contentStart = node.start + 1; // After opening backtick
      const contentEnd = node.end - 1; // Before closing backtick
      const fullContent = code.substring(contentStart, contentEnd);

      // Validate before processing
      const c = classifyStructural(fullContent, ancestors);
      if (!validateInput(fullContent, {
        minLength,
        structured: c.structured,
        structFloor: c.floor,
        requireSignal: c.requireSignal,
      })) {
        // fall through to recurse into children
      } else {
        // Collect all identifiers with their positions
        const allIdentifiers = []; // Array of {name, start, end} sorted by position

        for (let i = 0; i < expressions.length; i++) {
          const expr = expressions[i];

          const traverseExpr = (exprNode, isTopLevel = true) => {
            if (!exprNode || typeof exprNode !== 'object') return;

            if (exprNode.type === 'Identifier' && isTopLevel) {
              allIdentifiers.push({
                name: exprNode.name,
                start: exprNode.start - contentStart,
                end: exprNode.end - contentStart,
              });
            }

            if (exprNode.type === 'CallExpression') {
              traverseExpr(exprNode.callee, true);
              if (exprNode.arguments) {
                exprNode.arguments.forEach(arg => traverseExpr(arg, true));
              }
              return;
            }

            if (exprNode.type === 'MemberExpression') {
              traverseExpr(exprNode.object, true);
              return;
            }

            if (exprNode.type === 'TemplateLiteral') {
              if (exprNode.expressions) {
                exprNode.expressions.forEach(nestedExpr =>
                  traverseExpr(nestedExpr, true)
                );
              }
              return;
            }

            if (exprNode.type === 'ObjectExpression') {
              if (exprNode.properties) {
                exprNode.properties.forEach(prop => {
                  if (prop.value) {
                    traverseExpr(prop.value, false);
                  }
                });
              }
              return;
            }

            for (const key in exprNode) {
              if (key === 'loc' || key === 'start' || key === 'end') continue;
              const value = exprNode[key];
              if (Array.isArray(value)) {
                value.forEach(v => traverseExpr(v, true));
              } else if (value && typeof value === 'object') {
                traverseExpr(value, true);
              }
            }
          };

          traverseExpr(expr, true);
        }

        // Sort identifiers by position
        allIdentifiers.sort((a, b) => a.start - b.start);

        // Build pieces array by splitting around identifiers, keeping ${ and }
        const pieces = [];
        const identifierList = [];
        const identifierMap = {};

        let lastPos = 0;

        for (const id of allIdentifiers) {
          // Find the ${ before this identifier (search backwards from id.start)
          let beforeIdentifier = fullContent.substring(lastPos, id.start);

          // Find the } after this identifier (search forwards from id.end)
          // We need to find the matching closing brace for the interpolation
          let afterIdentifierStart = id.end;

          // Add the piece including everything up to and including just before the identifier
          pieces.push(beforeIdentifier);

          // Add identifier to the list
          identifierList.push(id.name);

          // Add to map if not already there
          if (!identifierMap[id.name]) {
            identifierMap[id.name] = '';
          }

          lastPos = id.end;
        }

        // Add the final piece after the last identifier
        pieces.push(fullContent.substring(lastPos));

        // Label encode the identifiers
        const uniqueVars = [...new Set(identifierList)];
        const varToLabel = {};
        uniqueVars.forEach((varName, idx) => {
          varToLabel[varName] = idx;
        });

        const labelEncodedIdentifiers = identifierList.map(
          varName => varToLabel[varName]
        );
        const labelEncodedMap = {};
        Object.keys(varToLabel).forEach(varName => {
          labelEncodedMap[varToLabel[varName]] = '';
        });

        stringData.push({
          name: '',
          id: '',
          description: '',
          pieces,
          identifiers: labelEncodedIdentifiers,
          identifierMap: labelEncodedMap,
          start: node.start,
          end: node.end,
        });
      }
    }

    // Recursively traverse
    for (const key in node) {
      if (
        key === 'loc' || key === 'start' || key === 'end' ||
        key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments'
      ) continue;

      const value = node[key];
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const child = value[i];
          if (!child || typeof child !== 'object') continue;
          ancestors.push({ node, key, index: i });
          traverse(child);
          ancestors.pop();
        }
      } else if (value && typeof value === 'object') {
        ancestors.push({ node, key, index: undefined });
        traverse(value);
        ancestors.pop();
      }
    }
  };

  traverse(ast);

  // Filter out strings that are subsets of other strings
  // Step 1: Sort by start index (ascending), then by end index (descending)
  // This puts earliest strings first, and among strings with same start, longest first
  stringData.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return b.end - a.end;
  });

  // Step 2: Track seen ranges and filter out subsets
  const seenRanges = [];
  const filteredData = [];

  for (const item of stringData) {
    const isSubset = seenRanges.some(
      range => item.start >= range.start && item.end <= range.end
    );

    if (!isSubset) {
      filteredData.push(item);
      seenRanges.push({ start: item.start, end: item.end });
    }
  }

  return { prompts: filteredData };
}

// Best-effort content-stable id for prompts the legacy merge didn't match by
// name. Empty `id` strings would collide on extract.py (it writes `.md` per
// `f"{p['id']}.md"` — two empty ids would clobber each other and a single
// empty id would emit a file literally named `.md`).
function autoId(item, taken) {
  const content = item.pieces.join('');
  const norm = content.replace(/\s+/g, ' ').trim();
  const slug = slugify(norm.split(' ').slice(0, 8).join(' ')).slice(0, 60);
  const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 10);
  let id = slug || ('auto-' + hash);
  if (taken.has(id) && taken.get(id) !== content) {
    id = (slug ? slug.slice(0, 50) : 'auto') + '-' + hash;
  }
  taken.set(id, content);
  return id;
}

function mergeWithExisting(newData, oldData, currentVersion) {
  if (!oldData || !oldData.prompts) {
    // No old data — auto-id every prompt so extract.py gets distinct filenames.
    const taken = new Map();
    return {
      prompts: newData.prompts.map(item => ({
        ...item,
        id: item.id || autoId(item, taken),
        version: currentVersion,
      })),
    };
  }

  // Helper to reconstruct content from pieces and identifiers
  const reconstructContent = item => {
    return item.pieces.join(''); // Don't actually insert the vairables.
  };

  const newPrompts = newData.prompts.map((newItem, idx) => {
    const newContent = reconstructContent(newItem);

    // Try to find a matching old item by content and label-encoded identifiers
    const matchingOld = oldData.prompts.find(oldItem => {
      const oldContent = reconstructContent(oldItem);
      if (newContent !== oldContent) return false;

      // Also compare label-encoded identifiers
      if (newItem.identifiers.length !== oldItem.identifiers.length)
        return false;
      return (
        JSON.stringify(newItem.identifiers) ===
        JSON.stringify(oldItem.identifiers)
      );
    });

    // If we found a match, copy over the metadata
    if (matchingOld) {
      // Prompt matches exactly
      // If old prompt has no version, use current version; otherwise use old version
      return {
        ...newItem,
        name: matchingOld.name,
        id: matchingOld.id || slugify(matchingOld.name),
        description: matchingOld.description,
        identifierMap: matchingOld.identifierMap,
        version: matchingOld.version || currentVersion,
      };
    }

    // No exact match found - check if there's a prompt with same metadata but different content
    const similarOld = oldData.prompts.find(oldItem => {
      // Check if names match (not placeholder) as a heuristic for "same prompt, different content"
      return oldItem.name !== '' && oldItem.name === newItem.name;
    });

    if (similarOld && similarOld.version) {
      // Old prompt exists with a version and content changed - use current version
      console.log(
        `Content changed for "${newItem.name}", updating version from ${similarOld.version} to ${currentVersion}`
      );
      return {
        ...newItem,
        id: similarOld.id || slugify(similarOld.name),
        version: currentVersion,
      };
    }

    // New prompt — return for now; auto-id assigned in the second pass.
    console.log(
      `No match for item ${idx}: ${JSON.stringify(newContent.slice(0, 100))}`
    );
    console.log();
    return {
      ...newItem,
      id: '',
      version: currentVersion,
    };
  });

  // Auto-id any prompt that ended up without a named match. Seed `taken` with
  // ids already claimed by named entries so collisions resolve cleanly.
  const taken = new Map();
  for (const p of newPrompts) {
    if (p.id) taken.set(p.id, reconstructContent(p));
  }
  for (const p of newPrompts) {
    if (!p.id) p.id = autoId(p, taken);
  }

  return { prompts: newPrompts };
}

// CLI
if (require.main === module) {
  const filepath = process.argv[2];

  if (!filepath) {
    console.error(
      'Usage: node promptExtractor.cjs <path-to-cli.js> [output-file]'
    );
    process.exit(1);
  }

  const outputFile = process.argv[3] || 'prompts.json';

  // Try to read existing output file
  let existingData = null;
  if (fs.existsSync(outputFile)) {
    try {
      const existingContent = fs.readFileSync(outputFile, 'utf-8');
      existingData = JSON.parse(existingContent);
      console.log(
        `Found existing output file with ${existingData.prompts?.length || 0} prompts`
      );
    } catch (err) {
      console.warn(
        `Warning: Could not parse existing output file: ${err.message}`
      );
    }
  }

  // Look for package.json alongside the input file
  const path = require('path');
  const inputDir = path.dirname(path.resolve(filepath));
  const packageJsonPath = path.join(inputDir, 'package.json');

  let version = null;
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      version = packageJson.version;
      console.log(`Found package.json with version ${version}`);
    } catch (err) {
      console.warn(`Warning: Could not parse package.json: ${err.message}`);
    }
  }

  // Helper functions to replace version strings with placeholder
  const replaceVersionInString = (str, versionStr) => {
    if (!versionStr) return str;
    // Escape dots for regex
    const escapedVersion = versionStr.replace(/\./g, '\\.');
    // Replace version with placeholder
    return str.replace(new RegExp(escapedVersion, 'g'), '<<CCVERSION>>');
  };

  // Helper function to replace BUILD_TIME timestamps with placeholder
  // BUILD_TIME is an ISO 8601 timestamp like "2025-12-09T19:43:43Z"
  const replaceBuildTimeInString = str => {
    // Match ISO 8601 timestamps in the format YYYY-MM-DDTHH:MM:SSZ
    // Only match when preceded by BUILD_TIME:" to avoid false positives
    return str.replace(
      /BUILD_TIME:"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"/g,
      'BUILD_TIME:"<<BUILD_TIME>>"'
    );
  };

  const replaceVersionInPrompts = (data, versionStr) => {
    return {
      ...data,
      prompts: data.prompts.map(prompt => ({
        ...prompt,
        pieces: prompt.pieces.map(piece => {
          let result = piece;
          // Replace BUILD_TIME first (always)
          result = replaceBuildTimeInString(result);
          // Then replace version if provided
          if (versionStr) {
            result = replaceVersionInString(result, versionStr);
          }
          return result;
        }),
      })),
    };
  };

  const result = extractStrings(filepath);
  // Replace version in newly extracted strings BEFORE merging
  const versionReplacedResult = replaceVersionInPrompts(result, version);

  const mergedResult = mergeWithExisting(
    versionReplacedResult,
    existingData,
    version
  );

  // Sort prompts by lexicographic order of pieces joined together (without interpolated vars)
  mergedResult.prompts.sort((a, b) => {
    const contentA = a.pieces.join('');
    const contentB = b.pieces.join('');
    return contentA.localeCompare(contentB);
  });

  // Remove start/end fields before writing
  mergedResult.prompts = mergedResult.prompts.map(({ start, end, ...rest }) => rest);

  // Add version as top-level field
  const outputData = {
    version,
    ...mergedResult,
  };

  fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));

  console.log(`Extracted ${mergedResult.prompts.length} strings`);
  console.log(`Written to ${outputFile}`);
}

module.exports = extractStrings;
