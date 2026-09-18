#!/usr/bin/env node
// lint-skill.js — Mavis SKILL.md validator
//
// Usage: node lint-skill.js <path/to/skill-directory>
// Exit codes: 0 = pass, 1 = errors found.
//
// See Step 5 in the adjacent SKILL.md for validation checks.
// No third-party dependencies; uses only Node.js built-in fs + path.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';

const FORBIDDEN_FILES = ['README.md', 'CHANGELOG.md', 'INSTALLATION.md', 'INSTALLATION_GUIDE.md', 'QUICK_REFERENCE.md'];
const FORBIDDEN_FRONTMATTER_KEYS = ['allowed-tools', 'license', 'model'];
const MAX_BODY_LINES = 500;
const REDUNDANT_WHEN_TO_USE_HEADINGS = [
  '## When to use',
  '## When to use this skill',
  '## When this skill should be used',
];
const README_SMELLS = [
  '## How it works',
  '## Usage',
  '### Command line',
  '### As a Python module',
  '### As a Node module',
  '## API',
];

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  return false;
}

function warn(msg) {
  console.error(`[WARN] ${msg}`);
}

function ok(msg) {
  console.log(`[OK]   ${msg}`);
}

// Minimal frontmatter parser: only top-level key: value entries enclosed by `---`.
// No nesting or complex YAML beyond multiline strings; sufficient for SKILL.md.
function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return { frontmatter: null, bodyStart: 0 };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { frontmatter: null, bodyStart: 0 };

  const fm = {};
  let currentKey = null;
  let currentValue = [];
  let inBlockScalar = false;
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    if (inBlockScalar) {
      if (/^[a-zA-Z_-]+\s*:/.test(line)) {
        // Flush the previous key when a new one starts.
        fm[currentKey] = currentValue.join('\n').trim();
        inBlockScalar = false;
        currentKey = null;
        currentValue = [];
        // Do not continue; proceed to parse the new line.
      } else {
        currentValue.push(line.replace(/^\s{0,4}/, ''));
        continue;
      }
    }
    const m = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
    if (m) {
      const [, k, v] = m;
      if (v === '|' || v === '>' || v === '|-' || v === '>-') {
        // Block scalar
        currentKey = k;
        currentValue = [];
        inBlockScalar = true;
      } else {
        fm[k] = v.trim();
      }
    }
  }
  if (inBlockScalar && currentKey) {
    fm[currentKey] = currentValue.join('\n').trim();
  }
  return { frontmatter: fm, bodyStart: endIdx + 1 };
}

function lintSkill(skillDir) {
  const dirAbs = resolve(skillDir);
  const dirName = basename(dirAbs);
  const skillMdPath = join(dirAbs, 'SKILL.md');

  console.log(`Linting skill at: ${dirAbs}`);
  console.log('');

  let allOk = true;

  // 0. SKILL.md must exist.
  if (!existsSync(skillMdPath)) {
    fail(`SKILL.md not found at ${skillMdPath}`);
    process.exit(1);
  }
  ok('SKILL.md exists');

  const content = readFileSync(skillMdPath, 'utf-8');
  const { frontmatter, bodyStart } = parseFrontmatter(content);

  // 1. Frontmatter must exist.
  if (!frontmatter) {
    fail('frontmatter (--- ... ---) missing or unclosed');
    process.exit(1);
  }
  ok('frontmatter parsed');

  // 2. name is required, must use kebab-case, and must match the directory name.
  const name = frontmatter.name;
  if (!name) {
    allOk = fail('frontmatter.name is missing') && allOk;
  } else if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    allOk = fail(`frontmatter.name "${name}" is not kebab-case (lowercase letters/digits/hyphens, start with letter)`) && allOk;
  } else if (name !== dirName) {
    allOk = fail(`frontmatter.name "${name}" does not match directory name "${dirName}"`) && allOk;
  } else {
    ok(`name "${name}" is valid kebab-case and matches directory`);
  }

  // 3. description is required and must include a trigger phrase.
  const desc = frontmatter.description;
  if (!desc) {
    allOk = fail('frontmatter.description is missing') && allOk;
  } else {
    const hasTriggerHint = /\b(when|trigger|use this|load this)\b/i.test(desc) || /["'']/.test(desc);
    if (!hasTriggerHint) {
      allOk = fail('frontmatter.description must contain at least one trigger phrase: a quoted phrase, "when", "trigger", "use this", or "load this"') && allOk;
    } else {
      ok('description contains trigger hint');
    }
    if (desc.length < 30) {
      warn(`description is very short (${desc.length} chars); make sure it covers what + when + near misses`);
    }
  }

  // 4. Forbidden frontmatter fields.
  for (const key of FORBIDDEN_FRONTMATTER_KEYS) {
    if (key in frontmatter) {
      allOk = fail(`frontmatter contains forbidden key "${key}" (Mavis does not recognize this; remove it)`) && allOk;
    }
  }
  if (FORBIDDEN_FRONTMATTER_KEYS.every((k) => !(k in frontmatter))) {
    ok('no forbidden frontmatter keys');
  }

  // 5. Body line-count check.
  const bodyLines = content.split('\n').length - bodyStart;
  if (bodyLines > MAX_BODY_LINES) {
    allOk = fail(`SKILL.md body is ${bodyLines} lines (> ${MAX_BODY_LINES}); split into references/<topic>.md`) && allOk;
  } else {
    ok(`body is ${bodyLines} lines (limit ${MAX_BODY_LINES})`);
  }

  // 5.1 README-style anti-pattern check.
  const body = content.split('\n').slice(bodyStart).join('\n');
  const hasRedundantWhenToUse = REDUNDANT_WHEN_TO_USE_HEADINGS.some((heading) => body.includes(heading));
  if (hasRedundantWhenToUse) {
    warn('body contains a "When to use" heading; prefer putting trigger/boundary rules in frontmatter.description to avoid duplication');
  }
  const readmeMatches = README_SMELLS.filter((heading) => body.includes(heading));
  if (readmeMatches.length > 0) {
    warn(`body contains README-style section(s): ${readmeMatches.join(', ')}; keep SKILL.md focused on execution rules unless these sections are truly necessary`);
  }

  // 5.2 Windows compatibility: WARN if the body indicates shell commands but the text never mentions windows/win32.
  const shellIndicators = [/python3\b/, /bash\s+scripts\//, /brew\s+install/, /\/tmp\//, /```(?:bash|sh)\b/];
  const hasShellIndicator = shellIndicators.some((re) => re.test(body));
  const mentionsWindows = /windows|win32/i.test(content);
  if (hasShellIndicator && !mentionsWindows) {
    warn('body contains shell/bash commands but does not mention Windows/win32; consider adding a "## Windows (win32) platform notes" section for cross-platform support');
  }

  // 6. Forbidden-file check.
  const entries = readdirSync(dirAbs);
  for (const entry of entries) {
    if (FORBIDDEN_FILES.includes(entry)) {
      allOk = fail(`forbidden file "${entry}" in skill directory (skill is for LLM, not human docs); remove it`) && allOk;
    }
  }
  if (FORBIDDEN_FILES.every((f) => !entries.includes(f))) {
    ok('no forbidden files in skill directory');
  }

  // 7. Referenced files under references/ must exist.
  const refRefs = [...content.matchAll(/references\/([a-zA-Z0-9_-]+\.md)/g)].map((m) => m[1]);
  const uniqueRefs = [...new Set(refRefs)];
  for (const ref of uniqueRefs) {
    const refPath = join(dirAbs, 'references', ref);
    if (!existsSync(refPath)) {
      allOk = fail(`SKILL.md references "references/${ref}" but file does not exist`) && allOk;
    }
  }
  if (uniqueRefs.length > 0 && uniqueRefs.every((r) => existsSync(join(dirAbs, 'references', r)))) {
    ok(`all ${uniqueRefs.length} references/*.md links resolve`);
  }

  console.log('');
  if (allOk) {
    console.log('✓ All checks passed');
    process.exit(0);
  } else {
    console.error('✗ Lint failed');
    process.exit(1);
  }
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node lint-skill.js <path/to/skill-directory>');
  process.exit(2);
}
lintSkill(arg);
