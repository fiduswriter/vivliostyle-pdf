// @vivliostyle/print ships no TypeScript types. This declaration covers the
// parts of the API we use, as verified against the installed dist bundle
// (v2.44.1): printCallback is invoked synchronously after pagination
// completes and is NOT awaited, so with removeIframe: false the iframe
// stays alive and async work can continue in the callback.
declare module "@vivliostyle/print" {
    export interface PrintHTMLConfig {
        title?: string
        printCallback?: (iframeWindow: Window) => void
        errorCallback?: (message: string) => void
        hideIframe?: boolean
        removeIframe?: boolean
    }

    export function printHTML(htmlDoc: string, config?: PrintHTMLConfig): void
}
