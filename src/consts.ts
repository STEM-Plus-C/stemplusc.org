/**
 * Shared site copy — the single source of truth for STEM+C's canonical
 * statements that are meant to appear verbatim across multiple pages.
 *
 * Centralize only text that should stay identical everywhere (the mission and
 * the org one-liner). Per-page SEO `description` meta tags are intentionally
 * tuned per page (~150 chars) and stay local to each page, not here.
 */
export const SITE = {
  /** Formal mission statement (About page "Our Mission" block). */
  mission:
    "STEM+C transforms students into the next generation of engineers, innovators, and leaders through hands-on robotics, real-world projects, and mentorship from industry professionals.",

  /** Vision statement (About page "Our Vision" block). */
  vision:
    "A future where every student has access to authentic engineering experiences and pathways to high-impact STEM careers.",

  /** Org one-liner repeated verbatim in the footer and JSON-LD structured data. */
  orgOneLiner:
    "STEM+C is a 501(c)(3) nonprofit in Gilbert, Arizona, transforming students into the next generation of engineers, innovators, and leaders through hands-on robotics, real-world projects, and industry mentorship.",

  /** Home page hero tagline / rallying cry. */
  tagline: "Real projects. Real mentors. Real engineers.",

  /** Supporting impact line for sponsor/grant-facing contexts (not the headline mission). */
  impact: "Building Arizona's future engineering workforce—one student at a time.",
} as const;
