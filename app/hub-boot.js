/* Entry point for the landing page (index.html).
 *
 * Lighter than the module boot: the hub only reads — the manifest, the baked
 * cross-module index, and single entries for the preview pane — so it needs
 * no store, no media rewriting and no save indicator. Just a session and the
 * three endpoints serve_hub.py used to answer.
 */
import { installHubStore } from './hub.js'
import { installGate }     from './gate.js'

installHubStore()
installGate({ title: 'System Design Hub', emoji: '🧭' })
