/* A single promise that resolves once the user is signed in and Drive is
 * reachable. The module apps call boot() the moment their script runs, so
 * their very first fetch('/terms') can arrive before anyone has signed in.
 * Rather than restructure that startup path, the store awaits this promise
 * before answering — the app simply experiences a slow first request and
 * renders normally once it resolves.
 */
let _resolve
export const ready = new Promise(r => { _resolve = r })
export function markReady() { _resolve() }
