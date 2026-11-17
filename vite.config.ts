/**
 * Build settings. The one non-default piece is the Content-Security-Policy,
 * added to index.html at build time only (the dev server needs inline styles
 * for hot reload, the shipped page does not).
 *
 * The policy is the page's main defence for the secrets it holds in memory:
 * scripts and styles from this origin only, no inline script, no eval, and
 * network access limited to this origin plus WebSocket relays.
 */
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const csp: Plugin = {
  name: 'tab-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
}

export default defineConfig({
  plugins: [csp],
  build: { target: 'es2022', sourcemap: false },
  server: { host: '0.0.0.0', port: 8080 },
  preview: { host: '0.0.0.0', port: 8080 },
  // Integration tests share two wallets and one channel: run files in order.
  test: { testTimeout: 40000, hookTimeout: 40000, fileParallelism: false },
})
