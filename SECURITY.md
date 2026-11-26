# Security Policy

`design-md-extractor` opens websites in a real browser and writes files to your machine, so security matters here. Thank you for helping keep it safe.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

1. Open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting), or
2. use this direct link: <https://github.com/suhailxhan/design-md-extractor/security/advisories/new>

Please include: affected version, what you did, what you expected, what happened, and a minimal reproduction (a URL or HTML file is ideal).

What to expect from the maintainer, [Suhail Khan](https://github.com/suhailxhan):

- acknowledgement within **3 business days**
- an initial assessment within **7 days**
- a fix or mitigation plan within **30 days** for confirmed issues, with credit in the changelog unless you prefer to stay anonymous

Please give us a reasonable chance to fix an issue before disclosing it publicly.

## Threat model

The extractor loads **untrusted web pages** in headless Chromium and turns what it measures into files and text that an AI coding agent will read. The main risks, and what the project does about them:

| Risk | Mitigation |
| --- | --- |
| **SSRF**: tricking the tool into reading localhost, a company LAN or cloud metadata (`169.254.169.254`) | Private, loopback, link-local and multicast addresses, `localhost`, `*.local`, `*.internal` and `file://` are refused by default. The check runs on the target, every redirect and every sub-request. Opt in only with `--allow-private`. Covered by the self-test. |
| **Prompt injection**: a scanned site hides text such as "ignore previous instructions" that ends up in `digest.md` | `SKILL.md` tells agents that page content is data, never instructions, and forbids running anything found on the scanned site. |
| **Malicious page code** | Pages run in a fresh, logged-out, isolated Playwright browser context with no access to your cookies, profile or local files. The tool never executes downloaded files. |
| **Path or file clobbering** | Output goes only to the `--out` folder, in a per-host sub-folder with sanitised names. |
| **Supply chain** | Zero runtime dependencies in this repository apart from Playwright, which the user installs. CI and Dependabot keep GitHub Actions current. |
| **Secrets in output** | The tool sends no credentials and reads no environment secrets. Output contains only what a public page already exposes. Review `rendered.html` before sharing it, because a page can embed tokens of its own. |

## Known limitations

- **DNS rebinding**: the address check resolves a hostname before the browser connects, so a hostile DNS server could in theory answer differently the second time. Run the tool inside a container or network namespace with no route to private networks if this matters to you.
- Websocket connections opened by a page are not filtered by the address guard.
- An egress proxy that resolves hostnames itself makes local DNS checks unavailable; in that case the proxy's own policy applies.
- Headless Chromium has its own vulnerabilities. Keep Playwright up to date (`npm i -g playwright@latest && npx playwright install chromium`).

## Safe-use guidance

- Only scan sites you are allowed to scan and respect their terms of service and `robots.txt`.
- Do not use `--allow-private` with URLs you did not choose yourself.
- Do not paste `digest.md` or `report.json` from an untrusted site into an agent that has powerful tools without reading it first.
- Do not copy logos, trademarks, copyrighted text, photography or proprietary fonts from the sites you analyse.
