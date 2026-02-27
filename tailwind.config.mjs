/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        navy: '#29386b',
        'brand-blue': '#5bb7e8',
        'brand-red': '#a61c1c',
      },
    },
  },
  plugins: [],
};
