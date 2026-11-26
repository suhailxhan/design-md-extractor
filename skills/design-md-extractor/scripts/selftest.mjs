#!/usr/bin/env node
/**
 * Self-test: serves a fixture page whose design values are KNOWN, runs the extractor on it,
 * and checks that every measured value matches ground truth.
 *
 *   node selftest.mjs
 *
 * Exit code 0 = all checks passed. Run this after installing the skill to prove the toolchain works.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'fixtures', 'demo');
const mime = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, p === '/' ? 'index.html' : p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dme-selftest-'));

console.log(`Serving fixture on http://127.0.0.1:${port}  (output: ${out})`);
// async spawn: the fixture server lives in this process, so the event loop must stay free
const run = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, 'extract.mjs'), `http://127.0.0.1:${port}/`, '--out', out, '--wait', '600', '--allow-private'], { env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
server.close();
if (run.status !== 0) { console.error(run.stderr || run.stdout); console.error('\nSELFTEST FAILED: extractor did not run (exit ' + run.status + ').'); process.exit(run.status || 1); }

// --- safety guard: the same loopback fixture must be REFUSED without --allow-private
const guard = await new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(here, 'extract.mjs'), 'http://127.0.0.1:9/', '--out', path.join(out, 'guard')], { env: { ...process.env, NO_PROXY: '*' } });
  let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('close', (status) => resolve({ status, err }));
});
const guardFile = await new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(here, 'extract.mjs'), 'file:///etc/hostname', '--out', path.join(out, 'guard')]);
  let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('close', (status) => resolve({ status, err }));
});
const guardMeta = await new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(here, 'extract.mjs'), 'http://169.254.169.254/latest/meta-data/', '--out', path.join(out, 'guard')]);
  let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('close', (status) => resolve({ status, err }));
});
const dir = path.join(out, fs.readdirSync(out).find((d) => d !== 'guard'));
const r = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`);
};
const rv = Object.fromEntries(r.cssVariables.rootVariables.map((v) => [v.name, v]));
const btns = r.components.buttons;
const primary = btns.find((b) => b.style.backgroundColor === '#5b3df5');
const secondary = btns.find((b) => b.kind === 'outline');
const card = r.components.cards[0];
const input = r.components.inputs[0];
const badge = r.components.badges[0];

console.log('\n--- document / tokens');
check('page background', r.document.pageBg, '#ffffff');
check('body text color', r.document.body.color, '#111827');
check('body font-size', r.document.body.fontSize, '16px');
check('html scroll-behavior', r.document.html.scrollBehavior, 'smooth');
check('root var count >= 10', r.cssVariables.count, (n) => n >= 10);
check('--color-primary computed hex', rv['--color-primary'] && rv['--color-primary'].hex, '#5b3df5');
check('--radius-md computed', rv['--radius-md'] && rv['--radius-md'].computed, '12px');
check('--shadow-md declared verbatim', rv['--shadow-md'] && rv['--shadow-md'].declared, '0 8px 24px rgba(17,24,39,.08)');

console.log('\n--- typography');
check('h1 font-size', r.roles.h1.fontSize, '56px');
check('h1 weight', r.roles.h1.fontWeight, '800');
check('h1 letter-spacing (-0.02em = -1.12px)', r.roles.h1.letterSpacing, '-1.12px');
check('h2 font-size', r.roles.h2.fontSize, '36px');
check('lead paragraph 20px exists in type styles', r.typography.styles.some((s) => s.size === '20px' && s.role === 'p'), true);
check('primary font family = Inter (declared first)', r.typography.families[0].value, 'Inter');

console.log('\n--- colors');
check('bg palette contains #f6f7fb', r.colors.bg.some((c) => c.value === '#f6f7fb'), true);
check('text palette contains #6b7280 (muted)', r.colors.text.some((c) => c.value === '#6b7280'), true);
check('border palette contains #e5e7eb', r.colors.border.some((c) => c.value === '#e5e7eb'), true);
check('gradient detected on hero', r.colors.gradients.length >= 1 && /linear-gradient/.test(r.colors.gradients[0].value), true);
check('contrast #111827 on #fff ≈ 17.74', (r.colors.textWithContrast.find((c) => c.value === '#111827') || {}).contrastOnPageBg, (v) => v > 17 && v < 18.5);

console.log('\n--- spacing / shape');
check('spacing base unit is 4 or 8', r.spacing.baseUnit.chosen, (v) => v === 4 || v === 8);
check('radii include 16px (cards)', r.shape.radii.some((x) => x.value === '16px'), true);
check('radii include 12px (buttons)', r.shape.radii.some((x) => x.value === '12px'), true);
check('pill elements counted (badge 999px)', r.shape.pillElements, (n) => n >= 1);
check('shadow token present', r.shape.shadows.some((s) => /rgba\(17, 24, 39, 0\.08\)/.test(s.value)), true);
check('backdrop-filter blur(12px) found', r.shape.backdropFilters.some((b) => b.value === 'blur(12px)'), true);
check('container max-width 1200px', r.layout.containers.some((c) => c.value === '1200px'), true);
check('3-column grid detected', r.layout.grids.some((g) => g.value.startsWith('3 cols')), true);
check('header height 72px', r.layout.header && r.layout.header.rect.h, 72);
check('sticky header detected', r.layout.fixedSticky.some((f) => f.position === 'sticky'), true);

console.log('\n--- breakpoints / responsive');
const bp = r.layout.breakpoints.map((b) => b.px);
check('breakpoint 768 found', bp.includes(768), true);
check('breakpoint 1024 found', bp.includes(1024), true);
check('mobile h1 shrinks to 36px', r.responsive.mobile && r.responsive.mobile.h1.fontSize, '36px');
check('desktop h1 stays 56px', r.responsive.desktop.h1.fontSize, '56px');
check('mobile feature grid = 1 column', r.responsive.mobile && r.responsive.mobile.grids.some((g) => g.columns === 1), true);
check('mobile shows menu toggle', r.responsive.mobile && r.responsive.mobile.visibleMenuToggles, (n) => n >= 1);
check('desktop hides menu toggle', r.responsive.desktop.visibleMenuToggles, 0);

console.log('\n--- components + states');
check('primary button found', !!primary, true);
check('primary bg', primary && primary.style.backgroundColor, '#5b3df5');
check('primary color', primary && primary.style.color, '#ffffff');
check('primary padding 12px 24px', primary && `${primary.style.paddingTop} ${primary.style.paddingRight}`, '12px 24px');
check('primary radius', primary && primary.style.borderRadius, '12px');
check('primary weight', primary && primary.style.fontWeight, '600');
check('primary hover bg → #4a2fd6', primary && primary.states && primary.states.hover.backgroundColor && primary.states.hover.backgroundColor[1], '#4a2fd6');
check('primary hover transform changes', primary && primary.states && !!primary.states.hover.transform, true);
check('primary focus-visible resolved outline', primary && primary.states && primary.states.focusVisible.outline && primary.states.focusVisible.outline[1], 'solid 3px #a99bff offset 2px');
check('primary active has transform', primary && primary.states && !!primary.states.active && !!primary.states.active.transform, true);
check('secondary classified outline', !!secondary, true);
check('secondary hover bg → #f6f7fb', secondary && secondary.states && secondary.states.hover.backgroundColor && secondary.states.hover.backgroundColor[1], '#f6f7fb');
check('card group size 3', card && card.count, 3);
check('card radius 16px', card && card.style.borderRadius, '16px');
check('card padding 24px', card && card.style.paddingTop, '24px');
check('card hover lifts (transform)', card && card.states && !!card.states.hover.transform, true);
check('input height 44px', input && input.style.height, '44px');
check('input radius 10px', input && input.style.borderRadius, '10px');
check('input focus border → #5b3df5', input && input.states && input.states.focusVisible.borderTopColor && input.states.focusVisible.borderTopColor[1], '#5b3df5');
check('badge detected (pill, 13px)', badge && badge.style.fontSize, '13px');

console.log('\n--- motion');
check('easing cubic-bezier(.4,0,.2,1) recorded', r.motion.easings.some((e) => /cubic-bezier\(0\.4, 0, 0\.2, 1\)/.test(e.value)), true);
check('duration 200ms recorded', r.motion.durations.some((d) => d.value === '200ms'), true);
check('keyframes fadeUp parsed (Chrome normalizes from→0%)', !!r.motion.keyframes.fadeUp && !!(r.motion.keyframes.fadeUp['0%'] || r.motion.keyframes.fadeUp.from), true);
check('reduced-motion rule detected', r.motion.hasReducedMotionRules, true);

console.log('\n--- dark mode');
const dm = r.darkMode.prefersColorScheme;
check('prefers-color-scheme dark supported', dm && dm.supported, true);
check('dark page bg', dm && dm.pageBg, '#0b0d12');
check('dark text color', dm && dm.text, '#e5e7eb');
check('--color-bg changes light→dark', dm && dm.changedVars['--color-bg'] && [dm.changedVars['--color-bg'].light, dm.changedVars['--color-bg'].dark], ['#ffffff', '#0b0d12']);
check('data-theme="dark" toggle discovered', r.darkMode.themeAttribute.working.some((w) => w.mechanism === 'html[data-theme="dark"]'), true);

console.log('\n--- architecture');
check('static HTML classified as server-rendered/static', r.architecture.rendering && /server-rendered/.test(r.architecture.rendering.classification), true);
check('XHR /api/items.json captured', r.architecture.api.sample.some((x) => /\/api\/items\.json/.test(x.url)), true);
check('NO technology falsely detected on a hand-written page (frameworks, UI kits, Bootstrap, Daisy, Tailwind)', r.architecture.detectedStack.map((x) => x.name), []);
check('forms parsed (POST /subscribe)', r.architecture.structure.forms.some((f) => f.action === '/subscribe' && f.method === 'post'), true);
check('SEO description captured', r.architecture.seo.description, 'Fixture page for the design-md-extractor self-test');
check('screenshots written', Object.values(r.screenshots).filter(Boolean).length >= 4, true);


console.log('\n--- security guard');
check('loopback target refused by default (exit 5)', guard.status, 5);
check('refusal message explains --allow-private', /--allow-private/.test(guard.err), true);
check('file:// target refused by default (exit 5)', guardFile.status, 5);
check('cloud-metadata address 169.254.169.254 refused (exit 5)', guardMeta.status, 5);
check('--allow-private run still works (report exists)', fs.existsSync(path.join(dir, 'report.json')), true);

console.log('\n--- regression locks (bugs found while reviewing real output)');
check('h1 letter-spacing reported in em (-0.02)', r.roles.h1.letterSpacingEm, -0.02);
check('h1 line-height ratio 1.1', r.roles.h1.lineHeightRatio, 1.1);
check('lead paragraph line-height ratio 1.6', r.roles.p.lineHeightRatio, 1.6);
check('transparent borders excluded from border palette', r.colors.border.some((c) => c.value === '#00000000'), false);
check('card <article> padding not counted as section padding', r.spacing.sectionPadding.some((x) => x.value === 24), false);
check('section padding 96px present', r.spacing.sectionPadding.some((x) => x.value === 96), true);
const pairWhiteOnPrimary = r.colors.contrastPairsMeasured.find((p) => p.text === '#ffffff' && p.background === '#5b3df5');
check('contrast pair #ffffff on #5b3df5 uses real button bg (≈6.1)', pairWhiteOnPrimary && pairWhiteOnPrimary.ratio, (v) => v > 6.0 && v < 6.3);
check('contrast pair white-on-primary passes AA', pairWhiteOnPrimary && pairWhiteOnPrimary.passAA, true);
const pairBody = r.colors.contrastPairsMeasured.find((p) => p.text === '#111827' && p.background === '#ffffff');
check('contrast pair #111827 on #ffffff ≈ 17.74', pairBody && pairBody.ratio, (v) => v > 17.5 && v < 18);
const gray = r.colors.contrastPairsMeasured.find((p) => p.text === '#9ca3af' && p.background === '#0b0d12');
check('footer pair #9ca3af on #0b0d12 measured against dark footer bg', !!gray, true);
check('every link exemplar probed without error', r.components.links.every((l) => l.states && !l.states.error), true);
check('transitions split per property (transform 200ms cubic-bezier)', r.motion.transitions.some((t) => t.value === 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1)'), true);
check('easings are individual values, not comma lists', r.motion.easings.every((e) => !/\)\s*,\s*cubic/.test(e.value)), true);
check('active state has no transform-induced width jitter', primary && primary.states && primary.states.active && !('width(px)' in primary.states.active), true);
check('secondary button focus ring flagged as browser default', secondary && secondary.states && /browser default/.test(secondary.states.focusVisible.outline[1]), true);
check('role font probe resolved Inter for h1 (CDP)', r.platformFonts.h1 && /Inter/i.test(r.platformFonts.h1[0].family), true);
check('digest says ::selection is browser default', /::selection: browser default \(no custom rule\)/.test(fs.readFileSync(path.join(dir, 'digest.md'), 'utf8')), true);

console.log(`\n${fail === 0 ? 'SELFTEST PASSED' : 'SELFTEST FAILED'}: ${pass} passed, ${fail} failed`);
console.log('Artifacts kept at: ' + dir);
process.exit(fail === 0 ? 0 : 1);
