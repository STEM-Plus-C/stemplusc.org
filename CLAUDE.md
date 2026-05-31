# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Marketing/informational site for **STEM+C**, a 501(c)(3) nonprofit in Gilbert, AZ (brand: "Tie Dye Samurai"). Static site built with Astro 6 + Tailwind CSS v4, deployed to a DirectAdmin server via rsync. Live at https://stemplusc.org.

**Requires Node ≥22.12.0** (Astro 6 dropped Node 18). An `.nvmrc` pins Node 22 — run `nvm use` before `npm install`/`build`/`deploy`.

**Sister site:** `../tiedyesamurai.org` (deploys to tiedyesamurai.org) is the FRC Team 10933 site — a *program of* STEM+C built on the same Astro/Tailwind/rsync stack. The two are tied at the hip: shared org, branding, hosting server, and architecture. When changing conventions here (image-loading pattern, brand colors, deploy flow), check whether the sibling repo should change in lockstep.

**Co-hosted sites:** `../7stalks.com` and `../pointcircle.com` are separate, unrelated Astro projects that happen to deploy to the *same server* (`vda3300.is.cc`) via the same `rsync --delete` pattern, each into its own `domains/<name>/public_html/`. They share no org or branding with STEM+C — relevant only as deploy-target neighbors (don't cross-deploy) and as reference implementations of the same hosting setup.

## Commands

```bash
npm run dev      # local dev server at http://localhost:4321
npm run build    # static build to dist/
npm run preview  # serve the built dist/ locally
npm run deploy   # build, then rsync dist/ to the production server
```

There is no test suite, linter, or typecheck step configured. `tsconfig.json` only extends Astro's strict preset for editor type-checking.

**Deploy is destructive:** `npm run deploy` runs `rsync -avz --delete dist/` to `stemplus@vda3300.is.cc:domains/stemplusc.org/public_html/`. The `--delete` flag removes anything on the server not in the local build. Requires SSH access to the server.

## Architecture

### Content lives in the filesystem, not in code

The defining pattern of this codebase: **images are discovered automatically by where they sit on disk.** Pages use `import.meta.glob(..., { eager: true })` to pull every file from a category folder under `src/assets/images/` — there is no manifest or registration step. Drop a file in the right folder and it appears on the next build.

- **Hero slideshow** (`src/pages/index.astro` → `HeroSlideshow.astro`): globs `src/assets/images/hero/`, shuffles, auto-rotates client-side (5s, pauses on hover).
- **Gallery** (`src/pages/gallery.astro`): separate globs for `gallery/`, `team/`, `robots/`.
- **Sponsors** (`src/pages/sponsors.astro`): one folder per tier — `sponsors/{founding,premium,grand,team-sponsor}/`. The **filename becomes the sponsor name** (extension stripped, `-`/`_` → spaces). Raster images and SVGs use *separate* globs because they import differently (raster → `ImageMetadata`; SVG → `?url` string).

Consequence: glob patterns list both lower- and upper-case extensions explicitly, e.g. `*.{jpg,jpeg,png,webp,JPG,JPEG,PNG,WEBP}`, to be case-insensitive. **When adding a new image category, copy an existing glob verbatim** and keep the full case-insensitive extension list — a missing variant silently drops files.

### Two image roots, two purposes

- `src/assets/images/` — processed by `astro:assets` (Sharp): WebP conversion, responsive `widths`, lazy loading. Go through the `Image` component or the `OptimizedImage.astro` wrapper. Referenced via glob/import, never by string path.
- `public/` — served as-is (logo, mascot, PDFs, favicons, `.htaccess`, `robots.txt`). Referenced by absolute URL path (`/logo.png`).

### Layout & SEO

Every page wraps in `src/layouts/BaseLayout.astro`, which owns all `<head>` metadata: Open Graph, Twitter cards, canonical URL, and a JSON-LD `NonProfit` block. Pages pass `title` (and optionally `description`, `image`) as props rather than writing their own head tags.

### Styling

Tailwind CSS **v4**, wired via the `@tailwindcss/vite` plugin in `astro.config.mjs` (not the old `@astrojs/tailwind` integration, which doesn't support Astro 6). There is **no `tailwind.config.mjs`** — all configuration is CSS-first in `src/styles/global.css`:

- Brand palette lives in the `@theme` block (`--color-navy`, `--color-electric`, `--color-steel`/`--color-steel-light`, `--color-seasonal`, `--color-brand-blue`, `--color-brand-purple`), which generates utilities like `bg-navy`, `text-brand-blue`. Use these tokens, not raw hex.
- **Custom element styles must stay inside `@layer base`.** In v4, unlayered CSS overrides layered Tailwind utilities regardless of specificity — an unlayered `a {}`/`h1 {}` rule will silently beat `text-navy` etc. on those elements.
- A border-color compatibility shim (in `@layer base`) preserves v3's default `gray-200` borders.
