/**
 * Public API for vivliostyle-pdf.
 *
 * Thin wrapper around `pages-to-pdf` that pins the Vivliostyle backend
 * configuration, so documents paginated by @vivliostyle/print are emitted with
 * the right page selectors, margin-box handling and internal-link rewriting.
 */
export {printHTML} from "@vivliostyle/print"
export type {PrintHTMLConfig} from "@vivliostyle/print"

import {
    emitPdfFromWindow,
    type DecorationStyle as PagesDecorationStyle,
    type EmitAttachment as PagesEmitAttachment,
    type EmitMetadata as PagesEmitMetadata,
    type EmitOptions as PagesEmitOptions,
    type PdfOptions as PagesPdfOptions,
    type PrintOptions as PagesPrintOptions
} from "pages-to-pdf"
import {VIVLIOSTYLE_BACKEND} from "./backend.js"

export type DecorationStyle = PagesDecorationStyle
export type EmitAttachment = PagesEmitAttachment
export type EmitMetadata = PagesEmitMetadata
export type PrintOptions = PagesPrintOptions
export type PdfOptions = PagesPdfOptions

/**
 * Options accepted by {@link emitPdfFromVivliostyleWindow}.
 *
 * This is the same shape as `pages-to-pdf`'s `EmitOptions`, but the backend is
 * fixed to Vivliostyle so it is omitted from the public API here.
 */
export type EmitOptions = Omit<PagesEmitOptions, "backend">


/**
 * Emit a PDF from the window of a @vivliostyle/print iframe after pagination
 * has completed.
 *
 * This delegates to `pages-to-pdf`'s `emitPdfFromWindow` with the Vivliostyle
 * backend preset, so the exported API and behavior stay unchanged from the
 * previous standalone implementation.
 *
 * @param win  the iframe window passed to printCallback
 * @param onProgress  optional status callback for UI feedback
 * @param options  optional extras (HTML source attachment, metadata, print options)
 * @returns the PDF file bytes
 */
export async function emitPdfFromVivliostyleWindow(
    win: Window,
    onProgress?: (message: string) => void,
    options?: EmitOptions
): Promise<Uint8Array> {
    return emitPdfFromWindow(win, onProgress, {
        ...options,
        backend: VIVLIOSTYLE_BACKEND
    })
}
