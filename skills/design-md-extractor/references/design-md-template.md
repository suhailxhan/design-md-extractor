# DESIGN.md template (required structure)

Every section must appear, in this order. Write "None detected" for empty ones. Source of every value: `digest.md` / `report.json`. Tag non-measured statements `[inferred: high|medium|low]`.

````markdown
# DESIGN.md: <Site name>

- Source: <final URL> · Measured: <date> · Viewports: 1440 / 768 / 390 / 1920
- Fidelity: values marked **[measured]** come from computed styles; **[inferred]** are deductions.
- Visual summary: <2 to 3 sentences: mood, density, light/dark, signature move>

## 1. Design principles [inferred]
3 to 6 bullets (e.g. "High contrast black on white, one accent color, generous whitespace"). Each cites evidence.

## 2. Color
### 2.1 Palette (semantic roles)
| Role | Token (site's own name if any) | Hex | Used for | Contrast |
Roles: background, surface, surface-alt, text, text-muted, border, primary, primary-hover, accent, success, warning, danger, overlay.
Only list roles actually found. Rank by usage weight.
### 2.2 Text/background pairs and WCAG
Copy from digest "pairs actually used". Flag any failing AA.
### 2.3 Gradients and effects
Exact CSS values. Mention text-gradient, glass (backdrop-filter), overlays.
### 2.4 Dark mode
Mechanism (prefers-color-scheme / `[data-theme]` / class), then a light → dark table of every variable that changes. If unsupported: "No dark mode".

## 3. Typography
- Families: name, role (heading/body/mono), source (Google Fonts / self-hosted / system), fallback stack **verbatim**.
- If proprietary: name it, say it is licensed, propose the closest open alternative.
### Type scale
| Role | Size | Weight | Line-height (ratio) | Letter-spacing (em) | Transform | Color | Margin t/b |
Rows: display/h1, h2, h3, h4, body, lead, small, caption, label, button, nav, code.
Include the mobile override for each size that changes (from responsive probes).

## 4. Spacing and layout
- Base unit (with coverage %), scale list, section vertical padding, container max-width + side padding, grid columns and gaps, header height, content measure (max text width).
- Breakpoints (from CSS) and what changes at each (from probes).

## 5. Shape and depth
Radius scale with where each is used; border widths; shadow scale (exact values); z-index layers; blur/backdrop.

## 6. Components
For each of: button (every variant), link, input/select/textarea, card, badge/chip, navbar, hero, footer, modal/dropdown (if observed), icons, imagery.
Per variant give: purpose · measured default · hover · focus-visible · active · disabled · exact CSS block · HTML skeleton.

## 7. Motion
Durations, easings (exact cubic-bezier), per-component transitions, keyframes (name + frames), scroll/animation libraries, reduced-motion behavior.

## 8. Page structure
Ordered sections of the page with: purpose, background, padding, layout, heading, and CTA. Navigation tree. Routes seen.

## 9. System architecture [measured / inferred]
Follow `references/architecture-inference.md`. Include: rendering strategy, framework, styling system, UI library, hosting/CDN, data layer observed, third-party services, SEO/PWA/security/performance, and a "Not observable" list.

## 10. Implementation kit
### 10.1 `:root` variables (ready to paste)
### 10.2 Tailwind theme (only if it maps cleanly)
### 10.3 Suggested file/folder structure for a rebuild [inferred]
### 10.4 Rebuild checklist (ordered)

## 11. Accessibility notes
Landmarks, focus style, contrast failures, missing alt, reduced motion.

## 12. Verification log
Result of the step-6 visual comparison: viewport, what matched, remaining diffs.

## 13. Gaps and usage notes
What was not captured. Reminder: do not reuse logos, trademarks, copy, photography or proprietary fonts.
````

## Rules for filling it in

1. **Hex everywhere**, lowercase. Keep alpha as 8-digit hex or `rgba()` where it matters.
2. **Keep the site's own variable names** if `--color-*` etc. exist. Otherwise invent semantic names and say so.
3. **Never round measured values.** 1.6 stays 1.6, `-0.02em` stays `-0.02em`.
4. **Merge near-duplicates** only when within 2 RGB units and say you merged.
5. **Prefer the digest's weighted ranking** over your impression of the screenshot.
6. **State what you checked.** Section 12 must list real comparison results, not a claim.
