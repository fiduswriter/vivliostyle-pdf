/* Debug helper: run the generation flow and print console + status output. */
import {chromium} from "@playwright/test"

const browser = await chromium.launch()
const page = await browser.newPage()
page.on("console", msg => console.log(`[console:${msg.type()}]`, msg.text()))
page.on("pageerror", err => console.log("[pageerror]", String(err)))

await page.goto("http://localhost:4173/vivliostyle-pdf/")
const downloadPromise = page.waitForEvent("download", {timeout: 60_000})
await page.click("#generate")

for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000)
    const status = await page.locator("#status").innerText()
    console.log(`--- t=${(i + 1) * 2}s status:`, JSON.stringify(status))
    if (status.includes("Done") || status.includes("failed") || status.includes("error")) {
        break
    }
}
const download = await downloadPromise
await download.saveAs("/tmp/demo.pdf")
console.log("saved to /tmp/demo.pdf")
await browser.close()
