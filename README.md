<p align="center">
  <img src="assets/banner.svg" alt="design-md-extractor banner" width="100%">
</p>

# design-md-extractor

Give your AI coding tool a URL, get a `DESIGN.md` (design system + page structure + system architecture) back.
Works in **Claude Code, OpenAI Codex, Google Antigravity and Cursor** (all use the open `SKILL.md` format).

## Install

```bash
# 1. one-time: browser for the measuring script
npm i -g playwright && npx playwright install chromium

# 2. install the skill into all four tools (global)
node install.mjs

# or only some tools / only this project
node install.mjs --tool claude,cursor
node install.mjs --project
node install.mjs --uninstall
```

| Tool | Global folder | Project folder |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.agents/skills/` | `.agents/skills/` |
| Antigravity | `~/.gemini/config/skills/` | `.agents/skills/` |
| Cursor | `~/.cursor/skills/` | `.cursor/skills/` |

Manual install: copy this folder (renamed `design-md-extractor`) into any folder above.

## Use

Restart the tool and say:

> Create a DESIGN.md from https://stripe.com

Or invoke directly: `/design-md-extractor https://stripe.com` (Claude Code, Cursor, Antigravity) or `$design-md-extractor` (Codex).

## What it measures (real Chromium, not guesses)

Computed colors with usage weights and WCAG contrast pairs · CSS variables (verbatim) · fonts actually rendered · type scale with line-height ratios and letter-spacing in em · spacing base unit · radii, shadows, blur · buttons, links, inputs, cards, badges with **hover / focus-visible / active / disabled** states · layout containers, grids, header, hero, footer, section order · breakpoints and what changes at 768 / 390 / 1920 · dark mode (media query and class/attribute toggles) · motion (durations, easings, keyframes) · architecture signals (rendering strategy, framework, styling system, hosting/CDN, API calls, third parties, SEO, PWA, security headers, performance).

## Verify the toolchain

```bash
node scripts/selftest.mjs     # 88 ground-truth checks against a fixture page
```

## Honest limits

- Server code, databases, auth and private APIs cannot be seen from outside. The skill labels architecture as measured / inferred / not observable and never invents the rest.
- Login-gated or bot-protected sites: export the page as "complete HTML" and run on its `file://` path.
- Scroll-triggered, WebGL and heavy JS animations are detected by library fingerprint, not reproduced.
- Do not copy logos, trademarks, copyrighted text, photography or proprietary fonts.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Suhail Khan.
