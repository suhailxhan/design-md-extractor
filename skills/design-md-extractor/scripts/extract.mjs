#!/usr/bin/env node
/**
 * design-md-extractor / extract.mjs
 *
 * Opens a URL in headless Chromium and MEASURES the rendered page:
 * computed styles, CSS variables, fonts, components (with hover / focus / active / disabled states),
 * layout, breakpoints, motion, dark mode, plus architecture signals (stack, hosting, API calls, SEO).
 *
 * Output (in <out>/<host>/): report.json, digest.md, tokens.draft.json, rendered.html,
 *                            screenshots/*.png, css/*.css
 *
 * Usage:
 *   node extract.mjs <url> [--out ./design-extract] [--wait 1500] [--max-elements 6000]
 *                    [--no-dark] [--no-mobile] [--no-states] [--no-banner]
 *                    [--allow-private] [--timeout 45000] [--proxy http://host:port] [--ua "custom user agent"]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import dns from 'node:dns/promises';
import nodeNet from 'node:net';

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const positional = [];
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const nx = argv[i + 1];
    if (nx === undefined || nx.startsWith('--')) opt[k] = true;
    else { opt[k] = nx; i++; }
  } else positional.push(a);
}
if (!positional[0] || opt.help) {
  console.error('Usage: node extract.mjs <url> [--out dir] [--wait ms] [--max-elements n] [--no-dark] [--no-mobile] [--no-states] [--no-banner] [--allow-private] [--timeout ms] [--proxy url] [--ua string]');
  process.exit(positional[0] ? 0 : 1);
}
let targetUrl = positional[0];
if (!/^[a-z][a-z0-9+.-]*:/i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
const TIMEOUT = Number(opt.timeout || 45000);
const EXTRA_WAIT = Number(opt.wait || 1500);
const MAX_EL = Number(opt['max-elements'] || 6000);

/* ------------------------------------------------------------------ safety
 * By default the extractor only visits PUBLIC http(s) hosts. It refuses localhost, private LAN ranges,
 * link-local / cloud-metadata (169.254.x.x) and file:// unless --allow-private is given.
 * The check also runs on every redirect and sub-request made by the page. */
const ALLOW_PRIVATE = !!opt['allow-private'];
function ipv4Private(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function ipPrivate(ip) {
  const v = nodeNet.isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4Private(mapped[1]);
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return false;
}
const hostVerdict = new Map();
async function hostIsPrivate(host) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostVerdict.has(host)) return hostVerdict.get(host);
  let bad = false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) bad = true;
  else if (nodeNet.isIP(host)) bad = ipPrivate(host);
  else {
    try { const addrs = await dns.lookup(host, { all: true }); bad = addrs.some((a) => ipPrivate(a.address)); }
    catch { bad = false; /* unresolvable here (e.g. resolved by an egress proxy): the browser will fail or the proxy enforces policy */ }
  }
  hostVerdict.set(host, bad);
  return bad;
}
async function installGuard(context) {
  if (ALLOW_PRIVATE) return;
  await context.route('**/*', async (route) => {
    let u; try { u = new URL(route.request().url()); } catch { return route.abort('blockedbyclient'); }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return route.continue();
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.abort('blockedbyclient');
    if (await hostIsPrivate(u.hostname)) { blockedRequests.push(u.hostname); return route.abort('blockedbyclient'); }
    return route.continue();
  });
}
const blockedRequests = [];
{
  const t = new URL(targetUrl);
  const refuse = (why) => { console.error('\n[design-md-extractor] Refusing to open ' + targetUrl + ': ' + why + '\n  This tool only visits public websites by default. If you really mean to scan a local or internal page, add --allow-private.\n'); process.exit(5); };
  if (!ALLOW_PRIVATE) {
    if (t.protocol !== 'http:' && t.protocol !== 'https:') refuse(t.protocol + ' URLs are not allowed');
    else if (await hostIsPrivate(t.hostname)) refuse('"' + t.hostname + '" is a local, private-network or link-local address');
  }
}

/* ------------------------------------------------------- load playwright */
async function loadPlaywright() {
  try { const m = await import('playwright'); return m.chromium ? m : m.default; } catch { /* fall through */ }
  const bases = [process.cwd()];
  try { bases.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { /* ignore */ }
  if (process.env.NODE_PATH) bases.push(...process.env.NODE_PATH.split(path.delimiter));
  for (const b of bases) {
    for (const name of ['playwright', 'playwright-core']) {
      try {
        const req = createRequire(path.join(b, 'noop.js'));
        const direct = path.join(b, name);
        const m = fs.existsSync(direct) ? req(direct) : req(name);
        if (m && m.chromium) return m;
      } catch { /* try next */ }
    }
  }
  console.error('\n[design-md-extractor] Playwright is not installed.\n  Fix:  npm i -D playwright && npx playwright install chromium\n  (or install it globally: npm i -g playwright && npx playwright install chromium)\n  No-browser fallback: see references/fallback-no-browser.md\n');
  process.exit(3);
}
const pw = await loadPlaywright();

/* ----------------------------------------------------------- output dirs */
const u0 = new URL(targetUrl);
const hostSlug = (u0.hostname || 'local').replace(/^www\./, '') + (u0.port ? '-' + u0.port : '');
const pathSlug = u0.pathname && u0.pathname !== '/' ? '__' + u0.pathname.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 60) : '';
const outDir = path.resolve(String(opt.out || './design-extract'), hostSlug + pathSlug);
const shotDir = path.join(outDir, 'screenshots');
const cssDir = path.join(outDir, 'css');
fs.mkdirSync(shotDir, { recursive: true });
fs.mkdirSync(cssDir, { recursive: true });

/* ======================================================================== *
 *  IN-PAGE HELPERS (installed once as window.__dme)                        *
 * ======================================================================== */
const HELPERS = () => {
  const cv = document.createElement('canvas');
  cv.width = 1; cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const rgbaOf = (str) => {
    if (!str) return null;
    if (cache.has(str)) return cache.get(str);
    let out = null;
    const m = str.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      out = [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3]), a];
    } else if (str === 'transparent') out = [0, 0, 0, 0];
    else if (!/^(currentcolor|inherit|initial|unset|none|auto|normal)$/i.test(str.trim())) {
      try {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#123456';
        ctx.fillStyle = str;
        if (ctx.fillStyle === '#123456' && str.trim().toLowerCase() !== '#123456') out = null;
        else {
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          out = [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
        }
      } catch (e) { out = null; }
    }
    cache.set(str, out);
    return out;
  };
  const hx = (n) => n.toString(16).padStart(2, '0');
  const toHex = (str) => {
    const c = rgbaOf(str);
    if (!c) return null;
    return '#' + hx(c[0]) + hx(c[1]) + hx(c[2]) + (c[3] < 1 ? hx(Math.round(c[3] * 255)) : '');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };
  const PROPS = ['color', 'backgroundColor', 'backgroundImage', 'borderTopWidth', 'borderTopStyle', 'borderTopColor',
    'borderRightWidth', 'borderBottomWidth', 'borderBottomColor', 'borderLeftWidth', 'borderRadius', 'boxShadow',
    'outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'paddingTop', 'paddingRight', 'paddingBottom',
    'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform',
    'textDecorationLine', 'textDecorationColor', 'textUnderlineOffset', 'display', 'alignItems', 'justifyContent', 'gap',
    'width', 'height', 'minHeight', 'cursor', 'transition', 'opacity', 'transform', 'filter', 'backdropFilter',
    'position', 'zIndex', 'accentColor', 'caretColor'];
  const snap = (el) => {
    const cs = getComputedStyle(el);
    const o = {};
    for (const p of PROPS) {
      let v = cs[p];
      if (v === undefined || v === '') continue;
      if (/color$/i.test(p)) { const h = toHex(v); if (h) v = h; }
      o[p] = v;
    }
    const r = el.getBoundingClientRect();
    o.__w = Math.round(r.width * 10) / 10;
    o.__h = Math.round(r.height * 10) / 10;
    if (el.matches && el.matches('input,textarea')) {
      try { o.placeholderColor = toHex(getComputedStyle(el, '::placeholder').color); } catch (e) { /* ignore */ }
    }
    return o;
  };
  window.__dme = { rgbaOf, toHex, visible, snap };
};

/* ======================================================================== *
 *  IN-PAGE EXTRACTION (single pass over the DOM)                           *
 * ======================================================================== */
const EXTRACT = (o) => {
  const { toHex, rgbaOf, snap } = window.__dme;
  const round1 = (n) => Math.round(n * 10) / 10;
  const px = (v) => { const f = parseFloat(v); return Number.isFinite(f) ? f : 0; };
  const trunc = (s, n) => (s || '').slice(0, n);
  const clsOf = (el) => trunc(typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''), 120);
  const bump = (m, k, inc = 1, meta) => { if (k == null) return; const e = m.get(k); if (e) e.n += inc; else m.set(k, { n: inc, meta }); };
  const topN = (m, n = 20) => Array.from(m, ([k, v]) => Object.assign({ value: k, count: Math.round(v.n * 10) / 10 }, v.meta || {}))
    .sort((a, b) => b.count - a.count).slice(0, n);
  const splitTop = (str) => { const out = []; let d = 0, b = ''; for (const ch of (str || '')) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(b.trim()); b = ''; } else b += ch; } if (b.trim()) out.push(b.trim()); return out; };
  const lhRatio = (cs) => { const lh = px(cs.lineHeight), fs = px(cs.fontSize); return lh && fs ? Math.round((lh / fs) * 1000) / 1000 : null; };
  const lsEm = (cs) => { const ls = px(cs.letterSpacing), fs = px(cs.fontSize); return cs.letterSpacing === 'normal' ? 0 : (fs ? Math.round((ls / fs) * 1000) / 1000 : null); };
  const primaryFamily = (f) => (f || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  const effBg = (el) => {
    let e = el;
    while (e) {
      const cs = getComputedStyle(e);
      const c = rgbaOf(cs.backgroundColor);
      if (c && c[3] >= 0.99) return toHex(cs.backgroundColor);
      e = e.parentElement;
    }
    return '#ffffff';
  };
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'br', 'wbr', 'source', 'track', 'option', 'optgroup', 'col', 'colgroup']);

  let all = Array.from(document.body.querySelectorAll('*'));
  const totalEls = all.length;
  if (all.length > o.maxEls) { const step = all.length / o.maxEls; all = Array.from({ length: o.maxEls }, (_, i) => all[Math.floor(i * step)]); }

  const pageBg = effBg(document.body);
  const bgCache = new Map();
  const effBgInfo = (el) => {
    if (!el) return { hex: '#ffffff', approx: false };
    if (bgCache.has(el)) return bgCache.get(el);
    const cs = getComputedStyle(el);
    const c = rgbaOf(cs.backgroundColor);
    let out;
    const img = cs.backgroundImage && cs.backgroundImage !== 'none';
    if (c && c[3] >= 0.99) out = { hex: toHex(cs.backgroundColor), approx: false };
    else { const up = effBgInfo(el.parentElement); out = { hex: up.hex, approx: up.approx || !!img || (c && c[3] > 0) }; }
    bgCache.set(el, out);
    return out;
  };
  const pairs = new Map();
  const M = () => new Map();
  const textColors = M(), bgColors = M(), borderColors = M(), borderWidths = M(), gradients = M(), svgFills = M(), svgStrokes = M();
  const typoStyles = M(), sizes = M(), weights = M(), famStacks = M(), families = M();
  const padH = M(), marH = M(), gapH = M(), sectionPad = M();
  const radii = M(), shadows = M(), zIdx = M(), backdrops = M(), filters = M();
  const transitions = M(), durations = M(), easings = M(), animations = M();
  const containers = M(), grids = M(), displays = M(), positions = M();
  const btnGroups = new Map(), linkGroups = new Map(), inputGroups = new Map(), badgeGroups = new Map(), cardGroups = new Map();
  const imgStats = { count: 0, objectFit: M(), radius: M(), ratio: M(), lazy: 0, shadow: M(), border: 0 };
  const iconStats = { svgCount: 0, sizes: M(), strokeWidths: M(), fillModes: M(), fontPrefixes: M() };
  const fixedSticky = [];
  const headings = [];
  let pillCount = 0, textGradient = 0, bgImageUrl = 0, seen = 0, videoCount = 0, canvasCount = 0;
  const ratioName = (w, h) => {
    const r = w / h; const c = [[1, '1:1'], [4 / 3, '4:3'], [3 / 2, '3:2'], [16 / 9, '16:9'], [21 / 9, '21:9'], [3 / 4, '3:4'], [2 / 3, '2:3'], [9 / 16, '9:16'], [5 / 4, '5:4'], [4 / 5, '4:5']];
    let best = null, bd = 1e9; for (const [v, n] of c) { const d = Math.abs(v - r); if (d < bd) { bd = d; best = n; } }
    return bd < 0.04 ? best : round1(r) + ':1';
  };
  let idc = 0;
  const tagEl = (el, prefix) => { const id = prefix + '-' + (idc++); el.setAttribute('data-dme', id); return id; };
  const exemplarInfo = (el, prefix, extra) => {
    const id = tagEl(el, prefix);
    return Object.assign({ id, tag: el.tagName.toLowerCase(), class: clsOf(el), text: trunc((el.value && el.tagName === 'INPUT' ? el.value : el.textContent || '').replace(/\s+/g, ' ').trim(), 40), style: snap(el), html: trunc(el.outerHTML.replace(/\s+/g, ' '), 420) }, extra || {});
  };
  const addGroup = (map, sig, el, extra) => {
    const g = map.get(sig);
    if (g) { g.count++; return; }
    map.set(sig, { count: 1, el, extra });
  };

  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    const sv = el.closest('svg');
    if (sv && sv !== el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    seen++;

    let own = '';
    for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue;
    own = own.replace(/\s+/g, ' ').trim();
    const bgc = rgbaOf(cs.backgroundColor);
    const bgA = bgc ? bgc[3] : 0;
    const maxR = Math.max(px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius), px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius));
    const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((s) => { const bc = rgbaOf(cs['border' + s + 'Color']); return px(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && bc && bc[3] > 0; });
    const fam = primaryFamily(cs.fontFamily);

    /* ---- typography */
    if (own.length) {
      const inNav = !!el.closest('nav,[role="navigation"]');
      const isBtnTag = tag === 'button' || el.getAttribute('role') === 'button';
      let role = /^h[1-6]$/.test(tag) ? tag : (tag === 'p' ? 'p' : (tag === 'a' ? (inNav ? 'nav-link' : 'a') : (isBtnTag ? 'button' : (tag === 'label' ? 'label' : (tag === 'li' ? 'li' : (tag === 'small' ? 'small' : (/^(code|pre|kbd|samp)$/.test(tag) ? 'code' : (tag === 'blockquote' ? 'blockquote' : 'text'))))))));
      const key = [role, fam, cs.fontSize, cs.fontWeight, cs.lineHeight, cs.letterSpacing, cs.textTransform, cs.fontStyle].join('|');
      bump(typoStyles, key, own.length, { role, family: fam, size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight, lineHeightRatio: lhRatio(cs), letterSpacing: cs.letterSpacing, letterSpacingEm: lsEm(cs), transform: cs.textTransform, fontStyle: cs.fontStyle, sample: trunc(own, 48), tag, els: 0 });
      typoStyles.get(key).meta.els++;
      bump(sizes, cs.fontSize, own.length); bump(weights, cs.fontWeight, own.length);
      bump(famStacks, cs.fontFamily, own.length); bump(families, fam, own.length);
      bump(textColors, toHex(cs.color), own.length);
      { const bi = effBgInfo(el); bump(pairs, toHex(cs.color) + ' on ' + bi.hex, own.length, { text: toHex(cs.color), bg: bi.hex, approxBackground: bi.approx, sizePx: px(cs.fontSize), weight: cs.fontWeight }); }
      if (/^h[1-3]$/.test(tag) && headings.length < 80) headings.push({ tag, text: trunc(own, 90) });
    }
    if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') textGradient++;

    /* ---- colors */
    if (bgA > 0) bump(bgColors, toHex(cs.backgroundColor), Math.round((r.width * r.height) / 1000));
    for (const s of ['Top', 'Right', 'Bottom', 'Left']) {
      if (px(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none') {
        const bcol = rgbaOf(cs['border' + s + 'Color']);
        if (bcol && bcol[3] > 0) { bump(borderColors, toHex(cs['border' + s + 'Color']), 1); bump(borderWidths, cs['border' + s + 'Width'], 1); }
      }
    }
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      if (cs.backgroundImage.includes('gradient(')) bump(gradients, trunc(cs.backgroundImage, 400), 1);
      else if (cs.backgroundImage.includes('url(')) bgImageUrl++;
    }

    /* ---- spacing */
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) { const v = px(cs[p]); if (v > 0 && v <= 240) bump(padH, round1(v)); }
    for (const p of ['marginTop', 'marginBottom']) { const v = px(cs[p]); if (v > 0 && v <= 240) bump(marH, round1(v)); }
    for (const p of ['rowGap', 'columnGap']) { const v = px(cs[p]); if (v > 0 && v <= 240) bump(gapH, round1(v)); }
    if ((/^(section|footer|main)$/.test(tag) || (el.parentElement && /^(main|body)$/.test(el.parentElement.tagName.toLowerCase()))) && r.width >= innerWidth * 0.9) {
      if (r.height > 120) { for (const p of ['paddingTop', 'paddingBottom']) { const v = px(cs[p]); if (v > 0) bump(sectionPad, round1(v)); } }
    }

    /* ---- shape */
    if (cs.borderRadius && !/^0(px)?$/.test(cs.borderRadius)) { bump(radii, cs.borderRadius); if (maxR > 0 && maxR >= Math.min(r.width, r.height) / 2 - 0.5) pillCount++; }
    if (cs.boxShadow && cs.boxShadow !== 'none') bump(shadows, cs.boxShadow);
    if (cs.zIndex !== 'auto') bump(zIdx, cs.zIndex);
    if (cs.backdropFilter && cs.backdropFilter !== 'none') bump(backdrops, cs.backdropFilter);
    if (cs.filter && cs.filter !== 'none') bump(filters, cs.filter);

    /* ---- motion */
    const td = cs.transitionDuration;
    if (td && !/^(0s,?\s*)+$/.test(td)) {
      const props = splitTop(cs.transitionProperty), durs = splitTop(td), eases = splitTop(cs.transitionTimingFunction), dels = splitTop(cs.transitionDelay);
      props.forEach((pn, i) => {
        const d = durs[i % durs.length], e = eases[i % eases.length], dl = dels[i % dels.length];
        const ms = d.endsWith('ms') ? parseFloat(d) : parseFloat(d) * 1000;
        if (!(ms > 0)) return;
        const dlms = dl.endsWith('ms') ? parseFloat(dl) : parseFloat(dl) * 1000;
        bump(transitions, pn + ' ' + Math.round(ms) + 'ms ' + e + (dlms ? ' delay ' + Math.round(dlms) + 'ms' : ''));
        bump(durations, Math.round(ms) + 'ms'); bump(easings, e);
      });
    }
    if (cs.animationName && cs.animationName !== 'none') bump(animations, [cs.animationName, cs.animationDuration, cs.animationTimingFunction, cs.animationIterationCount].join(' | '));

    /* ---- layout */
    bump(displays, cs.display);
    if (cs.position !== 'static') bump(positions, cs.position);
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      if (fixedSticky.length < 12) fixedSticky.push({ tag, id: el.id || '', class: clsOf(el).slice(0, 60), position: cs.position, top: cs.top, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, bg: toHex(cs.backgroundColor), z: cs.zIndex, backdropFilter: cs.backdropFilter });
    }
    if (cs.maxWidth !== 'none' && r.width >= 280 && r.width < innerWidth + 1) {
      bump(containers, cs.maxWidth, 1, { actualWidth: Math.round(r.width), paddingLeft: cs.paddingLeft, tag, class: clsOf(el).slice(0, 60) });
    }
    if (cs.display === 'grid' || cs.display === 'inline-grid') {
      const cols = cs.gridTemplateColumns && cs.gridTemplateColumns !== 'none' ? cs.gridTemplateColumns.split(' ').length : 0;
      if (cols >= 1) bump(grids, cols + ' cols | gap ' + cs.rowGap + ' / ' + cs.columnGap, 1, { resolvedColumns: trunc(cs.gridTemplateColumns, 120), class: clsOf(el).slice(0, 60), tag });
    }

    /* ---- images / icons */
    if (tag === 'img' || tag === 'picture') {
      if (tag === 'img') {
        imgStats.count++;
        bump(imgStats.objectFit, cs.objectFit); bump(imgStats.radius, cs.borderRadius);
        bump(imgStats.ratio, ratioName(r.width, r.height));
        if (el.loading === 'lazy') imgStats.lazy++;
        if (cs.boxShadow !== 'none') bump(imgStats.shadow, cs.boxShadow);
        if (hasBorder) imgStats.border++;
      }
    }
    if (tag === 'video') videoCount++;
    if (tag === 'canvas') canvasCount++;
    if (tag === 'svg') {
      iconStats.svgCount++;
      bump(iconStats.sizes, Math.round(r.width) + 'x' + Math.round(r.height));
      const sh = el.querySelector('path,line,circle,rect,polyline');
      if (sh) {
        const scs = getComputedStyle(sh);
        const fill = scs.fill, stroke = scs.stroke;
        bump(iconStats.fillModes, (fill && fill !== 'none' ? 'fill' : 'nofill') + '/' + (stroke && stroke !== 'none' ? 'stroke' : 'nostroke'));
        if (stroke && stroke !== 'none') bump(iconStats.strokeWidths, scs.strokeWidth);
        const fh = toHex(fill), sh2 = toHex(stroke);
        if (fill !== 'none' && fh) bump(svgFills, fh); if (stroke !== 'none' && sh2) bump(svgStrokes, sh2);
      }
    }
    if ((tag === 'i' || tag === 'span') && !own) {
      const m = clsOf(el).match(/(?:^|\s)(fa[srlbd]?|bi|material-icons[\w-]*|lucide|ti|ri|ph|feather|icon|iconify)(?:[\s-]|$)/);
      if (m) bump(iconStats.fontPrefixes, m[1]);
    }

    /* ---- components */
    const txt = (tag === 'input' ? (el.value || '') : (el.textContent || '')).replace(/\s+/g, ' ').trim();
    const shortTxt = txt.length >= 1 && txt.length <= 40;
    const cls = clsOf(el);
    const btnAnc = el.parentElement && el.parentElement.closest('button,a,[role="button"]');
    const isBtnTag = tag === 'button' || el.getAttribute('role') === 'button' || (tag === 'input' && /^(button|submit|reset)$/.test(el.type));
    const classBtn = (tag === 'a' || tag === 'div' || tag === 'span') && /(^|[\s_-])(btn|button|cta)([\s_-]|$)/i.test(cls) && !/(group|container|wrapper|text|label|icon)/i.test(cls);
    const anchorBtn = tag === 'a' && bgA > 0.05 && px(cs.paddingLeft) >= 10 && r.height <= 80 && shortTxt;
    const isBtn = !btnAnc && shortTxt && r.height >= 22 && r.height <= 96 && r.width <= 460 && (isBtnTag || classBtn || anchorBtn);
    if (isBtn) {
      const sig = [toHex(cs.backgroundColor), toHex(cs.color), cs.borderRadius, cs.paddingTop, cs.paddingRight, cs.fontSize, cs.fontWeight, cs.borderTopWidth, toHex(cs.borderTopColor), cs.boxShadow, cs.textTransform, cs.letterSpacing].join('|');
      addGroup(btnGroups, sig, el, { texts: [] });
      const g = btnGroups.get(sig); if (g.extra && g.extra.texts.length < 4 && !g.extra.texts.includes(trunc(txt, 28))) g.extra.texts.push(trunc(txt, 28));
    }
    const isInputTag = (tag === 'input' && !/^(hidden|checkbox|radio|submit|button|reset|image|range|file|color)$/.test(el.type || 'text')) || tag === 'textarea' || tag === 'select';
    if (isInputTag) {
      const sig = [tag, el.type || '', toHex(cs.backgroundColor), toHex(cs.color), cs.borderTopWidth, toHex(cs.borderTopColor), cs.borderRadius, cs.paddingTop, cs.paddingLeft, cs.fontSize, cs.height].join('|');
      addGroup(inputGroups, sig, el, { type: el.type || tag });
    }
    if (tag === 'a' && !isBtn && own) {
      const ctx = el.closest('nav,[role="navigation"]') ? 'nav' : (el.closest('footer') ? 'footer' : (el.closest('header') ? 'header' : 'content'));
      const sig = [ctx, toHex(cs.color), cs.textDecorationLine, cs.fontWeight, cs.fontSize].join('|');
      addGroup(linkGroups, sig, el, { ctx });
    }
    if (!isBtn && !isInputTag && tag !== 'a' && txt.length >= 1 && txt.length <= 24 && px(cs.fontSize) <= 15 && r.height <= 40 && r.width <= 220 &&
      ((bgA > 0.03 && maxR >= 4) || (hasBorder && maxR >= 4) || /badge|chip|pill|tag/i.test(cls)) && el.children.length <= 2) {
      const sig = [toHex(cs.backgroundColor), toHex(cs.color), cs.borderRadius, cs.paddingTop, cs.paddingLeft, cs.fontSize, cs.fontWeight, cs.textTransform, cs.letterSpacing, cs.borderTopWidth, toHex(cs.borderTopColor)].join('|');
      addGroup(badgeGroups, sig, el, {});
    }
    const cardish = !isBtn && !isInputTag && r.width >= 160 && r.width <= 720 && r.height >= 80 && r.height <= 960 && (cs.boxShadow !== 'none' || hasBorder || bgA > 0.5) && txt.length >= 10 && el.children.length >= 1 && !/^(body|html|main|section|header|footer|nav|form|ul|ol|table|tr|td|th)$/.test(tag);
    if (cardish) {
      const sig = [toHex(cs.backgroundColor), cs.borderTopWidth, toHex(cs.borderTopColor), cs.borderRadius, cs.boxShadow, cs.paddingTop, cs.paddingLeft].join('|');
      addGroup(cardGroups, sig, el, { w: Math.round(r.width) });
    }
  }

  /* ---- finalize component groups */
  const finishGroups = (map, prefix, limit, minCount) => Array.from(map.values())
    .filter((g) => g.count >= (minCount || 1)).sort((a, b) => b.count - a.count).slice(0, limit)
    .map((g) => Object.assign(exemplarInfo(g.el, prefix, g.extra), { count: g.count }));
  const buttons = finishGroups(btnGroups, 'btn', 8);
  const inputs = finishGroups(inputGroups, 'inp', 4);
  const links = finishGroups(linkGroups, 'lnk', 6);
  const badges = finishGroups(badgeGroups, 'bdg', 4);
  const cards = finishGroups(cardGroups, 'card', 4, 2);
  for (const b of buttons) {
    const s = b.style; const bgA = (rgbaOf(s.backgroundColor) || [0, 0, 0, 0])[3];
    const bw = parseFloat(s.borderTopWidth) || 0;
    b.kind = bgA > 0.05 && s.backgroundColor !== pageBg ? 'filled' : (bw > 0 ? 'outline' : 'ghost');
  }

  /* ---- semantic structure */
  const q1 = (sel) => { for (const e of document.querySelectorAll(sel)) { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); if (r.width > 1 && r.height > 1 && cs.display !== 'none') return e; } return null; };
  const header = q1('header, [role="banner"]') || q1('nav');
  const footer = q1('footer, [role="contentinfo"]');
  const h1 = q1('h1');
  const headerInfo = header ? Object.assign(exemplarInfo(header, 'hdr'), { rect: { y: Math.round(header.getBoundingClientRect().y), h: Math.round(header.getBoundingClientRect().height) } }) : null;
  if (headerInfo) delete headerInfo.html;
  let hero = null;
  if (h1) {
    const sec = h1.closest('section, header, [class*="hero" i], main > div') || h1.parentElement;
    const scs = getComputedStyle(sec); const sr = sec.getBoundingClientRect();
    const nextP = sec.querySelector('p');
    const ctaTexts = Array.from(sec.querySelectorAll('a,button')).filter((b) => b.getBoundingClientRect().height > 20).slice(0, 3).map((b) => trunc(b.textContent.replace(/\s+/g, ' ').trim(), 28));
    hero = { tag: sec.tagName.toLowerCase(), class: clsOf(sec), rect: { y: Math.round(sr.y + scrollY), w: Math.round(sr.width), h: Math.round(sr.height) }, bg: effBg(sec), backgroundImage: trunc(scs.backgroundImage, 200), paddingTop: scs.paddingTop, paddingBottom: scs.paddingBottom, textAlign: scs.textAlign, display: scs.display, minHeight: scs.minHeight, hasMedia: !!sec.querySelector('img,video,canvas,svg'), ctas: ctaTexts, h1: snap(h1), h1Text: trunc(h1.textContent.replace(/\s+/g, ' ').trim(), 100), lead: nextP ? Object.assign(snap(nextP), { text: trunc(nextP.textContent.replace(/\s+/g, ' ').trim(), 100) }) : null };
  }
  let footerInfo = null;
  if (footer) {
    const fcs = getComputedStyle(footer);
    const grid = Array.from(footer.querySelectorAll('*')).find((e) => /grid|flex/.test(getComputedStyle(e).display) && e.children.length >= 2);
    footerInfo = { bg: effBg(footer), color: toHex(fcs.color), paddingTop: fcs.paddingTop, paddingBottom: fcs.paddingBottom, borderTop: fcs.borderTopWidth + ' ' + toHex(fcs.borderTopColor), height: Math.round(footer.getBoundingClientRect().height), linkCount: footer.querySelectorAll('a').length, columns: grid ? grid.children.length : null, class: clsOf(footer) };
  }
  // sections root
  let root = document.querySelector('main') || document.body;
  for (let i = 0; i < 4; i++) { const kids = Array.from(root.children).filter((c) => !SKIP.has(c.tagName.toLowerCase()) && c.getBoundingClientRect().height > 1); if (kids.length === 1 && kids[0].children.length > 1) root = kids[0]; else break; }
  const sections = Array.from(root.children).filter((c) => !SKIP.has(c.tagName.toLowerCase()) && c.getBoundingClientRect().height > 60).slice(0, 30).map((c) => {
    const cs = getComputedStyle(c); const rr = c.getBoundingClientRect(); const hd = c.querySelector('h1,h2,h3');
    return { tag: c.tagName.toLowerCase(), id: c.id || '', class: clsOf(c).slice(0, 70), height: Math.round(rr.height), bg: effBg(c), paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, display: cs.display, heading: hd ? trunc(hd.textContent.replace(/\s+/g, ' ').trim(), 70) : '', imgs: c.querySelectorAll('img').length, grids: Array.from(c.querySelectorAll('*')).filter((e) => getComputedStyle(e).display === 'grid').length };
  });

  /* ---- nav tree, links, forms */
  const nav = q1('header nav, nav, [role="navigation"]');
  let navTree = [];
  if (nav) {
    const ul = nav.querySelector('ul');
    const items = ul ? Array.from(ul.children) : Array.from(nav.querySelectorAll(':scope > a'));
    navTree = items.slice(0, 14).map((li) => {
      const a = li.matches('a') ? li : li.querySelector('a,button');
      return { text: trunc((a ? a.textContent : li.textContent).replace(/\s+/g, ' ').trim(), 40), href: a && a.getAttribute ? a.getAttribute('href') : null, children: Array.from(li.querySelectorAll('ul a, [role="menu"] a')).slice(0, 10).map((x) => ({ text: trunc(x.textContent.replace(/\s+/g, ' ').trim(), 40), href: x.getAttribute('href') })) };
    });
  }
  const origin = location.origin;
  const linkSeen = new Set(); const internalLinks = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let href; try { href = new URL(a.getAttribute('href'), location.href); } catch (e) { continue; }
    if (href.origin !== origin) continue;
    const key = href.pathname; if (linkSeen.has(key) || key === location.pathname) continue; linkSeen.add(key);
    internalLinks.push({ path: key, text: trunc(a.textContent.replace(/\s+/g, ' ').trim(), 40) });
    if (internalLinks.length >= 80) break;
  }
  const forms = Array.from(document.querySelectorAll('form')).slice(0, 8).map((f) => ({ action: f.getAttribute('action') || '', method: (f.getAttribute('method') || 'get').toLowerCase(), fields: Array.from(f.querySelectorAll('input,textarea,select')).filter((i) => i.type !== 'hidden').slice(0, 14).map((i) => ({ tag: i.tagName.toLowerCase(), type: i.type || '', name: i.name || '', required: i.required })) }));

  /* ---- document-level */
  const hcs = getComputedStyle(document.documentElement), bcs = getComputedStyle(document.body);
  let selection = null; try { const sc = getComputedStyle(document.documentElement, '::selection'); selection = { color: toHex(sc.color), background: toHex(sc.backgroundColor) }; } catch (e) { /* ignore */ }
  const doc = {
    lang: document.documentElement.lang || '', title: document.title,
    html: { fontSize: hcs.fontSize, colorScheme: hcs.colorScheme, scrollBehavior: hcs.scrollBehavior, backgroundColor: toHex(hcs.backgroundColor) },
    body: { fontFamily: bcs.fontFamily, fontSize: bcs.fontSize, lineHeight: bcs.lineHeight, color: toHex(bcs.color), backgroundColor: toHex(bcs.backgroundColor), fontSmoothing: bcs.webkitFontSmoothing || '', textRendering: bcs.textRendering },
    pageBg, selectionMeasured: selection, scrollHeight: document.documentElement.scrollHeight, totalElements: totalEls, sampledVisible: seen,
  };
  // role samples (full computed typography for key roles)
  const roleSel = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6', p: 'main p, article p, section p, p', small: 'small', label: 'label', code: 'code, pre', blockquote: 'blockquote', navLink: 'header nav a, nav a', footerLink: 'footer a', li: 'main li, li' };
  const roles = {};
  for (const [k, sel] of Object.entries(roleSel)) {
    const e = q1(sel); if (!e) continue;
    const cs = getComputedStyle(e); const rr = e.getBoundingClientRect();
    roles[k] = { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, lineHeightRatio: lhRatio(cs), letterSpacing: cs.letterSpacing, letterSpacingEm: lsEm(cs), textTransform: cs.textTransform, color: toHex(cs.color), marginTop: cs.marginTop, marginBottom: cs.marginBottom, textAlign: cs.textAlign, width: Math.round(rr.width), maxWidth: cs.maxWidth, sample: trunc((e.textContent || '').replace(/\s+/g, ' ').trim(), 60), fontId: (e.setAttribute('data-dme-role', k), k) };
  }

  /* ---- class-name conventions + UI-lib hints */
  const tokens = new Set(); document.querySelectorAll('[class]').forEach((e) => { if (tokens.size < 4000 && typeof e.className === 'string') e.className.split(/\s+/).forEach((t) => t && tokens.add(t)); });
  const toks = Array.from(tokens); const T = Math.max(1, toks.length);
  const twRe = /^(?:[a-z0-9-]+:)*-?(?:m[trblxy]?|p[trblxy]?|w|h|min-w|max-w|min-h|max-h|flex|grid|col|row|gap|space-[xy]|text|bg|border|rounded|shadow|font|leading|tracking|items|justify|self|place|order|z|top|left|right|bottom|inset|opacity|overflow|block|inline|hidden|absolute|relative|fixed|sticky|transition|duration|ease|object|aspect|ring|divide|outline|backdrop|blur|from|via|to|translate|rotate|scale|origin|cursor|select|pointer-events|sr-only|truncate|underline|uppercase|lowercase|capitalize|italic)(?:-|$|\[)/;
  const classStats = {
    uniqueTokens: toks.length,
    tailwindLikePct: Math.round((toks.filter((t) => twRe.test(t)).length / T) * 100),
    tailwindArbitraryValues: toks.filter((t) => /\[[^\]]+\]/.test(t)).length,
    responsivePrefixes: toks.filter((t) => /^(sm|md|lg|xl|2xl):/.test(t)).length,
    bemPct: Math.round((toks.filter((t) => /__|--/.test(t)).length / T) * 100),
    cssModuleHashPct: Math.round((toks.filter((t) => /^[A-Za-z][\w-]*_[A-Za-z0-9_-]{5,}$|_[a-zA-Z0-9]{5,8}__?[a-zA-Z0-9]*$/.test(t) && !/^[a-z]+-[a-z]+/.test(t)).length / T) * 100),
    emotion: toks.filter((t) => /^css-[a-z0-9]+/.test(t)).length,
    styledComponents: toks.filter((t) => /^sc-[A-Za-z]+/.test(t)).length,
    mui: toks.filter((t) => /^Mui[A-Z]/.test(t)).length,
    chakra: toks.filter((t) => /^chakra-/.test(t)).length,
    antd: toks.filter((t) => /^ant-/.test(t)).length,
    bootstrapDistinct: toks.filter((t) => /^(col-(sm|md|lg|xl|xxl)-(\d+|auto)|navbar-(expand(-\w+)?|toggler|collapse|nav)|form-(control|select|check-input)|input-group|d-(flex|none|block|inline|inline-block|grid)|d-(sm|md|lg|xl)-\w+|justify-content-\w+|align-items-\w+|btn-(primary|secondary|success|danger|warning|info|light|dark|outline-\w+)|modal-(dialog|content|header|body|footer)|carousel-item|list-group(-item)?|dropdown-menu|breadcrumb-item|page-item|g[xy]?-\d)$/.test(t)).length,
    daisyDistinct: toks.filter((t) => /^(btn-(primary|secondary|accent|ghost|outline|neutral|info|success|warning|error)|badge-(primary|secondary|accent|ghost|outline)|card-(body|title|actions)|navbar-(start|center|end)|menu-title|hero-content|drawer-(toggle|content|side)|modal-box|tabs-boxed|toggle-primary|input-bordered|select-bordered)$/.test(t)).length,
    radixOrShadcnAttrs: document.querySelectorAll('[data-radix-collection-item],[data-radix-popper-content-wrapper],[data-state][role],[data-slot]').length,
    headlessUi: document.querySelectorAll('[id^="headlessui-"]').length,
    sample: toks.slice(0, 40),
  };

  /* ---- tech globals */
  const w = window; const has = (k) => { try { return k in w; } catch (e) { return false; } };
  const ver = (f) => { try { return f(); } catch (e) { return null; } };
  const rootEl = document.getElementById('root') || document.getElementById('__next') || document.getElementById('app') || document.body.firstElementChild;
  const reactKey = rootEl ? Object.keys(rootEl).find((k) => k.startsWith('__reactContainer$') || k.startsWith('_reactRootContainer')) : null;
  const tech = {
    metaGenerator: ver(() => (document.querySelector('meta[name="generator"]') || {}).content || null),
    next: has('__NEXT_DATA__') ? { buildId: ver(() => w.__NEXT_DATA__.buildId), page: ver(() => w.__NEXT_DATA__.page), nextVersion: ver(() => w.next && w.next.version), router: ver(() => (w.__NEXT_DATA__.props && w.__NEXT_DATA__.props.pageProps !== undefined ? 'pages' : 'unknown')), assetPrefix: ver(() => w.__NEXT_DATA__.assetPrefix || '') } : (document.querySelector('script[src*="/_next/static"]') ? { detectedVia: 'script src /_next/static' } : null),
    nextAppRouter: !!(w.__next_f || document.querySelector('script:not([src])') && /self\.__next_f/.test(document.documentElement.innerHTML.slice(0, 200000))),
    nuxt: has('__NUXT__') || has('$nuxt') ? { v: ver(() => (w.__NUXT__ && w.__NUXT__.config ? 'nuxt3' : 'nuxt2/3')) } : null,
    gatsby: has('___gatsby') ? true : null,
    remix: has('__remixContext') ? true : null,
    sveltekit: !!document.querySelector('[data-sveltekit-preload-data]') || has('__sveltekit_dev') || !!document.querySelector('script[src*="/_app/immutable"]'),
    astro: !!document.querySelector('astro-island, astro-slot') || !!document.querySelector('[data-astro-cid], [data-astro-source-file]'),
    angular: ver(() => (document.querySelector('[ng-version]') || {}).getAttribute('ng-version')),
    vue: has('__VUE__') || !!document.querySelector('[data-v-app]') || !!document.querySelector('[data-server-rendered]') || Array.from(document.querySelectorAll('*')).slice(0, 400).some((e) => Array.from(e.attributes).some((a) => /^data-v-[0-9a-f]{6,}/.test(a.name))),
    react: !!reactKey || !!document.querySelector('[data-reactroot]'),
    svelte: Array.from(document.querySelectorAll('[class]')).slice(0, 400).some((e) => /\bsvelte-[a-z0-9]{5,}\b/.test(e.className && e.className.toString())),
    solid: has('_$HY') ? true : null,
    qwik: !!document.querySelector('[q\\:container]'),
    htmx: has('htmx') ? ver(() => w.htmx.version) : null,
    alpine: has('Alpine') ? ver(() => w.Alpine.version) : null,
    jquery: ver(() => (w.jQuery && w.jQuery.fn && w.jQuery.fn.jquery) || null),
    wordpress: !!document.querySelector('link[href*="/wp-content/"], script[src*="/wp-content/"], meta[name="generator"][content*="WordPress"]'),
    shopify: has('Shopify') ? ver(() => w.Shopify.theme && w.Shopify.theme.name) || true : null,
    webflow: has('Webflow') || document.documentElement.hasAttribute('data-wf-site') ? true : null,
    framer: !!document.querySelector('[data-framer-name], [data-framer-component-type]') || !!document.querySelector('script[src*="framerusercontent"], link[href*="framerusercontent"]'),
    wix: !!document.querySelector('meta[name="generator"][content*="Wix"]') || has('wixBiSession'),
    squarespace: !!document.querySelector('meta[name="generator"][content*="Squarespace"]') || has('Squarespace'),
    ghost: !!document.querySelector('meta[name="generator"][content*="Ghost"]'),
    gsap: has('gsap') ? ver(() => w.gsap.version) : null,
    lenis: has('Lenis') || !!document.querySelector('html.lenis') ? true : null,
    locomotive: !!document.querySelector('[data-scroll-container]'),
    three: has('THREE') ? true : null,
    lottie: has('lottie') || has('bodymovin') || !!document.querySelector('lottie-player, dotlottie-player') ? true : null,
    framerMotion: !!document.querySelector('[style*="will-change: transform"]') && !!reactKey,
    analytics: ['gtag', 'dataLayer', 'ga', 'fbq', 'hj', 'analytics', 'mixpanel', 'posthog', 'amplitude', 'plausible', 'clarity', 'Intercom', 'Sentry', 'Stripe', '_paq', 'heap', 'umami'].filter(has),
  };

  /* ---- a11y / seo / pwa */
  const imgs = Array.from(document.querySelectorAll('img'));
  const a11y = {
    landmarks: { header: document.querySelectorAll('header,[role=banner]').length, nav: document.querySelectorAll('nav,[role=navigation]').length, main: document.querySelectorAll('main,[role=main]').length, aside: document.querySelectorAll('aside,[role=complementary]').length, footer: document.querySelectorAll('footer,[role=contentinfo]').length },
    h1Count: document.querySelectorAll('h1').length, imgCount: imgs.length, imgsMissingAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
    skipLink: !!Array.from(document.querySelectorAll('a[href^="#"]')).slice(0, 5).find((a) => /skip/i.test(a.textContent)),
    ariaLabelCount: document.querySelectorAll('[aria-label]').length, buttonsWithoutName: Array.from(document.querySelectorAll('button')).filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby') && !b.getAttribute('title')).length,
  };
  const metaC = (sel) => { const e = document.querySelector(sel); return e ? e.getAttribute('content') || e.getAttribute('href') : null; };
  const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => { try { const j = JSON.parse(s.textContent); return [].concat(j['@graph'] || j).map((x) => x['@type']).flat().filter(Boolean); } catch (e) { return []; } }).flat();
  const seo = {
    title: document.title, description: metaC('meta[name="description"]'), canonical: metaC('link[rel="canonical"]'), viewport: metaC('meta[name="viewport"]'), robots: metaC('meta[name="robots"]'), themeColor: metaC('meta[name="theme-color"]'),
    og: Object.fromEntries(Array.from(document.querySelectorAll('meta[property^="og:"]')).map((m) => [m.getAttribute('property'), trunc(m.content, 120)])),
    twitterCard: metaC('meta[name="twitter:card"]'), jsonLdTypes: Array.from(new Set(ld)), manifest: metaC('link[rel="manifest"]'),
    icons: Array.from(document.querySelectorAll('link[rel*="icon"]')).map((l) => ({ rel: l.rel, sizes: l.sizes ? l.sizes.toString() : '', type: l.type || '' })).slice(0, 8), hreflangCount: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
    preconnect: Array.from(document.querySelectorAll('link[rel="preconnect"],link[rel="dns-prefetch"]')).map((l) => l.href).slice(0, 10),
    preloadFonts: document.querySelectorAll('link[rel="preload"][as="font"]').length,
  };
  const linkHrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.href);

  return {
    doc, roles,
    colors: { contrastPairs: topN(pairs, 18), text: topN(textColors, 16), bg: topN(bgColors, 18), border: topN(borderColors, 10), svgFill: topN(svgFills, 8), svgStroke: topN(svgStrokes, 8), gradients: topN(gradients, 8), textGradientElements: textGradient, bgImageUrlElements: bgImageUrl },
    typography: { families: topN(families, 8), stacks: topN(famStacks, 6), styles: topN(typoStyles, 40), sizes: topN(sizes, 20), weights: topN(weights, 8) },
    spacing: { padding: topN(padH, 30), margin: topN(marH, 24), gap: topN(gapH, 20), sectionPadding: topN(sectionPad, 10), borderWidths: topN(borderWidths, 6) },
    shape: { radii: topN(radii, 14), pillElements: pillCount, shadows: topN(shadows, 12), zIndex: topN(zIdx, 12), backdropFilters: topN(backdrops, 5), filters: topN(filters, 5) },
    motion: { transitions: topN(transitions, 14), durations: topN(durations, 8), easings: topN(easings, 8), animations: topN(animations, 10) },
    layout: { containers: topN(containers, 8), grids: topN(grids, 10), displays: topN(displays, 10), positions: topN(positions, 6), fixedSticky, header: headerInfo, hero, footer: footerInfo, sections, headings },
    components: { buttons, links, inputs, badges, cards, images: { count: imgStats.count, lazy: imgStats.lazy, withBorder: imgStats.border, objectFit: topN(imgStats.objectFit, 4), radius: topN(imgStats.radius, 5), ratios: topN(imgStats.ratio, 6), shadows: topN(imgStats.shadow, 3), videos: videoCount, canvases: canvasCount }, icons: { svgCount: iconStats.svgCount, sizes: topN(iconStats.sizes, 6), strokeWidths: topN(iconStats.strokeWidths, 4), fillModes: topN(iconStats.fillModes, 4), iconFonts: topN(iconStats.fontPrefixes, 4) } },
    structure: { navTree, internalLinks, forms },
    tech: Object.assign(tech, { classStats }), a11y, seo, linkHrefs,
  };
};

/* ======================================================================== *
 *  NODE-SIDE HELPERS                                                       *
 * ======================================================================== */
function walkCss(cssText, h) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = []; let buf = ''; let inStr = null; let paren = 0;
  const emit = () => {
    const t = buf.trim(); if (!t) return;
    const i = t.indexOf(':');
    if (i > 0 && stack.length) h.decl && h.decl(stack, t.slice(0, i).trim(), t.slice(i + 1).trim());
  };
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (inStr) { buf += ch; if (ch === '\\') buf += css[++i] || ''; else if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; buf += ch; continue; }
    if (ch === '(') { paren++; buf += ch; continue; }
    if (ch === ')') { paren = Math.max(0, paren - 1); buf += ch; continue; }
    if (paren > 0) { buf += ch; continue; }
    if (ch === '{') { const pre = buf.trim(); stack.push(pre); h.open && h.open(pre, stack); buf = ''; continue; }
    if (ch === '}') { emit(); const pre = stack.pop(); h.close && h.close(pre, stack); buf = ''; continue; }
    if (ch === ';') { emit(); buf = ''; continue; }
    buf += ch;
  }
}

function analyzeCss(sheets) {
  const rootVars = new Map(); const darkVars = []; const otherVars = { count: 0 };
  const bpCount = new Map(); const mediaFeatures = new Map(); const atRules = new Map();
  const keyframes = {}; const fontFaces = []; const declFamilies = new Map();
  let cur = null; let twVars = 0; let bsVars = 0; let selectionRules = false; let focusVisible = false; let reducedMotion = false; let darkMedia = false;
  const rootRe = /(^|,)\s*(:root|html|:host|body|\*)\s*(?=,|$)/;
  for (const { css } of sheets) {
    if (/:focus-visible/.test(css)) focusVisible = true;
    if (/::(-moz-)?selection/.test(css)) selectionRules = true;
    if (/prefers-reduced-motion/.test(css)) reducedMotion = true;
    if (/prefers-color-scheme\s*:\s*dark/.test(css)) darkMedia = true;
    walkCss(css, {
      open(pre) {
        if (pre.startsWith('@')) { const k = pre.split(/[\s({]/)[0]; atRules.set(k, (atRules.get(k) || 0) + 1); }
        if (pre.startsWith('@font-face')) cur = {};
        if (pre.startsWith('@media') || pre.startsWith('@container')) {
          for (const m of pre.matchAll(/\(\s*(min|max)-width\s*:\s*([\d.]+)(px|em|rem)\s*\)/g)) { const v = Math.round(parseFloat(m[2]) * (m[3] === 'px' ? 1 : 16) * 100) / 100; const k = m[1] + '-width ' + v + 'px'; bpCount.set(k, (bpCount.get(k) || 0) + 1); }
          for (const m of pre.matchAll(/\(\s*width\s*(>=|<=|>|<)\s*([\d.]+)(px|em|rem)\s*\)/g)) { const v = Math.round(parseFloat(m[2]) * (m[3] === 'px' ? 1 : 16) * 100) / 100; const k = (m[1][0] === '>' ? 'min' : 'max') + '-width ' + v + 'px'; bpCount.set(k, (bpCount.get(k) || 0) + 1); }
          for (const m of pre.matchAll(/\(\s*(prefers-[a-z-]+|hover|pointer|orientation|forced-colors)\s*:?\s*([a-z-]*)\s*\)/g)) { const k = m[1] + (m[2] ? ': ' + m[2] : ''); mediaFeatures.set(k, (mediaFeatures.get(k) || 0) + 1); }
        }
      },
      close(pre) { if (pre && pre.startsWith('@font-face') && cur) { fontFaces.push(cur); cur = null; } },
      decl(stack, prop, value) {
        const top = stack[stack.length - 1];
        if (top.startsWith('@font-face')) { if (cur) cur[prop] = value; return; }
        const kfIdx = stack.findIndex((s) => /^@(-webkit-)?keyframes/.test(s));
        if (kfIdx >= 0) { const name = stack[kfIdx].replace(/^@(-webkit-)?keyframes\s*/, ''); if (Object.keys(keyframes).length < 24 || keyframes[name]) { keyframes[name] = keyframes[name] || {}; const fr = stack[stack.length - 1]; keyframes[name][fr] = keyframes[name][fr] || {}; keyframes[name][fr][prop] = value; } return; }
        if (prop === 'font-family' && !top.startsWith('@')) { const f = value.split(',')[0].trim().replace(/^["']|["']$/g, ''); declFamilies.set(f, (declFamilies.get(f) || 0) + 1); }
        if (prop.startsWith('--')) {
          if (prop.startsWith('--tw-')) twVars++;
          if (prop.startsWith('--bs-')) bsVars++;
          const sel = stack.filter((s) => !s.startsWith('@')).join(' ') || '';
          const media = stack.filter((s) => s.startsWith('@')).join(' ');
          const isRoot = rootRe.test(sel);
          const isDark = /dark|night/i.test(sel) || /prefers-color-scheme\s*:\s*dark/.test(media);
          if (isRoot && !isDark && !/@media[^{]*(min|max)-width/.test(media)) rootVars.set(prop, { value, scope: sel, media });
          else if (isDark) darkVars.push({ name: prop, value, scope: sel, media });
          else otherVars.count++;
        }
      },
    });
  }
  const sorted = (m) => Array.from(m, ([k, v]) => ({ value: k, count: v })).sort((a, b) => b.count - a.count);
  const bps = sorted(bpCount).map((x) => ({ query: x.value, px: parseFloat(x.value.split(' ')[1]), count: x.count })).sort((a, b) => a.px - b.px);
  return {
    rootVariables: Array.from(rootVars, ([name, v]) => ({ name, declared: v.value, scope: v.scope })),
    darkVariables: darkVars.slice(0, 400), otherScopedVariableCount: otherVars.count,
    breakpoints: bps, mediaFeatures: sorted(mediaFeatures), atRules: sorted(atRules),
    keyframes, fontFaces: fontFaces.slice(0, 60), declaredFontFamilies: sorted(declFamilies).slice(0, 12),
    tailwindVarCount: twVars, bootstrapVarCount: bsVars, hasSelectionRules: selectionRules, hasFocusVisibleRules: focusVisible, hasReducedMotionRules: reducedMotion, hasPrefersDarkRules: darkMedia,
  };
}

const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const hexToRgba = (h) => { if (!h || h[0] !== '#') return null; const x = h.slice(1); const n = (i) => parseInt(x.slice(i, i + 2), 16); return [n(0), n(2), n(4), x.length >= 8 ? n(6) / 255 : 1]; };
const over = (fg, bg) => { const a = fg[3]; return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))); };
const contrast = (fgHex, bgHex) => { const fg = hexToRgba(fgHex), bg = hexToRgba(bgHex); if (!fg || !bg) return null; const f = fg[3] < 1 ? over(fg, bg) : fg; const L1 = lum(f), L2 = lum(bg); return Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100; };

function inferBaseUnit(hist) {
  const total = hist.reduce((s, x) => s + x.count, 0) || 1;
  const cands = [8, 4, 6, 5, 10, 12, 2, 3];
  const cov = cands.map((b) => ({ base: b, coverage: Math.round((hist.filter((x) => Math.abs(x.value / b - Math.round(x.value / b)) < 0.02).reduce((s, x) => s + x.count, 0) / total) * 100) / 100 }));
  const good = cov.filter((c) => c.coverage >= 0.8).sort((a, b) => b.base - a.base)[0];
  return { chosen: good ? good.base : (cov.slice().sort((a, b) => b.coverage - a.coverage)[0] || {}).base, coverage: cov };
}

function mdTable(headers, rows) {
  if (!rows.length) return '_none detected_\n';
  const esc = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return '| ' + headers.join(' | ') + ' |\n| ' + headers.map(() => '---').join(' | ') + ' |\n' + rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |').join('\n') + '\n';
}
const outlineStr = (s) => (!s.outlineStyle || s.outlineStyle === 'none' ? 'none' : (s.outlineStyle === 'auto' ? `auto (browser default focus ring, ${s.outlineColor})` : `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} offset ${s.outlineOffset}`));
const diffSnap = (a, b) => {
  const out = {};
  for (const k of Object.keys(b)) {
    if (k === '__w' || k === '__h') { if (Math.abs((a[k] || 0) - (b[k] || 0)) > 1) out[k === '__w' ? 'width(px)' : 'height(px)'] = [a[k], b[k]]; continue; }
    if (a[k] !== b[k]) out[k] = [a[k], b[k]];
  }
  // Chrome keeps outline-width/offset even when outline-style is none, so individual diffs mislead:
  // always give the resolved outline as a single value.
  if (out.transform) { delete out['width(px)']; delete out['height(px)']; }
  if (Object.keys(out).some((k) => k.startsWith('outline'))) {
    for (const k of ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset']) delete out[k];
    out.outline = [outlineStr(a), outlineStr(b)];
  }
  return out;
};
const fmtDiff = (d) => Object.entries(d || {}).map(([k, v]) => `${k}: ${v[0]} → ${v[1]}`).join('; ') || '(no change)';

/* ======================================================================== *
 *  MAIN                                                                    *
 * ======================================================================== */
const started = Date.now();
const log = (...a) => console.error('[dme]', ...a);
const proxy = opt.proxy || process.env.DME_PROXY;
let browser;
try {
  browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'] });
} catch (e) {
  console.error('\n[design-md-extractor] Could not launch Chromium: ' + e.message + '\n  Fix: npx playwright install chromium\n');
  process.exit(3);
}
{ const _nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await _nc(o); await installGuard(c); return c; }; }
const major = (browser.version() || '120').split('.')[0];
const UA = opt.ua || `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
const ctxOpts = (extra) => Object.assign({ userAgent: UA, deviceScaleFactor: 1, ...(proxy ? { proxy: { server: String(proxy) } } : {}) }, extra);

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((res) => {
      let y = 0; const step = Math.max(300, innerHeight * 0.8);
      const t = setInterval(() => { window.scrollBy(0, step); y += step; if (y >= document.documentElement.scrollHeight || y > 30000) { clearInterval(t); window.scrollTo(0, 0); setTimeout(res, 300); } }, 110);
    });
  }).catch(() => {});
}
async function dismissBanner(page) {
  if (opt['no-banner']) return;
  await page.evaluate(() => {
    const roots = document.querySelectorAll('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i],[aria-label*="cookie" i]');
    const accept = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|accept & close|accept and continue)$/i;
    for (const r of roots) for (const b of r.querySelectorAll('button,a,[role="button"]')) if (accept.test((b.textContent || '').trim())) { b.click(); return true; }
    return false;
  }).catch(() => {});
  await page.waitForTimeout(400);
}
async function openPage(ctx, url) {
  const page = await ctx.newPage();
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await dismissBanner(page);
  await autoScroll(page);
  await page.waitForTimeout(EXTRA_WAIT);
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  return { page, resp };
}
async function shot(page, name, full = true) {
  const file = path.join(shotDir, name + '.png');
  try { await page.screenshot({ path: file, fullPage: full, timeout: 30000 }); }
  catch { try { await page.screenshot({ path: file, timeout: 15000 }); } catch (e2) { return null; } }
  return path.relative(outDir, file);
}

/* ---------- 1. desktop / light (main pass) */
const net = { css: [], fonts: [], scripts: [], xhr: [], ws: [], types: {}, bytes: 0, hosts: {}, mainHeaders: null, mainStatus: null, finalUrl: targetUrl, thirdPartyTypes: {} };
const ctx = await browser.newContext(ctxOpts({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' }));
let page, mainResp;
try {
  ({ page, resp: mainResp } = await (async () => {
    const p = await ctx.newPage();
    p.on('response', async (resp) => {
      try {
        const req = resp.request(); const type = req.resourceType(); const url = resp.url(); const h = resp.headers();
        net.types[type] = (net.types[type] || 0) + 1;
        const len = parseInt(h['content-length'] || '0', 10); if (len) net.bytes += len;
        let host = ''; try { host = new URL(url).hostname; } catch { /* data: etc */ }
        if (host) net.hosts[host] = (net.hosts[host] || 0) + 1;
        const st = resp.status();
        if (!net.mainHeaders && req.isNavigationRequest() && req.frame() === p.mainFrame() && !(st >= 300 && st < 400)) { net.mainHeaders = h; net.mainStatus = st; net.finalUrl = url; }
        if (type === 'stylesheet') { const body = await resp.text().catch(() => null); if (body && body.length < 5e6) net.css.push({ url, css: body }); }
        else if (type === 'font') net.fonts.push({ url, contentType: h['content-type'] || '' });
        else if (type === 'script') net.scripts.push(url);
        else if (type === 'xhr' || type === 'fetch') { let graphql = false; try { graphql = /"query"\s*:|"operationName"/.test(req.postData() || ''); } catch { /* ignore */ } net.xhr.push({ method: req.method(), url, status: st, contentType: h['content-type'] || '', graphql }); }
      } catch { /* ignore */ }
    });
    p.on('websocket', (ws) => net.ws.push(ws.url()));
    const resp = await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await dismissBanner(p);
    await autoScroll(p);
    await p.waitForTimeout(EXTRA_WAIT);
    await p.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    return { page: p, resp };
  })());
} catch (e) {
  console.error('\n[design-md-extractor] Could not load ' + targetUrl + ': ' + e.message + '\n  If the site needs a login or blocks automation, see SKILL.md ("Blocked or authenticated sites").\n');
  await browser.close();
  process.exit(4);
}
log('loaded', net.finalUrl, 'status', net.mainStatus);
const title0 = await page.title();
const blocked = /just a moment|attention required|access denied|verify you are human|captcha/i.test(title0);

await page.evaluate(HELPERS);
const renderedHtml = await page.content();
fs.writeFileSync(path.join(outDir, 'rendered.html'), renderedHtml);
const screenshots = {};
screenshots.desktopFold = await shot(page, 'desktop-1440-fold', false);
screenshots.desktopFull = await shot(page, 'desktop-1440-full', true);
await page.evaluate(() => window.scrollTo(0, 0));

log('extracting DOM measurements...');
const data = await page.evaluate(EXTRACT, { maxEls: MAX_EL });

// inline / CSSOM stylesheets
const inlineSheets = await page.evaluate(() => Array.from(document.styleSheets).filter((s) => !s.href).map((s) => { try { return Array.from(s.cssRules).map((r) => r.cssText).join('\n'); } catch (e) { return ''; } }).filter(Boolean));
inlineSheets.forEach((css, i) => net.css.push({ url: 'inline-' + i, css }));
net.css.forEach((s, i) => { const name = (s.url.startsWith('inline-') ? s.url : (new URL(s.url).hostname + '_' + path.basename(new URL(s.url).pathname || 'style')).replace(/[^a-z0-9._-]/gi, '_')).slice(0, 90); try { fs.writeFileSync(path.join(cssDir, String(i).padStart(2, '0') + '_' + name + (name.endsWith('.css') ? '' : '.css')), s.css); } catch { /* ignore */ } });
const cssInfo = analyzeCss(net.css);

// resolve root CSS variables to computed values
const varNames = cssInfo.rootVariables.map((v) => v.name).slice(0, 600);
const resolved = await page.evaluate((names) => { const cs = getComputedStyle(document.documentElement); const o = {}; for (const n of names) { const v = cs.getPropertyValue(n).trim(); o[n] = { computed: v, hex: window.__dme.toHex(v) }; } return o; }, varNames);
cssInfo.rootVariables = cssInfo.rootVariables.map((v) => Object.assign(v, { computed: (resolved[v.name] || {}).computed, hex: (resolved[v.name] || {}).hex || null }));

// loaded font faces + platform fonts (what really rendered)
const loadedFonts = await page.evaluate(() => Array.from(document.fonts || []).filter((f) => f.status === 'loaded').map((f) => ({ family: f.family.replace(/^["']|["']$/g, ''), weight: f.weight, style: f.style })));
let client = null; const platformFonts = {};
try {
  client = await ctx.newCDPSession(page);
  await client.send('DOM.enable'); await client.send('CSS.enable');
  const { root } = await client.send('DOM.getDocument', { depth: 0 });
  for (const role of ['h1', 'h2', 'p', 'navLink']) {
    const info = data.roles[role]; if (!info) continue;
    try {
      const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-dme-role="${info.fontId}"]` });
      if (!nodeId) continue;
      const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
      platformFonts[role] = fonts.map((f) => ({ family: f.familyName, postScript: f.postScriptName, custom: f.isCustomFont, glyphs: f.glyphCount }));
    } catch { /* ignore */ }
  }
} catch { client = null; }

/* ---------- component state probing (hover / focus-visible / active / disabled) */
async function probeStates(list, kindLabel) {
  for (const item of list) {
    const sel = `[data-dme="${item.id}"]`;
    const loc = page.locator(sel).first();
    item.states = {};
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2500 });
      await page.waitForTimeout(120);
      const base = await loc.evaluate((el) => window.__dme.snap(el));
      let nodeId = null;
      if (client) {
        const { root } = await client.send('DOM.getDocument', { depth: 0 });
        nodeId = (await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).nodeId || null;
      }
      const force = async (pseudo) => {
        if (nodeId) { await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudo }); await page.waitForTimeout(450); const s = await loc.evaluate((el) => window.__dme.snap(el)); await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }); await page.waitForTimeout(150); return s; }
        return null;
      };
      let hover = await force(['hover']);
      if (!hover) { await loc.hover({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(450); hover = await loc.evaluate((el) => window.__dme.snap(el)); await page.mouse.move(1, 1); await page.waitForTimeout(200); }
      item.states.hover = diffSnap(base, hover);
      const focusable = await loc.evaluate((el) => el.matches('a[href],button,input,select,textarea,summary,[tabindex]'));
      if (focusable) {
        const fv = await force(['focus', 'focus-visible']);
        if (fv) item.states.focusVisible = diffSnap(base, fv);
        else { await page.keyboard.press('Shift').catch(() => {}); await loc.focus({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(250); const f2 = await loc.evaluate((el) => window.__dme.snap(el)); item.states.focusVisible = diffSnap(base, f2); await loc.evaluate((el) => el.blur()).catch(() => {}); }
        const act = await force(['hover', 'active']);
        if (act) item.states.active = diffSnap(base, act);
      }
      const canDisable = await loc.evaluate((el) => /^(button|input|select|textarea)$/i.test(el.tagName));
      if (canDisable) {
        const dis = await loc.evaluate((el) => { const had = el.disabled; el.disabled = true; const s = window.__dme.snap(el); el.disabled = had; return s; });
        item.states.disabled = diffSnap(base, dis);
      }
    } catch (e) { item.states.error = String(e.message || e).slice(0, 120); }
  }
}
if (!opt['no-states']) {
  log('probing interaction states...');
  await probeStates(data.components.buttons.slice(0, 6), 'button');
  await probeStates(data.components.inputs.slice(0, 3), 'input');
  await probeStates(data.components.cards.slice(0, 2), 'card');
  await probeStates(data.components.links.slice(0, 4), 'link');
  await probeStates(data.components.badges.slice(0, 1), 'badge');
}

/* ---------- theme-attribute dark mode probe (class / data-theme toggles) */
const themeProbe = await page.evaluate((names) => {
  const { toHex } = window.__dme; const root = document.documentElement; const body = document.body;
  const st = document.createElement('style'); st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.appendChild(st);
  const read = () => { const cs = getComputedStyle(root); const vars = {}; for (const n of names) vars[n] = cs.getPropertyValue(n).trim(); return { bodyBg: toHex(getComputedStyle(body).backgroundColor), rootBg: toHex(cs.backgroundColor), text: toHex(getComputedStyle(body).color), vars }; };
  const base = read(); const results = [];
  const mechs = [['class', 'dark'], ['data-theme', 'dark'], ['data-mode', 'dark'], ['data-bs-theme', 'dark'], ['data-color-mode', 'dark'], ['data-color-scheme', 'dark'], ['class', 'theme-dark'], ['class', 'dark-mode']];
  for (const target of [root, body]) {
    for (const [attr, val] of mechs) {
      const had = target.getAttribute(attr);
      if (attr === 'class') target.classList.add(val); else target.setAttribute(attr, val);
      const after = read();
      const changedVars = names.filter((n) => after.vars[n] !== base.vars[n]);
      if (after.bodyBg !== base.bodyBg || after.rootBg !== base.rootBg || after.text !== base.text || changedVars.length) results.push({ mechanism: (target === root ? 'html' : 'body') + (attr === 'class' ? '.' + val : '[' + attr + '="' + val + '"]'), bodyBg: after.bodyBg, text: after.text, changedVarCount: changedVars.length, sample: Object.fromEntries(changedVars.slice(0, 40).map((n) => [n, after.vars[n]])) });
      if (attr === 'class') { if (had === null) target.removeAttribute('class'); else target.setAttribute('class', had); /* restore full */ } else if (had === null) target.removeAttribute(attr); else target.setAttribute(attr, had);
    }
  }
  st.remove();
  return { baseline: { bodyBg: base.bodyBg, text: base.text }, working: results.slice(0, 4) };
}, varNames);
// restore: classList removal above replaced class attr; reload not needed (page is read-only for the rest)

/* ---------- raw HTML vs rendered (rendering strategy) */
let rendering = null;
try {
  const raw = await ctx.request.get(net.finalUrl, { timeout: 15000, failOnStatusCode: false });
  const rawHtml = await raw.text();
  const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const rawText = strip(rawHtml.replace(/^[\s\S]*?<body/i, '<body'));
  const renderedText = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim().length);
  rendering = { rawHtmlBytes: rawHtml.length, rawTextChars: rawText.length, renderedTextChars: renderedText, ratio: renderedText ? Math.round((rawText.length / renderedText) * 100) / 100 : null, rawHasH1: /<h1[\s>]/i.test(rawHtml), emptyRootDiv: /<div id=["'](root|app|__next)["']>\s*<\/div>/i.test(rawHtml) };
  rendering.classification = rendering.ratio === null ? 'unknown' : (rendering.ratio >= 0.6 ? 'server-rendered or statically generated (content present in raw HTML)' : (rendering.ratio <= 0.15 ? 'client-side rendered SPA (content absent from raw HTML)' : 'partially server-rendered / hydrated'));
} catch { rendering = null; }

/* ---------- robots / sitemap */
const origin = new URL(net.finalUrl).origin;
const site = { robots: null, sitemap: null };
try { const r = await ctx.request.get(origin + '/robots.txt', { timeout: 8000, failOnStatusCode: false }); if (r.ok()) { const t = await r.text(); if (/user-agent/i.test(t)) site.robots = { sitemaps: (t.match(/^sitemap:\s*(.+)$/gim) || []).map((s) => s.replace(/^sitemap:\s*/i, '').trim()).slice(0, 5), disallowCount: (t.match(/^disallow:/gim) || []).length }; } } catch { /* ignore */ }
try {
  const smUrl = (site.robots && site.robots.sitemaps[0]) || origin + '/sitemap.xml';
  const r = await ctx.request.get(smUrl, { timeout: 8000, failOnStatusCode: false });
  if (r.ok()) { const t = await r.text(); if (/<(urlset|sitemapindex)/i.test(t)) { const locs = (t.match(/<loc>([^<]+)<\/loc>/g) || []).map((s) => s.replace(/<\/?loc>/g, '')); site.sitemap = { url: smUrl, type: /<sitemapindex/i.test(t) ? 'index' : 'urlset', entries: locs.length, sample: locs.slice(0, 40).map((x) => { try { return new URL(x).pathname; } catch { return x; } }) }; } }
} catch { /* ignore */ }

/* ---------- performance snapshot */
const perf = await page.evaluate(() => new Promise((res) => {
  const nav = performance.getEntriesByType('navigation')[0];
  const out = { domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null, loadMs: nav ? Math.round(nav.loadEventEnd) : null, transferKB: nav ? Math.round((nav.transferSize || 0) / 1024) : null, protocol: nav ? nav.nextHopProtocol : null, resources: performance.getEntriesByType('resource').length, lcpMs: null };
  try { new PerformanceObserver((l) => { const e = l.getEntries(); out.lcpMs = Math.round(e[e.length - 1].startTime); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) { /* ignore */ }
  setTimeout(() => res(out), 500);
})).catch(() => null);
const swRegistered = await page.evaluate(async () => { try { const r = await navigator.serviceWorker.getRegistrations(); return r.length; } catch (e) { return null; } }).catch(() => null);

/* ---------- 2. tablet + mobile probes */
const PROBE = () => {
  const q = (s) => document.querySelector(s); const cs = (e) => (e ? getComputedStyle(e) : null);
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const ty = (sel) => { const e = q(sel); if (!e) return null; const s = cs(e); return { fontSize: s.fontSize, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, left: Math.round(e.getBoundingClientRect().left) }; };
  const header = q('header') || q('nav');
  const burger = Array.from(document.querySelectorAll('button,[role="button"],a,summary')).filter((e) => /menu|hamburger|burger|nav-toggle|navbar-toggler|drawer|toggle/i.test((e.getAttribute('aria-label') || '') + ' ' + (typeof e.className === 'string' ? e.className : '') + ' ' + (e.id || ''))).filter(vis).length;
  const grids = Array.from(document.querySelectorAll('*')).filter((e) => getComputedStyle(e).display === 'grid' && vis(e)).slice(0, 6).map((e) => ({ class: (typeof e.className === 'string' ? e.className : '').slice(0, 50), columns: getComputedStyle(e).gridTemplateColumns.split(' ').length }));
  return { viewport: { w: innerWidth, h: innerHeight }, h1: ty('h1'), h2: ty('h2'), h3: ty('h3'), p: ty('p'), body: { fontSize: getComputedStyle(document.body).fontSize }, headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null, visibleNavLinks: Array.from(document.querySelectorAll('header a, nav a')).filter(vis).length, visibleMenuToggles: burger, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, grids };
};
const responsive = {};
async function probeViewport(name, vp, mobile) {
  const c = await browser.newContext(ctxOpts({ viewport: vp, isMobile: !!mobile, hasTouch: !!mobile, deviceScaleFactor: mobile ? 2 : 1, colorScheme: 'light' }));
  try {
    const { page: p } = await openPage(c, targetUrl);
    await p.evaluate(HELPERS);
    responsive[name] = await p.evaluate(PROBE);
    screenshots[name] = await shot(p, name + '-' + vp.width + (mobile ? '-full' : '-full'), true);
  } catch (e) { responsive[name] = { error: String(e.message || e).slice(0, 140) }; }
  await c.close();
}
log('probing responsive viewports...');
await probeViewport('tablet', { width: 768, height: 1024 }, false);
if (!opt['no-mobile']) await probeViewport('mobile', { width: 390, height: 844 }, true);
// also probe desktop for the same fields so diffs are apples-to-apples
responsive.desktop = await page.evaluate(PROBE);
await probeViewport('wide', { width: 1920, height: 1080 }, false);

/* ---------- 3. prefers-color-scheme: dark */
let darkMode = { prefersColorScheme: null };
if (!opt['no-dark']) {
  log('probing prefers-color-scheme: dark...');
  const c = await browser.newContext(ctxOpts({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' }));
  try {
    const { page: p } = await openPage(c, targetUrl);
    await p.evaluate(HELPERS);
    const d = await p.evaluate((names) => { const { toHex } = window.__dme; const cs = getComputedStyle(document.documentElement); const vars = {}; for (const n of names) vars[n] = cs.getPropertyValue(n).trim(); const bg = (() => { let e = document.body; while (e) { const c = window.__dme.rgbaOf(getComputedStyle(e).backgroundColor); if (c && c[3] >= 0.99) return toHex(getComputedStyle(e).backgroundColor); e = e.parentElement; } return '#ffffff'; })(); return { pageBg: bg, text: toHex(getComputedStyle(document.body).color), colorScheme: cs.colorScheme, vars }; }, varNames);
    const lightVars = Object.fromEntries(varNames.map((n) => [n, (resolved[n] || {}).computed]));
    const changed = {}; for (const n of varNames) if (d.vars[n] !== lightVars[n]) changed[n] = { light: lightVars[n], dark: d.vars[n] };
    const differs = d.pageBg !== data.doc.pageBg || d.text !== data.doc.body.color || Object.keys(changed).length > 0;
    darkMode.prefersColorScheme = { supported: differs, pageBg: d.pageBg, text: d.text, colorScheme: d.colorScheme, changedVarCount: Object.keys(changed).length, changedVars: Object.fromEntries(Object.entries(changed).slice(0, 80)) };
    if (differs) screenshots.dark = await shot(p, 'dark-1440-full', true);
  } catch (e) { darkMode.prefersColorScheme = { error: String(e.message || e).slice(0, 140) }; }
  await c.close();
}
darkMode.themeAttribute = themeProbe;
darkMode.declaredDarkVariables = cssInfo.darkVariables.slice(0, 120);

await browser.close();

/* ======================================================================== *
 *  POST-PROCESS: architecture inference + digest                           *
 * ======================================================================== */
const H = net.mainHeaders || {};
const allUrls = [...net.scripts, ...net.css.map((c) => c.url), ...net.fonts.map((f) => f.url), ...(data.linkHrefs || [])];
const anyUrl = (re) => allUrls.some((u) => re.test(u));
const hostList = Object.entries(net.hosts).sort((a, b) => b[1] - a[1]);
const regDomain = (h) => h.split('.').slice(-2).join('.');
const firstParty = regDomain(new URL(net.finalUrl).hostname);
const thirdParty = hostList.filter(([h]) => regDomain(h) !== firstParty);
const T = data.tech;
const sig = [];
const add = (name, confidence, evidence, category) => sig.push({ name, confidence, evidence, category });
// frameworks
if (T.next) add('Next.js', 'high', [T.next.buildId ? '__NEXT_DATA__ present' : '/_next/static assets', T.next.nextVersion ? 'version ' + T.next.nextVersion : null, T.nextAppRouter ? 'App Router flight data (self.__next_f)' : (T.next.router === 'pages' ? 'Pages Router (__NEXT_DATA__.props)' : null)].filter(Boolean), 'framework');
if (T.nuxt) add('Nuxt', 'high', ['window.__NUXT__ / $nuxt'], 'framework');
if (T.gatsby) add('Gatsby', 'high', ['window.___gatsby'], 'framework');
if (T.remix) add('Remix / React Router framework', 'high', ['window.__remixContext'], 'framework');
if (T.sveltekit) add('SvelteKit', 'high', ['/_app/immutable assets or data-sveltekit attributes'], 'framework');
if (T.astro) add('Astro', 'high', ['astro-island / data-astro attributes'], 'framework');
if (T.angular) add('Angular', 'high', ['ng-version=' + T.angular], 'framework');
if (T.react && !T.next && !T.gatsby && !T.remix) add('React', 'high', ['React root container key / data-reactroot'], 'ui-library');
else if (T.react) add('React (under the meta-framework above)', 'high', ['React root container key'], 'ui-library');
if (T.vue && !T.nuxt) add('Vue', 'medium', ['Vue scoped-style data-v attributes / __VUE__'], 'ui-library');
if (T.svelte && !T.sveltekit) add('Svelte', 'medium', ['svelte-xxxx scoped class names'], 'ui-library');
if (T.solid) add('SolidJS', 'medium', ['window._$HY hydration marker'], 'ui-library');
if (T.qwik) add('Qwik', 'medium', ['q:container attribute'], 'framework');
if (T.htmx) add('htmx', 'high', ['window.htmx ' + T.htmx], 'library');
if (T.alpine) add('Alpine.js', 'high', ['window.Alpine'], 'library');
if (T.jquery) add('jQuery ' + T.jquery, 'high', ['window.jQuery'], 'library');
if (T.wordpress) add('WordPress', 'high', ['/wp-content/ or generator meta'], 'cms');
if (T.shopify) add('Shopify', 'high', ['window.Shopify'], 'platform');
if (T.webflow) add('Webflow', 'high', ['window.Webflow / data-wf-site'], 'platform');
if (T.framer) add('Framer', 'high', ['framer data attributes / framerusercontent assets'], 'platform');
if (T.wix) add('Wix', 'high', ['generator meta / wixBiSession'], 'platform');
if (T.squarespace) add('Squarespace', 'high', ['generator meta'], 'platform');
if (T.ghost) add('Ghost', 'high', ['generator meta'], 'cms');
if (T.metaGenerator) add('Generator meta: ' + T.metaGenerator, 'high', ['<meta name="generator">'], 'cms');
if (!T.next && !T.nuxt && !T.gatsby && !T.remix && !T.sveltekit && !T.astro) {
  if (anyUrl(/\/assets\/[^/]*-[A-Za-z0-9_-]{8}\.(js|css)/)) add('Vite build (hashed /assets/ bundles)', 'medium', ['asset filename pattern /assets/name-hash.js'], 'build');
  if (anyUrl(/\/static\/js\/main\.[0-9a-f]+\.js/)) add('Create React App / webpack (static/js/main.hash.js)', 'medium', ['CRA asset pattern'], 'build');
  if (anyUrl(/\.chunk\.js|webpack|runtime~/)) add('webpack bundling', 'low', ['chunk filename patterns'], 'build');
}
// styling
const cs = T.classStats;
if (cs.tailwindLikePct >= 35 || cs.tailwindArbitraryValues > 5 || cssInfo.tailwindVarCount > 20) add('Tailwind CSS', cs.tailwindLikePct >= 35 && cssInfo.tailwindVarCount > 20 ? 'high' : 'medium', [`${cs.tailwindLikePct}% of class tokens look like Tailwind utilities`, cssInfo.tailwindVarCount + ' --tw-* custom property declarations', cs.responsivePrefixes ? cs.responsivePrefixes + ' responsive-prefix classes' : null].filter(Boolean), 'styling');
if (cssInfo.bootstrapVarCount >= 5 || anyUrl(/bootstrap(\.min)?\.(css|js)|bootstrap@|\/bootstrap\//i)) add('Bootstrap', 'high', [cssInfo.bootstrapVarCount ? cssInfo.bootstrapVarCount + ' --bs-* custom properties' : null, anyUrl(/bootstrap/i) ? 'bootstrap asset URL' : null, cs.bootstrapDistinct ? cs.bootstrapDistinct + ' distinctive Bootstrap class tokens' : null].filter(Boolean), 'styling');
else if (cs.bootstrapDistinct >= 6) add('Bootstrap-like class names (unconfirmed)', 'low', [cs.bootstrapDistinct + ' distinctive Bootstrap class tokens, but no --bs-* variables or bootstrap asset'], 'styling');
if (sig.some((x) => x.name === 'Tailwind CSS') && cs.daisyDistinct >= 3) add('DaisyUI (on Tailwind)', 'medium', [cs.daisyDistinct + ' distinctive daisyUI class tokens alongside Tailwind'], 'styling');
if (cs.mui >= 3) add('Material UI', 'high', ['Mui* class names'], 'ui-library');
if (cs.chakra >= 3) add('Chakra UI', 'high', ['chakra-* class names'], 'ui-library');
if (cs.antd >= 3) add('Ant Design', 'high', ['ant-* class names'], 'ui-library');
if (cs.radixOrShadcnAttrs >= 1) add('Radix UI primitives (often shadcn/ui)', 'medium', [cs.radixOrShadcnAttrs + ' data-radix / data-slot / data-state elements'], 'ui-library');
if (cs.headlessUi >= 1) add('Headless UI', 'medium', ['headlessui-* ids'], 'ui-library');
if (cs.emotion >= 3) add('Emotion (CSS-in-JS)', 'medium', ['css-hash class names'], 'styling');
if (cs.styledComponents >= 3) add('styled-components', 'medium', ['sc-* class names'], 'styling');
if (cs.cssModuleHashPct >= 25) add('CSS Modules (hashed class names)', 'low', [cs.cssModuleHashPct + '% of class tokens look like module hashes'], 'styling');
if (cs.bemPct >= 20) add('BEM-style naming', 'medium', [cs.bemPct + '% of class tokens contain __ or --'], 'styling');
if (T.gsap) add('GSAP', 'high', ['window.gsap ' + T.gsap], 'animation');
if (T.lenis) add('Lenis smooth scroll', 'high', ['Lenis global / html.lenis'], 'animation');
if (T.locomotive) add('Locomotive Scroll', 'medium', ['data-scroll-container'], 'animation');
if (T.three) add('three.js', 'high', ['window.THREE'], 'animation');
if (T.lottie) add('Lottie', 'high', ['lottie global / element'], 'animation');
if (T.framerMotion) add('Framer Motion (likely)', 'low', ['will-change transforms on React app'], 'animation');
// hosting / cdn
const hosting = [];
const hadd = (n, c, e) => hosting.push({ name: n, confidence: c, evidence: e });
if (H['x-vercel-id'] || /vercel/i.test(H.server || '')) hadd('Vercel', 'high', ['x-vercel-id / server header']);
if (H['x-nf-request-id'] || /netlify/i.test(H.server || '')) hadd('Netlify', 'high', ['x-nf-request-id / server header']);
if (H['cf-ray'] || /cloudflare/i.test(H.server || '')) hadd('Cloudflare (CDN/proxy)', 'high', ['cf-ray / server: cloudflare']);
if (H['x-amz-cf-id'] || /cloudfront/i.test(H.via || '')) hadd('AWS CloudFront', 'high', ['x-amz-cf-id / via']);
if (/github\.com/i.test(H.server || '') || H['x-github-request-id']) hadd('GitHub Pages', 'high', ['server / x-github-request-id']);
if (H['fly-request-id']) hadd('Fly.io', 'high', ['fly-request-id']);
if (H['x-render-origin-server']) hadd('Render', 'high', ['x-render-origin-server']);
if (H['x-azure-ref']) hadd('Azure Front Door/CDN', 'high', ['x-azure-ref']);
if (H['x-served-by'] && /cache-/i.test(H['x-served-by'])) hadd('Fastly (CDN)', 'medium', ['x-served-by: cache-*']);
if (/firebase/i.test(net.finalUrl) || H['x-firebase-hosting'] !== undefined) hadd('Firebase Hosting', 'medium', ['domain/header']);
if (H['x-powered-by']) hadd('x-powered-by: ' + H['x-powered-by'], 'high', ['response header']);
if (H.server && !hosting.length) hadd('server: ' + H.server, 'medium', ['response header']);
// API / backend (only what is observable)
const apiHosts = new Map();
for (const x of net.xhr) { let h = ''; try { h = new URL(x.url).hostname; } catch { /* ignore */ } apiHosts.set(h, (apiHosts.get(h) || 0) + 1); }
const backends = [];
const badd = (n, e) => backends.push({ name: n, evidence: e });
for (const x of net.xhr) {
  if (/\.supabase\.(co|in)/.test(x.url)) badd('Supabase', x.url.split('?')[0]);
  else if (/firestore\.googleapis\.com|firebaseio\.com|identitytoolkit\.googleapis\.com/.test(x.url)) badd('Firebase', x.url.split('?')[0]);
  else if (/\/graphql/i.test(x.url) || x.graphql) badd('GraphQL endpoint', x.url.split('?')[0]);
  else if (/\/api\/trpc/.test(x.url)) badd('tRPC', x.url.split('?')[0]);
  else if (/algolia(net)?\.(com|net)/.test(x.url)) badd('Algolia search', x.url.split('?')[0]);
  else if (/cdn\.sanity\.io|\.sanity\.io/.test(x.url)) badd('Sanity CMS', x.url.split('?')[0]);
  else if (/contentful\.com/.test(x.url)) badd('Contentful CMS', x.url.split('?')[0]);
  else if (/stripe\.com/.test(x.url)) badd('Stripe', x.url.split('?')[0]);
  else if (/clerk\.|auth0\.com/.test(x.url)) badd('Clerk/Auth0 auth', x.url.split('?')[0]);
  else if (/\/api\//.test(x.url)) badd('/api/ endpoint (same-origin or first-party)', x.url.split('?')[0]);
}
const dedupBackends = Array.from(new Map(backends.map((b) => [b.name + b.evidence, b])).values()).slice(0, 25);
const thirdPartyHints = thirdParty.filter(([h]) => /googletagmanager|google-analytics|doubleclick|facebook|hotjar|segment|mixpanel|intercom|sentry|clarity|posthog|plausible|cloudinary|imgix|fonts\.(googleapis|gstatic)|typekit|fontawesome|cdnjs|jsdelivr|unpkg|stripe|recaptcha|youtube|vimeo|hubspot|crisp|drift|zendesk|shopify|cloudflareinsights/i.test(h)).slice(0, 25);

const googleFonts = net.css.filter((c) => /fonts\.googleapis\.com/.test(c.url)).map((c) => { try { return new URL(c.url).searchParams.getAll('family'); } catch { return []; } }).flat();
const fontSource = { googleFontsRequested: googleFonts, adobeTypekit: anyUrl(/typekit\.net/), selfHostedFontFiles: net.fonts.filter((f) => { try { return regDomain(new URL(f.url).hostname) === firstParty; } catch { return false; } }).slice(0, 12).map((f) => path.basename(new URL(f.url).pathname)), thirdPartyFontHosts: Array.from(new Set(net.fonts.map((f) => { try { return new URL(f.url).hostname; } catch { return ''; } }).filter((h) => h && regDomain(h) !== firstParty))), loadedFaces: loadedFonts, declaredFontFaceCount: cssInfo.fontFaces.length };

const architecture = {
  detectedStack: sig,
  rendering,
  hosting,
  security: { https: net.finalUrl.startsWith('https'), hsts: !!H['strict-transport-security'], csp: !!H['content-security-policy'], xFrameOptions: H['x-frame-options'] || null, referrerPolicy: H['referrer-policy'] || null, permissionsPolicy: !!H['permissions-policy'] },
  delivery: { contentEncoding: H['content-encoding'] || null, httpProtocol: perf && perf.protocol, cacheControlHtml: H['cache-control'] || null, altSvc: H['alt-svc'] ? 'advertised' : null },
  requests: { byType: net.types, approxTransferKB: Math.round(net.bytes / 1024), note: 'approxTransferKB only counts responses that expose content-length', firstPartyDomain: firstParty, thirdPartyHosts: thirdParty.slice(0, 30).map(([h, n]) => ({ host: h, requests: n })), thirdPartyHints: thirdPartyHints.map(([h, n]) => ({ host: h, requests: n })) },
  api: { xhrFetchCount: net.xhr.length, hosts: Array.from(apiHosts, ([h, n]) => ({ host: h, requests: n })).sort((a, b) => b.requests - a.requests).slice(0, 10), identifiedBackends: dedupBackends, sample: net.xhr.slice(0, 40).map((x) => ({ method: x.method, url: x.url.split('#')[0].slice(0, 160), status: x.status, contentType: x.contentType.split(';')[0], graphql: x.graphql })), websockets: net.ws.slice(0, 5) },
  structure: data.structure, site, perf, pwa: { manifest: data.seo.manifest, serviceWorkers: swRegistered, themeColor: data.seo.themeColor }, seo: data.seo, a11y: data.a11y,
  notObservable: ['server-side code and language', 'databases and data models', 'authenticated routes and private APIs', 'CI/CD and repository structure', 'business logic'],
};

const colorsWithContrast = data.colors.text.slice(0, 10).map((c) => Object.assign({}, c, { contrastOnPageBg: contrast(c.value, data.doc.pageBg) }));
const contrastPairsMeasured = data.colors.contrastPairs.map((p) => ({ text: p.text, background: p.bg, ratio: contrast(p.text, p.bg), weight: p.count, approximateBackground: p.approxBackground, sizePx: p.sizePx, weight_: p.weight, passAA: (contrast(p.text, p.bg) || 0) >= ((p.sizePx >= 24 || (p.sizePx >= 18.66 && Number(p.weight) >= 700)) ? 3 : 4.5) }));
const spacingAll = [...data.spacing.padding, ...data.spacing.margin, ...data.spacing.gap];
const mergedHist = Array.from(spacingAll.reduce((m, x) => m.set(x.value, (m.get(x.value) || 0) + x.count), new Map()), ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
const baseUnit = inferBaseUnit(mergedHist.filter((x) => x.value >= 2));

const report = {
  tool: { name: 'design-md-extractor', version: '1.0.0', chromium: major, measuredAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000) },
  source: { requestedUrl: targetUrl, finalUrl: net.finalUrl, httpStatus: net.mainStatus, title: title0, blockedOrChallenge: blocked, viewportUsed: '1440x900 desktop (also 768, 390, 1920)' },
  document: data.doc, roles: data.roles, platformFonts, fontSource,
  colors: Object.assign({}, data.colors, { textWithContrast: colorsWithContrast, contrastPairsMeasured: contrastPairsMeasured }),
  typography: data.typography,
  spacing: Object.assign({}, data.spacing, { baseUnit, merged: mergedHist.slice(0, 30) }),
  shape: data.shape, motion: Object.assign({}, data.motion, { keyframes: cssInfo.keyframes, hasReducedMotionRules: cssInfo.hasReducedMotionRules }),
  layout: Object.assign({}, data.layout, { breakpoints: cssInfo.breakpoints, mediaFeatures: cssInfo.mediaFeatures }),
  components: data.components, responsive, darkMode,
  cssVariables: { rootVariables: cssInfo.rootVariables, count: cssInfo.rootVariables.length, otherScopedVariableCount: cssInfo.otherScopedVariableCount, tailwindVarCount: cssInfo.tailwindVarCount },
  css: { sheets: net.css.map((c) => ({ url: c.url, bytes: c.css.length })), atRules: cssInfo.atRules, declaredFontFamilies: cssInfo.declaredFontFamilies, fontFaces: cssInfo.fontFaces, hasFocusVisibleRules: cssInfo.hasFocusVisibleRules },
  architecture, screenshots,
  gaps: [blockedRequests.length ? 'Blocked by the private-address guard (not fetched): ' + Array.from(new Set(blockedRequests)).join(', ') : null, 'Interaction states measured via forced pseudo-classes on up to 6 buttons, 3 inputs, 2 cards, 4 links (see components[].states).', 'Scroll-triggered, JS-driven or WebGL effects are only detected by library fingerprint, not reproduced.', 'Content behind login, geo, A/B tests or consent walls is not captured.', 'Mega-menus / modals not rendered at load are not measured.', blocked ? 'WARNING: page title suggests a bot challenge/blocked page; results may describe the challenge page, not the site.' : null].filter(Boolean),
};
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

/* ---------- tokens.draft.json */
const tokens = {
  source: net.finalUrl,
  colors: { pageBackground: data.doc.pageBg, text: data.colors.text.slice(0, 10).map((c) => c.value), backgrounds: data.colors.bg.slice(0, 12).map((c) => c.value), borders: data.colors.border.slice(0, 6).map((c) => c.value), gradients: data.colors.gradients.slice(0, 5).map((g) => g.value) },
  fonts: { primary: (data.typography.families[0] || {}).value, families: data.typography.families.map((f) => f.value), stacks: data.typography.stacks.map((s) => s.value) },
  typeScale: data.typography.styles.slice(0, 24).map((s) => ({ role: s.role, family: s.family, size: s.size, weight: s.weight, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, transform: s.transform })),
  spacing: { baseUnit: baseUnit.chosen, values: mergedHist.slice(0, 16).map((x) => x.value).sort((a, b) => a - b) },
  radii: data.shape.radii.map((r) => r.value), shadows: data.shape.shadows.map((s) => s.value),
  breakpoints: cssInfo.breakpoints.map((b) => b.query), containers: data.layout.containers.slice(0, 4).map((c) => c.value),
  cssVariables: Object.fromEntries(cssInfo.rootVariables.map((v) => [v.name, v.computed || v.declared])),
};
fs.writeFileSync(path.join(outDir, 'tokens.draft.json'), JSON.stringify(tokens, null, 2));

/* ---------- digest.md (compact, agent-readable) */
const D = [];
const P = (s = '') => D.push(s);
P(`# Extraction digest: ${net.finalUrl}`);
P(`Measured ${report.tool.measuredAt} with Chromium ${major}; ${report.tool.seconds}s. Full data: report.json. Screenshots: ${Object.values(screenshots).filter(Boolean).join(', ')}`);
if (blocked) P(`\n> **WARNING:** page title "${title0}" looks like a bot-challenge/blocked page. Do not trust the numbers below.`);
P(`\n## Page\n- Title: ${data.doc.title}\n- lang: ${data.doc.lang || '(none)'}; html font-size: ${data.doc.html.fontSize}; body: ${data.doc.body.fontSize}/${data.doc.body.lineHeight} ${data.doc.body.color} on page bg ${data.doc.pageBg}\n- color-scheme: ${data.doc.html.colorScheme}; scroll-behavior: ${data.doc.html.scrollBehavior}; ::selection: ${cssInfo.hasSelectionRules ? (data.doc.selectionMeasured ? data.doc.selectionMeasured.color + ' on ' + data.doc.selectionMeasured.background : 'custom rule present') : 'browser default (no custom rule)'}\n- Document height ${data.doc.scrollHeight}px; ${data.doc.totalElements} elements (${data.doc.sampledVisible} visible measured)`);
P(`\n## CSS variables on :root (${cssInfo.rootVariables.length}; verbatim names)\n`);
P(mdTable(['name', 'declared', 'computed', 'hex'], cssInfo.rootVariables.slice(0, 120).map((v) => [v.name, String(v.declared).slice(0, 70), String(v.computed || '').slice(0, 50), v.hex || ''])));
P(`## Colors\nPage background: **${data.doc.pageBg}**\n`);
P('### Backgrounds (weighted by painted area)\n' + mdTable(['hex', 'weight'], data.colors.bg.map((c) => [c.value, c.count])));
P('### Text / background pairs actually used (weighted by characters; WCAG contrast measured against the element\'s real background)\n' + mdTable(['text', 'on background', 'contrast', 'AA pass', 'size', 'weight', 'chars', 'bg approximate?'], contrastPairsMeasured.map((c) => [c.text, c.background, c.ratio, c.passAA, c.sizePx + 'px', c.weight_, c.weight, c.approximateBackground ? 'yes (gradient/image/alpha above)' : 'no'])));
P('### Borders\n' + mdTable(['hex', 'sides'], data.colors.border.map((c) => [c.value, c.count])));
P('### Gradients\n' + (data.colors.gradients.length ? data.colors.gradients.map((g) => `- (${g.count}×) \`${g.value}\``).join('\n') : '_none detected_') + `\n- gradient-clipped text elements: ${data.colors.textGradientElements}; elements with url() backgrounds: ${data.colors.bgImageUrlElements}\n`);
P('### SVG fills / strokes\n' + mdTable(['kind', 'hex', 'count'], [...data.colors.svgFill.map((c) => ['fill', c.value, c.count]), ...data.colors.svgStroke.map((c) => ['stroke', c.value, c.count])]));
P(`## Typography\nFamilies (by text volume): ${data.typography.families.map((f) => `${f.value} (${f.count})`).join(', ')}\n\nFull stacks: ${data.typography.stacks.map((s) => '`' + s.value + '`').join(' ; ')}\n`);
P('Actually rendered fonts (CDP platform fonts): ' + (Object.keys(platformFonts).length ? Object.entries(platformFonts).map(([k, v]) => `${k}→${v.map((f) => f.family + (f.custom ? ' [web font]' : ' [system]')).join('+')}`).join('; ') : 'unavailable') + '\n');
P(`Font sources: Google Fonts families requested: ${googleFonts.join(', ') || 'none'}; Adobe Typekit: ${fontSource.adobeTypekit}; self-hosted files: ${fontSource.selfHostedFontFiles.join(', ') || 'none'}; third-party font hosts: ${fontSource.thirdPartyFontHosts.join(', ') || 'none'}\nLoaded faces: ${loadedFonts.map((f) => `${f.family} ${f.weight} ${f.style}`).join('; ') || 'none reported'}\n`);
P('### Role samples (first visible element of each role, desktop)\n' + mdTable(['role', 'size', 'weight', 'line-height (ratio)', 'letter-spacing (em)', 'transform', 'color', 'margin t/b', 'sample'], Object.entries(data.roles).map(([k, v]) => [k, v.fontSize, v.fontWeight, v.lineHeight + ' (' + v.lineHeightRatio + ')', v.letterSpacing + ' (' + v.letterSpacingEm + 'em)', v.textTransform, v.color, v.marginTop + ' / ' + v.marginBottom, v.sample])));
P('### Type styles in use (ranked by text volume)\n' + mdTable(['role', 'family', 'size', 'weight', 'line-height (ratio)', 'letter-spacing (em)', 'transform', 'elements', 'sample'], data.typography.styles.slice(0, 28).map((s) => [s.role, s.family, s.size, s.weight, s.lineHeight + ' (' + s.lineHeightRatio + ')', s.letterSpacing + ' (' + s.letterSpacingEm + 'em)', s.transform, s.els, s.sample])));
P('### Distinct font sizes\n' + data.typography.sizes.map((s) => `${s.value} (${s.count})`).join(', ') + '\n');
P(`## Spacing\nInferred base unit: **${baseUnit.chosen}px** (coverage by base: ${baseUnit.coverage.map((c) => c.base + 'px=' + Math.round(c.coverage * 100) + '%').join(', ')})\n`);
P('Most-used spacing values (padding+margin+gap): ' + mergedHist.slice(0, 24).map((x) => `${x.value}px(${x.count})`).join(', ') + '\n');
P('Section vertical padding: ' + (data.spacing.sectionPadding.map((x) => `${x.value}px(${x.count})`).join(', ') || 'n/a') + '\n');
P(`## Shape & depth\nRadii: ${data.shape.radii.map((r) => `${r.value}(${r.count})`).join(', ') || 'none'}; pill-shaped elements: ${data.shape.pillElements}\n\nBorder widths: ${data.spacing.borderWidths.map((b) => b.value + '(' + b.count + ')').join(', ') || 'none'}\n`);
P('### Shadows\n' + (data.shape.shadows.length ? data.shape.shadows.map((s) => `- (${s.count}×) \`${s.value}\``).join('\n') : '_none detected_') + '\n');
P(`z-index values: ${data.shape.zIndex.map((z) => z.value + '(' + z.count + ')').join(', ') || 'none'}; backdrop-filter: ${data.shape.backdropFilters.map((b) => b.value).join(', ') || 'none'}; filter: ${data.shape.filters.map((b) => b.value).join(', ') || 'none'}\n`);
P(`## Layout\nMax-width constraints (page containers are the widest ones; narrow ones are text measures): ${data.layout.containers.map((c) => `${c.value} on <${c.tag} class="${c.class}"> (actual ${c.actualWidth}px, padding-left ${c.paddingLeft}, ×${c.count})`).join('; ') || 'none'}\n\nGrids: ${data.layout.grids.map((g) => `${g.value} [${g.resolvedColumns}] ×${g.count}`).join('; ') || 'none'}\n\nDisplay usage: ${data.layout.displays.map((d) => d.value + '(' + d.count + ')').join(', ')}; positioned: ${data.layout.positions.map((d) => d.value + '(' + d.count + ')').join(', ')}\n`);
P('### Breakpoints declared in CSS (`@media`/`@container` width conditions)\n' + mdTable(['condition', 'px', 'uses'], cssInfo.breakpoints.map((b) => [b.query, b.px, b.count])));
P('Media features: ' + (cssInfo.mediaFeatures.map((m) => m.value + '(' + m.count + ')').join(', ') || 'none') + '\n');
P('### Fixed / sticky elements\n' + mdTable(['tag', 'class', 'position', 'top', 'rect', 'bg', 'z', 'backdrop'], data.layout.fixedSticky.map((f) => [f.tag, f.class, f.position, f.top, `${f.rect.w}x${f.rect.h}@y${f.rect.y}`, f.bg, f.z, f.backdropFilter])));
if (data.layout.header) { const h = data.layout.header; P(`### Header\nheight ${h.rect.h}px; bg ${h.style.backgroundColor}; border-bottom ${h.style.borderBottomWidth} ${h.style.borderBottomColor}; position ${h.style.position}; backdrop ${h.style.backdropFilter}; shadow ${h.style.boxShadow}; padding ${h.style.paddingTop}/${h.style.paddingLeft}\n`); }
if (data.layout.hero) { const h = data.layout.hero; P(`### Hero\n<${h.tag} class="${h.class}"> ${h.rect.w}x${h.rect.h}px, bg ${h.bg}, bg-image \`${h.backgroundImage}\`, padding ${h.paddingTop}/${h.paddingBottom}, text-align ${h.textAlign}, display ${h.display}, min-height ${h.minHeight}, media: ${h.hasMedia}, CTAs: ${h.ctas.join(' | ')}\nH1: "${h.h1Text}" ${h.h1.fontSize}/${h.h1.lineHeight} w${h.h1.fontWeight} ls ${h.h1.letterSpacing} ${h.h1.color}\n` + (h.lead ? `Lead: ${h.lead.fontSize}/${h.lead.lineHeight} ${h.lead.color} — "${h.lead.text}"\n` : '')); }
if (data.layout.footer) { const f = data.layout.footer; P(`### Footer\nbg ${f.bg}, text ${f.color}, padding ${f.paddingTop}/${f.paddingBottom}, border-top ${f.borderTop}, height ${f.height}px, ${f.linkCount} links, ${f.columns || '?'} columns\n`); }
P('### Page sections (top-level order)\n' + mdTable(['#', 'tag', 'class', 'height', 'bg', 'padding t/b', 'display', 'heading'], data.layout.sections.map((s, i) => [i + 1, s.tag + (s.id ? '#' + s.id : ''), s.class, s.height, s.bg, s.paddingTop + '/' + s.paddingBottom, s.display, s.heading])));
P('### Heading outline\n' + data.layout.headings.slice(0, 40).map((h) => `- ${h.tag}: ${h.text}`).join('\n') + '\n');
P(`## Components (measured; states via forced :hover/:focus-visible/:active; "active" is the full resolved pressed state and therefore includes hover effects)\n`);
for (const [label, list] of [['Buttons', data.components.buttons], ['Links', data.components.links], ['Inputs', data.components.inputs], ['Cards', data.components.cards], ['Badges', data.components.badges]]) {
  P(`### ${label}`);
  if (!list.length) { P('_none detected_\n'); continue; }
  list.forEach((c, i) => {
    const s = c.style;
    P(`**${label.slice(0, -1)} variant ${i + 1}** — ×${c.count}${c.kind ? ', ' + c.kind : ''}, <${c.tag} class="${c.class.slice(0, 70)}"> "${c.text}"`);
    P(`- default: bg ${s.backgroundColor}; color ${s.color}; border ${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}; radius ${s.borderRadius}; padding ${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}; font ${s.fontSize}/${s.lineHeight} w${s.fontWeight} ls ${s.letterSpacing} ${s.textTransform}; size ${s.__w}x${s.__h}; shadow ${s.boxShadow}; transition ${s.transition}; cursor ${s.cursor}` + (s.textDecorationLine && s.textDecorationLine !== 'none' ? `; text-decoration ${s.textDecorationLine}` : '') + (s.backgroundImage && s.backgroundImage !== 'none' ? `; bg-image ${s.backgroundImage.slice(0, 120)}` : ''));
    if (c.states) { for (const [k, v] of Object.entries(c.states)) if (k !== 'error') P(`- ${k}: ${fmtDiff(v)}`); if (c.states.error) P(`- (state probe error: ${c.states.error})`); }
    P(`- html: \`${c.html.slice(0, 300)}\``);
  });
  P('');
}
const im = data.components.images, ic = data.components.icons;
P(`### Imagery & icons\nImages: ${im.count} (lazy ${im.lazy}); object-fit ${im.objectFit.map((x) => x.value + '(' + x.count + ')').join(', ') || 'n/a'}; radii ${im.radius.map((x) => x.value + '(' + x.count + ')').join(', ') || 'n/a'}; aspect ratios ${im.ratios.map((x) => x.value + '(' + x.count + ')').join(', ') || 'n/a'}; videos ${im.videos}; canvases ${im.canvases}\nIcons: ${ic.svgCount} inline SVG; sizes ${ic.sizes.map((x) => x.value + '(' + x.count + ')').join(', ') || 'n/a'}; stroke widths ${ic.strokeWidths.map((x) => x.value + '(' + x.count + ')').join(', ') || 'n/a'}; fill/stroke modes ${ic.fillModes.map((x) => x.value + '(' + x.count + ')').join(', ') || 'n/a'}; icon-font prefixes ${ic.iconFonts.map((x) => x.value).join(', ') || 'none'}\n`);
P(`## Motion\nTransitions in use:\n${data.motion.transitions.map((t) => `- (${t.count}×) ${t.value}`).join('\n') || '_none_'}\n\nDurations: ${data.motion.durations.map((d) => d.value + '(' + d.count + ')').join(', ') || 'n/a'}; easings: ${data.motion.easings.map((d) => d.value + '(' + d.count + ')').join(' ; ') || 'n/a'}\nRunning animations: ${data.motion.animations.map((a) => a.value + ' ×' + a.count).join('; ') || 'none'}\nKeyframes declared: ${Object.keys(cssInfo.keyframes).join(', ') || 'none'}; prefers-reduced-motion rules: ${cssInfo.hasReducedMotionRules}\n`);
P('## Responsive probes\n' + mdTable(['viewport', 'h1', 'h2', 'p', 'header h', 'header/nav links visible', 'menu toggles', 'h-overflow', 'h1 left'], Object.entries(responsive).map(([k, v]) => v.error ? [k, 'error: ' + v.error, '', '', '', '', '', '', ''] : [k + ' ' + v.viewport.w + 'px', v.h1 ? v.h1.fontSize + '/' + v.h1.lineHeight : '', v.h2 ? v.h2.fontSize : '', v.p ? v.p.fontSize : '', v.headerHeight, v.visibleNavLinks, v.visibleMenuToggles, v.horizontalOverflow, v.h1 ? v.h1.left : ''])));
P('Grid columns by viewport: ' + Object.entries(responsive).map(([k, v]) => `${k}: ${(v.grids || []).map((g) => g.columns + ' cols').join(', ') || 'none'}`).join(' | ') + '\n');
const dm = darkMode.prefersColorScheme;
P(`## Dark mode\n- prefers-color-scheme: ${dm ? (dm.error ? 'error ' + dm.error : (dm.supported ? `SUPPORTED — page bg ${dm.pageBg}, text ${dm.text}, ${dm.changedVarCount} root variables change` : 'no change detected')) : 'not tested'}\n- class/attribute toggle: ${themeProbe.working.length ? themeProbe.working.map((w) => `${w.mechanism} → body ${w.bodyBg}, text ${w.text}, ${w.changedVarCount} vars`).join('; ') : 'none of html/body .dark, [data-theme], [data-mode], [data-bs-theme] changed the page'}\n- dark-scoped variable declarations in CSS: ${cssInfo.darkVariables.length}\n`);
if (dm && dm.changedVars && Object.keys(dm.changedVars).length) P('### Variables that change in dark (light → dark)\n' + mdTable(['variable', 'light', 'dark'], Object.entries(dm.changedVars).slice(0, 60).map(([k, v]) => [k, String(v.light).slice(0, 50), String(v.dark).slice(0, 50)])));
P(`## Architecture signals\n### Detected stack (confidence reflects evidence strength)\n` + mdTable(['technology', 'confidence', 'category', 'evidence'], sig.map((s) => [s.name, s.confidence, s.category, s.evidence.join('; ')])));
P('Hosting / CDN / server: ' + (hosting.map((h) => `${h.name} [${h.confidence}] (${h.evidence.join(', ')})`).join('; ') || 'no identifying headers') + '\n');
P(`Rendering: ${rendering ? `${rendering.classification} — raw HTML text ${rendering.rawTextChars} chars vs rendered ${rendering.renderedTextChars} chars (ratio ${rendering.ratio}); raw has <h1>: ${rendering.rawHasH1}; empty root div: ${rendering.emptyRootDiv}` : 'not measured'}\n`);
P(`API / data layer observed (XHR/fetch during load): ${net.xhr.length} calls. Backends: ${dedupBackends.map((b) => b.name).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'none identified'}. Hosts: ${architecture.api.hosts.map((h) => h.host + '×' + h.requests).join(', ') || 'none'}. WebSockets: ${net.ws.length}\n`);
P('### Request mix\n' + Object.entries(net.types).map(([k, v]) => `${k}: ${v}`).join(', ') + `; approx transfer (declared content-length only): ${Math.round(net.bytes / 1024)} KB\n\nThird-party hosts: ${thirdPartyHints.map(([h, n]) => h + '×' + n).join(', ') || 'none notable'}\n`);
P(`Security headers: HSTS ${architecture.security.hsts}, CSP ${architecture.security.csp}, X-Frame-Options ${architecture.security.xFrameOptions}, Referrer-Policy ${architecture.security.referrerPolicy}\nDelivery: encoding ${architecture.delivery.contentEncoding}, protocol ${architecture.delivery.httpProtocol}, html cache-control ${architecture.delivery.cacheControlHtml}\nPerformance (this run): DCL ${perf && perf.domContentLoadedMs}ms, load ${perf && perf.loadMs}ms, LCP ${perf && perf.lcpMs}ms, ${perf && perf.resources} resources\nPWA: manifest ${data.seo.manifest || 'none'}, service workers ${swRegistered}, theme-color ${data.seo.themeColor || 'none'}\n`);
P('### Class-name conventions\n' + JSON.stringify(Object.fromEntries(Object.entries(cs).filter(([k]) => k !== 'sample'))) + '\n');
P('### Navigation tree\n' + (data.structure.navTree.map((n) => `- ${n.text} → ${n.href}` + (n.children.length ? '\n' + n.children.map((c) => `  - ${c.text} → ${c.href}`).join('\n') : '')).join('\n') || '_none_') + '\n');
P('### Internal routes seen in links\n' + data.structure.internalLinks.slice(0, 50).map((l) => `- ${l.path}  (${l.text})`).join('\n') + '\n');
if (site.sitemap) P(`### sitemap.xml\n${site.sitemap.type}, ${site.sitemap.entries} entries; sample: ${site.sitemap.sample.slice(0, 25).join(', ')}\n`);
P('### Forms\n' + (data.structure.forms.map((f) => `- ${f.method.toUpperCase()} ${f.action || '(self)'}: ${f.fields.map((x) => x.name || x.type).join(', ')}`).join('\n') || '_none_') + '\n');
P(`### SEO / meta\ntitle: ${data.seo.title}\ndescription: ${data.seo.description}\ncanonical: ${data.seo.canonical}; og keys: ${Object.keys(data.seo.og).join(', ')}; twitter: ${data.seo.twitterCard}; JSON-LD: ${data.seo.jsonLdTypes.join(', ') || 'none'}; icons: ${data.seo.icons.length}\nPreconnect: ${data.seo.preconnect.join(', ') || 'none'}\n`);
P(`### Accessibility signals\nlandmarks ${JSON.stringify(data.a11y.landmarks)}; h1 count ${data.a11y.h1Count}; images ${data.a11y.imgCount} (missing alt ${data.a11y.imgsMissingAlt}); skip link ${data.a11y.skipLink}; aria-labels ${data.a11y.ariaLabelCount}; unnamed buttons ${data.a11y.buttonsWithoutName}; :focus-visible rules in CSS ${cssInfo.hasFocusVisibleRules}\n`);
P('## Gaps (do not invent these)\n' + report.gaps.map((g) => '- ' + g).join('\n') + '\n- Not observable from outside: ' + architecture.notObservable.join('; ') + '\n');
fs.writeFileSync(path.join(outDir, 'digest.md'), D.join('\n'));

console.log(JSON.stringify({ ok: true, outDir, files: { digest: path.join(outDir, 'digest.md'), report: path.join(outDir, 'report.json'), tokens: path.join(outDir, 'tokens.draft.json'), screenshots: shotDir }, blocked }, null, 2));
