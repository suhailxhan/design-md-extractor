# Inferring system architecture from outside

The extractor's "Architecture signals" section gives measured evidence. Turn it into DESIGN.md section 9 using these rules. **Label every line** `[measured]`, `[inferred: high|medium|low]` or `[not observable]`.

## What can be measured (state as fact)
- Rendering: compare raw HTML text vs rendered text (`rendering.ratio`). ≥0.6 server-rendered/static; ≤0.15 client-side SPA; between = hybrid/hydrated.
- Framework fingerprints with high confidence: `__NEXT_DATA__`, `/_next/static`, `__NUXT__`, `___gatsby`, `__remixContext`, `ng-version`, `astro-island`, `/_app/immutable`.
- Response headers: hosting/CDN (`x-vercel-id`, `x-nf-request-id`, `cf-ray`, `x-amz-cf-id`...), HSTS, CSP, compression, HTTP protocol, cache-control.
- Network calls made during load: hosts, paths, GraphQL vs REST, WebSockets, third parties.
- CSS tooling: Tailwind (`--tw-*` variables plus utility classes), Bootstrap (`--bs-*`), CSS Modules hashes, BEM.
- SEO/PWA: meta tags, Open Graph, JSON-LD types, sitemap, robots, manifest, service workers.
- Fonts source, image formats, lazy-loading, performance timings from this run.

## What can be inferred (label with confidence)
| Observation | Inference | Confidence |
|---|---|---|
| `/_next/static` and `self.__next_f` | Next.js App Router with RSC | high |
| `__NEXT_DATA__` with `pageProps` | Next.js Pages Router | high |
| Hashed `/assets/index-xxxx.js`, empty `#root` | Vite SPA | medium |
| `/static/js/main.hash.js` | Create React App | medium |
| Supabase / Firebase host in XHR | BaaS backend | high (it is observed) |
| `/api/trpc` | tRPC | high |
| `data-radix-*`, `data-slot` | Radix primitives, likely shadcn/ui | medium |
| Tailwind classes plus `cn()` style merged classes | shadcn/ui pattern | low |
| `x-powered-by: Express` | Node/Express origin | medium (headers can lie) |
| `cf-ray` only | Cloudflare in front, origin unknown | high for CDN, none for origin |

## Never claim
Database engine, server language, auth implementation, internal APIs behind login, CI/CD, repo layout, business logic. Put them under **Not observable**. If the user needs a plausible backend design, add a clearly separated "Suggested backend for a rebuild" subsection labelled as a recommendation, not as a finding.

## Output shape for section 9
```
### Rendering            [measured] server-rendered, ratio 0.94
### Framework            [inferred: high] Next.js App Router (evidence: ...)
### Styling              [measured] Tailwind (62% utility tokens, 480 --tw vars)
### UI primitives        [inferred: medium] Radix / shadcn
### Hosting / CDN        [measured] Vercel (x-vercel-id)
### Data layer observed  [measured] 3 fetches to /api/..., 1 GraphQL
### Third parties        [measured] GA4, Stripe.js, Sentry
### Security headers     [measured] HSTS yes, CSP no
### Performance (1 run)  [measured] LCP 1.2 s, 38 requests
### Not observable       server code, database, auth, CI/CD
### Suggested rebuild structure [inferred] app/, components/ui/, lib/, ...
```
