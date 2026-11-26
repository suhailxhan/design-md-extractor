# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-26

### Added
- Skill that turns a website URL into a measured `DESIGN.md` (13-section template).
- Playwright extractor measuring colors with usage weights, WCAG contrast pairs, CSS variables, rendered fonts, type scale (line-height ratio, letter-spacing in em), spacing base unit, radii, shadows, motion, layout, breakpoints, responsive probes (390 / 768 / 1440 / 1920) and dark mode (media query and class/attribute toggles).
- Component state probing (hover, focus-visible, active, disabled) through forced pseudo-classes.
- Architecture signals with confidence labels: rendering strategy, framework, styling system, hosting/CDN, API calls, third parties, SEO, PWA, security headers and performance.
- Private-address guard (blocks localhost, private networks, cloud metadata and `file://` unless `--allow-private`).
- Plugin manifests for Claude Code, Cursor and Codex, plus an installer for Claude Code, Codex, Antigravity and Cursor.
- 93-check ground-truth self-test with a fixture website.
- MIT license, security policy, contributing guide, code of conduct, issue and PR templates, CI and Dependabot.

[Unreleased]: https://github.com/suhailxhan/design-md-extractor/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/suhailxhan/design-md-extractor/releases/tag/v1.0.0
