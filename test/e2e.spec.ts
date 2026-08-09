import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import {PDFDict, PDFDocument, PDFName, PDFRef} from "@pdfme/pdf-lib"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

interface PdfjsAnnotation {
    subtype?: string
    url?: string
    dest?: unknown
}

type PdfjsDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>

/** Resolve a GoTo destination to a 0-based page index (null if unknown). */
async function resolveDestPageIndex(
    doc: PdfjsDoc,
    dest: unknown
): Promise<number | null> {
    if (Array.isArray(dest) && dest.length > 0) {
        const ref = dest[0] as {num: number; gen: number}
        try {
            return await doc.getPageIndex(ref)
        } catch {
            return null
        }
    }
    if (typeof dest === "string") {
        const explicit = await doc.getDestination(dest)
        return explicit ? resolveDestPageIndex(doc, explicit) : null
    }
    return null
}

interface PdfInspection {
    /** plain text per page (1-based order) */
    pageTexts: string[]
    /** URLs of external (URI action) Link annotations */
    urls: string[]
    /** per page: resolved 0-based target page of each GoTo Link (null for
        URI links or unresolvable dests) */
    destPagesPerPage: (number | null)[][]
}

/** Extract text + link annotations with pdfjs-dist (@pdfme/pdf-lib, like
    pdf-lib, cannot read text or annotations). */
async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
    // pdfjs v6 rejects node Buffers; copy into a plain Uint8Array.
    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    const pageTexts: string[] = []
    const urls: string[] = []
    const destPagesPerPage: (number | null)[][] = []
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        pageTexts.push(
            content.items
                .map(item => ("str" in item ? item.str : ""))
                .join(" ")
                .replace(/\s+/g, " ")
        )
        const annots = (await page.getAnnotations()) as PdfjsAnnotation[]
        const destPages: (number | null)[] = []
        for (const annot of annots) {
            if (annot.subtype !== "Link") {
                continue
            }
            if (annot.url) {
                urls.push(annot.url)
            }
            destPages.push(await resolveDestPageIndex(doc, annot.dest))
        }
        destPagesPerPage.push(destPages)
    }
    return {pageTexts, urls, destPagesPerPage}
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
    const {pageTexts: pages, urls, destPagesPerPage} = await inspectPdf(bytes)
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

    // 6. Links: text is present AND clickable annotations exist.
    const allText = pages.join(" ")
    expect(allText).toContain("vivliostyle pagination engine")
    expect(allText).toContain("using pdf-lib")

    // 6a. External links → URI action annotations for both demo URLs.
    expect(urls).toContain("https://vivliostyle.org/")
    expect(urls).toContain("https://pdf-lib.js.org/")

    // 6b. Internal links → GoTo annotations. The TOC has 7 entries and
    //     there are 6 cross-reference anchors; each anchor may produce
    //     several rects, so the floor is conservative.
    const goToCount = destPagesPerPage
        .flat()
        .filter(p => p !== null).length
    expect(goToCount).toBeGreaterThanOrEqual(10)

    // 6c. TOC link annotations jump to the pages where the sections
    //     actually are.
    const tocDests = new Set(
        destPagesPerPage[pageContaining(pages, "Contents") - 1]
    )
    for (const heading of [
        "The Pagination Pipeline",
        "Tabular Results",
        "References"
    ]) {
        const targetPage = pageContaining(pages, heading, 2)
        expect(
            tocDests.has(targetPage - 1),
            `TOC link to "${heading}" lands on page ${targetPage}`
        ).toBe(true)
    }

    // 6d. Cross-reference link annotations jump to their caption pages.
    const xrefDests = new Set(
        destPagesPerPage[
            pageContaining(pages, "A feature matrix is provided in") - 1
        ]
    )
    expect(
        xrefDests.has(
            pageContaining(pages, "Table 2: CSS Paged Media features") - 1
        ),
        "Table 2 cross reference links to the caption's page"
    ).toBe(true)
    expect(
        xrefDests.has(
            pageContaining(pages, "Figure 1: The four-stage pagination") - 1
        ),
        "Figure 1 cross reference links to the caption's page"
    ).toBe(true)

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
    // "deleted emphasis" is struck through; the exact page break depends on
    // vivliostyle layout, so just verify both halves remain extractable.
    expect(allText).toContain("deleted emphasis")
    // The <pre> code block renders in Libertinus Mono; its text is present.
    expect(collapsed).toContain("paintBackgrounds(page,pdfPage)")
    expect(allText).toContain("emitPdfFromVivliostyleWindow()")

    // 8. Document metadata (from the demo document's <title>/<meta> tags).
    const doc2 = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    const {info} = await doc2.getMetadata()
    const meta = info as Record<string, unknown>
    expect(String(meta.Title)).toContain("Client-Side Paged Media")
    expect(meta.Author).toBe("J. Wilm and A. Researcher")
    expect(String(meta.Subject)).toContain("browser-only production")
    expect(String(meta.Keywords)).toContain("vivliostyle")
    expect(String(meta.Creator)).toContain("vivliostyle-pdf")
    expect(String(meta.Producer)).toContain("@pdfme/pdf-lib")

    // 9. Outline / bookmarks: the h1–h3 heading tree is present, nested,
    //    and its destinations resolve to the right pages.
    interface OutlineItem {
        title: string
        dest: unknown
        items?: OutlineItem[]
    }
    const outline = (await doc2.getOutline()) as OutlineItem[] | null
    expect(outline).not.toBeNull()
    const flatten = (items: OutlineItem[]): OutlineItem[] =>
        items.flatMap(item => [item, ...flatten(item.items ?? [])])
    const flat = flatten(outline!)
    expect(flat.length).toBeGreaterThanOrEqual(12)
    expect(flat.some(item => item.title.includes("Introduction"))).toBe(true)
    expect(flat.some(item => item.title.includes("Tabular Results"))).toBe(
        true
    )
    // h2 "The Pagination Pipeline" nests its h3 subsections.
    const pipeline = flat.find(item =>
        item.title.includes("The Pagination Pipeline")
    )
    expect(pipeline).toBeTruthy()
    expect(
        (pipeline!.items ?? []).some(item => item.title.includes("Overview")),
        "h3 nested below its h2"
    ).toBe(true)
    // Bookmark destinations land on the pages where the headings are.
    const tabular = flat.find(item => item.title.includes("Tabular Results"))
    const tabularDest = await resolveDestPageIndex(doc2, tabular!.dest)
    expect(tabularDest).toBe(pageContaining(pages, "Tabular Results", 2) - 1)

    // 10. The source HTML is embedded as an attachment. (pdfjs v6 returns a
    //     Map of FileSpec metadata here; content is fetched separately.)
    const atts = (await doc2.getAttachments()) as Map<
        string,
        {filename: string; description: string}
    > | null
    expect(atts?.has("demo-document.html")).toBe(true)
    const attContent = await doc2.getAttachmentContent("demo-document.html")
    expect(attContent).not.toBeNull()
    const attHead = new TextDecoder()
        .decode(attContent!.subarray(0, 100))
        .toLowerCase()
    expect(attHead).toContain("<!doctype html")

    // 11. Catalog-level viewer preferences (@pdfme/pdf-lib can read these
    //     low-level dictionaries, pdfjs does not expose them).
    const loaded = await PDFDocument.load(bytes)
    expect(String(loaded.catalog.get(PDFName.of("PageMode")))).toContain(
        "UseOutlines"
    )
    expect(String(loaded.catalog.get(PDFName.of("Lang")))).toContain("en-US")
    let vp = loaded.catalog.get(PDFName.of("ViewerPreferences"))
    if (vp instanceof PDFRef) {
        vp = loaded.context.lookup(vp)
    }
    expect(vp).toBeInstanceOf(PDFDict)
    expect(String((vp as PDFDict).get(PDFName.of("DisplayDocTitle")))).toBe(
        "true"
    )
})
