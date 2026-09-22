import type {BackendConfig} from "pages-to-pdf"
import {printHTML} from "@vivliostyle/print"

import {VIVLIOSTYLE_BACKEND} from "./backend.js"

export interface PaginateConfig {
    /** The complete HTML document to paginate. */
    html: string
    /** Document title, applied to the paginated iframe. */
    title?: string
    /** Called with a message when pagination fails. */
    errorCallback?: (message: string) => void
}

/** A paginated document living in a hidden iframe. */
export interface PaginatedWindow {
    /** The iframe window holding the paginated DOM. */
    win: Window
    /** Remove the iframe from the DOM once it is no longer needed. */
    cleanup: () => void
}

/**
 * A pagination engine: renders the paginated output used by the browser
 * print dialog and describes its page structure to the DOM-to-PDF emitter
 * through the `backend` configuration.
 */
export interface PrintEngine {
    /** Identifier used by host applications to select the engine. */
    name: string
    /**
     * Paginate the given HTML in a hidden iframe and hand back the iframe
     * window without opening a print dialog. The caller must invoke
     * `cleanup()` when it is done with the window.
     */
    preparePagination(config: PaginateConfig): Promise<PaginatedWindow>
    /**
     * Paginate the given HTML and open the browser print dialog. Resolves
     * once the document has been handed to the browser.
     */
    print(config: PaginateConfig): Promise<void>
    /** DOM-to-PDF emitter configuration matching this engine's output. */
    backend: BackendConfig
}

/**
 * Firefox has issues printing images that are located in an iframe. As a
 * workaround, the paginated body is swapped into the main document, the main
 * window prints, and the original body is restored afterwards. This
 * workaround can be removed once that browser bug has been fixed.
 */
function printViaBodySwap(win: Window): void {
    const oldBody = document.body
    document.body.parentElement!.dataset.printPaginated = "true"
    document.body = win.document.body
    // Data attributes that trigger editor-specific styling in the main
    // document's CSS must not affect the swapped-in print content.
    document.body
        .querySelectorAll("figure, table")
        .forEach(el => delete (el as HTMLElement).dataset.category)
    win.document
        .querySelectorAll("style")
        .forEach(el => document.body.appendChild(el))
    const backgroundStyle = document.createElement("style")
    backgroundStyle.innerHTML = "body {background-color: white;}"
    document.body.appendChild(backgroundStyle)
    window.print()
    document.body = oldBody
    delete document.body.parentElement!.dataset.printPaginated
}

function isFirefox(): boolean {
    return navigator.userAgent.includes("Gecko/")
}

function preparePagination(config: PaginateConfig): Promise<PaginatedWindow> {
    return new Promise((resolve, reject) => {
        // @vivliostyle/print does not await `printCallback` and returns
        // nothing, so the paginated window is captured from the callback and
        // the iframe is kept alive until the caller cleans it up.
        printHTML(config.html, {
            title: config.title,
            removeIframe: false,
            hideIframe: true,
            errorCallback: message => {
                config.errorCallback?.(message)
                reject(new Error(message))
            },
            printCallback: iframeWin =>
                resolve({
                    win: iframeWin,
                    cleanup: () => iframeWin.frameElement?.remove()
                })
        })
    })
}

async function print(config: PaginateConfig): Promise<void> {
    if (isFirefox()) {
        printHTML(config.html, {
            title: config.title,
            errorCallback: config.errorCallback,
            printCallback: printViaBodySwap
        })
        return
    }
    // Without a printCallback, @vivliostyle/print prints the paginated
    // iframe directly and removes it afterwards.
    printHTML(config.html, {
        title: config.title,
        errorCallback: config.errorCallback
    })
}

export const vivliostylePdfEngine: PrintEngine = {
    name: "vivliostyle-pdf",
    preparePagination,
    print,
    backend: VIVLIOSTYLE_BACKEND
}
