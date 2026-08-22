import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/**
 * Per-glyph font fallback: characters missing from a run's chosen font must
 * be split off into their own segments and drawn with an embedded font that
 * actually contains the glyph (like browsers do), instead of rendering
 * `.notdef` boxes.
 *
 * Setup mirrors inline-code typography: a monospace face (JetBrains Mono,
 * which covers "≈" natively but lacks "∝") plus a serif body. Assertions
 * compare the pdf.js-reported font of the fallback character against the
 * font of the surrounding monospace text.
 */
test("missing glyphs are drawn from a fallback font", async ({page}) => {
    const FALLBACK_HTML = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8" />
<title>Glyph fallback test</title>
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "SerifFace", serif; font-size: 11pt; line-height: 1.4; }
p { margin: 0 0 6pt 0; }
.mono { font-family: "MonoFace", "DejaVu Sans Mono", monospace; }
@font-face { font-family: "SerifFace"; src: url(__BASE__fonts/LibertinusSerif-Regular.ttf); }
@font-face { font-family: "MonoFace"; src: url(__BASE__fonts/JetBrainsMono-Regular.ttf); }
</style>
</head>
<body>
<p class="mono">ab∝cd</p>
<p class="mono">wx≈yz</p>
<p>Serifbody text.</p>
</body>
</html>`

    const consoleErrors: string[] = []
    page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", error => consoleErrors.push(String(error)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()
    await page.locator("#source").fill(FALLBACK_HTML)
    const downloadPromise = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const download = await downloadPromise
    const path = await download.path()
    expect(path).toBeTruthy()
    const bytes = await readFile(path!)

    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    await expect(page.locator("#status")).toContainText("Done")
    expect(consoleErrors).toEqual([])

    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    const items: Array<{str: string; fontName: string}> = []
    for (let i = 1; i <= doc.numPages; i++) {
        const pd = await doc.getPage(i)
        const content = await pd.getTextContent()
        for (const item of content.items) {
            if ("str" in item) {
                items.push({
                    str: (item as {str: string}).str,
                    fontName: (item as {fontName: string}).fontName
                })
            }
        }
    }
    const allText = items.map(item => item.str).join(" ")
    expect(allText).toContain("∝")
    expect(allText).toContain("≈")

    // Font used for the plain monospace letters.
    const monoItem = items.find(item => /[ab]b[cd]/.test(item.str)) ??
        items.find(item => item.str.includes("ab"))
    expect(monoItem, "monospace text found").toBeTruthy()
    const monoFontName = monoItem!.fontName

    // ∝ is missing from JetBrains Mono → must be drawn with a DIFFERENT
    // embedded font (per-glyph fallback), not the monospace one.
    const proportionalItem = items.find(item => item.str.includes("∝"))
    expect(proportionalItem, "∝ found").toBeTruthy()
    expect(proportionalItem!.fontName).not.toBe(monoFontName)

    // ≈ IS covered by JetBrains Mono → must stay in the monospace font
    // (no unnecessary font switch).
    const approxItem = items.find(item => item.str.includes("≈"))
    expect(approxItem, "≈ found").toBeTruthy()
    expect(approxItem!.fontName).toBe(monoFontName)
})
