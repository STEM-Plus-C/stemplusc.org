import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://stemplusc.org',
  vite: {
    plugins: [tailwindcss()],
  },
});
