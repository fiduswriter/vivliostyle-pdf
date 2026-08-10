import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/*
 * List-marker fidelity: `::marker` color/font, `list-style-position: inside`
 * (content is pushed right), custom `::marker` content, and preserved
 * synthesized markers for ordered/unordered lists.
 *
 * Note: `list-style-image` is deliberately not covered — Chromium does not
 * expose it in computed style, so it cannot be detected (see FEATURES.md §2).
 */
const MARKERS_HTML = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8" />
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "Lib", serif; font-size: 12pt; }
p, ul, ol { margin: 0 0 8pt; }
ol.inside { list-style-position: inside; }
ul.custom li::marker { content: "» "; color: #b00020; }
ul.colorfm li::marker { color: #2f9e44; }
</style>
</head>
<body>
<p>one two three</p>
<ol class="inside"><li>Inside alpha</li><li>Inside beta</li></ol>
<ol><li>Outside alpha</li></ol>
<ul class="custom"><li>Custom marker item</li></ul>
<ul class="colorfm"><li>Colored marker item</li></ul>
</body>
</html>`

test("list markers: inside/outside and ::marker content/color", async ({
    page
}) => {
    const consoleErrors: string[] = []
    page.on("console", m => {
        if (m.type() === "error") consoleErrors.push(m.text())
    })
    page.on("pageerror", e => consoleErrors.push(String(e)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()
    await page.locator("#source").fill(MARKERS_HTML)
    const dp = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const d = await dp
    const bytes = await readFile(await d.path())
    await expect(page.locator("#status")).toContainText("Done")
    expect(consoleErrors).toEqual([])

    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    const items: Array<{str: string; x: number}> = []
    for (let i = 1; i <= doc.numPages; i++) {
        const pd = await doc.getPage(i)
        const content = await pd.getTextContent()
        for (const it of content.items as Array<Record<string, unknown>>) {
            if (typeof it.str === "string" && it.str.trim().length) {
                items.push({str: it.str, x: (it.transform as number[])[4]})
            }
        }
    }
    const xOf = (needle: string): number | null =>
        items.find(item => item.str.includes(needle))?.x ?? null
    const allText = items.map(t => t.str).join(" ")

    // Inside list content is pushed right of an outside list's content.
    const inside = xOf("Inside alpha")
    const outside = xOf("Outside alpha")
    expect(inside).not.toBeNull()
    expect(outside).not.toBeNull()
    expect(inside!).toBeGreaterThan(outside!)
    // Both are indented right of the control paragraph.
    expect(inside!).toBeGreaterThan(xOf("one two three")!)

    // Custom ::marker content is drawn.
    expect(allText).toContain("»")

    // Other marker types still present.
    expect(allText).toContain("Colored marker item")
})