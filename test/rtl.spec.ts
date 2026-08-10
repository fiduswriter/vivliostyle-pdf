import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/**
 * RTL / bidi end-to-end verification.
 *
 * The DOM→PDF emitter draws each direction-homogeneous bidi run at its own
 * measured rect (the browser already ran the Unicode Bidi Algorithm), so a
 * right-to-left paragraph must place its first logical word rightmost, and a
 * token that mixes Arabic with Western digits must keep the digits as a
 * separate left-of-Arabic LTR pane (rather than mirroring them).
 */
const RTL_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "Serif", serif; font-size: 11pt; line-height: 1.5; }
@font-face { font-family: "Arabic"; src: url(__BASE__fonts/NotoSansArabic-Regular.ttf); }
@font-face { font-family: "Hebrew"; src: url(__BASE__fonts/NotoSansHebrew-Regular.ttf); }
.ar { font-family: "Arabic"; }
.he { font-family: "Hebrew"; }
</style>
</head>
<body>
<p class="ar">مرحبا بالعالم</p>
<p class="ar" dir="rtl">عدد123 تقرير</p>
<p class="he" dir="rtl">שלום עולם</p>
<p dir="ltr">English left to right sentence.</p>
</body>
</html>`

test("rtl/bidi: runs are drawn right-to-left at their measured positions", async ({
    page
}) => {
    const consoleErrors: string[] = []
    page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", error => consoleErrors.push(String(error)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()
    await page.locator("#source").fill(RTL_HTML)
    const downloadPromise = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const download = await downloadPromise
    const bytes = await readFile(await download.path())

    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    await expect(page.locator("#status")).toContainText("Done")
    expect(consoleErrors).toEqual([])

    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    const items: Array<{str: string; x: number}> = []
    for (let i = 1; i <= doc.numPages; i++) {
        const pd = await doc.getPage(i)
        const content = await pd.getTextContent()
        for (const item of content.items as Array<Record<string, unknown>>) {
            if (typeof item.str === "string" && item.str.trim().length > 0) {
                items.push({
                    str: item.str.replace(/\u0000/g, ""),
                    x: (item.transform as number[])[4]
                })
            }
        }
    }
    const xOf = (needle: string): number | null =>
        items.find(item => item.str.includes(needle))?.x ?? null

    // Presence of every intended word/pane.
    const allText = items.map(item => item.str).join(" ")
    for (const needle of [
        "مرحبا",
        "بالعالم",
        "عدد",
        "123",
        "تقرير",
        "שלום",
        "עולם",
        "English"
    ]) {
        expect(allText).toContain(needle)
    }

    // Pure Arabic sentence: first logical word is rightmost.
    const mrb = xOf("مرحبا")
    const bal = xOf("بالعالم")
    expect(mrb).not.toBeNull()
    expect(bal).not.toBeNull()
    expect(mrb! > bal!).toBe(true)

    // Mixed token "عدد123 تقرير": the Arabic leading run is rightmost, the
    // digit pane sits to its left, and the trailing word is leftmost.
    const adad = xOf("عدد")
    const digits = xOf("123")
    const taq = xOf("تقرير")
    expect(adad).not.toBeNull()
    expect(digits).not.toBeNull()
    expect(taq).not.toBeNull()
    expect(adad! > digits!).toBe(true)
    expect(digits! > taq!).toBe(true)

    // Hebrew sentence: first logical word rightmost.
    const shalom = xOf("שלום")
    const olam = xOf("עולם")
    expect(shalom).not.toBeNull()
    expect(olam).not.toBeNull()
    expect(shalom! > olam!).toBe(true)

    // Latin LTR paragraph is leftmost of all the RTL text.
    const english = xOf("English")
    expect(english).not.toBeNull()
    expect(english! < taq!).toBe(true)
})