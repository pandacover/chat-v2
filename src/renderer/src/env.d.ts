/// <reference types="svelte" />
/// <reference types="vite/client" />
/// <reference path="../../preload/index.d.ts" />

// Electron's <webview> tag, used by the built-in browser.
declare module 'svelte/elements' {
  interface SvelteHTMLElements {
    webview: import('svelte/elements').HTMLAttributes<HTMLElement> & { src?: string; partition?: string; allowpopups?: boolean }
  }
}
export {}
