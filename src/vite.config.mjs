import { defineConfig } from 'vite'
export default defineConfig({
  build: {
    target: 'es2022',
    emptyOutDir: false,
    lib: { entry: 'driver.js', formats: ['iife'], name: 'TabDemo', fileName: () => 'demo.js' },
  },
})
