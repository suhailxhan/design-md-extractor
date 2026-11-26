#!/usr/bin/env node
/**
 * design-md-extractor installer
 * Copies skills/design-md-extractor into the skills folder of Claude Code, OpenAI Codex,
 * Google Antigravity and Cursor.
 *
 *   node install.mjs                       install globally for all four tools
 *   node install.mjs --project             install into the current project instead
 *   node install.mjs --tool claude,cursor  only some tools
 *   node install.mjs --uninstall           remove it again
 *   node install.mjs --dry-run             show what would happen
 *
 * Paths are taken from each tool's official documentation:
 *   Claude Code   ~/.claude/skills/<name>/         project: .claude/skills/<name>/
 *   Codex         ~/.agents/skills/<name>/         project: .agents/skills/<name>/
 *   Antigravity   ~/.gemini/config/skills/<name>/  project: .agents/skills/<name>/
 *   Cursor        ~/.cursor/skills/<name>/         project: .cursor/skills/<name>/
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'design-md-extractor';
const repo = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(repo, 'skills', NAME);
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

if (!fs.existsSync(path.join(source, 'SKILL.md'))) { console.error(`Cannot find ${source}/SKILL.md. Run this script from the repository root.`); process.exit(1); }

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
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

const seen = new Set();
let installed = 0;
for (const t of chosen) {
  const dest = path.join(project ? TARGETS[t].project : TARGETS[t].global, NAME);
  const dup = seen.has(dest);
  seen.add(dest);
  if (dup) { console.log(`skip      ${TARGETS[t].label}: ${dest} (same folder as another selected tool)`); continue; }
  if (has('--uninstall')) {
    if (fs.existsSync(dest)) { if (!has('--dry-run')) fs.rmSync(dest, { recursive: true, force: true }); console.log(`removed   ${TARGETS[t].label}: ${dest}`); }
    else console.log(`skip      ${TARGETS[t].label}: nothing at ${dest}`);
    continue;
  }
  if (has('--dry-run')) { console.log(`would install ${TARGETS[t].label} -> ${dest}`); continue; }
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    copyDir(source, dest);
    fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(dest, 'LICENSE'));
    console.log(`installed ${TARGETS[t].label} -> ${dest}`);
    installed++;
  } catch (e) { console.error(`FAILED    ${TARGETS[t].label}: ${e.message}`); }
}
if (!has('--uninstall') && !has('--dry-run')) {
  console.log(`\nDone (${installed} location${installed === 1 ? '' : 's'}). Restart your tool, then say:  "Create a DESIGN.md from https://example.com"`);
  console.log('One-time browser setup:  npm i -g playwright && npx playwright install chromium');
}
