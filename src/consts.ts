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

  /**
   * Physical location — single source of truth for the Contact page address
   * block, its map embed, and the JSON-LD `PostalAddress`. Update here and all
   * three follow. `entryNote` is the arrival instruction shown under the
   * address; set it to an empty string to hide the line.
   */
  address: {
    street: "21325 S 154th St",
    locality: "Gilbert",
    region: "AZ",
    postalCode: "85298",
    entryNote:
      "Please enter through the gate — mind the dogs, and be sure to close it behind you.",
  },

  /**
   * Registration links, per team. Null until the BoldSign templates are live;
   * the Register page falls back to "contact your coach" while they are, so
   * the page never advertises a link that does not work yet.
   *
   * These are signing-flow URLs, not forms on this site — participant data is
   * never collected by this static site. See scripts/README.md.
   */
  registration: {
    samurai: null as string | null,
    jedi: null as string | null,
  },

  /**
   * Social media profiles — single source of truth for the footer links and
   * the JSON-LD `sameAs` array. Add/remove a profile here and both update.
   * `icon` is the SVG path data (24x24 viewBox) for the brand glyph, from
   * Simple Icons (simpleicons.org).
   */
  socials: [
    {
      name: "Instagram",
      url: "https://www.instagram.com/_tiedyesamurai/",
      icon: "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.073.321 18.2004.1197 16.9231.0645 15.6458.0093 15.2347-.0014 11.9762.0048 8.7177.011 8.3091.0256 7.0301.0838m.1402 21.6932c-1.17-.0509-1.8051-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9.423-.1651 1.0575-.3612 2.227-.4171 1.2655-.0599 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8051-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077",
    },
    {
      name: "YouTube",
      url: "https://www.youtube.com/@Tiedyesamurai",
      icon: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
    },
    {
      name: "Facebook",
      url: "https://www.facebook.com/stemplusc",
      icon: "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z",
    },
  ],
} as const;
