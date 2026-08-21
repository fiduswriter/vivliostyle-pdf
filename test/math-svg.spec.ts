import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import {inflateSync} from "node:zlib"
import {PDFDocument, PDFName} from "@pdfme/pdf-lib"

/**
 * Verification: when the Fidus Writer HTML exporter renders equations as SVG
 * images (mathOutput: "svg"), the DOM→PDF emitter paints the full formula as
 * vector drawing ops — fraction bars, radicals and glyphs — instead of only
 * copying text tokens (the MathML gap covered by math.spec.ts).
 *
 * The fidus exporter emits `equation` nodes as
 *   <span class="equation"><img class="equation-svg" …></span>
 * and `figure_equation` nodes as
 *   <div class="figure-equation"><img class="equation-svg" …></div>
 * with a data-URI SVG (MathJax tex2svg, fontCache:none) and explicit em
 * sizing/alignment. The two SVGs below are the real output of that pipeline
 * for \frac{1}{2} (inline) and \sqrt{a+b}=0 (display).
 */
const FRAC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" role="img" focusable="false" viewBox="0 -864.9 793.6 1209.9"><g stroke="currentColor" fill="currentColor" stroke-width="0" transform="scale(1,-1)"><g data-mml-node="math"><g data-mml-node="mfrac"><g data-mml-node="mn" transform="translate(220,394) scale(0.707)"><path data-c="31" d="M213 578L200 573Q186 568 160 563T102 556H83V602H102Q149 604 189 617T245 641T273 663Q275 666 285 666Q294 666 302 660V361L303 61Q310 54 315 52T339 48T401 46H427V0H416Q395 3 257 3Q121 3 100 0H88V46H114Q136 46 152 46T177 47T193 50T201 52T207 57T213 61V578Z"></path></g><g data-mml-node="mn" transform="translate(220,-345) scale(0.707)"><path data-c="32" d="M109 429Q82 429 66 447T50 491Q50 562 103 614T235 666Q326 666 387 610T449 465Q449 422 429 383T381 315T301 241Q265 210 201 149L142 93L218 92Q375 92 385 97Q392 99 409 186V189H449V186Q448 183 436 95T421 3V0H50V19V31Q50 38 56 46T86 81Q115 113 136 137Q145 147 170 174T204 211T233 244T261 278T284 308T305 340T320 369T333 401T340 431T343 464Q343 527 309 573T212 619Q179 619 154 602T119 569T109 550Q109 549 114 549Q132 549 151 535T170 489Q170 464 154 447T109 429Z"></path></g><rect width="553.6" height="60" x="120" y="220"></rect></g></g></g></svg>`

const SQRT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" role="img" focusable="false" viewBox="0 -1081.3 5034 1260"><g stroke="currentColor" fill="currentColor" stroke-width="0" transform="scale(1,-1)"><g data-mml-node="math"><g data-mml-node="msqrt"><g transform="translate(1020,0)"><g data-mml-node="mi"><path data-c="1D44E" d="M33 157Q33 258 109 349T280 441Q331 441 370 392Q386 422 416 422Q429 422 439 414T449 394Q449 381 412 234T374 68Q374 43 381 35T402 26Q411 27 422 35Q443 55 463 131Q469 151 473 152Q475 153 483 153H487Q506 153 506 144Q506 138 501 117T481 63T449 13Q436 0 417 -8Q409 -10 393 -10Q359 -10 336 5T306 36L300 51Q299 52 296 50Q294 48 292 46Q233 -10 172 -10Q117 -10 75 30T33 157ZM351 328Q351 334 346 350T323 385T277 405Q242 405 210 374T160 293Q131 214 119 129Q119 126 119 118T118 106Q118 61 136 44T179 26Q217 26 254 59T298 110Q300 114 325 217T351 328Z"></path></g><g data-mml-node="mo" transform="translate(751.2,0)"><path data-c="2B" d="M56 237T56 250T70 270H369V420L370 570Q380 583 389 583Q402 583 409 568V270H707Q722 262 722 250T707 230H409V-68Q401 -82 391 -82H389H387Q375 -82 369 -68V230H70Q56 237 56 250Z"></path></g><g data-mml-node="mi" transform="translate(1751.4,0)"><path data-c="1D44F" d="M73 647Q73 657 77 670T89 683Q90 683 161 688T234 694Q246 694 246 685T212 542Q204 508 195 472T180 418L176 399Q176 396 182 402Q231 442 283 442Q345 442 383 396T422 280Q422 169 343 79T173 -11Q123 -11 82 27T40 150V159Q40 180 48 217T97 414Q147 611 147 623T109 637Q104 637 101 637H96Q86 637 83 637T76 640T73 647ZM336 325V331Q336 405 275 405Q258 405 240 397T207 376T181 352T163 330L157 322L136 236Q114 150 114 114Q114 66 138 42Q154 26 178 26Q211 26 245 58Q270 81 285 114T318 219Q336 291 336 325Z"></path></g></g><g data-mml-node="mo" transform="translate(0,171.3)"><path data-c="221A" d="M263 249Q264 249 315 130T417 -108T470 -228L725 302Q981 837 982 839Q989 850 1001 850Q1008 850 1013 844T1020 832V826L741 243Q645 43 540 -176Q479 -303 469 -324T453 -348Q449 -350 436 -350L424 -349L315 -96Q206 156 205 156L171 130Q138 104 137 104L111 130L263 249Z"></path></g><rect width="2180.4" height="60" x="1020" y="961.2"></rect></g><g data-mml-node="mo" transform="translate(3478.2,0)"><path data-c="3D" d="M56 347Q56 360 70 367H707Q722 359 722 347Q722 336 708 328L390 327H72Q56 332 56 347ZM56 153Q56 168 72 173H708Q722 163 722 153Q722 140 707 133H70Q56 140 56 153Z"></path></g><g data-mml-node="mn" transform="translate(4534,0)"><path data-c="30" d="M96 585Q152 666 249 666Q297 666 345 640T423 548Q460 465 460 320Q460 165 417 83Q397 41 362 16T301 -15T250 -22Q224 -22 198 -16T137 16T82 83Q39 165 39 320Q39 494 96 585ZM321 597Q291 629 250 629Q208 629 178 597Q153 571 145 525T137 333Q137 175 145 125T181 46Q209 16 250 16Q290 16 318 46Q347 76 354 130T362 333Q362 478 354 524T321 597Z"></path></g></g></g></svg>`

const dataUri = (svg: string): string =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

const MATH_SVG_HTML = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8" />
<title>Math SVG translation test</title>
<style>
@page { size: A4; margin: 20mm; }
html { font-family: serif; font-size: 11pt; line-height: 1.4; }
div.figure-equation { text-align: center; margin: 1em 0; }
span.equation { display: inline-block; }
span.equation img.equation-svg { width: 0.794em; height: 1.21em; vertical-align: -0.345em; }
div.figure-equation img.equation-svg { width: 5.034em; height: 1.26em; vertical-align: middle; }
</style>
</head>
<body>
<p>Inline: <span class="equation"><img class="equation-svg" src="${dataUri(FRAC_SVG)}" alt="\\frac{1}{2}"></span> — continues here.</p>
<div class="figure-equation"><img class="equation-svg" src="${dataUri(SQRT_SVG)}" alt="\\sqrt{a+b}=0"></div>
</body>
</html>`

/** PDF paint operators that mark visible drawing (path fills/strokes, rects). */
const PAINT_PATTERN = /\b(?:re|f|F|f\*|S|s|B|B\*|b|b\*)\b/

test("math-svg: formulas are painted as vector ops, not lost", async ({
    page
}) => {
    const consoleErrors: string[] = []
    page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", error => consoleErrors.push(String(error)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()

    await page.locator("#source").fill(MATH_SVG_HTML)
    const downloadPromise = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const download = await downloadPromise
    const path = await download.path()
    expect(path).toBeTruthy()
    const bytes = await readFile(path!)

    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    await expect(page.locator("#status")).toContainText("Done")
    expect(consoleErrors).toEqual([])

    // The SVG formulas must survive as vector drawing ops in the content
    // streams (fraction bar rect, radical stroke and glyph paths), unlike the
    // MathML path where only the text tokens were copied.
    const pdf = await PDFDocument.load(bytes)
    let content = ""
    for (const page of pdf.getPages()) {
        const contents = page.node.Contents()
        if (!contents) continue
        for (let i = 0; i < contents.size(); i++) {
            const stream = pdf.context.lookup(contents.get(i)) as {
                dict: {get(name: PDFName): unknown}
                getContents(): Uint8Array
            }
            let bytes = stream.getContents()
            const filter = String(stream.dict.get(PDFName.of("Filter")))
            if (filter.includes("FlateDecode")) {
                bytes = inflateSync(bytes)
            }
            content += "\n" + new TextDecoder().decode(bytes)
        }
    }
    // Fill/stroke ops must be present. The two formulas together contain ten
    // painted shapes (frac: 2 glyphs + bar; sqrt: 6 glyphs + bar), all drawn
    // as closed paths + fill by the SVG path — so expect several paint ops.
    const paintCount = (
        content.match(/\b(?:re|f|F|f\*|S|s|B|B\*|b|b\*)\b/g) || []
    ).length
    console.log(`paint ops in PDF content: ${paintCount}`)
    expect(content).toMatch(PAINT_PATTERN)
    expect(paintCount).toBeGreaterThanOrEqual(5)
})
