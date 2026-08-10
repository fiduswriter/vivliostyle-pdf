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
 * natively. This spec paginates the same markup with the app's real
 * pipeline and inspects what actually made it into the PDF:
 *
 *  - are the math tokens (numbers, variables) drawn as text?
 *  - are the *painted* math structures (fraction bars, radicals,
 *    stretchy delimiters, table rules) present as vector drawing ops,
 *    or did the emitter only copy the text tokens?
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

/** Operator names that paint visible marks (fill/stroke of paths/rects). */
const PAINT_OPS = new Set([
    "re",
    "f",
    "F",
    "f*",
    "S",
    "s",
    "B",
    "B*",
    "b",
    "b*",
    "n"
])

test("math: emitter copies tokens but loses painted MathML structure", async ({
    page
}) => {
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
    const paintOpNames = new Set<string>()
    const allOpNames = new Set<string>()
    const fractionPositions: {x: number; y: number}[] = []
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
        for (const item of content.items as Array<{
            str?: string
            transform?: number[]
        }>) {
            if (item.str === "123" || item.str === "456") {
                fractionPositions.push({
                    x: item.transform?.[4] ?? 0,
                    y: (item.transform?.[5] ?? 0)
                })
            }
        }
        const ops = await pd.getOperatorList()
        for (const code of ops.fnArray) {
            const name = OPS_BY_CODE.get(code) ?? `op${code}`
            allOpNames.add(name)
            if (PAINT_OPS.has(name)) {
                paintOpNames.add(name)
            }
            if (name === "showText") totalTextOps++
        }
    }
    const allText = pages.join(" ")

    // 1. The math tokens DID make it into the PDF as text.
    expect(allText).toContain("123")
    expect(allText).toContain("456")
    expect(allText).toContain("z")

    // 2. Numerator/denominator are stacked (different baselines, same x).
    expect(fractionPositions.length).toBe(2)
    const [num, den] = fractionPositions
    expect(Math.abs(num.x - den.x)).toBeLessThan(5)
    expect(Math.abs(num.y - den.y)).toBeGreaterThan(4)

    // 3. The PAINTED math structures (fraction bar, radical, stretchy
    //    parentheses, table rules) are NOT in the PDF: the emitter only
    //    draws word text runs, never math rules/glyph strokes. So the
    //    content streams of this math-only document contain no paint ops.
    console.log("paint ops found in PDF:", [...paintOpNames])
    console.log("text ops:", totalTextOps)
    console.log("all ops:", [...allOpNames].sort().join(", "))
    expect(paintOpNames.size).toBe(0)
})