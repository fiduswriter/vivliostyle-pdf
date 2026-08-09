import {defineConfig, devices} from "@playwright/test"

/**
 * The e2e test builds the app and serves dist/ via vite preview, then
 * generates a real PDF in chromium and validates the downloaded bytes.
 */
export default defineConfig({
    testDir: "./test",
    timeout: 120_000,
    use: {
        baseURL: "http://localhost:4173/vivliostyle-pdf/",
        ...devices["Desktop Chrome"]
    },
    webServer: {
        command: "pnpm run build && pnpm run preview -- --port 4173 --strictPort",
        url: "http://localhost:4173/vivliostyle-pdf/",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000
    }
})
