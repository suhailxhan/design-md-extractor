# Contributing

Thanks for helping make `design-md-extractor` better. Accuracy is the whole point of this project, so changes are judged by one question: **does the output stay true to what the website really does?**

## Quick start

```bash
git clone https://github.com/suhailxhan/design-md-extractor
cd design-md-extractor
npm i --no-save playwright && npx playwright install chromium
node skills/design-md-extractor/scripts/selftest.mjs   # must print SELFTEST PASSED
```

## Repository layout

```
.claude-plugin/        Claude Code plugin + marketplace manifests
.cursor-plugin/        Cursor plugin manifest
.codex-plugin/         Codex plugin manifest
.agents/plugins/       Codex marketplace manifest
skills/design-md-extractor/
  SKILL.md             the instructions agents follow
  scripts/extract.mjs  the measuring script (Playwright)
  scripts/selftest.mjs ground-truth tests
  scripts/fixtures/    the test website with known values
  references/          template + architecture guide + fallback
assets/                logo and README animations
install.mjs            installs the skill into all four tools
```

## Ground rules

1. **Every behaviour change needs a test.** Add a known value to `scripts/fixtures/demo/index.html` and a `check(...)` in `selftest.mjs`. If you fix a bug, add a regression check first and watch it fail.
2. **Measure, don't guess.** Anything not read from the browser must be labelled `[inferred]` with a confidence, or `[not observable]`.
3. **No new runtime dependencies** without discussion. The only dependency is Playwright.
4. **Keep SKILL.md frontmatter portable**: only `name` and `description`, so it loads in Claude Code, Codex, Antigravity and Cursor. The `name` must equal the folder name.
5. **Security first.** Do not weaken the private-address guard. See [SECURITY.md](SECURITY.md).
6. Node 18+ compatible. Plain ES modules, no build step.

## Pull requests

- One logical change per PR, with a clear description of the problem and the evidence.
- `node skills/design-md-extractor/scripts/selftest.mjs` passes locally. CI runs it on Node 18, 20 and 22.
- Update `CHANGELOG.md` under **Unreleased**.
- If you touch a manifest, run `claude plugin validate .` when you can.

## Reporting bugs

Use the bug template and include the URL (or a minimal HTML file), the command you ran, and the relevant part of `digest.md`. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
