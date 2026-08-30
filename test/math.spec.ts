import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/**
 * Verification: can the DOM→PDF emitter translate MathML math the way the
 * Fidus Writer print exporter produces it?
 *
 * The fidus print exporter renders `equation` nodes as
 *   <span class="equation"><math>…</math></span>
 * and `figure_equation` nodes as
 *   <div class="figure-equation"><math display="block">…</math></div>
 * (via mathlive convertLatexToMathMl). Chromium lays this MathML out
 * natively. The emitter converts each `<math>` element to SVG via MathJax
 * (MathML input, SVG output — see src/math-svg.ts) and paints the formula
 * as vector paths at the measured rect. This spec paginates the same markup
 * with the app's real pipeline and inspects what actually made it into the
 * PDF:
 *
 *  - is the formula painted as vector drawing ops (fraction bar, radical,
 *    stretchy delimiters — everything the browser drew but the old token
 *    copy lost)?
 *  - is the math text NOT double-rendered as overlapping token text?
 */
const MATH_HTML = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8" />
<title>Math translation test</title>
<style>
@page { size: A4; margin: 20mm; }
html { font-family: serif; font-size: 11pt; line-height: 1.4; }
div.figure-equation { text-align: center; margin: 1em 0; }
</style>
</head>
<body>
<p>Inline: <span class="equation"><math display="inline"><mrow><mi>z</mi><mo>=</mo><mfrac><mn>123</mn><mn>456</mn></mfrac><msup><mi>y</mi><mn>2</mn></msup></mrow></math></span> — continues here.</p>
<div class="figure-equation"><math display="block"><mrow><msqrt><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow></msqrt><mo>=</mo><mn>0</mn></mrow></math></div>
<div class="figure-equation"><math display="block"><mrow><mo fence="true">(</mo><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>0</mn></mtd></mtr><mtr><mtd><mn>0</mn></mtd><mtd><mn>1</mn></mtd></mtr></mtable><mo fence="true">)</mo></mrow></math></div>
</body>
</html>`

/** pdfjs operator names that paint visible marks (paths, fills, strokes). */
const PAINT_OPS = new Set([
    "constructPath",
    "fill",
    "eoFill",
    "stroke",
    "fillStroke",
    "paintImageXObject"
])

test("math: emitter paints formulas as vector SVG paths", async ({page}) => {
    const consoleErrors: string[] = []
    page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", error => consoleErrors.push(String(error)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()

    await page.locator("#source").fill(MATH_HTML)
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
    // pdfjs OPS maps name→code; build the reverse for operator inspection.
    const OPS_BY_CODE = new Map<number, string>()
    for (const [name, code] of Object.entries(pdfjs.OPS)) {
        if (typeof code === "number") OPS_BY_CODE.set(code, name)
    }
    const pages: string[] = []
    const paintOpCount = {total: 0}
    let totalTextOps = 0
    for (let i = 1; i <= doc.numPages; i++) {
        const pd = await doc.getPage(i)
        const content = await pd.getTextContent()
        pages.push(
            content.items
                .map(item => ("str" in item ? item.str : ""))
                .join(" ")
                .replace(/\s+/g, " ")
        )
        const ops = await pd.getOperatorList()
        for (const code of ops.fnArray) {
            const name = OPS_BY_CODE.get(code) ?? `op${code}`
            if (PAINT_OPS.has(name)) paintOpCount.total++
            if (name === "showText") totalTextOps++
        }
    }
    const allText = pages.join(" ")

    // 1. The formulas are painted as vector paths: the fraction bar,
    //    radical, stretchy parentheses and table rules that MathJax draws
    //    (and the old token copy lost) are present as paint ops. A math-only
    //    document needs a substantial number of them.
    console.log("paint ops found in PDF:", paintOpCount.total)
    console.log("text ops:", totalTextOps)
    expect(paintOpCount.total).toBeGreaterThan(20)

    // 2. The math tokens are NOT copied as overlapping text anymore — the
    //    only text on the pages is the surrounding prose ("Inline:",
    //    "continues here.").
    expect(allText).toContain("Inline:")
    expect(allText).toContain("continues here.")
    expect(allText).not.toContain("123")
    expect(allText).not.toContain("456")
})
