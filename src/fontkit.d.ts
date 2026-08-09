// fontkit v2 (foliojs) ships no TypeScript types. This declaration covers
// the small surface we use; @pdfme/pdf-lib consumes the same object via
// registerFontkit (cast at the call site).
declare module "fontkit" {
    export interface FontkitFont {
        unitsPerEm: number
        ascent: number
        descent: number
    }

    export function create(buffer: Uint8Array): FontkitFont
}
