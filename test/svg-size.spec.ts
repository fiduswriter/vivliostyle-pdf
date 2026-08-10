import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/** PDF transformation matrix in PDF/postscript order [a,b,c,d,e,f]. */
type Matrix = [number, number, number, number, number, number]

interface BBox {
    left: number
    bottom: number
    right: number
    top: number
}

function identity(): Matrix {
    return [1, 0, 0, 1, 0, 0]
}

function multiply(m1: Matrix, m2: Matrix): Matrix {
    const [a1, b1, c1, d1, e1, f1] = m1
    const [a2, b2, c2, d2, e2, f2] = m2
    return [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2
    ]
}

function transformPoint(m: Matrix, x: number, y: number): {x: number; y: number} {
    return {
        x: m[0] * x + m[2] * y + m[4],
        y: m[1] * x + m[3] * y + m[5]
    }
}

function bboxOfRect(m: Matrix, rect: BBox): BBox {
    const corners = [
        transformPoint(m, rect.left, rect.bottom),
        transformPoint(m, rect.right, rect.bottom),
        transformPoint(m, rect.left, rect.top),
        transformPoint(m, rect.right, rect.top)
    ]
    const xs = corners.map(p => p.x)
    const ys = corners.map(p => p.y)
    return {
        left: Math.min(...xs),
        right: Math.max(...xs),
        bottom: Math.min(...ys),
        top: Math.max(...ys)
    }
}

function width(b: BBox): number {
    return b.right - b.left
}

function height(b: BBox): number {
    return b.top - b.bottom
}

/**
 * Walk a pdfjs operator list and return the bounding box (in PDF pt) of the
 * first painted SVG content.
 *
 * For raster output we locate the first `paintImageXObject` and use the CTM
 * that positions it (image covers [0,0,1,1]).
 *
 * For vector output the first `constructPath` is the SVG viewport clip rect.
 * Its local bounding box (third argument) reflects the rendered viewport size,
 * so we transform that through the active CTM.
 */
function extractSvgBBox(
    ops: {fnArray: number[]; argsArray: unknown[]},
    mode: "raster" | "vector"
): BBox | null {
    const OPS_BY_CODE = new Map<number, string>()
    for (const [name, code] of Object.entries(pdfjs.OPS)) {
        if (typeof code === "number") OPS_BY_CODE.set(code, name)
    }

    let ctm: Matrix = identity()
    const stack: Matrix[] = []

    for (let i = 0; i < ops.fnArray.length; i++) {
        const name = OPS_BY_CODE.get(ops.fnArray[i])
        const args = ops.argsArray[i]

        if (name === "save") {
            stack.push(ctm)
            continue
        }
        if (name === "restore") {
            ctm = stack.pop() ?? identity()
            continue
        }
        if (name === "transform") {
            const m = (args as number[]).slice(0, 6) as Matrix
            // PDF concatenates new transforms on the left: CTM = M * CTM.
            ctm = multiply(m, ctm)
            continue
        }

        if (mode === "raster" && name === "paintImageXObject") {
            return bboxOfRect(ctm, {left: 0, bottom: 0, right: 1, top: 1})
        }

        if (mode === "vector" && name === "constructPath") {
            const local = (args as [unknown, unknown, Float32Array])[2]
            return bboxOfRect(ctm, {
                left: local[0],
                bottom: local[1],
                right: local[2],
                top: local[3]
            })
        }
    }

    return null
}

const testHtml = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <style>
        @page { size: 300pt 250pt; margin: 20pt; }
        body { margin: 0; }
        img { display: block; }
    </style>
</head>
<body>
    <img src="__BASE__images/figure-1.svg" width="200" height="125" alt="test" />
</body>
</html>`

/**
 * figure-1.svg is displayed at 200x125 CSS px, so the PDF should place it at
 * 150x93.75 pt regardless of whether it is emitted as vector or raster.
 */
const EXPECTED_WIDTH_PT = 200 * 0.75
const EXPECTED_HEIGHT_PT = 125 * 0.75

async function generatePdfBytes(
    page: import("@playwright/test").Page,
    rasterize: boolean
): Promise<Uint8Array> {
    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()

    await page.fill("#source", testHtml)
    if (rasterize) {
        await page.check("#rasterize-svgs")
    } else {
        await page.uncheck("#rasterize-svgs")
    }

    const downloadPromise = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const download = await downloadPromise
    const path = await download.path()
    expect(path).toBeTruthy()
    return await readFile(path!)
}

test("vector SVG is rendered at the same size as the rasterized SVG", async ({
    page
}) => {
    const consoleErrors: string[] = []
    page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", error => consoleErrors.push(String(error)))

    const vectorBytes = await generatePdfBytes(page, false)
    const rasterBytes = await generatePdfBytes(page, true)

    for (const bytes of [vectorBytes, rasterBytes]) {
        expect(Buffer.from(bytes).subarray(0, 5).toString("latin1")).toBe(
            "%PDF-"
        )
    }

    const vectorBBox = await (async () => {
        const doc = await pdfjs.getDocument({
            data: new Uint8Array(vectorBytes)
        }).promise
        const page = await doc.getPage(1)
        return extractSvgBBox(await page.getOperatorList(), "vector")
    })()

    const rasterBBox = await (async () => {
        const doc = await pdfjs.getDocument({
            data: new Uint8Array(rasterBytes)
        }).promise
        const page = await doc.getPage(1)
        return extractSvgBBox(await page.getOperatorList(), "raster")
    })()

    expect(vectorBBox).not.toBeNull()
    expect(rasterBBox).not.toBeNull()

    // The vector and raster outputs should occupy the same rectangle.
    expect(width(vectorBBox!)).toBeCloseTo(width(rasterBBox!), 1)
    expect(height(vectorBBox!)).toBeCloseTo(height(rasterBBox!), 1)
    expect(vectorBBox!.left).toBeCloseTo(rasterBBox!.left, 1)
    expect(vectorBBox!.bottom).toBeCloseTo(rasterBBox!.bottom, 1)

    // And the size should match the HTML display size (CSS px * 0.75).
    expect(width(vectorBBox!)).toBeCloseTo(EXPECTED_WIDTH_PT, 1)
    expect(height(vectorBBox!)).toBeCloseTo(EXPECTED_HEIGHT_PT, 1)

    expect(consoleErrors).toEqual([])
})
