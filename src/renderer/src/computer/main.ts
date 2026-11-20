// The computer-use overlay page: the acting frame and the Show-me spotlight (Overlay.svelte), and Point.
import '@fontsource-variable/inter'
import '@fontsource-variable/geist-mono'
import { mount } from 'svelte'
import Overlay from './Overlay.svelte'
import PointLayer from './PointLayer.svelte'

mount(Overlay, { target: document.getElementById('app')! })
// Point mode, above the rest (PointLayer.svelte).
mount(PointLayer, { target: document.getElementById('app')! })
