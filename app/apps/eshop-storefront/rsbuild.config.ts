import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const BFF_PORT = Number(process.env.ESHOP_STOREFRONT_PORT ?? 3060);

export default defineConfig({
  html: {
    meta: {
      description: 'Kavárna Doma – prezentační DEMO e-shop nad platformou OntOS. Nic se neplatí ani nedoručuje.',
      robots: 'noindex, nofollow',
      'theme-color': '#2b1d16',
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
    },
    tags: [{ attrs: { href: '/img/favicon.svg', rel: 'icon', type: 'image/svg+xml' }, tag: 'link' }],
    title: 'Kavárna Doma · DEMO e-shop',
  },
  output: { cleanDistPath: true, distPath: { root: 'dist' } },
  plugins: [pluginReact()],
  server: {
    historyApiFallback: true,
    port: 3061,
    proxy: { '/api': `http://127.0.0.1:${BFF_PORT}` },
  },
  source: { entry: { index: './src/main.tsx' } },
});
