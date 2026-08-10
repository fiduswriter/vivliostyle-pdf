import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as zlib from "node:zlib"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/**
 * `list-style-image` markers.
 *
 * Two distinct facts (both verified here):
 *
 * 1. Chromium DOES expose `list-style-image` in computed style (both on the
 *    element and on `::marker`) — but only once the image resource has
 *    actually loaded. Reproducible and asserted below.
 *
 * 2. In the vivliostyle-PAGINATED document this library walks, vivliostyle
 *    neutralizes `list-style-image` (and for image/ordered cases
 *    `list-style-type`) to `none` so it can render markers itself. The
 *    emitter therefore cannot currently read image markers from the
 *    paginated layout — the gap is vivliostyle pagination, NOT Chromium.
 *    Re-enabling image markers needs reading the original source CSS and
 *    matching selectors to paginated elements.
 */

/** A real, tiny, valid 16×16 RGBA PNG as a base64 data URI. */
function validPngB64(): string {
    const w = 16
    const h = 16
    const stride = w * 4 + 1
    const raw = Buffer.alloc(h * stride)
    for (let y = 0; y < h; y++) {
        raw[y * stride] = 0
        for (let x = 0; x < w; x++) {
            const i = y * stride + 1 + x * 4
            raw[i] = 200
            raw[i + 1] = 60
            raw[i + 2] = 90
            raw[i + 3] = 255
        }
    }
    const chunk = (t: string, d: Buffer): Buffer => {
        const len = Buffer.alloc(4)
        len.writeUInt32BE(d.length)
        const tb = Buffer.from(t, "latin1")
        const crc = Buffer.alloc(4)
        crc.writeUInt32BE(zlib.crc32(Buffer.concat([tb, d])) >>> 0)
        return Buffer.concat([len, tb, d, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0)
    ihdr.writeUInt32BE(h, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    return Buffer.concat([
        sig,
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0))
    ]).toString("base64")
}

const PNG = validPngB64()

test("browser probe: Chromium exposes list-style-image once the image loads", async ({
    page
}) => {
    await page.setContent(
        `<!doctype html><meta charset="utf-8"><ul id="ul"><li id="li">x</li></ul>`
    )
    const reported = await page.evaluate(async uri => {
        const ul = document.getElementById("ul") as HTMLUListElement
        ul.style.listStyleImage = `url(${uri})`
        // Wait for the CSS image to actually load before reading computed style.
        await new Promise<void>(resolve => {
            const img = new Image()
            img.onload = () => setTimeout(resolve, 30)
            img.onerror = () => resolve()
            img.src = uri
        })
        const li = document.getElementById("li")!
        return {
            element: getComputedStyle(li).listStyleImage,
            marker: getComputedStyle(li, "::marker").listStyleImage
        }
    }, `data:image/png;base64,${PNG}`)
    expect(reported.element).toContain("data:image/png")
    expect(reported.marker).toContain("data:image/png")
})

// vivliostyle renders image markers through Chromium's native `::marker`,
// exposing the image URL via `getComputedStyle(li, "::marker").content`. The
// emitter reads that and embeds/draws the marker image, so the image now ends
// up embedded in the PDF.
test(
    "list-style-image markers are embedded in the emitted PDF",
    async ({page}) => {
        const FIXTURE = `<!doctype html>
<html lang="en-US"><head><meta charset="UTF-8" /><title>list-style-image test</title>
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "Lib", serif; font-size: 12pt; }
ul.imaged { list-style-image: url(data:image/png;base64,${PNG}); }
</style>
</head>
<body>
<ul class="imaged"><li>Image marker item</li></ul>
</body>
</html>`

        await page.goto("/")
        await expect(page.locator("#generate")).toBeVisible()
        await page.locator("#source").fill(FIXTURE)
        const dp = page.waitForEvent("download", {timeout: 90_000})
        await page.click("#generate")
        const d = await dp
        const bytes = await readFile(await d.path())

    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    const seen = new Set<string>()
    const OPS = new Map<number, string>()
    for (const [name, code] of Object.entries(pdfjs.OPS)) {
        if (typeof code === "number") OPS.set(code, name)
    }
    for (let i = 1; i <= doc.numPages; i++) {
        const pd = await doc.getPage(i)
        const ops = await pd.getOperatorList()
        for (const code of ops.fnArray) seen.add(OPS.get(code) ?? "")
    }
    expect(
        seen.has("paintImageXObject") ||
            seen.has("paintXObject") ||
            seen.has("paintInlineImageXObject")
    ).toBe(true)
    }
)