import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // Sandboxed preloads must be a single CommonJS file.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: { alias: { ...shared, '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [svelte(), tailwindcss()]
  }
})
