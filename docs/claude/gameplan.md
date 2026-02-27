# STEM+C Website Redesign Gameplan

## Overview

- **Domain**: stemplusc.org (hosting stays as-is)
- **Organization**: STEM+C, 501(c)(3) nonprofit, EIN: 83-3523903
- **Location**: Gilbert, Arizona
- **Current Platform**: WordPress with Divi theme (replacing)
- **New Platform**: Astro static site
- **Assets**: ~4900 robotics photos/videos in `photos/` folder

---

## Tech Stack

```
┌─────────────────────────────────────────────────────┐
│                    FRONTEND                          │
│  Astro - Static site generator                       │
│  + Tailwind CSS for styling                          │
│  + Markdown/MDX for content (blog posts)             │
│  + Astro Image for optimization                      │
└─────────────────────────────────────────────────────┘
                         │
┌─────────────────────────────────────────────────────┐
│                     HOSTING                          │
│  Existing server (DirectAdmin)                       │
│  - Deploy via FTP/SSH                                │
│  - Build locally or via GitHub Actions               │
│  - Static HTML output = no server-side maintenance   │
└─────────────────────────────────────────────────────┘
                         │
┌─────────────────────────────────────────────────────┐
│                   INTEGRATIONS                       │
│  Donations: Zeffy (already chosen)                   │
│  Forms: Formspree or email endpoint                  │
│  Analytics: Google Analytics + Search Console        │
│  Social: Instagram, YouTube                          │
└─────────────────────────────────────────────────────┘
```

---

## Site Structure

```
/                   Home
/about              About Us
/programs           Programs (FRC focus)
/donate             Donate (links to Zeffy)
/contact            Contact form
/news               Blog/News (optional)
/legacy/*           Archived content from old site (not in nav)
```

---

## Page Content (from your brief)

### HOME
- **Hero**: "Hands-on STEM education that builds the future."
- **Tagline**: Join our community of engineers, coders, and makers in Gilbert, AZ
- **CTAs**: Join a Program | Donate | Become a Mentor
- **Sections**:
  - What We Do (nonprofit focused on robotics, aeronautics, hands-on engineering)
  - Why STEM+C? (Real tools, inclusive teams, learn by doing, career pathways, mentorship)
  - Join the Team (students, mentors, sponsors)
- **Visuals**: Large photos, gallery/carousel of student activities

### ABOUT
- Mission statement
- Who We Are (501c3, Gilbert AZ, 10+ years)
- FIRST partnership: FLL (2 yrs), FTC (7 yrs), FRC (1 yr)
- Community team - any school or homeschool welcome
- Philosophy + FDR quote
- Alumni impact (Columbia, ASU, UofA, NAU, SDSU, UW → Intel, AMD, HP)
- Safety & Inclusion (background checks, code of conduct)

### PROGRAMS
- **Current**: FIRST Robotics Competition (FRC)
  - Skills: CAD, 3D printing, software, project mgmt, business, outreach
  - Community-based, no experience required
  - CTA: Join the Team, Parent Info Packet
- **Past Programs**: FLL, FTC (archived, not featured)

### DONATE
- What donations support (tools, competition fees, scholarships, outreach)
- 100% goes to student programs
- Ways to give: One-time, Monthly, Corporate matching, In-kind
- **Donate button → Zeffy**
- **Sponsor button → Sponsorship PDF**
- EIN: 83-3523903

### CONTACT
- Email: info@stemplus.org
- Location: Gilbert, Arizona
- Social: Instagram, YouTube
- Contact form: Name, Email, Message

---

## Design Direction

### Brand
- Official STEM+C logo (consistent usage)
- Primary Blue: `#29386b`
- Accent Blue: `#2ea3f2`
- Clean, professional, mobile-responsive

### Requirements
- Accessibility-friendly (alt text, contrast, readable fonts)
- Photo-heavy (especially Home and Programs)
- Gallery/carousel for events
- Optional video embeds (if performance allows)
- SEO optimized
- Secure forms with CAPTCHA

---

## Implementation Phases

### Phase 1: Project Setup
- [ ] Initialize Astro project
- [ ] Set up Tailwind CSS
- [ ] Create base layout (header, footer, nav)
- [ ] Add STEM+C logo and brand colors
- [ ] Set up deployment to existing server

### Phase 2: Core Pages
- [ ] Home page (hero, sections, CTAs)
- [ ] About page
- [ ] Programs page (FRC focus)
- [ ] Donate page (Zeffy integration)
- [ ] Contact page (form)

### Phase 3: Enhancements
- [ ] Photo gallery component
- [ ] Image optimization pipeline
- [ ] Blog/news section (if wanted)
- [ ] Legacy content archive

### Phase 4: Polish & Launch
- [ ] SEO (meta tags, sitemap, robots.txt)
- [ ] Google Analytics + Search Console
- [ ] Accessibility audit
- [ ] Performance optimization
- [ ] Deploy and DNS cutover

### Future Phase
- [ ] Dedicated FRC team microsite (separate project)

---

## Assets & Links

- **Logo**: `assets/logo.png`
- **Sponsorship PDF**: `assets/sponsorship.pdf`
- **Zeffy donation**: https://www.zeffy.com/en-US/donation-form/donate-to-make-a-difference-12690
- **Instagram**: https://www.instagram.com/_tiedyesamurai/
- **YouTube**: https://www.youtube.com/@Tiedyesamurai
- **Brand colors**:
  - Navy blue: `#29386b` (primary text)
  - Light blue: `#5bb7e8` (accents, swoops)
  - Red/maroon: `#a61c1c` (accent)
  - Black (secondary text)

## Still Needed

1. **Photo curation** - All 4900 photos or a curated set for gallery?
2. **Legacy content** - What specifically needs to be preserved?

## Confirmed

- **Contact form** - submissions via email (info@stemplus.org)

---

## Next Steps

1. Answer open questions above
2. Get logo and any brand assets
3. Start Phase 1 implementation
