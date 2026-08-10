/**
 * Public API for vivliostyle-pdf.
 *
 * Converts an HTML/CSS Paged Media document, paginated by
 * @vivliostyle/print in a hidden iframe, into a real vector PDF using
 * @pdfme/pdf-lib.
 */
export {
    emitPdfFromVivliostyleWindow,
    type DecorationStyle,
    type EmitMetadata,
    type EmitOptions,
    type PrintOptions
} from "./pdf-emitter.js"
