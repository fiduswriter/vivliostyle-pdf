/**
 * DOM-to-PDF emitter.
 *
 * Walks the paginated output produced by vivliostyle inside its (hidden)
 * iframe and re-renders it as a real vector PDF using @pdfme/pdf-lib (an
 * API-compatible, maintained fork of pdf-lib). No browser print dialog is
 * involved.
 *
 * Scope of this prototype: text (word-precise positions), embedded
 * Libertinus Serif/Mono with subsetting, PNG/JPEG images, SVG images
 * (rasterized), solid background-color rects and simple solid borders, and
 * link annotations (external URI actions, internal GoTo destinations)
 * hand-built via the low-level PDF object API.
 *
 * Coordinate systems:
 *  - Browser DOM: origin top-left, units CSS px.
 *  - PDF: origin bottom-left, units points (1 px = 0.75 pt).
 *  All measured rects are made relative to their page container first, then
 *  Y is flipped when drawing.
 */
import * as fontkit from "fontkit"
import {PDFDocument, PDFFont, PDFString, rgb} from "@pdfme/pdf-lib"
import type {PDFPage, RGB} from "@pdfme/pdf-lib"

const PX_TO_PT = 0.75

/** The four Libertinus Serif variants shipped in public/fonts/ (OFL licensed). */
const FONT_FILES = {
    regular: "fonts/LibertinusSerif-Regular.ttf",
    bold: "fonts/LibertinusSerif-Bold.ttf",
    italic: "fonts/LibertinusSerif-Italic.ttf",
    boldItalic: "fonts/LibertinusSerif-BoldItalic.ttf",
    // Libertinus Mono has no bold/italic cuts; all monospace text maps here.
    mono: "fonts/LibertinusMono-Regular.ttf"
} as const

type FontVariant = keyof typeof FONT_FILES

interface FontMetrics {
    /** ascent and descent in px for a given font size (from fontkit, em-scaled) */
    ascent(sizePx: number): number
    descent(sizePx: number): number
}

interface LoadedFont {
    pdfFont: PDFFont
    metrics: FontMetrics
}

interface WordRun {
    text: string
    /** rect relative to the page container, in px */
    x: number
    yTop: number
    yBottom: number
    width: number
    fontSizePx: number
    variant: FontVariant
    color: RGB
    /** draw a strike line through this run (text-decoration: line-through) */
    lineThrough: boolean
    /** synthesize small caps: lowercase drawn as uppercase at reduced size */
    smallCaps: boolean
}

/**
 * Emit a PDF from the window of a vivliostyle-print iframe after pagination
 * has completed.
 *
 * @param win  the iframe window passed to printCallback
 * @param onProgress  optional status callback for UI feedback
 * @returns the PDF file bytes
 */
export async function emitPdfFromVivliostyleWindow(
    win: Window,
    onProgress?: (message: string) => void
): Promise<Uint8Array> {
    const doc = win.document
    const pageContainers = Array.from(
        doc.querySelectorAll<HTMLElement>("[data-vivliostyle-page-container]")
    ).filter(container => !isEmptyPage(container))

    if (pageContainers.length === 0) {
        throw new Error("No paginated pages found in vivliostyle output")
    }

    // Make sure web fonts used for pagination are fully loaded before we
    // measure text rects — otherwise line breaks measured now could differ
    // from the final layout.
    await doc.fonts.ready

    // Vivliostyle's viewer only displays the first page on screen (the
    // print stylesheet would reveal the rest, but we never print). Restore
    // display on hidden page containers so their rects can be measured.
    // Layout inside each page container is fixed, so this is safe.
    for (const container of pageContainers) {
        if (win.getComputedStyle(container).display === "none") {
            container.style.display = "block"
        }
    }
    // Force a reflow so the display changes take effect before measuring.
    void doc.body.offsetWidth

    const pdfDoc = await PDFDocument.create()
    // The fork's Fontkit interface is not re-exported from its index.
    pdfDoc.registerFontkit(
        fontkit as unknown as Parameters<PDFDocument["registerFontkit"]>[0]
    )

    onProgress?.("Loading fonts…")
    const fonts = await loadFonts(pdfDoc)

    // Link collection runs alongside page emission. Internal (#id) links
    // need their target's page, which may come later — so anchor targets
    // are recorded per page and the annotations are attached afterwards.
    const links: CollectedLink[] = []
    const anchorTargets = new Map<string, AnchorTarget>()

    for (const [index, container] of pageContainers.entries()) {
        onProgress?.(`Emitting page ${index + 1} of ${pageContainers.length}…`)
        const {pageHeightPt} = await emitPage(win, pdfDoc, container, fonts)
        collectAnchorTargets(
            win,
            container,
            pageHeightPt,
            index,
            anchorTargets
        )
        collectLinks(win, container, pageHeightPt, index, links)
    }
    addLinkAnnotations(pdfDoc, links, anchorTargets)

    onProgress?.("Serializing PDF…")
    return pdfDoc.save()
}

/** A page is "empty" if it contains neither visible text nor images. */
function isEmptyPage(container: HTMLElement): boolean {
    if (container.querySelector("img")) {
        return false
    }
    const text = container.textContent ?? ""
    return text.trim().length === 0
}

/** Fetch the four TTF files, embed them (subset) and expose fontkit metrics. */
async function loadFonts(
    pdfDoc: PDFDocument
): Promise<Record<FontVariant, LoadedFont>> {
    const base = new URL(import.meta.env.BASE_URL, window.location.href)
    const entries = await Promise.all(
        (
            Object.entries(FONT_FILES) as [FontVariant, string][]
        ).map(async ([variant, path]) => {
            const res = await fetch(new URL(path, base))
            if (!res.ok) {
                throw new Error(`Failed to fetch font ${path}: ${res.status}`)
            }
            const bytes = new Uint8Array(await res.arrayBuffer())
            const pdfFont = await pdfDoc.embedFont(bytes, {subset: true})
            // fontkit gives us real ascent/descent for baseline placement.
            const fkFont = fontkit.create(bytes)
            const unitsPerEm = fkFont.unitsPerEm
            const metrics: FontMetrics = {
                ascent: sizePx => (fkFont.ascent / unitsPerEm) * sizePx,
                descent: sizePx =>
                    (Math.abs(fkFont.descent) / unitsPerEm) * sizePx
            }
            return [variant, {pdfFont, metrics}] as const
        })
    )
    return Object.fromEntries(entries) as Record<FontVariant, LoadedFont>
}

async function emitPage(
    win: Window,
    pdfDoc: PDFDocument,
    container: HTMLElement,
    fonts: Record<FontVariant, LoadedFont>
): Promise<{pageHeightPt: number}> {
    const containerRect = container.getBoundingClientRect()
    const pageWidthPt = containerRect.width * PX_TO_PT
    const pageHeightPt = containerRect.height * PX_TO_PT
    if (containerRect.width === 0 || containerRect.height === 0) {
        throw new Error(
            "Page container has zero size — cannot measure paginated layout"
        )
    }
    const page = pdfDoc.addPage([pageWidthPt, pageHeightPt])

    /** Convert a DOM rect (relative to container, px) to PDF coords. */
    const toPdf = (x: number, y: number, height: number) => ({
        x: x * PX_TO_PT,
        // flip Y: PDF y is the *bottom* of the rect
        y: pageHeightPt - (y + height) * PX_TO_PT
    })

    // Paint order (a simplification of CSS stacking, fine for a prototype):
    // 1. backgrounds, 2. borders, 3. images, 4. text.
    paintBackgrounds(win, container, containerRect, page, toPdf)
    paintBorders(win, container, containerRect, page, toPdf)
    await paintImages(win, pdfDoc, container, containerRect, page, toPdf)

    const words = collectWords(win, container, containerRect)
    // ::marker pseudo-boxes have no text nodes; synthesize them separately.
    words.push(...collectListMarkers(win, container, containerRect, fonts))
    for (const word of words) {
        const font = fonts[word.variant]
        const sizePt = word.fontSizePx * PX_TO_PT
        // Baseline approximation: the range rect roughly spans ascent..descent
        // of the text, so the baseline sits `descent` above the rect bottom.
        // (Approximation — see README "Limitations".)
        const baselinePx =
            word.yBottom - font.metrics.descent(word.fontSizePx)
        const baselineY = pageHeightPt - baselinePx * PX_TO_PT
        const xPt = word.x * PX_TO_PT
        if (word.smallCaps) {
            drawSmallCapsRun(
                page,
                word.text,
                xPt,
                baselineY,
                sizePt,
                word.width * PX_TO_PT,
                font,
                word.color
            )
        } else {
            page.drawText(word.text, {
                x: xPt,
                y: baselineY,
                size: sizePt,
                font: font.pdfFont,
                color: word.color
            })
        }
        if (word.lineThrough) {
            // Strike line at roughly mid x-height above the baseline.
            const strikeY = baselineY + sizePt * 0.3
            page.drawLine({
                start: {x: xPt, y: strikeY},
                end: {x: xPt + word.width * PX_TO_PT, y: strikeY},
                thickness: Math.max(0.4, sizePt / 18),
                color: word.color
            })
        }
    }
    return {pageHeightPt}
}

/* ---- Link annotations ----------------------------------------------
 * pdf-lib/@pdfme/pdf-lib has no high-level annotation API, so link
 * annotations are hand-built as PDF dictionaries via doc.context.obj(),
 * registered with doc.context.register(), and attached to each page's
 * leaf node with page.node.addAnnot().
 * ------------------------------------------------------------------ */

interface CollectedLink {
    href: string
    /** 0-based index into pdfDoc.getPages() */
    pageIndex: number
    /** rects in PDF coordinates (origin bottom-left, pt) */
    rects: {x: number; y: number; width: number; height: number}[]
}

interface AnchorTarget {
    pageIndex: number
    /** top edge of the target element, in PDF pt from the page bottom */
    yTopPt: number
}

/** Record where each element with an id landed (page + top coordinate). */
function collectAnchorTargets(
    win: Window,
    container: HTMLElement,
    pageHeightPt: number,
    pageIndex: number,
    targets: Map<string, AnchorTarget>
): void {
    const containerRect = container.getBoundingClientRect()
    for (const el of Array.from(
        container.querySelectorAll<HTMLElement>("[id]")
    )) {
        // vivliostyle adds shadow elements with rewritten "viv-id-…" ids;
        // the original ids are what links should resolve to.
        if (el.id.startsWith("viv-id-")) {
            continue
        }
        if (targets.has(el.id)) {
            continue
        }
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
            continue
        }
        const yTopPx = rect.top - containerRect.top
        targets.set(el.id, {
            pageIndex,
            yTopPt: pageHeightPt - yTopPx * PX_TO_PT
        })
    }
    void win
}

/** Collect every <a href> rect; inline links can wrap → multiple rects. */
function collectLinks(
    win: Window,
    container: HTMLElement,
    pageHeightPt: number,
    pageIndex: number,
    links: CollectedLink[]
): void {
    const containerRect = container.getBoundingClientRect()
    for (const anchor of Array.from(
        container.querySelectorAll<HTMLAnchorElement>("a[href]")
    )) {
        const href = anchor.getAttribute("href") ?? ""
        if (!href) {
            continue
        }
        const rects = Array.from(anchor.getClientRects())
            .filter(r => r.width > 0 && r.height > 0)
            .map(r => ({
                x: (r.left - containerRect.left) * PX_TO_PT,
                y: pageHeightPt - (r.top - containerRect.top + r.height) * PX_TO_PT,
                width: r.width * PX_TO_PT,
                height: r.height * PX_TO_PT
            }))
        if (rects.length > 0) {
            links.push({href, pageIndex, rects})
        }
    }
    void win
}

/**
 * Recover the original fragment id from an href. Vivliostyle rewrites
 * internal "#id" hrefs to "#viv-id-<url-encoded document URL>:0023id"
 * (":0023" is the encoded "#"); strip that prefix when present.
 */
function resolveFragmentId(href: string): string | null {
    if (!href.startsWith("#")) {
        return null
    }
    const raw = href.slice(1)
    const marker = ":0023"
    const idx = raw.lastIndexOf(marker)
    return idx === -1 ? raw : raw.slice(idx + marker.length)
}

/**
 * Attach link annotations after all pages are emitted (two-pass: internal
 * GoTo destinations need the target's page, which may be emitted later).
 */
function addLinkAnnotations(
    pdfDoc: PDFDocument,
    links: CollectedLink[],
    targets: Map<string, AnchorTarget>
): void {
    const pages = pdfDoc.getPages()
    for (const link of links) {
        const page = pages[link.pageIndex]
        const isExternal = /^https?:\/\//.test(link.href)
        const fragmentId = resolveFragmentId(link.href)
        const target = fragmentId ? targets.get(fragmentId) : undefined
        for (const rect of link.rects) {
            const rectArray = [
                rect.x,
                rect.y,
                rect.x + rect.width,
                rect.y + rect.height
            ]
            let annot
            if (isExternal) {
                annot = pdfDoc.context.obj({
                    Type: "Annot",
                    Subtype: "Link",
                    Rect: rectArray,
                    Border: [0, 0, 0],
                    A: {
                        Type: "Action",
                        S: "URI",
                        URI: PDFString.of(link.href)
                    }
                })
            } else if (target) {
                // GoTo link: [pageRef /XYZ left top zoom]; null = keep.
                annot = pdfDoc.context.obj({
                    Type: "Annot",
                    Subtype: "Link",
                    Rect: rectArray,
                    Border: [0, 0, 0],
                    Dest: [
                        pages[target.pageIndex].ref,
                        "XYZ",
                        null,
                        target.yTopPt,
                        null
                    ]
                })
            } else {
                continue // unresolvable target — skip
            }
            const annotRef = pdfDoc.context.register(annot)
            page.node.addAnnot(annotRef)
        }
    }
}

/**
 * Draw a run in synthesized small caps: lowercase letters become uppercase
 * glyphs at a reduced size, everything else stays at full size. Chromium
 * applies `font-variant-caps: small-caps` via glyph substitution at render
 * time (the DOM text stays lowercase), so we reproduce it here — pdf-lib
 * does not apply OpenType features such as `smcp`.
 *
 * Real small-cap glyphs are narrower than our scaled uppercase, so the
 * synthesized run is uniformly scaled to fit the measured layout width of
 * the word; otherwise it would overlap the following word.
 */
const SMALL_CAPS_SCALE = 0.8

function drawSmallCapsRun(
    page: PDFPage,
    text: string,
    xPt: number,
    baselineY: number,
    sizePt: number,
    targetWidthPt: number,
    font: LoadedFont,
    color: RGB
): void {
    // Per-character (text, size) pieces at their natural sizes.
    const pieces = Array.from(text, ch => {
        const isLower = ch.toUpperCase() !== ch
        const out = isLower ? ch.toUpperCase() : ch
        const size = isLower ? sizePt * SMALL_CAPS_SCALE : sizePt
        return {out, size, advance: font.pdfFont.widthOfTextAtSize(out, size)}
    })
    const naturalWidth = pieces.reduce((sum, p) => sum + p.advance, 0)
    // Fit to the measured width (clamped so a bad measurement can't
    // produce absurd glyph sizes).
    const fit =
        naturalWidth > 0
            ? Math.min(1.3, Math.max(0.6, targetWidthPt / naturalWidth))
            : 1
    let cursor = xPt
    for (const piece of pieces) {
        page.drawText(piece.out, {
            x: cursor,
            y: baselineY,
            size: piece.size * fit,
            font: font.pdfFont,
            color
        })
        cursor += piece.advance * fit
    }
}

type ToPdfFn = (x: number, y: number, height: number) => {x: number; y: number}

/** Draw background-color rects for elements with a non-transparent background. */
function paintBackgrounds(
    win: Window,
    container: HTMLElement,
    containerRect: DOMRect,
    page: PDFPage,
    toPdf: ToPdfFn
): void {
    for (const el of walkElements(win, container)) {
        const bg = win.getComputedStyle(el).backgroundColor
        const color = parseCssColor(bg)
        if (!color || color.alpha === 0) {
            continue
        }
        for (const rect of Array.from(el.getClientRects())) {
            const x = rect.left - containerRect.left
            const y = rect.top - containerRect.top
            const pos = toPdf(x, y, rect.height)
            page.drawRectangle({
                x: pos.x,
                y: pos.y,
                width: rect.width * PX_TO_PT,
                height: rect.height * PX_TO_PT,
                color: color.rgb
            })
        }
    }
}

/** Draw simple solid borders (each edge as a filled rect of the border width). */
function paintBorders(
    win: Window,
    container: HTMLElement,
    containerRect: DOMRect,
    page: PDFPage,
    toPdf: ToPdfFn
): void {
    for (const el of walkElements(win, container)) {
        const style = win.getComputedStyle(el)
        const sides = [
            {
                width: parseFloat(style.borderTopWidth),
                style: style.borderTopStyle,
                color: style.borderTopColor,
                edge: "top" as const
            },
            {
                width: parseFloat(style.borderRightWidth),
                style: style.borderRightStyle,
                color: style.borderRightColor,
                edge: "right" as const
            },
            {
                width: parseFloat(style.borderBottomWidth),
                style: style.borderBottomStyle,
                color: style.borderBottomColor,
                edge: "bottom" as const
            },
            {
                width: parseFloat(style.borderLeftWidth),
                style: style.borderLeftStyle,
                color: style.borderLeftColor,
                edge: "left" as const
            }
        ]
        if (sides.every(s => !s.width || s.style !== "solid")) {
            continue
        }
        const rect = el.getBoundingClientRect()
        const x = rect.left - containerRect.left
        const y = rect.top - containerRect.top
        for (const side of sides) {
            if (!side.width || side.style !== "solid") {
                continue
            }
            const color = parseCssColor(side.color)
            if (!color || color.alpha === 0) {
                continue
            }
            const w = side.width
            let rx = x
            let ry = y
            let rw = rect.width
            let rh = w
            if (side.edge === "bottom") {
                ry = y + rect.height - w
            } else if (side.edge === "left") {
                rw = w
                rh = rect.height
            } else if (side.edge === "right") {
                rx = x + rect.width - w
                rw = w
                rh = rect.height
            }
            const pos = toPdf(rx, ry, rh)
            page.drawRectangle({
                x: pos.x,
                y: pos.y,
                width: rw * PX_TO_PT,
                height: rh * PX_TO_PT,
                color: color.rgb
            })
        }
    }
}

/** Embed and draw <img> elements. PNG/JPEG embed directly; SVG is rasterized. */
async function paintImages(
    win: Window,
    pdfDoc: PDFDocument,
    container: HTMLElement,
    containerRect: DOMRect,
    page: PDFPage,
    toPdf: ToPdfFn
): Promise<void> {
    const images = Array.from(container.querySelectorAll("img"))
    for (const img of images) {
        const rect = img.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
            continue
        }
        const x = rect.left - containerRect.left
        const y = rect.top - containerRect.top
        const pos = toPdf(x, y, rect.height)
        const widthPt = rect.width * PX_TO_PT
        const heightPt = rect.height * PX_TO_PT

        const res = await fetch(img.currentSrc || img.src)
        if (!res.ok) {
            console.warn(`Skipping image ${img.src}: HTTP ${res.status}`)
            continue
        }
        const bytes = new Uint8Array(await res.arrayBuffer())
        let embedded
        if (isPng(bytes)) {
            embedded = await pdfDoc.embedPng(bytes)
        } else if (isJpeg(bytes)) {
            embedded = await pdfDoc.embedJpg(bytes)
        } else {
            // Assume SVG (or anything else): rasterize via canvas at 2x.
            const png = await rasterizeToPng(
                win,
                img.currentSrc || img.src,
                img.naturalWidth || rect.width,
                img.naturalHeight || rect.height
            )
            if (!png) {
                console.warn(`Skipping unrasterizable image ${img.src}`)
                continue
            }
            embedded = await pdfDoc.embedPng(png)
        }
        page.drawImage(embedded, {
            x: pos.x,
            y: pos.y,
            width: widthPt,
            height: heightPt
        })
    }
}

function isPng(bytes: Uint8Array): boolean {
    return (
        bytes.length > 4 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    )
}

function isJpeg(bytes: Uint8Array): boolean {
    return bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8
}

/**
 * Rasterize an image (used for SVGs) through an offscreen canvas at 2x.
 * Returns PNG bytes, or null if the image could not be loaded.
 */
function rasterizeToPng(
    win: Window,
    src: string,
    naturalWidth: number,
    naturalHeight: number
): Promise<Uint8Array | null> {
    return new Promise(resolve => {
        // Draw in the *parent* document — the iframe may be 0x0 sized.
        const image = new window.Image()
        image.onload = () => {
            const canvas = window.document.createElement("canvas")
            canvas.width = Math.max(1, Math.round(naturalWidth * 2))
            canvas.height = Math.max(1, Math.round(naturalHeight * 2))
            const ctx = canvas.getContext("2d")
            if (!ctx) {
                resolve(null)
                return
            }
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
            canvas.toBlob(blob => {
                if (!blob) {
                    resolve(null)
                    return
                }
                blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)))
            }, "image/png")
        }
        image.onerror = () => resolve(null)
        image.src = src
        void win // kept for symmetry / future iframe-canvas needs
    })
}

/**
 * Collect individually positioned word runs for all text inside the page.
 * Positions come from Range.getBoundingClientRect() per word, so browser
 * line breaking, justification and spacing are preserved exactly.
 */
function collectWords(
    win: Window,
    container: HTMLElement,
    containerRect: DOMRect
): WordRun[] {
    const words: WordRun[] = []
    const doc = win.document
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const range = doc.createRange()

    let node = walker.nextNode()
    while (node) {
        const textNode = node as Text
        node = walker.nextNode()
        const parent = textNode.parentElement
        if (!parent) {
            continue
        }
        const style = win.getComputedStyle(parent)
        if (
            style.visibility === "hidden" ||
            parseFloat(style.fontSize) === 0
        ) {
            continue
        }
        const color = parseCssColor(style.color)?.rgb ?? rgb(0, 0, 0)
        const fontSizePx = parseFloat(style.fontSize)
        const variant = pickVariant(
            style.fontWeight,
            style.fontStyle,
            style.fontFamily
        )
        const transform = style.textTransform
        const lineThrough = hasLineThrough(win, container, parent)
        const smallCaps = style.fontVariantCaps.includes("small-caps")
        const text = textNode.data

        const applyTransform = (s: string): string => {
            // (capitalize not handled — prototype limitation.)
            if (transform === "uppercase") {
                return s.toUpperCase()
            }
            if (transform === "lowercase") {
                return s.toLowerCase()
            }
            return s
        }
        const pushRun = (runText: string, rect: DOMRect): void => {
            words.push({
                text: applyTransform(runText),
                x: rect.left - containerRect.left,
                yTop: rect.top - containerRect.top,
                yBottom: rect.bottom - containerRect.top,
                width: rect.width,
                fontSizePx,
                variant,
                color,
                lineThrough,
                smallCaps
            })
        }
        const measureRange = (start: number, end: number): DOMRect => {
            range.setStart(textNode, start)
            range.setEnd(textNode, end)
            return range.getBoundingClientRect()
        }

        // Split into words, keeping offsets so each word can be ranged
        // and measured individually.
        const wordPattern = /\S+/g
        let match: RegExpExecArray | null
        while ((match = wordPattern.exec(text)) !== null) {
            const word = match[0]
            const wordEnd = match.index + word.length
            const wordRect = measureRange(match.index, wordEnd)
            const rects = Array.from(range.getClientRects()).filter(
                r => r.width > 0 && r.height > 0
            )
            if (rects.length <= 1) {
                if (wordRect.width > 0 && wordRect.height > 0) {
                    pushRun(word, wordRect)
                }
                continue
            }
            // The word wraps across lines (e.g. broken at a hyphen). Group
            // its characters by line and emit one run per group — otherwise
            // the whole word would be drawn once per fragment and overlap
            // the following words.
            let groupStart = match.index
            let lineTop: number | null = null
            for (let k = match.index; k < wordEnd; k++) {
                const charRect = measureRange(k, k + 1)
                if (charRect.width === 0 || charRect.height === 0) {
                    continue
                }
                if (lineTop === null) {
                    lineTop = charRect.top
                } else if (Math.abs(charRect.top - lineTop) > 1) {
                    pushRun(
                        text.slice(groupStart, k),
                        measureRange(groupStart, k)
                    )
                    groupStart = k
                    lineTop = charRect.top
                }
            }
            if (groupStart < wordEnd) {
                pushRun(
                    text.slice(groupStart, wordEnd),
                    measureRange(groupStart, wordEnd)
                )
            }
        }
    }
    return words
}

/**
 * Synthesize runs for list markers. ::marker pseudo-boxes have no DOM text
 * node, so word collection never sees them; we approximate them here from
 * each list item's computed style. Handles decimal markers and the common
 * bullet types; markers are drawn right-aligned just left of the item's
 * content box.
 */
function collectListMarkers(
    win: Window,
    container: HTMLElement,
    containerRect: DOMRect,
    fonts: Record<FontVariant, LoadedFont>
): WordRun[] {
    const runs: WordRun[] = []
    for (const el of walkElements(win, container)) {
        const style = win.getComputedStyle(el)
        if (style.display !== "list-item") {
            continue
        }
        // Ordinal = position among preceding list-item siblings.
        const ordinal = (): number => {
            let n = 1
            let sibling = el.previousElementSibling
            while (sibling) {
                if (
                    win.getComputedStyle(sibling as HTMLElement).display ===
                    "list-item"
                ) {
                    n++
                }
                sibling = sibling.previousElementSibling
            }
            return n
        }
        const listStyle = style.listStyleType
        let marker: string | null = null
        if (el.style.listStyleType === "none") {
            // Vivliostyle overrides list-style-type with an inline "none"
            // and renders markers internally (invisible to a DOM walk).
            // Synthesize them from the list element type. An author-specified
            // "none" lives in a stylesheet and is NOT matched here.
            const parentTag = el.parentElement?.tagName
            if (parentTag === "OL") {
                marker = `${ordinal()}.`
            } else if (parentTag === "UL") {
                // Bullet type by nesting depth (UA default disc/circle/square
                // sequence); U+25AA is not in Libertinus Serif, hence "•".
                let depth = 0
                let ancestor = el.parentElement?.parentElement
                while (ancestor) {
                    if (ancestor.tagName === "UL") {
                        depth++
                    }
                    ancestor = ancestor.parentElement
                }
                marker = depth % 2 === 0 ? "•" : "◦"
            }
        } else if (listStyle === "decimal") {
            marker = `${ordinal()}.`
        } else if (listStyle === "disc" || listStyle === "square") {
            marker = "•"
        } else if (listStyle === "circle") {
            marker = "◦"
        }
        if (!marker) {
            continue
        }
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
            continue
        }
        const fontSizePx = parseFloat(style.fontSize)
        const variant = pickVariant(
            style.fontWeight,
            style.fontStyle,
            style.fontFamily
        )
        const font = fonts[variant].pdfFont
        // Right-align the marker ending 0.4em left of the item's box.
        const markerWidthPx =
            (font.widthOfTextAtSize(marker, fontSizePx * PX_TO_PT) /
                PX_TO_PT)
        const x =
            rect.left -
            containerRect.left -
            markerWidthPx -
            0.4 * fontSizePx
        const yTop = rect.top - containerRect.top + parseFloat(style.paddingTop || "0")
        runs.push({
            text: marker,
            x,
            yTop,
            // Approximate the first line's em box: font size plus a bit.
            yBottom: yTop + fontSizePx * 1.2,
            width: markerWidthPx,
            fontSizePx,
            variant,
            color: parseCssColor(style.color)?.rgb ?? rgb(0, 0, 0),
            lineThrough: false,
            smallCaps: false
        })
    }
    return runs
}

/**
 * Does any ancestor (up to the page container) carry
 * `text-decoration-line: line-through`? Text decorations propagate to
 * inline descendants visually, but the computed style only shows them on
 * the element they are declared on — so walk up. Results are cached per
 * ancestor element.
 */
const lineThroughCache = new WeakMap<HTMLElement, boolean>()

function hasLineThrough(
    win: Window,
    container: HTMLElement,
    el: HTMLElement
): boolean {
    const cached = lineThroughCache.get(el)
    if (cached !== undefined) {
        return cached
    }
    let result = false
    let node: HTMLElement | null = el
    while (node && node !== container) {
        if (
            win
                .getComputedStyle(node)
                .textDecorationLine.includes("line-through")
        ) {
            result = true
            break
        }
        node = node.parentElement
    }
    lineThroughCache.set(el, result)
    return result
}

function pickVariant(
    fontWeight: string,
    fontStyle: string,
    fontFamily: string
): FontVariant {
    // Monospace maps to Libertinus Mono, which has no bold/italic cuts.
    // Vivliostyle rewrites families (e.g. `Fnt_2, "Libertinus Mono",
    // monospace`) but the original names survive in the computed value.
    if (/mono/i.test(fontFamily)) {
        return "mono"
    }
    const weight = parseInt(fontWeight, 10)
    const bold = Number.isNaN(weight) ? fontWeight === "bold" : weight >= 600
    const italic = fontStyle === "italic" || fontStyle === "oblique"
    if (bold && italic) {
        return "boldItalic"
    }
    if (bold) {
        return "bold"
    }
    if (italic) {
        return "italic"
    }
    return "regular"
}

interface ParsedColor {
    rgb: RGB
    alpha: number
}

/** Parse "rgb(...)"/"rgba(...)" computed colors. Hex never appears here. */
function parseCssColor(cssColor: string): ParsedColor | null {
    const match = cssColor.match(
        /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*([\d.]+)\s*)?\)/
    )
    if (!match) {
        return null
    }
    return {
        rgb: rgb(
            Number(match[1]) / 255,
            Number(match[2]) / 255,
            Number(match[3]) / 255
        ),
        alpha: match[4] === undefined ? 1 : Number(match[4])
    }
}

function* walkElements(win: Window, root: HTMLElement): Generator<HTMLElement> {
    const walker = win.document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT
    )
    let node = walker.nextNode()
    while (node) {
        yield node as HTMLElement
        node = walker.nextNode()
    }
}

