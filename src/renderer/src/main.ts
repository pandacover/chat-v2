import { mount } from 'svelte'
import './app.css'
// Applies the theme before first paint.
import './lib/theme.svelte'
import './lib/appearance.svelte'
import App from './App.svelte'
import { loadHighlighter } from './lib/highlight.svelte'

export default mount(App, { target: document.getElementById('app')! })

// Code highlighting loads once the window is idle, so it is usually ready before code shows.
requestIdleCallback(() => void loadHighlighter(), { timeout: 2000 })
