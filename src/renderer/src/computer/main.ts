// The computer-use overlay page: the acting frame and the Show-me spotlight (Overlay.svelte).
import '@fontsource-variable/inter'
import '@fontsource-variable/geist-mono'
import { mount } from 'svelte'
import Overlay from './Overlay.svelte'

mount(Overlay, { target: document.getElementById('app')! })
