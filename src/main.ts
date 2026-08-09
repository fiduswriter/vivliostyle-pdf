/**
 * Demo wiring: paginate the demo document with vivliostyle in a hidden
 * iframe, then run the DOM-to-PDF emitter on the paginated output and
 * download the result. Everything happens client-side.
 */
import {printHTML} from "@vivliostyle/print"
import {emitPdfFromVivliostyleWindow} from "./pdf-emitter.js"
import demoHtml from "./demo-document.html?raw"

// Static index.html elements; assert non-null.
const generateButton =
    document.querySelector<HTMLButtonElement>("#generate")!
const statusArea = document.querySelector<HTMLDivElement>("#status")!
const sourceArea = document.querySelector<HTMLTextAreaElement>("#source")!
const cropMarksCheckbox =
    document.querySelector<HTMLInputElement>("#crop-marks")!
const trimBoxCheckbox = document.querySelector<HTMLInputElement>("#trim-box")!
const bleedBoxCheckbox =
    document.querySelector<HTMLInputElement>("#bleed-box")!
const bleedMmInput = document.querySelector<HTMLInputElement>("#bleed-mm")!

// Seed the editor with the demo source.
sourceArea.value = demoHtml

function setStatus(message: string, isError = false): void {
    const line = document.createElement("div")
    line.textContent = message
    if (isError) {
        line.classList.add("error")
    }
    statusArea.appendChild(line)
    statusArea.scrollTop = statusArea.scrollHeight
}

function downloadPdf(bytes: Uint8Array, filename: string): void {
    const blob = new Blob([bytes as BlobPart], {type: "application/pdf"})
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Revoke later so the download (and test harness) can grab it first.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function generate(): void {
    generateButton.disabled = true
    statusArea.textContent = ""
    setStatus("Paginating with vivliostyle…")

    // The paginated document is loaded from a blob: URL inside the iframe,
    // and vivliostyle resolves relative resource URLs against that blob URL
    // (it ignores <base>). To make fonts and images load, the source HTML
    // uses a __BASE__ placeholder that we expand to this app's absolute
    // deployment root.
    const baseHref = new URL(import.meta.env.BASE_URL, window.location.href)
        .href
    const html = sourceArea.value.replaceAll("__BASE__", baseHref)

    const bleedMm = Math.max(0, parseFloat(bleedMmInput.value) || 0)
    const printOptions = {
        cropMarks: cropMarksCheckbox.checked,
        trimBox: trimBoxCheckbox.checked,
        bleedBox: bleedBoxCheckbox.checked,
        bleedMm
    }

    printHTML(html, {
        title: "Vivliostyle PDF Prototype Demo",
        hideIframe: true,
        // Keep the iframe: vivliostyle does NOT await printCallback (verified
        // in the installed dist bundle), so our async emitter runs after the
        // callback returns. We remove the iframe ourselves when done.
        removeIframe: false,
        errorCallback: message => {
            setStatus(`vivliostyle error: ${message}`, true)
            generateButton.disabled = false
        },
        printCallback: iframeWindow => {
            void (async () => {
                const iframe = iframeWindow.frameElement
                try {
                    setStatus("Pagination complete. Emitting PDF…")
                    // The paginated iframe DOM does not retain the source
                    // <head>, so metadata is parsed from the raw source.
                    const sourceDoc = new DOMParser().parseFromString(
                        sourceArea.value,
                        "text/html"
                    )
                    const metaContent = (name: string) =>
                        sourceDoc
                            .querySelector(`meta[name="${name}"]`)
                            ?.getAttribute("content") ?? undefined
                    const bytes = await emitPdfFromVivliostyleWindow(
                        iframeWindow,
                        setStatus,
                        {
                            sourceHtml: sourceArea.value,
                            metadata: {
                                title:
                                    sourceDoc
                                        .querySelector("title")
                                        ?.textContent?.trim() ?? undefined,
                                author: metaContent("author"),
                                subject: metaContent("description"),
                                keywords: metaContent("keywords"),
                                language:
                                    sourceDoc.documentElement.lang || "en-US"
                            },
                            printOptions
                        }
                    )
                    downloadPdf(bytes, "demo.pdf")
                    setStatus(
                        `Done — downloaded demo.pdf (${(
                            bytes.length / 1024
                        ).toFixed(0)} KB).`
                    )
                } catch (error) {
                    console.error(error)
                    setStatus(
                        `PDF emission failed: ${
                            error instanceof Error ? error.message : error
                        }`,
                        true
                    )
                } finally {
                    iframe?.remove()
                    generateButton.disabled = false
                }
            })()
        }
    })
}

generateButton.addEventListener("click", generate)
