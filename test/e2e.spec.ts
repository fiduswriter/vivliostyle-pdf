import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import {PDFDocument} from "pdf-lib"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/** Extract per-page plain text with pdfjs-dist (pdf-lib cannot read text). */
async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
    // pdfjs v6 rejects node Buffers; copy into a plain Uint8Array.
    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    const texts: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        const text = content.items
            .map(item => ("str" in item ? item.str : ""))
            .join(" ")
            .replace(/\s+/g, " ")
        texts.push(text)
    }
    return texts
}

/** Total number of annotations across all pages (expected: zero). */
async function countAnnotations(bytes: Uint8Array): Promise<number> {
    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)})
        .promise
    let count = 0
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        count += (await page.getAnnotations()).length
    }
    return count
}

/** 1-based index of the first page whose text contains `needle`. */
function pageContaining(
    pages: string[],
    needle: string,
    fromPage = 1
): number {
    for (let i = fromPage - 1; i < pages.length; i++) {
        if (pages[i].includes(needle)) {
            return i + 1
        }
    }
    throw new Error(`No page contains: ${needle}`)
}

test("generates a valid multi-page PDF in the browser", async ({page}) => {
    const consoleErrors: string[] = []
    page.on("console", msg => {
        if (msg.type() === "error") {
            consoleErrors.push(msg.text())
        }
    })
    page.on("pageerror", error => consoleErrors.push(String(error)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()

    const downloadPromise = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const download = await downloadPromise

    const path = await download.path()
    expect(path).toBeTruthy()
    const bytes = await readFile(path!)

    // It is a real PDF…
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    // …of substantial size (fonts, images, many text runs)…
    expect(bytes.length).toBeGreaterThan(20 * 1024)
    // …with more than 5 pages (TOC + body + long table + figures + refs).
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThan(5)

    // The page reported success and no errors occurred along the way.
    await expect(page.locator("#status")).toContainText("Done")
    expect(consoleErrors).toEqual([])

    // ---- Feature-level assertions on the extracted text ----
    const pages = await extractPageTexts(bytes)
    const pageCount = pages.length

    // 1. Running header on every page. (Only the margin header contains
    //    this string on pages 2+; page 1 also has it as the doc title.)
    for (const [i, text] of pages.entries()) {
        expect(text, `header on page ${i + 1}`).toContain(
            "Client-Side Paged Media"
        )
    }

    // 2. Page-number footer ("N / total") on every page.
    for (const [i, text] of pages.entries()) {
        expect(
            new RegExp(`${i + 1}\\s*/\\s*${pageCount}`).test(text),
            `footer page number on page ${i + 1}`
        ).toBe(true)
    }

    // 3. TOC entries carry resolved page numbers (digits after leader dots).
    const tocPage = pages[pageContaining(pages, "Contents") - 1]
    for (const entry of [
        "Introduction",
        "Tabular Results",
        "Figures",
        "References"
    ]) {
        expect(
            new RegExp(`${entry}[\\s.]*\\d+`).test(tocPage),
            `TOC entry with page number: ${entry}`
        ).toBe(true)
    }

    // 4. Cross references: each "X (page N)" must point at the page where
    //    the target's caption/heading actually lands.
    const crossRefs: {
        /** distinctive text of the link, as rendered before " (page N)" */
        ref: string
        /** distinctive caption/heading text of the target */
        target: string
        /** page search for the target starts here (skip the TOC page) */
        fromPage?: number
    }[] = [
        {ref: "Table 2", target: "Table 2: CSS Paged Media features"},
        {ref: "Figure 1", target: "Figure 1: The four-stage pagination"},
        {ref: "Figure 3", target: "Figure 3: Latency by payload size"},
        {
            ref: "Section 2",
            target: "The Pagination Pipeline",
            fromPage: 2
        }
    ]
    for (const {ref, target, fromPage} of crossRefs) {
        const targetPage = pageContaining(pages, target, fromPage ?? 1)
        // Find every occurrence of the cross reference and check its number.
        const pattern = new RegExp(
            `${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(page (\\d+)\\)`,
            "g"
        )
        let occurrences = 0
        for (const text of pages) {
            for (const match of text.matchAll(pattern)) {
                occurrences++
                expect(
                    Number(match[1]),
                    `${ref} cross reference resolves to page ${targetPage}`
                ).toBe(targetPage)
            }
        }
        expect(occurrences, `cross reference present: ${ref}`).toBeGreaterThan(
            0
        )
    }

    // 5. Footnotes: the footnote body text lands on the same page as the
    //    sentence containing its call.
    const footnoteChecks = [
        {
            call: "detour through the browser's print dialog",
            body: "Print-dialog workflows cannot be automated"
        },
        {
            call: "the emitter never re-breaks a line",
            body: "Justified text survives because inter-word"
        }
    ]
    for (const {call, body} of footnoteChecks) {
        const callPage = pageContaining(pages, call, 2)
        expect(
            pages[callPage - 1],
            `footnote "${body.slice(0, 30)}…" on page ${callPage}`
        ).toContain(body)
    }

    // 6. Links render as (styled) text…
    const allText = pages.join(" ")
    expect(allText).toContain("vivliostyle pagination engine")
    expect(allText).toContain("using pdf-lib")
    // …but the PDF contains no annotations at all: links are not clickable
    // (pdf-lib has no annotation support — documented limitation).
    expect(await countAnnotations(bytes)).toBe(0)

    // 7. Inline styles. pdfjs inserts erratic spaces around the glyph-size
    //    changes of synthesized small caps, so compare space-collapsed text.
    const collapsed = allText.replace(/\s+/g, "")
    // Small caps are synthesized as uppercase glyphs (pinned behavior):
    expect(collapsed).toContain("SMALLCAPS") // span in the §2.2 sentence
    expect(collapsed).toContain("INLINESTYLES") // small-caps h3 heading
    expect(collapsed).toContain("ABSTRACT") // small-caps abstract label
    // Strikethrough content is drawn as text (the strike line itself is a
    // vector line, invisible to text extraction — verified visually).
    expect(allText).toContain("strikethrough")
    // "deleted emphasis" is struck through and straddles a page break:
    // "deleted" ends page 2, "emphasis" starts page 3.
    expect(pages[1]).toContain("deleted")
    expect(pages[2]).toContain("emphasis shows that decorations compose")
    // The <pre> code block renders in Libertinus Mono; its text is present.
    expect(collapsed).toContain("paintBackgrounds(page,pdfPage)")
    expect(allText).toContain("emitPdfFromVivliostyleWindow()")
})
