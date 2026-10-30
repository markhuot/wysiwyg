import { defineConfig, devices } from '@playwright/test'

const PORT = 4317

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `PORT=${PORT} bun serve.ts`,
    url: `http://localhost:${PORT}/fixture`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
