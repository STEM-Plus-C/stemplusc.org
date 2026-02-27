# STEM+C Website

Official website for STEM+C Creative Robotics — Home of the Tie Dye Samurai.

**Live site:** https://stemplusc.org

## Quick Start

```bash
# Install dependencies
npm install

# Start local development server
npm run dev

# Build for production
npm run build

# Deploy to production
npm run deploy
```

## Local Development

1. Start the dev server:
   ```bash
   npm run dev
   ```
2. Open http://localhost:4321 in your browser
3. Changes auto-reload as you edit files

## Adding Content

### Photos

Drop images into the appropriate folder — they auto-appear on the site:

| Folder | Purpose |
|--------|---------|
| `src/assets/images/hero/` | Homepage slideshow (auto-rotates every 5s) |
| `src/assets/images/gallery/` | Gallery page "Highlights" section |
| `src/assets/images/team/` | Gallery page "Team" section |
| `src/assets/images/robots/` | Gallery page "Robots" section |

**Supported formats:** `.jpg`, `.jpeg`, `.png`, `.webp`

Images are automatically optimized during build (WebP conversion, responsive sizes).

### Sponsor Logos

Drop logos into tier folders:

```
src/assets/images/sponsors/
├── founding/      # $5,000+ sponsors
├── premium/       # $2,000+ sponsors
├── grand/         # $1,000+ sponsors
└── team-sponsor/  # $500+ sponsors
```

**Supported formats:** `.jpg`, `.jpeg`, `.png`, `.webp`, `.svg`

The filename becomes the sponsor name (dashes/underscores become spaces).

## Editing Pages

| Page | File |
|------|------|
| Home | `src/pages/index.astro` |
| About | `src/pages/about.astro` |
| Programs | `src/pages/programs.astro` |
| Gallery | `src/pages/gallery.astro` |
| Sponsors | `src/pages/sponsors.astro` |
| Donate | `src/pages/donate.astro` |
| Contact | `src/pages/contact.astro` |

### Components

| Component | File |
|-----------|------|
| Header/Nav | `src/components/Header.astro` |
| Footer | `src/components/Footer.astro` |
| Hero Slideshow | `src/components/HeroSlideshow.astro` |

## Deployment

Deploy to production with one command:

```bash
npm run deploy
```

This will:
1. Build the optimized static site
2. Upload to the server via rsync

**Server:** `stemplus@vda3300.is.cc`
**Web root:** `domains/stemplusc.org/public_html/`

### Manual Deployment

If you prefer manual deployment:

```bash
npm run build
# Upload contents of dist/ folder to your server
```

## Project Structure

```
stemplusc.org/
├── src/
│   ├── assets/images/     # Images (auto-optimized)
│   │   ├── hero/          # Homepage slideshow
│   │   ├── gallery/       # Gallery highlights
│   │   ├── team/          # Team photos
│   │   ├── robots/        # Robot photos
│   │   └── sponsors/      # Sponsor logos by tier
│   ├── components/        # Reusable components
│   ├── layouts/           # Page layouts
│   ├── pages/             # Site pages
│   └── styles/            # Global CSS
├── public/                # Static assets (copied as-is)
│   ├── logo.svg           # Site logo
│   ├── mascot.png         # Tie Dye Samurai mascot
│   └── sponsorship.pdf    # Sponsorship packet
├── docs/                  # Documentation
└── dist/                  # Built site (git-ignored)
```

## Brand Colors

| Color | Hex | Usage |
|-------|-----|-------|
| Team Navy Blue | `#081F3F` | Headers, primary backgrounds |
| Team Electric Blue | `#1DAEFF` | Links, accents |
| Seasonal Purple | `#7030a0` | CTA buttons |
| Cool Steel Grey | `#5F6B76` | Secondary text |
| White | `#FFFFFF` | Backgrounds |

## Key Links

- **Donation:** https://www.zeffy.com/en-US/donation-form/donate-to-make-a-difference-12690
- **Instagram:** https://www.instagram.com/_tiedyesamurai/
- **YouTube:** https://www.youtube.com/@Tiedyesamurai
- **Contact:** info@stemplus.org
- **Team Contact:** tie-dye-admin@stemplusc.org

## Tech Stack

- **Framework:** [Astro](https://astro.build/) (static site generator)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/)
- **Images:** Sharp (auto-optimization)
- **Hosting:** DirectAdmin server via SSH/rsync

## Organization Info

**STEM+C Creative Robotics**
501(c)(3) Nonprofit
EIN: 83-3523903
3316 E Maplewood St, Gilbert, AZ 85297
