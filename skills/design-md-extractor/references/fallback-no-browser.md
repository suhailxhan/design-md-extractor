# Fallback when Playwright/Chromium cannot run

Accuracy drops, so say so in the DESIGN.md header: "Fidelity: static analysis, lower confidence".

1. Install first if at all possible: `npm i -D playwright && npx playwright install chromium` (needs network access to the Playwright CDN). In restricted sandboxes ask the user to allow package installs.
2. Otherwise fetch the page HTML and every linked stylesheet with the agent's web fetch tool or `curl -L`.
3. Parse CSS: collect `:root` custom properties, `@font-face`, `@media` breakpoints, `@keyframes`, and the rules for `body, h1..h6, a, button, .btn, input, .card`.
4. Mark each value `[declared]` (from CSS source, not computed) and resolve `var()` chains by hand. Do not claim computed accuracy.
5. Hover/focus states: read `:hover`, `:focus-visible`, `:active` rules directly from CSS.
6. Architecture: use only response headers, HTML markers, and script URLs.
7. Ask the user for screenshots (desktop + mobile) so visual structure can be described accurately.
8. Skip step 6 (visual verification) only if no browser exists, and write that in the Verification log.

## Blocked or authenticated sites
- Bot challenge / 403 / Cloudflare page: the extractor flags `blockedOrChallenge`. Do not try to evade protections. Ask for a saved HTML+CSS export ("Save page as, complete") and run the extractor on `file:///path/page.html --allow-private` (file:// is refused by default as a safety measure).
- Login-gated pages: ask the user to export the logged-in page the same way.
