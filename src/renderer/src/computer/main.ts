// The computer-use overlay page: the acting frame and the Show-me spotlight (Overlay.svelte), and Point.
// The app's own faces (Instrument Sans, JetBrains Mono) and computer use's shared look.
import '@fontsource-variable/instrument-sans/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import './computer.css'
import { mount } from 'svelte'
import Overlay from './Overlay.svelte'
import PointLayer from './PointLayer.svelte'

mount(Overlay, { target: document.getElementById('app')! })
// Point mode, above the rest (PointLayer.svelte).
mount(PointLayer, { target: document.getElementById('app')! })
