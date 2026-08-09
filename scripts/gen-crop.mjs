import {chromium} from "@playwright/test"

const browser = await chromium.launch()
const page = await browser.newPage()
page.on("console", msg => console.log(`[console:${msg.type()}]`, msg.text()))
page.on("pageerror", err => console.log("[pageerror]", String(err)))

await page.goto("http://localhost:4173/vivliostyle-pdf/")
await page.locator("#crop-marks").check()
await page.locator("#trim-box").check()
await page.locator("#bleed-box").check()
await page.locator("#bleed-mm").fill("5")

const downloadPromise = page.waitForEvent("download", {timeout: 90_000})
await page.click("#generate")
const download = await downloadPromise
await download.saveAs("/tmp/demo-crop.pdf")
console.log("saved /tmp/demo-crop.pdf")
await browser.close()
