import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import {PDFDocument} from "pdf-lib"

test("generates a valid multi-page PDF in the browser", async ({page}) => {
    const consoleErrors: string[] = []
    page.on("console", msg => {
        if (msg.type() === "error") {
            consoleErrors.push(msg.text())
        }
    })
    page.on("pageerror", error => consoleErrors.push(String(error)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()

    const downloadPromise = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const download = await downloadPromise

    const path = await download.path()
    expect(path).toBeTruthy()
    const bytes = await readFile(path!)

    // It is a real PDF…
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    // …of substantial size (fonts, images, many text runs)…
    expect(bytes.length).toBeGreaterThan(20 * 1024)
    // …with more than 5 pages (TOC + body + long table + figures + refs).
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThan(5)

    // The page reported success and no errors occurred along the way.
    await expect(page.locator("#status")).toContainText("Done")
    expect(consoleErrors).toEqual([])
})
