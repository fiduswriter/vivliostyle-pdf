import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/*
 * text-decoration breadth (dotted/dashed/double/wavy underline, overline)
 * and border-style breadth (dashed/dotted/double) are drawn as vector
 * graphics. Dashed/dotted lines reach the PDF as `setDash` operators; every
 * decoration/border emits `stroke` (and rounded chip backgrounds emit
 * `fill`). This spec asserts those vector ops appear for a document that
 * exercises them.
 */
const DECOR_HTML = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8" />
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "Lib", serif; font-size: 12pt; }
p { margin: 0 0 8pt 0; }
.u-dashed { text-decoration: underline dashed red; }
.u-dotted { text-decoration: underline dotted blue; }
.u-double { text-decoration: underline double green; }
.u-wavy { text-decoration: underline wavy orange; }
.o-line { text-decoration: overline #333; }
.strike { text-decoration: line-through magenta; }
.s-dash { border: 2px dashed #333; padding: 4px; }
.s-dot { border: 1px dotted #666; padding: 4px; }
.b-double { border: 3px double #aaa; padding: 4px; }
.chip { background: #e8e8e8; border-radius: 8px; display: inline-block; padding: 2px 6px; }
</style>
</head>
<body>
<p class="u-dashed">Dashed underline</p>
<p class="u-dotted">Dotted underline</p>
<p class="u-double">Double underline</p>
<p class="u-wavy">Wavy underline</p>
<p class="o-line">Overline text</p>
<p class="strike">Struck through</p>
<div class="s-dash">Dashed box</div>
<div class="s-dot">Dotted box</div>
<div class="b-double">Double box</div>
<span class="chip">Rounded chip</span>
</body>
</html>`

test("decorations and borders emit dashed/dotted/double vector ops", async ({
    page
}) => {
    const consoleErrors: string[] = []
    page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", error => consoleErrors.push(String(error)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()
    await page.locator("#source").fill(DECOR_HTML)
    const downloadPromise = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const download = await downloadPromise
    const bytes = await readFile(await download.path())

    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    await expect(page.locator("#status")).toContainText("Done")
    expect(consoleErrors).toEqual([])

    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    const OPS_BY_CODE = new Map<number, string>()
    for (const [name, code] of Object.entries(pdfjs.OPS)) {
        if (typeof code === "number") OPS_BY_CODE.set(code, name)
    }
    const seen = new Set<string>()
    let text = ""
    for (let i = 1; i <= doc.numPages; i++) {
        const pd = await doc.getPage(i)
        const content = await pd.getTextContent()
        text += content.items
            .map(item => ("str" in item ? item.str : ""))
            .join(" ")
        const ops = await pd.getOperatorList()
        for (const code of ops.fnArray) {
            seen.add(OPS_BY_CODE.get(code) ?? "op" + code)
        }
    }

    // All the words are present.
    expect(text).toContain("Dashed underline")
    expect(text).toContain("Double underline")
    expect(text).toContain("Wavy underline")
    expect(text).toContain("Overline text")
    expect(text).toContain("Struck through")
    expect(text).toContain("Rounded chip")

    // Dashed/dotted lines hit the PDF as setDash operators (the old emitter
    // never emitted a dash pattern); dotted lines additionally set a round
    // line cap; borders/decorations are stroked (setStrokeRGBColor); text and
    // the rounded chip fill (setFillRGBColor); and all of them are vector
    // paths (constructPath).
    expect(seen.has("setDash")).toBe(true)
    expect(seen.has("setLineCap")).toBe(true)
    expect(seen.has("setStrokeRGBColor")).toBe(true)
    expect(seen.has("setFillRGBColor")).toBe(true)
    expect(seen.has("constructPath")).toBe(true)
})