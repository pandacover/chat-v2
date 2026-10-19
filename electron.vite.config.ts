import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  // Every package is a devDependency, so it is bundled into out/ and electron-builder
  // ships no node_modules. (A package under "dependencies" is left external and copied
  // in whole: effect alone was 41 MB of app.asar.)
  main: {
    resolve: { alias: shared }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // The overlay that draws computer use on screen gets its own, much smaller bridge.
        input: { index: resolve(__dirname, 'src/preload/index.ts'), overlay: resolve(__dirname, 'src/preload/overlay.ts') },
        // Sandboxed preloads must be a single CommonJS file.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: { alias: { ...shared, '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [svelte(), tailwindcss()],
    build: {
      rollupOptions: {
        // The overlay and the hidden page that streams the screen for computer use are pages of their own.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          capture: resolve(__dirname, 'src/renderer/capture.html')
        }
      }
    }
  }
})
