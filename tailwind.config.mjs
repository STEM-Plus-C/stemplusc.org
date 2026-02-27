/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // Tie Dye Samurai Official Palette
        navy: '#081F3F',           // Team Navy Blue
        electric: '#1DAEFF',       // Team Electric Blue
        steel: {
          light: '#8F9AA6',        // Cool Steel Grey (light)
          DEFAULT: '#5F6B76',      // Cool Steel Grey (medium)
        },
        seasonal: '#7030a0',       // Seasonal Purple

        // Aliases for convenience
        'brand-blue': '#1DAEFF',   // Electric Blue
        'brand-purple': '#7030a0', // Seasonal Purple (accent/CTA)
      },
    },
  },
  plugins: [],
};
