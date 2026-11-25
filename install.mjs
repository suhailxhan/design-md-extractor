#!/usr/bin/env node
/**
 * Installer for the design-md-extractor skill.
 * Copies the skill folder into the skills directory of Claude Code, OpenAI Codex, Google Antigravity and Cursor.
 *
 *   node install.mjs                    # interactive-free: installs globally for every tool
 *   node install.mjs --project          # install into the current project instead of the home folder
 *   node install.mjs --tool claude,cursor
 *   node install.mjs --uninstall
 *   node install.mjs --dry-run
 *
 * Paths come from each tool's official docs (verified Nov 2026):
 *   Claude Code   ~/.claude/skills/<name>/            | project .claude/skills/<name>/
 *   Codex         ~/.agents/skills/<name>/            | project .agents/skills/<name>/
 *   Antigravity   ~/.gemini/config/skills/<name>/     | project .agents/skills/<name>/  (.agent/skills legacy)
 *   Cursor        ~/.cursor/skills/<name>/            | project .cursor/skills/<name>/ (also reads .agents/skills, .claude/skills)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'design-md-extractor';
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const home = os.homedir();
const cwd = process.cwd();
const project = has('--project');

const TARGETS = {
  claude: { label: 'Claude Code', global: path.join(home, '.claude', 'skills'), project: path.join(cwd, '.claude', 'skills') },
  codex: { label: 'OpenAI Codex', global: path.join(home, '.agents', 'skills'), project: path.join(cwd, '.agents', 'skills') },
  antigravity: { label: 'Google Antigravity', global: path.join(home, '.gemini', 'config', 'skills'), project: path.join(cwd, '.agents', 'skills') },
  cursor: { label: 'Cursor', global: path.join(home, '.cursor', 'skills'), project: path.join(cwd, '.cursor', 'skills') },
};
const chosen = (val('--tool') || 'claude,codex,antigravity,cursor').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
for (const t of chosen) if (!TARGETS[t]) { console.error(`Unknown tool "${t}". Use: ${Object.keys(TARGETS).join(', ')}`); process.exit(1); }

const EXCLUDE = new Set(['node_modules', '.git', 'design-extract', '.DS_Store']);
const SKIP_DIR_FROM_COPY = new Set(['installers']);
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name) || (SKIP_DIR_FROM_COPY.has(e.name) && src === here)) continue;
    if (src === here && ['install.mjs', 'README.md'].includes(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// An Antigravity/Codex/Cursor project install all share .agents/skills: de-duplicate.
const seen = new Set();
let ok = 0;
for (const t of chosen) {
  const base = project ? TARGETS[t].project : TARGETS[t].global;
  const dest = path.join(base, NAME);
  const note = seen.has(dest) ? ' (same folder as another selected tool, skipped)' : '';
  if (has('--uninstall')) {
    if (!seen.has(dest) && fs.existsSync(dest)) { if (!has('--dry-run')) fs.rmSync(dest, { recursive: true, force: true }); console.log(`removed  ${TARGETS[t].label}: ${dest}`); }
    else console.log(`skip     ${TARGETS[t].label}: nothing at ${dest}${note}`);
    seen.add(dest); continue;
  }
  if (seen.has(dest)) { console.log(`skip     ${TARGETS[t].label}: ${dest}${note}`); continue; }
  seen.add(dest);
  if (has('--dry-run')) { console.log(`would install ${TARGETS[t].label} -> ${dest}`); continue; }
  try { if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true }); copyDir(here, dest); console.log(`installed ${TARGETS[t].label} -> ${dest}`); ok++; }
  catch (e) { console.error(`FAILED    ${TARGETS[t].label}: ${e.message}`); }
}
if (!has('--uninstall') && !has('--dry-run')) {
  console.log(`\nDone (${ok} location${ok === 1 ? '' : 's'}). Restart the tool, then say:  "Create a DESIGN.md from https://example.com"`);
  console.log('One-time browser setup for the measuring script:  npm i -g playwright && npx playwright install chromium');
}
