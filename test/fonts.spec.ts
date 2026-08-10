import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as zlib from "node:zlib"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/**
 * End-to-end verification of dynamic @font-face font resolution, mirroring
 * how Fidus Writer delivers document-style fonts (CSS inlined into the
 * document, fonts loaded via @font-face src url).
 *
 * Covers:
 *  - custom family names resolved from @font-face rules (no hardcoded
 *    registry involved),
 *  - weight/style CSS matching selecting the right cut (bold text in a
 *    family that has both a 400 and a 700 rule must use the 700 file),
 *  - a WOFF font delivered as a data: URI being unwrapped to sfnt, embedded
 *    and actually used,
 *  - identical font bytes embedded only once (content-hash dedup),
 *  - unknown families falling back to the default serif without errors.
 */
function checksum(data: Buffer): number {
    const padded = data.byteLength % 4
        ? Buffer.concat([data, Buffer.alloc(4 - (data.byteLength % 4))])
        : data
    let sum = 0
    for (let i = 0; i < padded.length; i += 4) {
        sum = (sum + padded.readUInt32BE(i)) >>> 0
    }
    return sum
}

function ttfToWoff(ttf: Buffer): Buffer {
    const numTables = ttf.readUInt16BE(4)
    const records: Array<{tag: string; offset: number; length: number}> = []
    for (let i = 0; i < numTables; i++) {
        const base = 12 + i * 16
        records.push({
            tag: ttf.toString("latin1", base, base + 4),
            offset: ttf.readUInt32BE(base + 8),
            length: ttf.readUInt32BE(base + 12)
        })
    }
    const directoryBase = 44
    let dataOffset = directoryBase + records.length * 20
    const entries: Array<{
        tag: string
        offset: number
        compLength: number
        origLength: number
        origChecksum: number
    }> = []
    const chunks: Buffer[] = []
    for (const record of records) {
        if (record.offset + record.length > ttf.length) continue
        const table = ttf.subarray(record.offset, record.offset + record.length)
        const compressed = zlib.deflateSync(table)
        const stored = compressed.length < table.length ? compressed : table
        entries.push({
            tag: record.tag,
            offset: dataOffset,
            compLength: stored.length,
            origLength: table.length,
            origChecksum: checksum(table)
        })
        chunks.push(stored)
        dataOffset += stored.length
    }
    const header = Buffer.alloc(directoryBase)
    header.write("wOFF", 0, "latin1")
    header.writeUInt32BE(0x00010000, 4)
    header.writeUInt32BE(dataOffset, 8)
    header.writeUInt16BE(entries.length, 12)
    header.writeUInt16BE(0, 14)
    header.writeUInt32BE(0, 16)
    header.writeUInt16BE(1, 20)
    const dir = Buffer.alloc(entries.length * 20)
    entries.forEach((entry, i) => {
        const base = i * 20
        dir.write(entry.tag, base, "latin1")
        dir.writeUInt32BE(entry.offset, base + 4)
        dir.writeUInt32BE(entry.compLength, base + 8)
        dir.writeUInt32BE(entry.origLength, base + 12)
        dir.writeUInt32BE(entry.origChecksum, base + 16)
    })
    return Buffer.concat([header, dir, ...chunks])
}

test("dynamic @font-face fonts: discovery, matching, WOFF and dedup", async ({
    page
}) => {
    const boldItalic = await readFile(
        "public/fonts/LibertinusSerif-BoldItalic.ttf"
    )
    const ghostWoff = ttfToWoff(boldItalic).toString("base64")

    const FONTS_HTML = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8" />
<title>Dynamic fonts test</title>
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "Plain", serif; font-size: 11pt; line-height: 1.4; }
p { margin: 0 0 6pt 0; }
@font-face { font-family: "Plain"; src: url(__BASE__fonts/LibertinusSerif-Regular.ttf); }
@font-face { font-family: "Fancy"; src: url(__BASE__fonts/LibertinusSerif-Italic.ttf); font-style: italic; }
@font-face { font-family: "Heavy"; src: url(__BASE__fonts/LibertinusSerif-Regular.ttf); font-weight: 400; }
@font-face { font-family: "Heavy"; src: url(__BASE__fonts/LibertinusSerif-Bold.ttf); font-weight: 700; }
@font-face { font-family: "Ghost"; src: url(data:font/woff;base64,${ghostWoff}) format("woff"); font-style: italic; }
.fancy { font-family: "Fancy"; }
.ghost { font-family: "Ghost"; font-style: italic; }
.heavy { font-family: "Heavy"; }
.unknown { font-family: "NoSuchFont", serif; }
</style>
</head>
<body>
<p>Plainbody regular text.</p>
<p><em class="fancy">Fancytext</em> mixed.</p>
<p class="ghost">Ghosttext spoken here.</p>
<p>Heavy <strong class="heavy">Heavyword</strong> run.</p>
<p class="unknown">Unknownfamily text.</p>
</body>
</html>`

    const consoleErrors: string[] = []
    page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", error => consoleErrors.push(String(error)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()
    await page.locator("#source").fill(FONTS_HTML)
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
    const fontOf = (needle: string): string | null => {
        const found = items.find(item => item.str.includes(needle))
        return found ? found.fontName : null
    }

    // All the text is present.
    const allText = items.map(item => item.str).join(" ")
    for (const needle of ["Plainbody", "Fancytext", "Ghosttext", "Heavyword", "Unknownfamily"]) {
        expect(allText).toContain(needle)
    }

    // Plain body text uses the family resolved via @font-face (not the
    // hardcoded registry — both now resolve, this asserts the discovery).
    const body = fontOf("Plainbody")
    const fancy = fontOf("Fancytext")
    const ghost = fontOf("Ghosttext")
    const heavy = fontOf("Heavyword")
    const unknown = fontOf("Unknownfamily")
    expect(body).toBeTruthy()
    expect(fancy).toBeTruthy()
    expect(ghost).toBeTruthy()
    expect(heavy).toBeTruthy()
    expect(unknown).toBeTruthy()

    // Italic (Fancy) is a distinct embedded font from the regular body.
    expect(fancy).not.toBe(body)
    // Weight matching: Heavyword (weight 700) must use the bold file, not
    // the Plain/regular file.
    expect(heavy).not.toBe(body)
    // The WOFF data-URI font (BoldItalic TTF, family "Ghost") is a distinct
    // embedded font — content-hash dedup must still keep it separate from
    // the other three Libertinus cuts.
    expect(ghost).not.toBe(body)
    expect(ghost).not.toBe(fancy)
    expect(ghost).not.toBe(heavy)
    // An unknown family falls back to the default serif — the same embedded
    // regular font (deduplicated by content).
    expect(unknown).toBe(body)
})

test("identical bytes across formats embed only once (content-hash dedup)", async ({
    page
}) => {
    // The same physical font delivered twice — once as TTF file, once via a
    // WOFF data URI under different family names — must produce ONE embedded
    // font program (shared by both families).
    const italic = await readFile("public/fonts/LibertinusSerif-Italic.ttf")
    const woffB64 = ttfToWoff(italic).toString("base64")

    const DEDUP_HTML = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8" />
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "A", serif; font-size: 11pt; }
@font-face { font-family: "A"; src: url(__BASE__fonts/LibertinusSerif-Italic.ttf); font-style: italic; }
@font-face { font-family: "B"; src: url(data:font/woff;base64,${woffB64}) format("woff"); font-style: italic; }
.one { font-family: "A"; font-style: italic; }
.two { font-family: "B"; font-style: italic; }
</style>
</head>
<body>
<p class="one">Onefamily word.</p>
<p class="two">Twofamily word.</p>
</body>
</html>`

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()
    await page.locator("#source").fill(DEDUP_HTML)
    const downloadPromise = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const download = await downloadPromise
    const path = await download.path()
    const bytes = await readFile(await path!)

    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    const names = new Map<string, string>()
    for (let i = 1; i <= doc.numPages; i++) {
        const pd = await doc.getPage(i)
        const content = await pd.getTextContent()
        for (const item of content.items) {
            if (!("str" in item)) continue
            const text = (item as {str: string}).str
            if (text.includes("Onefamily")) names.set("one", (item as {fontName: string}).fontName)
            if (text.includes("Twofamily")) names.set("two", (item as {fontName: string}).fontName)
        }
    }
    expect(names.get("one")).toBeTruthy()
    expect(names.get("two")).toBe(names.get("one"))
})