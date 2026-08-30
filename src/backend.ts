/**
 * Backend configuration for documents paginated by @vivliostyle/print.
 *
 * This is the only engine-specific knowledge vivliostyle-pdf needs
 * on top of the generic pages-to-pdf emitter.
 */
import {type BackendConfig} from "pages-to-pdf"

export const VIVLIOSTYLE_BACKEND: BackendConfig = {
    pageSelector: "[data-vivliostyle-page-container]",
    filterEmptyPages: true,
    unhidePagesSelector: "[data-vivliostyle-page-container]",
    internalLinkPrefix: /^viv-id-.*:0023/,
    scaleRunsToMeasuredWidth: true,
    handleHyphenation: true,
    // Engine furniture: Vivliostyle renders running heads and page numbers
    // as real DOM inside page margin boxes.
    artifactSelectors: ["[data-vivliostyle-page-margin-box]"],
    // Engine layout wrappers are transparent for the structure tree.
    wrapperSelectors: [
        "[data-vivliostyle-bleed-box]",
        "[data-vivliostyle-page-box]",
        "[data-vivliostyle-page-area-container]",
        "[data-vivliostyle-page-area]",
        "[data-vivliostyle-column]",
        "[data-vivliostyle-original-tag]"
    ],
    footnoteSelectors: {
        item: "[data-viv-footnote-counter]",
        call: "[data-viv-footnote-call-owner]"
    },
    defaultCreator: "vivliostyle-pdf"
}
