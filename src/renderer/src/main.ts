import { mount } from 'svelte'
import './app.css'
// Applies the theme before first paint.
import './lib/theme.svelte'
import './lib/appearance.svelte'
import App from './App.svelte'

export default mount(App, { target: document.getElementById('app')! })
