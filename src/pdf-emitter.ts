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
import {
    PDFDocument,
    PDFDict,
    PDFName,
    PDFFont,
    PDFRef,
    PDFString,
    LineCapStyle,
    PDFImage,
    rgb
} from "@pdfme/pdf-lib"
import type {PDFPage, RGB} from "@pdfme/pdf-lib"
import {
    concatTransformationMatrix,
    popGraphicsState,
    pushGraphicsState
} from "./pdf-lib-ops.js"
import {
    collectFontFaceRules,
    parseFontFamilyList,
    selectFontFace,
    type FontFaceDescriptor
} from "./font-face.js"
import {
    normalizeFontBytes,
    setWoff2WasmUrl,
    sfntTableSignature
} from "./font-formats.js"
import {splitBidiRuns} from "./bidi.js"
import {drawSvg} from "svg4pdf-lib"

const PX_TO_PT = 0.75

/**
 * Resolve the base URL for the library's own static assets (bundled fallback
 * fonts, woff2.wasm). Uses Vite's `BASE_URL` when a Vite build injects it
 * (the demo), otherwise falls back to the consuming page's base URL. Callers
 * can pin an explicit base via `EmitOptions.baseUrl`.
 */
function getBaseUrl(optionsBase?: string): string {
    try {
        if (optionsBase) {
            return new URL(optionsBase, window.location.href).href
        }
        // Vite statically replaces `import.meta.env.BASE_URL` at build time;
        // in a plain ESM bundle (tsc/rspack) `import.meta.env` is undefined.
        const viteBase = import.meta.env?.BASE_URL
        if (viteBase) {
            return new URL(viteBase, window.location.href).href
        }
    } catch {
        // import.meta.env is a Vite construct; absent in plain ESM builds.
    }
    return new URL(".", document.baseURI || window.location.href).href
}

type FontCut = "regular" | "bold" | "italic" | "boldItalic"

/** Bundled fallback fonts (used when no @font-face rule matches a run). */
const FALLBACK_FONT_FILES: Record<string, Partial<Record<FontCut, string>>> = {
    serif: {
        regular: "fonts/LibertinusSerif-Regular.ttf",
        bold: "fonts/LibertinusSerif-Bold.ttf",
        italic: "fonts/LibertinusSerif-Italic.ttf",
        boldItalic: "fonts/LibertinusSerif-BoldItalic.ttf"
    },
    monospace: {
        regular: "fonts/LibertinusMono-Regular.ttf"
    }
}

/** Cut fallback order per generic fallback family. */
const FALLBACK_ORDER: Record<string, FontCut[]> = {
    serif: ["regular", "italic", "bold", "boldItalic"],
    monospace: ["regular"]
}

interface FontMetrics {
    /** ascent and descent in px for a given font size (from fontkit, em-scaled) */
    ascent(sizePx: number): number
    descent(sizePx: number): number
}

/** A font embedded into the PDF (from @font-face discovery or the fallback set). */
interface LoadedFont {
    pdfFont: PDFFont
    metrics: FontMetrics
    key: FontKey
}

/** Stable key identifying an embedded font file. */
type FontKey = string

/**
 * Everything the emitter needs to resolve a text run's font: the discovered
 * `@font-face` rules, the embedded font per rule, and the bundled fallbacks.
 */
interface FontSelectionContext {
    rules: FontFaceDescriptor[]
    /** embedded-font key per rule; only rules that loaded successfully are present. */
    keyByRule: Map<FontFaceDescriptor, FontKey>
    /** every embedded font (discovered + fallback), keyed by FontKey. */
    byKey: Map<FontKey, LoadedFont>
    /** bundled last-resort fonts per generic family (serif / monospace). */
    fallback: Map<string, Partial<Record<FontCut, FontKey>>>
}

export type DecorationStyle = "solid" | "double" | "dotted" | "dashed" | "wavy"

interface DecorationLine {
    style: DecorationStyle
    /** Color from `text-decoration-color`, or null to inherit the text color. */
    color: RGB | null
}

interface TextDecoration {
    underline: DecorationLine | null
    overline: DecorationLine | null
    lineThrough: DecorationLine | null
}

interface WordRun {
    text: string
    /** rect relative to the page container, in px */
    x: number
    yTop: number
    yBottom: number
    width: number
    fontSizePx: number
    fontKey: FontKey
    color: RGB
    decoration: TextDecoration
    /** synthesize small caps: lowercase drawn as uppercase at reduced size */
    smallCaps: boolean
}

/** Document metadata to embed (sourced from the original HTML head — the
    paginated iframe DOM does not retain the source <head>). */
export interface EmitMetadata {
    title?: string
    author?: string
    subject?: string
    /** comma-separated */
    keywords?: string
    language?: string
    /** PDF /Creator string. Defaults to the library's own string. */
    creator?: string
    /** PDF /Producer string. Defaults to the library's own string. */
    producer?: string
}

export interface PrintOptions {
    /** Draw registration/crop marks around each page. */
    cropMarks?: boolean
    /** Include a PDF TrimBox matching the final page size. */
    trimBox?: boolean
    /** Include a PDF BleedBox enlarged by bleedMm on every side. */
    bleedBox?: boolean
    /** Bleed margin in millimetres (default 3). */
    bleedMm?: number
    /** Draw a visible border around each Link annotation. */
    linkAnnotationBorders?: boolean
    /** Rasterize SVG images at 2x instead of emitting them as vector PDF. */
    rasterizeSvgs?: boolean
}

/** A file to embed as a PDF attachment (e.g. a Fidus .fidus source file). */
export interface EmitAttachment {
    filename: string
    bytes: Uint8Array | ArrayBuffer
    mimeType: string
    description?: string
}

/** Optional extras for emitPdfFromVivliostyleWindow. */
export interface EmitOptions {
    /**
     * The document's HTML source. Used for `@font-face` discovery when the
     * paginated iframe did not retain them. Only embedded as a PDF attachment
     * when `embedSourceHtml` is set.
     */
    sourceHtml?: string
    /**
     * Whether to embed `sourceHtml` as a file attachment in the PDF. Off by
     * default: most consumers do not want the HTML copy inside the PDF (it is
     * a demo feature).
     */
    embedSourceHtml?: boolean
    /** Document metadata from the original HTML head. */
    metadata?: EmitMetadata
    /** Print-production options (crop marks, trim/bleed boxes). */
    printOptions?: PrintOptions
    /**
     * Base URL for the library's bundled static assets (fallback fonts,
     * woff2.wasm). Defaults to Vite's BASE_URL (demo) or the page base URL.
     */
    baseUrl?: string
    /**
     * Where the WOFF2 decoder's wasm lives: a URL string or an `ArrayBuffer`
     * of the wasm bytes. Defaults to `<baseUrl>woff2/woff2.wasm`.
     */
    woff2WasmUrl?: string | ArrayBuffer
    /** Additional files to attach to the PDF (besides `sourceHtml`). */
    attachments?: EmitAttachment[]
}

/**
 * Emit a PDF from the window of a vivliostyle-print iframe after pagination
 * has completed.
 *
 * @param win  the iframe window passed to printCallback
 * @param onProgress  optional status callback for UI feedback
 * @param options  optional extras (HTML source attachment)
 * @returns the PDF file bytes
 */
export async function emitPdfFromVivliostyleWindow(
    win: Window,
    onProgress?: (message: string) => void,
    options?: EmitOptions
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
    const base = getBaseUrl(options?.baseUrl)
    // Point the WOFF2 decoder at the wasm the caller (or the default base)
    // provides. Done before font loading so WOFF2 fonts can be embedded.
    setWoff2WasmUrl(
        options?.woff2WasmUrl ?? new URL("woff2/woff2.wasm", base).href
    )
    const fonts = await loadFontSelectionContext(pdfDoc, win, options, base)

    // Link collection runs alongside page emission. Internal (#id) links
    // need their target's page, which may come later — so anchor targets
    // are recorded per page and the annotations are attached afterwards.
    const links: CollectedLink[] = []
    const anchorTargets = new Map<string, AnchorTarget>()
    const headings: CollectedHeading[] = []

    const printOptions: Required<PrintOptions> = {
        cropMarks: options?.printOptions?.cropMarks ?? false,
        trimBox: options?.printOptions?.trimBox ?? false,
        bleedBox: options?.printOptions?.bleedBox ?? false,
        bleedMm: Math.max(0, options?.printOptions?.bleedMm ?? 3),
        linkAnnotationBorders:
            options?.printOptions?.linkAnnotationBorders ?? false,
        rasterizeSvgs: options?.printOptions?.rasterizeSvgs ?? false
    }

    const pageOffsets: {x: number; y: number}[] = []
    for (const [index, container] of pageContainers.entries()) {
        onProgress?.(`Emitting page ${index + 1} of ${pageContainers.length}…`)
        const {pageHeightPt, originX, originY} = await emitPage(
            win,
            pdfDoc,
            container,
            fonts,
            printOptions
        )
        pageOffsets.push({x: originX, y: originY})
        collectAnchorTargets(
            win,
            container,
            pageHeightPt,
            index,
            anchorTargets,
            pageOffsets[index]
        )
        collectLinks(
            win,
            container,
            pageHeightPt,
            index,
            links,
            pageOffsets[index]
        )
        collectHeadings(
            container,
            pageHeightPt,
            index,
            headings,
            pageOffsets[index]
        )
    }
    addLinkAnnotations(pdfDoc, links, anchorTargets, printOptions.linkAnnotationBorders)

    // Beyond-the-print-dialog extras: metadata, bookmarks, attachments.
    onProgress?.("Adding metadata, outline and attachment…")
    addMetadata(pdfDoc, options?.metadata ?? {})
    buildOutline(pdfDoc, headings)
    const now = new Date()
    if (options?.sourceHtml && options?.embedSourceHtml) {
        await pdfDoc.attach(
            new TextEncoder().encode(options.sourceHtml),
            "demo-document.html",
            {
                mimeType: "text/html",
                description:
                    "HTML source of this document (before vivliostyle pagination)",
                creationDate: now,
                modificationDate: now
            }
        )
    }
    for (const attachment of options?.attachments ?? []) {
        await pdfDoc.attach(
            attachment.bytes instanceof ArrayBuffer
                ? new Uint8Array(attachment.bytes)
                : attachment.bytes,
            attachment.filename,
            {
                mimeType: attachment.mimeType,
                description: attachment.description,
                creationDate: now,
                modificationDate: now
            }
        )
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

/**
 * Discover `@font-face` rules (from the paginated document, or — when the
 * iframe did not retain them — from the source HTML), fetch each unique font
 * file, normalize it to embeddable sfnt bytes (WOFF unwrapped; WOFF2 decoded
 * via fonteditor-core) and embed it subsetted. The bundled fallback fonts are
 * embedded too, deduplicated against the discovered ones by content hash.
 * Missing fallback fonts are skipped with a warning rather than aborting, so
 * an app that does not serve them still exports fine when the document's own
 * `@font-face` fonts cover the text.
 */
async function loadFontSelectionContext(
    pdfDoc: PDFDocument,
    win: Window,
    options: EmitOptions | undefined,
    base: string
): Promise<FontSelectionContext> {
    const sourceHtml = options?.sourceHtml
    const rules = collectFontFaceRules(win.document, win.document.baseURI)
    const allRules =
        rules.length > 0
            ? rules
            : collectFontFaceRules(parseSourceDocument(sourceHtml, base), base)

    const byKey = new Map<FontKey, LoadedFont>()
    const semanticToKey = new Map<string, FontKey>()
    const keyByRule = new Map<FontFaceDescriptor, FontKey>()

    const embedBytes = async (
        bytes: Uint8Array
    ): Promise<{key: FontKey} | {reason: string}> => {
        const normalized = await normalizeFontBytes(bytes)
        if (!normalized.ok) {
            return {reason: normalized.reason}
        }
        const fkFont = fontkit.create(normalized.bytes)
        // Dedup by *content* (postscript name + table directory), not byte
        // layout: a WOFF unwrapped to sfnt differs physically from the same
        // font as a TTF but must still map to one embedded program.
        const signature = sfntTableSignature(normalized.bytes)
        const postscriptName = (
            fkFont as unknown as {postscriptName?: string}
        ).postscriptName
        const semanticKey = `${postscriptName ?? ""}|${signature}`
        const hash = fnv1a(semanticKey)
        const existing = semanticToKey.get(semanticKey)
        if (existing) {
            return {key: existing}
        }
        const key = `font:${hash}`
        const pdfFont = await pdfDoc.embedFont(normalized.bytes, {
            subset: true
        })
        const unitsPerEm = fkFont.unitsPerEm
        byKey.set(key, {
            key,
            pdfFont,
            metrics: {
                ascent: sizePx => (fkFont.ascent / unitsPerEm) * sizePx,
                descent: sizePx =>
                    (Math.abs(fkFont.descent) / unitsPerEm) * sizePx
            }
        })
        semanticToKey.set(semanticKey, key)
        return {key}
    }

    const loadSrc = async (srcUrl: string): Promise<FontKey | null> => {
        let bytes: Uint8Array | null = null
        if (srcUrl.startsWith("data:")) {
            bytes = decodeDataUri(srcUrl)
        } else {
            try {
                const response = await fetch(srcUrl)
                if (response.ok) {
                    bytes = new Uint8Array(await response.arrayBuffer())
                }
            } catch {
                // Unfetchable font (CORS etc.); try the next src.
            }
        }
        if (!bytes) {
            return null
        }
        const result = await embedBytes(bytes)
        if ("reason" in result) {
            console.warn(`vivliostyle-pdf: skipping font src ${srcUrl} (${result.reason})`)
            return null
        }
        return result.key
    }

    for (const rule of allRules) {
        if (keyByRule.has(rule)) {
            continue
        }
        for (const src of rule.srcs) {
            const key = await loadSrc(src.url)
            if (key) {
                keyByRule.set(rule, key)
                break
            }
        }
    }

    // Bundled fallbacks — deduplicated against discovered fonts by content.
    // Each cut is optional: a missing/unfetchable fallback font is skipped
    // with a warning instead of aborting the export (the document's own
    // @font-face fonts normally cover the text anyway).
    const fallback = new Map<string, Partial<Record<FontCut, FontKey>>>()
    for (const [generic, cuts] of Object.entries(FALLBACK_FONT_FILES)) {
        const keyedCuts: Partial<Record<FontCut, FontKey>> = {}
        for (const [cut, path] of Object.entries(cuts)) {
            try {
                const response = await fetch(new URL(path, base))
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`)
                }
                const bytes = new Uint8Array(await response.arrayBuffer())
                const result = await embedBytes(bytes)
                if ("reason" in result) {
                    throw new Error(result.reason)
                }
                keyedCuts[cut as FontCut] = result.key
            } catch (error) {
                console.warn(
                    `vivliostyle-pdf: fallback font ${path} unavailable (${error instanceof Error ? error.message : String(error)}); that cut will not be used`
                )
            }
        }
        fallback.set(generic, keyedCuts)
    }

    if (allRules.length === 0) {
        console.warn(
            "vivliostyle-pdf: no @font-face rules found; using bundled fallback fonts only"
        )
    }
    if (keyByRule.size === 0 && allRules.length > 0) {
        console.warn(
            "vivliostyle-pdf: none of the document's @font-face fonts could be embedded; falling back to bundled fonts"
        )
    }

    return {rules: allRules, keyByRule, byKey, fallback}
}

/** Parse the (pre-pagination) source HTML so its <style> @font-face rules
    can be enumerated when the iframe document dropped them. Any demo-only
    `__BASE__` placeholder is expanded against the resolved base URL. */
function parseSourceDocument(
    sourceHtml: string | undefined,
    baseUrl: string
): Document {
    const expanded = (sourceHtml ?? "").replaceAll("__BASE__", baseUrl)
    return new DOMParser().parseFromString(expanded, "text/html")
}

function decodeDataUri(uri: string): Uint8Array | null {
    const match = uri.match(/^data:([^,]*)?,(.*)$/s)
    if (!match) {
        return null
    }
    const meta = match[1] ?? ""
    const payload = match[2]
    if (meta.includes(";base64")) {
        try {
            const binary = atob(payload)
            const out = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
                out[i] = binary.charCodeAt(i)
            }
            return out
        } catch {
            return null
        }
    }
    try {
        const decoded = decodeURIComponent(payload)
        return new Uint8Array([...decoded].map(c => c.charCodeAt(0)))
    } catch {
        return new Uint8Array([...payload].map(c => c.charCodeAt(0)))
    }
}

/** FNV-1a over a string — used only to name deduped font keys. */
function fnv1a(input: string): string {
    let hash = 2166136261
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(36)
}

/**
 * Resolve which embedded font to draw a text run in, using CSS font matching
 * over the discovered `@font-face` rules and falling back to the bundled
 * fonts when nothing matches (or the matching font failed to embed).
 */
function resolveRunFontKey(
    ctx: FontSelectionContext,
    fontFamily: string,
    fontWeight: string,
    fontStyle: string
): FontKey {
    const familyList = parseFontFamilyList(fontFamily)
    const weight = Number.parseFloat(fontWeight)
    const face = selectFontFace(
        ctx.rules,
        familyList,
        Number.isNaN(weight) ? 400 : weight,
        fontStyle
    )
    if (face) {
        const key = ctx.keyByRule.get(face)
        if (key) {
            return key
        }
    }
    const isMono = familyList.some(family => /mono/i.test(family))
    const generic = isMono ? "monospace" : "serif"
    const italic = fontStyle === "italic" || fontStyle === "oblique"
    const bold = Number.isNaN(weight)
        ? fontWeight === "bold"
        : weight >= 600
    const requestedCut: FontCut =
        bold && italic
            ? "boldItalic"
            : bold
              ? "bold"
              : italic
                ? "italic"
                : "regular"
    const cutOrder = [
        requestedCut,
        ...FALLBACK_ORDER[generic].filter(cut => cut !== requestedCut)
    ]
    const cuts = ctx.fallback.get(generic)
    if (!cuts) {
        throw new Error(`No fallback font family: ${generic}`)
    }
    for (const candidate of cutOrder) {
        const key = cuts[candidate]
        if (key) {
            return key
        }
    }
    throw new Error("No fallback font available")
}

const MM_TO_PT = 2.83464567

async function emitPage(
    win: Window,
    pdfDoc: PDFDocument,
    container: HTMLElement,
    fonts: FontSelectionContext,
    printOptions: Required<PrintOptions>
): Promise<{pageHeightPt: number; originX: number; originY: number}> {
    const containerRect = container.getBoundingClientRect()
    const pageWidthPt = containerRect.width * PX_TO_PT
    const pageHeightPt = containerRect.height * PX_TO_PT
    if (containerRect.width === 0 || containerRect.height === 0) {
        throw new Error(
            "Page container has zero size — cannot measure paginated layout"
        )
    }

    const bleedPt = printOptions.bleedBox
        ? printOptions.bleedMm * MM_TO_PT
        : 0
    const markOffsetPt = printOptions.cropMarks ? Math.max(bleedPt, 9) : 0
    const totalWidthPt = pageWidthPt + markOffsetPt * 2
    const totalHeightPt = pageHeightPt + markOffsetPt * 2

    const page = pdfDoc.addPage([totalWidthPt, totalHeightPt])

    // Translate page content so the original (0,0) sits at the offset point.
    const originX = markOffsetPt
    const originY = markOffsetPt
    page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(1, 0, 0, 1, originX, originY)
    )

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
    await paintImages(win, pdfDoc, container, containerRect, page, toPdf, fonts, printOptions)

    const words = collectWords(win, container, containerRect, fonts)
    // ::marker pseudo-boxes have no text nodes; synthesize them separately
    // (text markers become word runs, image markers are drawn afterwards).
    const markers = collectListMarkers(win, container, containerRect, fonts)
    words.push(...markers.words)
    for (const word of words) {
        const font = fonts.byKey.get(word.fontKey)
        if (!font) {
            continue
        }
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
        if (
            word.decoration.lineThrough ||
            word.decoration.overline ||
            word.decoration.underline
        ) {
            drawWordDecorations(page, word, xPt, baselineY, sizePt)
        }
    }

    // Draw list-style-image markers (natural size, once loaded).
    await drawMarkerImages(pdfDoc, markers.images, page, toPdf)

    // Restore the original (untranslated) graphics state before drawing marks
    // or setting page boxes, so those refer to the full media box.
    page.pushOperators(popGraphicsState())

    if (printOptions.trimBox || printOptions.bleedBox) {
        setPageBoxes(page, {
            trim: printOptions.trimBox
                ? {x: originX, y: originY, width: pageWidthPt, height: pageHeightPt}
                : undefined,
            bleed: printOptions.bleedBox
                ? {
                      x: originX - bleedPt,
                      y: originY - bleedPt,
                      width: pageWidthPt + bleedPt * 2,
                      height: pageHeightPt + bleedPt * 2
                  }
                : undefined
        })
    }

    if (printOptions.cropMarks) {
        drawCropMarks(page, {
            left: originX,
            bottom: originY,
            width: pageWidthPt,
            height: pageHeightPt,
            markLength: Math.max(8, markOffsetPt - bleedPt),
            outer: markOffsetPt
        })
    }

    return {pageHeightPt, originX, originY}
}

interface Box {
    x: number
    y: number
    width: number
    height: number
}

function setPageBoxes(
    page: PDFPage,
    boxes: {trim?: Box; bleed?: Box}
): void {
    const context = page.node.context
    const arrayFor = (box: Box) =>
        context.obj([
            box.x,
            box.y,
            box.x + box.width,
            box.y + box.height
        ])
    if (boxes.trim) {
        page.node.set(PDFName.of("TrimBox"), arrayFor(boxes.trim))
    }
    if (boxes.bleed) {
        page.node.set(PDFName.of("BleedBox"), arrayFor(boxes.bleed))
    }
}

interface CropMarkSpec {
    left: number
    bottom: number
    width: number
    height: number
    markLength: number
    /** distance from the trim edge to the outer end of the mark (media edge) */
    outer: number
}

function drawCropMarks(page: PDFPage, spec: CropMarkSpec): void {
    const {left, bottom, width, height, markLength, outer} = spec
    const right = left + width
    const top = bottom + height
    const color = rgb(0, 0, 0)
    const thickness = 0.5
    const marks: Array<{
        start: {x: number; y: number}
        end: {x: number; y: number}
    }> = []

    // Corner crop marks sit in the margin between trim box and media box,
    // so they are visible on the full page but will be trimmed off.
    const inner = outer - markLength
    // Bottom-left corner.
    marks.push(
        {start: {x: left - outer, y: bottom}, end: {x: left - inner, y: bottom}},
        {start: {x: left, y: bottom - outer}, end: {x: left, y: bottom - inner}}
    )
    // Bottom-right corner.
    marks.push(
        {start: {x: right + inner, y: bottom}, end: {x: right + outer, y: bottom}},
        {start: {x: right, y: bottom - outer}, end: {x: right, y: bottom - inner}}
    )
    // Top-left corner.
    marks.push(
        {start: {x: left - outer, y: top}, end: {x: left - inner, y: top}},
        {start: {x: left, y: top + inner}, end: {x: left, y: top + outer}}
    )
    // Top-right corner.
    marks.push(
        {start: {x: right + inner, y: top}, end: {x: right + outer, y: top}},
        {start: {x: right, y: top + inner}, end: {x: right, y: top + outer}}
    )

    for (const {start, end} of marks) {
        page.drawLine({start, end, thickness, color})
    }
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
    targets: Map<string, AnchorTarget>,
    pageOffset: {x: number; y: number}
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
            yTopPt: pageHeightPt - yTopPx * PX_TO_PT + pageOffset.y
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
    links: CollectedLink[],
    pageOffset: {x: number; y: number}
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
                x: (r.left - containerRect.left) * PX_TO_PT + pageOffset.x,
                y:
                    pageHeightPt -
                    (r.top - containerRect.top + r.height) * PX_TO_PT +
                    pageOffset.y,
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
    targets: Map<string, AnchorTarget>,
    showBorders: boolean
): void {
    const pages = pdfDoc.getPages()
    const LINK_COLOR = rgb(0.141, 0.337, 0.651) // #2456a6
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
            const borderDict = showBorders
                ? {
                      Border: [0, 0, 0.5],
                      C: [LINK_COLOR.red, LINK_COLOR.green, LINK_COLOR.blue],
                      H: "I"
                  }
                : {Border: [0, 0, 0]}
            let annot
            if (isExternal) {
                annot = pdfDoc.context.obj({
                    Type: "Annot",
                    Subtype: "Link",
                    Rect: rectArray,
                    ...borderDict,
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
                    ...borderDict,
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

/* ---- Metadata, outline, viewer preferences --------------------------
 * None of these are obtainable via the browser print dialog.
 * ------------------------------------------------------------------ */

/** Set document metadata (sourced from the original HTML head). */
function addMetadata(pdfDoc: PDFDocument, meta: EmitMetadata): void {
    // showInWindowTitleBar sets ViewerPreferences/DisplayDocTitle: true.
    pdfDoc.setTitle(meta.title ?? "Untitled", {showInWindowTitleBar: true})
    if (meta.author) {
        pdfDoc.setAuthor(meta.author)
    }
    if (meta.subject) {
        pdfDoc.setSubject(meta.subject)
    }
    if (meta.keywords) {
        pdfDoc.setKeywords(
            meta.keywords
                .split(",")
                .map(k => k.trim())
                .filter(Boolean)
        )
    }
    pdfDoc.setCreator(
        meta.creator ?? "vivliostyle-pdf (vivliostyle + DOM-to-PDF emitter)"
    )
    pdfDoc.setProducer(meta.producer ?? "@pdfme/pdf-lib + fontkit")
    pdfDoc.setLanguage(meta.language ?? "en-US")
    const now = new Date()
    pdfDoc.setCreationDate(now)
    pdfDoc.setModificationDate(now)
}

interface CollectedHeading {
    text: string
    level: number
    pageIndex: number
    /** top edge of the heading, in PDF pt from the page bottom */
    yTopPt: number
}

/** Record h1–h6 headings (with their generated section numbers) per page. */
function collectHeadings(
    container: HTMLElement,
    pageHeightPt: number,
    pageIndex: number,
    headings: CollectedHeading[],
    pageOffset: {x: number; y: number}
): void {
    const containerRect = container.getBoundingClientRect()
    for (const el of Array.from(
        container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
    )) {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
            continue
        }
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim()
        if (!text) {
            continue
        }
        headings.push({
            text,
            level: Number(el.tagName[1]),
            pageIndex,
            yTopPt:
                pageHeightPt -
                (rect.top - containerRect.top) * PX_TO_PT +
                pageOffset.y
        })
    }
}

/**
 * Build the PDF outline (bookmarks sidebar) from the collected headings:
 * a root /Outlines dict with nested outline item dicts linked via
 * First/Last/Prev/Next/Parent, and /PageMode /UseOutlines on the catalog
 * so viewers open with the bookmarks panel visible.
 */
function buildOutline(pdfDoc: PDFDocument, headings: CollectedHeading[]): void {
    if (headings.length === 0) {
        return
    }
    const context = pdfDoc.context
    const pages = pdfDoc.getPages()

    interface OutlineNode {
        heading: CollectedHeading
        children: OutlineNode[]
    }

    // Nest by heading level: an h2 nests under the preceding h1, etc.
    const topNodes: OutlineNode[] = []
    const stack: OutlineNode[] = []
    for (const heading of headings) {
        const node: OutlineNode = {heading, children: []}
        while (
            stack.length > 0 &&
            stack[stack.length - 1].heading.level >= heading.level
        ) {
            stack.pop()
        }
        if (stack.length === 0) {
            topNodes.push(node)
        } else {
            stack[stack.length - 1].children.push(node)
        }
        stack.push(node)
    }

    const outlinesRef = context.register(context.obj({}))

    const createItems = (
        nodes: OutlineNode[],
        parentRef: PDFRef
    ): {first: PDFRef; last: PDFRef; count: number} => {
        // Refs must exist before they can reference each other.
        const refs = nodes.map(() => context.register(context.obj({})))
        let count = 0
        nodes.forEach((node, i) => {
            const dict = context.lookup(refs[i]) as PDFDict
            dict.set(PDFName.of("Title"), PDFString.of(node.heading.text))
            dict.set(PDFName.of("Parent"), parentRef)
            dict.set(
                PDFName.of("Dest"),
                context.obj([
                    pages[node.heading.pageIndex].ref,
                    "XYZ",
                    null,
                    node.heading.yTopPt,
                    null
                ])
            )
            if (i > 0) {
                dict.set(PDFName.of("Prev"), refs[i - 1])
            }
            if (i < nodes.length - 1) {
                dict.set(PDFName.of("Next"), refs[i + 1])
            }
            count += 1
            if (node.children.length > 0) {
                const children = createItems(node.children, refs[i])
                dict.set(PDFName.of("First"), children.first)
                dict.set(PDFName.of("Last"), children.last)
                // Positive Count: subtree is shown expanded.
                dict.set(PDFName.of("Count"), context.obj(children.count))
                count += children.count
            }
        })
        return {first: refs[0], last: refs[refs.length - 1], count}
    }

    const top = createItems(topNodes, outlinesRef)
    const rootDict = context.lookup(outlinesRef) as PDFDict
    rootDict.set(PDFName.of("Type"), PDFName.of("Outlines"))
    rootDict.set(PDFName.of("First"), top.first)
    rootDict.set(PDFName.of("Last"), top.last)
    rootDict.set(PDFName.of("Count"), context.obj(top.count))

    pdfDoc.catalog.set(PDFName.of("Outlines"), outlinesRef)
    pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"))
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
        const style = win.getComputedStyle(el)
        const bg = style.backgroundColor
        const color = parseCssColor(bg)
        if (!color || color.alpha === 0) {
            continue
        }
        const radiusPx = Math.min(
            parseLengthPx(style.borderTopLeftRadius),
            parseLengthPx(style.borderTopRightRadius)
        )
        const radiusPt = radiusPx * PX_TO_PT
        for (const rect of Array.from(el.getClientRects())) {
            const x = rect.left - containerRect.left
            const y = rect.top - containerRect.top
            const pos = toPdf(x, y, rect.height)
            page.drawRectangle({
                x: pos.x,
                y: pos.y,
                width: rect.width * PX_TO_PT,
                height: rect.height * PX_TO_PT,
                color: color.rgb,
                radius: radiusPt
            })
        }
    }
}

/** Parse a length like "3px"/"1pt" into a px number (0 when none). */
function parseLengthPx(value: string): number {
    const match = value.match(/([\d.]+)(px|pt|em|mm|cm)?/)
    if (!match) {
        return 0
    }
    const number = Number(match[1])
    const unit = match[2]
    if (unit === "px") return number
    if (unit === "pt") return number / PX_TO_PT
    return number
}

const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "double"])

type BorderEdge = "top" | "right" | "bottom" | "left"

/** Draw borders with support for solid/dashed/dotted/double styles. */
function paintBorders(
    win: Window,
    container: HTMLElement,
    containerRect: DOMRect,
    page: PDFPage,
    toPdf: ToPdfFn
): void {
    for (const el of walkElements(win, container)) {
        const style = win.getComputedStyle(el)
        const sides: Array<{
            width: number
            style: string
            color: string
            edge: BorderEdge
        }> = [
            {width: parseFloat(style.borderTopWidth), style: style.borderTopStyle, color: style.borderTopColor, edge: "top"},
            {width: parseFloat(style.borderRightWidth), style: style.borderRightStyle, color: style.borderRightColor, edge: "right"},
            {width: parseFloat(style.borderBottomWidth), style: style.borderBottomStyle, color: style.borderBottomColor, edge: "bottom"},
            {width: parseFloat(style.borderLeftWidth), style: style.borderLeftStyle, color: style.borderLeftColor, edge: "left"}
        ]
        const drawable = sides.filter(
            s => s.width > 0 && BORDER_STYLES.has(s.style)
        )
        if (drawable.length === 0) {
            continue
        }
        const rect = el.getBoundingClientRect()
        const x = rect.left - containerRect.left
        const y = rect.top - containerRect.top
        const w = rect.width
        const h = rect.height

        // Convert a pixel point (relative to the container, origin top-left)
        // to PDF coordinates.
        const toPt = (sx: number, sy: number) => {
            const p = toPdf(sx, sy, 0)
            return {x: p.x, y: p.y}
        }

        for (const side of drawable) {
            const color = parseCssColor(side.color)
            if (!color || color.alpha === 0) {
                continue
            }
            const thicknessPt = Math.max(0.4, side.width * PX_TO_PT)
            const rgbColor = color.rgb
            const strokeOpts = {
                thickness: thicknessPt,
                color: rgbColor,
                dashArray:
                    side.style === "dotted"
                        ? [thicknessPt * 0.4, thicknessPt * 2]
                        : side.style === "dashed"
                          ? [thicknessPt * 3, thicknessPt * 2]
                          : undefined,
                lineCap:
                    side.style === "dotted" ? LineCapStyle.Round : undefined
            } as const

            const drawLineOnly = (a: {x: number; y: number}, b: {x: number; y: number}): void => {
                page.drawLine({start: a, end: b, ...strokeOpts})
            }

            const drawDouble = (a: {x: number; y: number}, b: {x: number; y: number}): void => {
                // Two parallel lines separated by the border thickness.
                const dx = b.x - a.x
                const dy = b.y - a.y
                const len = Math.hypot(dx, dy) || 1
                const nx = (-dy / len) * thicknessPt
                const ny = (dx / len) * thicknessPt
                page.drawLine({start: {x: a.x + nx, y: a.y + ny}, end: {x: b.x + nx, y: b.y + ny}, thickness: thicknessPt, color: rgbColor})
                page.drawLine({start: {x: a.x - nx, y: a.y - ny}, end: {x: b.x - nx, y: b.y - ny}, thickness: thicknessPt, color: rgbColor})
            }

            if (side.edge === "top" || side.edge === "bottom") {
                const centerY =
                    side.edge === "top" ? y + side.width / 2 : y + h - side.width / 2
                const a = toPt(x, centerY)
                const b = toPt(x + w, centerY)
                if (side.style === "double") drawDouble(a, b)
                else drawLineOnly(a, b)
            } else {
                const centerX =
                    side.edge === "left" ? x + side.width / 2 : x + w - side.width / 2
                const a = toPt(centerX, y)
                const b = toPt(centerX, y + h)
                if (side.style === "double") drawDouble(a, b)
                else drawLineOnly(a, b)
            }
        }
    }
}

/** Embed and draw <img> elements. PNG/JPEG embed directly; SVG is drawn as vector by default. */
async function paintImages(
    win: Window,
    pdfDoc: PDFDocument,
    container: HTMLElement,
    containerRect: DOMRect,
    page: PDFPage,
    toPdf: ToPdfFn,
    fonts: FontSelectionContext,
    printOptions: Required<PrintOptions>
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

        const imageUrl = img.currentSrc || img.src
        const res = await fetch(imageUrl)
        if (!res.ok) {
            console.warn(`Skipping image ${imageUrl}: HTTP ${res.status}`)
            continue
        }
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (isPng(bytes)) {
            const embedded = await pdfDoc.embedPng(bytes)
            page.drawImage(embedded, {
                x: pos.x,
                y: pos.y,
                width: widthPt,
                height: heightPt
            })
        } else if (isJpeg(bytes)) {
            const embedded = await pdfDoc.embedJpg(bytes)
            page.drawImage(embedded, {
                x: pos.x,
                y: pos.y,
                width: widthPt,
                height: heightPt
            })
        } else if (isSvg(img.currentSrc || img.src, bytes, res.headers.get("content-type"))) {
            if (printOptions.rasterizeSvgs) {
                // User opted to rasterize SVGs: render through the browser canvas
                // at 2x so unsupported vector features fall back to pixels.
                const png = await rasterizeToPng(
                    win,
                    img.currentSrc || img.src,
                    img.naturalWidth || rect.width,
                    img.naturalHeight || rect.height
                )
                if (!png) {
                    console.warn(`Skipping unrasterizable SVG image ${img.src}`)
                    continue
                }
                const embedded = await pdfDoc.embedPng(png)
                page.drawImage(embedded, {
                    x: pos.x,
                    y: pos.y,
                    width: widthPt,
                    height: heightPt
                })
            } else {
                // Draw SVG as vector via svg4pdf-lib. The library receives the
                // on-page rectangle and a font callback backed by our already
                // embedded fonts.
                const svgText = new TextDecoder().decode(bytes)
                drawSvg(page, svgText, pos.x, pos.y, {
                    width: widthPt,
                    height: heightPt,
                    preserveAspectRatio: getSvgPreserveAspectRatio(svgText),
                    fontCallback: (family, bold, italic) =>
                        resolveSvgFont(fonts, family, bold, italic)
                })
            }
        } else {
            // Fallback for any other image type: rasterize via canvas at 2x.
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
            const embedded = await pdfDoc.embedPng(png)
            page.drawImage(embedded, {
                x: pos.x,
                y: pos.y,
                width: widthPt,
                height: heightPt
            })
        }
    }
}

function isSvg(src: string, bytes: Uint8Array, contentType?: string | null): boolean {
    if (contentType?.includes("image/svg+xml")) return true
    const lowerSrc = src.toLowerCase()
    if (lowerSrc.endsWith(".svg") || lowerSrc.includes(".svg?") || lowerSrc.includes(".svg#")) return true
    const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart()
    return head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg")
}

/** Extract the SVG root's preserveAspectRatio value, defaulting to CSS-like meet. */
function getSvgPreserveAspectRatio(svgText: string): string {
    const match = svgText.match(
        /<svg[^>]*\spreserveAspectRatio=["']([^"']+)["'][^>]*>/i
    )
    const value = match?.[1].trim()
    return value || "xMidYMid meet"
}

/** Map an SVG font-family request to one of our embedded fonts. */
function resolveSvgFont(
    ctx: FontSelectionContext,
    family: string,
    bold: boolean,
    italic: boolean
): import("@pdfme/pdf-lib").PDFFont | undefined {
    const isMono = /mono/i.test(family)
    const isSans = /sans/i.test(family)
    const generic = isMono ? "monospace" : isSans ? "sans-serif" : "serif"
    const cutOrder: FontCut[] = bold && italic
        ? ["boldItalic", "bold", "italic", "regular"]
        : bold
          ? ["bold", "boldItalic", "regular", "italic"]
          : italic
            ? ["italic", "boldItalic", "regular", "bold"]
            : ["regular", "italic", "bold", "boldItalic"]
    const cuts = ctx.fallback.get(generic)
    if (!cuts) return undefined
    for (const cut of cutOrder) {
        const key = cuts[cut]
        if (key) {
            return ctx.byKey.get(key)?.pdfFont
        }
    }
    return undefined
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
    containerRect: DOMRect,
    ctx: FontSelectionContext
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
        const transform = style.textTransform
        const fontKey = resolveRunFontKey(
            ctx,
            style.fontFamily,
            style.fontWeight,
            style.fontStyle
        )
        const decorations = getTextDecorations(win, container, parent)
        const smallCaps = style.fontVariantCaps.includes("small-caps")
        const baseRtl = style.direction === "rtl"
        const text = textNode.data

        const applyTransform = (s: string): string => {
    if (transform === "uppercase") {
        return s.toUpperCase()
    }
    if (transform === "lowercase") {
        return s.toLowerCase()
    }
    if (transform === "capitalize") {
        return s.replace(/\b\w/g, c => c.toUpperCase())
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
                fontKey,
                color,
                decoration: decorations,
                smallCaps
            })
        }
        const measureRange = (start: number, end: number): DOMRect => {
            range.setStart(textNode, start)
            range.setEnd(textNode, end)
            return range.getBoundingClientRect()
        }

        // Split into words, keeping offsets so each word can be ranged
        // and measured individually. Words are further split into bidi runs
        // so mixed RTL/LTR content (e.g. Latin words or digits inside Arabic
        // script) is laid out with the correct direction per run.
        const wordPattern = /\S+/g
        let match: RegExpExecArray | null
        while ((match = wordPattern.exec(text)) !== null) {
            const word = match[0]
            const runs = splitBidiRuns(word, baseRtl)
            if (runs.length === 0) {
                continue
            }
            for (const run of runs) {
                const runStart = match.index + run.start
                const runEnd = runStart + run.text.length
                const runRect = measureRange(runStart, runEnd)
                const rects = Array.from(range.getClientRects()).filter(
                    r => r.width > 0 && r.height > 0
                )
                if (rects.length <= 1) {
                    if (runRect.width > 0 && runRect.height > 0) {
                        pushRun(run.text, runRect)
                    }
                    continue
                }
                // The run wraps across lines (e.g. broken at a hyphen).
                // Group its characters by line and emit one run per group —
                // otherwise the whole run would be drawn once per fragment
                // and overlap the following text.
                let groupStart = runStart
                let lineTop: number | null = null
                for (let k = runStart; k < runEnd; k++) {
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
                if (groupStart < runEnd) {
                    pushRun(
                        text.slice(groupStart, runEnd),
                        measureRange(groupStart, runEnd)
                    )
                }
            }
        }
    }
    return words
}

/** A list-marker that is an image (`list-style-image`), drawn at the item's
    first line. Geometry is deferred because the natural size is only known
    once the image is loaded. */
interface MarkerImageRun {
    url: string
    /** left edge of the item's border box, relative to the container (px) */
    boxLeftPx: number
    /** top of the item's first line, relative to the container (px) */
    yTopPx: number
    /** content-box left edge (border+padding), relative to container (px) */
    contentXInsidePx: number
    /** gap between an outside marker and the content (px) */
    gapPx: number
    /** when true, the marker is placed inside the content box */
    inside: boolean
}

interface ListMarkers {
    words: WordRun[]
    images: MarkerImageRun[]
}

/**
 * Synthesize runs for list markers. `::marker` pseudo-boxes have no DOM text
 * node, so word collection never sees them; we approximate them here using
 * the item's computed style and its `::marker` pseudo-element style (color,
 * font, custom `content`, `list-style-position` and `list-style-image`).
 * Text markers become word runs; image markers are returned separately.
 */
function collectListMarkers(
    win: Window,
    container: HTMLElement,
    containerRect: DOMRect,
    ctx: FontSelectionContext
): ListMarkers {
    const result: ListMarkers = {words: [], images: []}
    for (const el of walkElements(win, container)) {
        const style = win.getComputedStyle(el)
        if (style.display !== "list-item") {
            continue
        }
        let markerStyle: CSSStyleDeclaration | null = null
        try {
            markerStyle = win.getComputedStyle(el, "::marker")
        } catch {
            markerStyle = null
        }
        const markerStyleOrDefault = markerStyle ?? style

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

        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
            continue
        }
        const inside = style.listStylePosition === "inside"
        const fontSizePx = parseFloat(markerStyleOrDefault.fontSize) || parseFloat(style.fontSize)
        const fontKey = resolveRunFontKey(
            ctx,
            markerStyleOrDefault.fontFamily,
            markerStyleOrDefault.fontWeight,
            markerStyleOrDefault.fontStyle
        )
        const font = ctx.byKey.get(fontKey)?.pdfFont
        if (!font) {
            continue
        }
        const color = parseCssColor(markerStyleOrDefault.color)?.rgb ?? rgb(0, 0, 0)
        const gapPx = 0.4 * fontSizePx

        const borderLeftPx = parseFloat(style.borderLeftWidth) || 0
        const paddingLeftPx = parseFloat(style.paddingLeft) || 0
        const boxLeftPx = rect.left - containerRect.left
        const contentXInsidePx = boxLeftPx + borderLeftPx + paddingLeftPx
        const yTopPx =
            rect.top - containerRect.top + (parseFloat(style.paddingTop) || 0)

        // Custom ::marker content / list-style-image resolution.
        //
        // Order of precedence:
        //  1. element or ::marker `list-style-image` (readable in a normal,
        //     non-paginated document);
        //  2. vivliostyle renders image markers via the native `::marker`,
        //     so `::marker content` is `url(...)` there even though the
        //     element's `list-style-image` is reset to none — read it from there;
        //  3. custom ::marker string `content` (e.g. `"» "`);
        //  4. synthesized marker from `list-style-type`.
        const contentProp = markerStyleOrDefault.content
        let markerText: string | null = null
        let markerImageUrl: string | null = null
        const nonNone = (v: string): boolean => !!v && v !== "none" && v !== ""

        if (nonNone(style.listStyleImage)) {
            markerImageUrl = resolveMarkerImageUrl(style.listStyleImage, win.document.baseURI)
        } else if (nonNone(markerStyleOrDefault.listStyleImage)) {
            markerImageUrl = resolveMarkerImageUrl(markerStyleOrDefault.listStyleImage, win.document.baseURI)
        } else if (
            contentProp &&
            contentProp.trim().toLowerCase().startsWith("url(")
        ) {
            markerImageUrl = resolveMarkerImageUrl(contentProp, win.document.baseURI)
        }

        if (markerImageUrl) {
            result.images.push({
                url: markerImageUrl,
                boxLeftPx,
                yTopPx,
                contentXInsidePx,
                gapPx,
                inside
            })
            continue
        }

        if (contentProp && contentProp !== "normal" && contentProp !== "none") {
            markerText = contentProp.replace(/^["']|["']$/g, "")
        } else {
            markerText = markerForListStyle(
                style.listStyleType,
                () => ordinal(),
                () => bulletDepth(el)
            )
        }

        if (!markerText) {
            continue
        }
        const markerWidthPx =
            (font.widthOfTextAtSize(markerText, fontSizePx * PX_TO_PT) /
                PX_TO_PT
            )
        const x = inside
            ? contentXInsidePx
            : boxLeftPx - markerWidthPx - gapPx
        result.words.push({
            text: markerText,
            x,
            yTop: yTopPx,
            // Approximate the first line's em box: font size plus a bit.
            yBottom: yTopPx + fontSizePx * 1.2,
            width: markerWidthPx,
            fontSizePx,
            fontKey,
            color,
            decoration: {underline: null, overline: null, lineThrough: null},
            smallCaps: false
        })
    }
    return result
}

/** Extract + resolve a `list-style-image` URL against the document base. */
function resolveMarkerImageUrl(
    computedValue: string,
    baseUri: string
): string | null {
    const match = computedValue.match(/url\(\s*(?:["']?)([^"')]+)(?:["']?)\s*\)/)
    if (!match) {
        return null
    }
    const raw = match[1].trim()
    try {
        return new URL(raw, baseUri).href
    } catch {
        return raw
    }
}

/** Draw `list-style-image` markers once their natural size is known. */
async function drawMarkerImages(
    pdfDoc: PDFDocument,
    images: MarkerImageRun[],
    page: PDFPage,
    toPdf: ToPdfFn
): Promise<void> {
    for (const marker of images) {
        let bytes: Uint8Array | null = null
        try {
            const response = await fetch(marker.url)
            if (response.ok) {
                bytes = new Uint8Array(await response.arrayBuffer())
            }
        } catch {
            bytes = null
        }
        if (!bytes) {
            console.warn(
                `vivliostyle-pdf: could not load list-style-image ${marker.url}`
            )
            continue
        }
        const natural = await imageNaturalSize(bytes)
        if (!natural) {
            console.warn(
                `vivliostyle-pdf: could not read list-style-image ${marker.url}`
            )
            continue
        }
        let image: PDFImage | null = null
        if (isPng(bytes)) {
            image = await pdfDoc.embedPng(bytes)
        } else if (isJpeg(bytes)) {
            image = await pdfDoc.embedJpg(bytes)
        } else {
            console.warn(
                `vivliostyle-pdf: unsupported list-style-image ${marker.url}`
            )
            continue
        }
        const widthPx = natural.width
        const heightPx = natural.height
        const x = marker.inside
            ? marker.contentXInsidePx
            : marker.boxLeftPx - widthPx - marker.gapPx
        const y = marker.yTopPx
        const pos = toPdf(x, y, heightPx)
        page.drawImage(image, {
            x: pos.x,
            y: pos.y,
            width: widthPx * PX_TO_PT,
            height: heightPx * PX_TO_PT
        })
    }
}

/** Load image bytes into a detached <img> (in the app window) for dimensions. */
function imageNaturalSize(
    bytes: Uint8Array
): Promise<{width: number; height: number} | null> {
    return new Promise(resolve => {
        const url = URL.createObjectURL(
            new Blob([toFreshBuffer(bytes)], {type: "image/png"})
        )
        const image = new window.Image()
        image.onload = () =>
            resolve(
                image.naturalWidth && image.naturalHeight
                    ? {width: image.naturalWidth, height: image.naturalHeight}
                    : null
            )
        image.onerror = () => {
            URL.revokeObjectURL(url)
            resolve(null)
        }
        image.src = url
    })
}

/** Copy bytes into a fresh ArrayBuffer-backed view (Blob typing). */
function toFreshBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(bytes.byteLength)
    out.set(bytes)
    return out
}

/**
 * Does any ancestor (up to the page container) carry a text-decoration line
 * (`line-through`, `overline`, `underline`)? Text decorations propagate to
 * inline descendants visually, but the computed style only shows them on the
 * element they are declared on — so walk up, taking the nearest ancestor's
 * style/color for each decoration line. Results are cached per element.
 */
const decorationCache = new WeakMap<HTMLElement, TextDecoration>()

function decorationLineFrom(
    style: CSSStyleDeclaration
): {style: DecorationStyle; color: RGB | null} {
    const raw = style.textDecorationStyle
    const decoStyle: DecorationStyle =
        raw === "double" ||
        raw === "dotted" ||
        raw === "dashed" ||
        raw === "wavy"
            ? raw
            : "solid"
    const color = parseCssColor(style.textDecorationColor)
    return {style: decoStyle, color: color ? color.rgb : null}
}

function getTextDecorations(
    win: Window,
    container: HTMLElement,
    el: HTMLElement
): TextDecoration {
    const cached = decorationCache.get(el)
    if (cached !== undefined) {
        return cached
    }
    const result: TextDecoration = {
        underline: null,
        overline: null,
        lineThrough: null
    }
    let node: HTMLElement | null = el
    while (node && node !== container) {
        const style = win.getComputedStyle(node)
        const line = style.textDecorationLine
        if (line.includes("line-through") && !result.lineThrough) {
            result.lineThrough = decorationLineFrom(style)
        }
        if (line.includes("overline") && !result.overline) {
            result.overline = decorationLineFrom(style)
        }
        if (line.includes("underline") && !result.underline) {
            result.underline = decorationLineFrom(style)
        }
        if (result.lineThrough && result.overline && result.underline) {
            break
        }
        node = node.parentElement
    }
    decorationCache.set(el, result)
    return result
}

/** Paint a single decoration line in the given style (PDF coordinates, pt). */
function paintStyledLine(
    page: PDFPage,
    x: number,
    y: number,
    width: number,
    thickness: number,
    style: DecorationStyle,
    color: RGB
): void {
    if (style === "solid") {
        page.drawLine({
            start: {x, y},
            end: {x: x + width, y},
            thickness,
            color
        })
        return
    }
    if (style === "double") {
        const t = Math.max(0.4, thickness)
        page.drawLine({
            start: {x, y: y - t},
            end: {x: x + width, y: y - t},
            thickness: t,
            color
        })
        page.drawLine({
            start: {x, y: y + t},
            end: {x: x + width, y: y + t},
            thickness: t,
            color
        })
        return
    }
    if (style === "dashed") {
        page.drawLine({
            start: {x, y},
            end: {x: x + width, y},
            thickness,
            color,
            dashArray: [thickness * 3, thickness * 2]
        })
        return
    }
    if (style === "dotted") {
        page.drawLine({
            start: {x, y},
            end: {x: x + width, y},
            thickness,
            color,
            dashArray: [0.01, thickness * 2],
            lineCap: LineCapStyle.Round
        })
        return
    }
    // wavy: a sine polyline.
    const steps = Math.max(8, Math.floor(width / Math.max(2, thickness * 2)))
    const amplitude = thickness
    const periods = Math.max(1, Math.floor(width / (thickness * 8)))
    let prev = {x, y}
    for (let i = 1; i <= steps; i++) {
        const xx = x + (i / steps) * width
        const yy = y + amplitude * Math.sin((i / steps) * Math.PI * 2 * periods)
        page.drawLine({start: prev, end: {x: xx, y: yy}, thickness, color})
        prev = {x: xx, y: yy}
    }
}

/** Draw a word's text decorations (underline/overline/line-through). */
function drawWordDecorations(
    page: PDFPage,
    word: WordRun,
    xPt: number,
    baselineY: number,
    sizePt: number
): void {
    const width = word.width * PX_TO_PT
    const paint = (
        line: DecorationLine | null,
        offset: number,
        thickness: number
    ): void => {
        if (!line) {
            return
        }
        paintStyledLine(
            page,
            xPt,
            baselineY + offset,
            width,
            thickness,
            line.style,
            line.color ?? word.color
        )
    }
    paint(word.decoration.lineThrough, sizePt * 0.3, sizePt / 18)
    paint(word.decoration.overline, sizePt * 0.8, sizePt / 16)
    paint(word.decoration.underline, -sizePt * 0.1, sizePt / 16)
}

function bulletDepth(el: Element): number {
    let depth = 0
    let ancestor = el.parentElement?.parentElement
    while (ancestor) {
        if (ancestor.tagName === "UL") {
            depth++
        }
        ancestor = ancestor.parentElement
    }
    return depth
}

const ROMAN_ONES = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix"]
const ROMAN_TENS = ["", "x", "xx", "xxx", "xl", "l", "lx", "lxx", "lxxx", "xc"]
const ROMAN_HUNDREDS = ["", "c", "cc", "ccc", "cd", "d", "dc", "dcc", "dccc", "cm"]

function toRoman(n: number): string {
    if (n <= 0 || n > 1999) return String(n)
    return (
        ROMAN_HUNDREDS[Math.floor(n / 100)] +
        ROMAN_TENS[Math.floor((n % 100) / 10)] +
        ROMAN_ONES[n % 10]
    )
}

function toAlphaOrdinal(n: number, upper: boolean): string {
    const letter = String.fromCharCode(0x61 + ((n - 1) % 26))
    const repeats = Math.floor((n - 1) / 26) + 1
    return upper ? letter.toUpperCase().repeat(repeats) : letter.repeat(repeats)
}

function markerForListStyle(
    listStyle: string,
    ordinal: () => number,
    bulletDepth: () => number
): string | null {
    // Vivliostyle overrides list-style-type with an inline "none" and renders
    // markers internally (invisible to a DOM walk). Synthesize from the list
    // element type. An author-specified "none" in a stylesheet is NOT matched.
    if (listStyle === "none" || listStyle === "") {
        return null
    }

    // Ordered list styles.
    switch (listStyle) {
        case "decimal":
        case "decimal-leading-zero":
            return `${ordinal()}.`
        case "lower-roman":
            return `${toRoman(ordinal())}.`
        case "upper-roman":
            return `${toRoman(ordinal()).toUpperCase()}.`
        case "lower-alpha":
        case "lower-latin":
            return `${toAlphaOrdinal(ordinal(), false)}.`
        case "upper-alpha":
        case "upper-latin":
            return `${toAlphaOrdinal(ordinal(), true)}.`
    }

    // Unordered list styles.
    switch (listStyle) {
        case "disc":
        case "square":
            return "•"
        case "circle":
            return "◦"
        case "disclosure-open":
            return "▾"
        case "disclosure-closed":
            return "▸"
    }

    // Default UA bullet sequence by nesting depth.
    if (listStyle === "list-item" || listStyle === "initial") {
        return bulletDepth() % 2 === 0 ? "•" : "◦"
    }

    return null
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

