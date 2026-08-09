/**
 * DOM-to-PDF emitter.
 *
 * Walks the paginated output produced by vivliostyle inside its (hidden)
 * iframe and re-renders it as a real vector PDF using pdf-lib. No browser
 * print dialog is involved.
 *
 * Scope of this prototype: text (word-precise positions), embedded Libertinus
 * Serif with subsetting, PNG/JPEG images, SVG images (rasterized), solid
 * background-color rects and simple solid borders. Links/annotations are not
 * emitted (pdf-lib has no annotation support) — see the TODO below.
 *
 * Coordinate systems:
 *  - Browser DOM: origin top-left, units CSS px.
 *  - PDF: origin bottom-left, units points (1 px = 0.75 pt).
 *  All measured rects are made relative to their page container first, then
 *  Y is flipped when drawing.
 */
import fontkit from "@pdf-lib/fontkit"
import {PDFDocument, PDFFont, rgb} from "pdf-lib"
import type {RGB} from "pdf-lib"

const PX_TO_PT = 0.75

/** The four Libertinus Serif variants shipped in public/fonts/ (OFL licensed). */
const FONT_FILES = {
    regular: "fonts/LibertinusSerif-Regular.ttf",
    bold: "fonts/LibertinusSerif-Bold.ttf",
    italic: "fonts/LibertinusSerif-Italic.ttf",
    boldItalic: "fonts/LibertinusSerif-BoldItalic.ttf"
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
    fontSizePx: number
    variant: FontVariant
    color: RGB
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
    pdfDoc.registerFontkit(fontkit)

    onProgress?.("Loading fonts…")
    const fonts = await loadFonts(pdfDoc)

    for (const [index, container] of pageContainers.entries()) {
        onProgress?.(`Emitting page ${index + 1} of ${pageContainers.length}…`)
        await emitPage(win, pdfDoc, container, fonts)
    }

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
): Promise<void> {
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
        page.drawText(word.text, {
            x: word.x * PX_TO_PT,
            y: pageHeightPt - baselinePx * PX_TO_PT,
            size: sizePt,
            font: font.pdfFont,
            color: word.color
        })
    }
}

type ToPdfFn = (x: number, y: number, height: number) => {x: number; y: number}

/** Draw background-color rects for elements with a non-transparent background. */
function paintBackgrounds(
    win: Window,
    container: HTMLElement,
    containerRect: DOMRect,
    page: import("pdf-lib").PDFPage,
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
    page: import("pdf-lib").PDFPage,
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
    page: import("pdf-lib").PDFPage,
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
        const variant = pickVariant(style.fontWeight, style.fontStyle)
        const transform = style.textTransform
        const text = textNode.data

        const applyTransform = (s: string): string => {
            // (capitalize / small-caps not handled — prototype limitation.)
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
                fontSizePx,
                variant,
                color
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
        const variant = pickVariant(style.fontWeight, style.fontStyle)
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
            fontSizePx,
            variant,
            color: parseCssColor(style.color)?.rgb ?? rgb(0, 0, 0)
        })
    }
    return runs
}

function pickVariant(fontWeight: string, fontStyle: string): FontVariant {
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

// TODO(links): pdf-lib cannot create link annotations. When a solution is
// available (or we switch PDF writers), walk <a href> elements here, take
// their client rects, and emit URI link annotations with the same Y-flip.
