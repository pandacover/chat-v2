import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  // Every package but one is a devDependency, so it is bundled into out/. (A package under
  // "dependencies" is left external and copied in whole: effect alone was 41 MB of app.asar.)
  // The one is the Claude Agent SDK, kept external on purpose: it finds and starts Claude Code,
  // a native binary in its platform package, which electron-builder unpacks beside app.asar.
  main: {
    resolve: { alias: shared }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // The computer-use overlay (src/main/computer) gets its own, much smaller bridge.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          computer: resolve(__dirname, 'src/preload/computer.ts')
        },
        // Sandboxed preloads must be a single CommonJS file.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: { alias: { ...shared, '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [svelte(), tailwindcss()],
    build: {
      // electron-vite leaves the renderer unminified by default: 740 KB of script to parse at startup.
      minify: true,
      rollupOptions: {
        // The computer-use overlay is a page of its own.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          'computer-overlay': resolve(__dirname, 'src/renderer/computer-overlay.html')
        }
      }
    }
  }
})
