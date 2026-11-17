/**
 * Browser tests run against the built app served on :8080 (the `web` service
 * in Compose), never the dev server: the production build is what carries the
 * Content-Security-Policy and what a phone would download.
 *
 * Galaxy A55 is Playwright's profile for a 2024 mid-range Android phone:
 * viewport, touch and user agent. It does not make this machine as slow as
 * that phone; CPU and network limits are applied per test through CDP.
 */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Galaxy A55'],
    baseURL: process.env.APP_URL ?? 'http://localhost:8080',
    trace: 'off',
    // Set CHROMIUM to reuse a browser already on the machine instead of
    // downloading the exact build this Playwright version pins.
    launchOptions: process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
  },
})
