import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),

    VitePWA({
      registerType: 'autoUpdate',

      includeAssets: ['icon.svg'],

      manifest: {
        name: 'WIs App',
        short_name: 'WIs App',
        description: 'Wildlife Indicators Monitoring',

        theme_color: '#24583c',
        background_color: '#f2f6f1',

        display: 'standalone',
        start_url: './',
        scope: './',

        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },

      workbox: {
        navigateFallback: 'index.html',
        globPatterns: [
          '**/*.{js,css,html,svg,png,ico}',
        ],
      },
    }),
  ],
})