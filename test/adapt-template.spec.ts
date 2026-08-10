import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

// Faithful reproduction of Fidus Writer's print footnote mechanism, which
// uses vivliostyle's `-adapt-template` shadow template (s:content/s:include)
// instead of the demo's `float: footnote`.
const TEMPLATE = encodeURI(
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:s="http://www.pyroxy.com/ns/shadow"><head><style>.footnote-content{float:footnote}</style></head><body><s:template id="footnote"><s:content/><s:include class="footnote-content"/></s:template></body></html>#footnote'
)

const HTML = `<!doctype html>
<html lang="en-US"><head><meta charset="UTF-8" /><title>Adapt footnote test</title>
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "Lib", serif; font-size: 12pt; }
a.footnote, a.affiliation {
  -adapt-template: url(data:application/xml,${TEMPLATE});
  text-decoration: none; color: inherit; vertical-align: baseline; font-size: 70%; position: relative; top: -0.3em;
}
aside.footnote label:first-child:after { content: '. '; }
body, section[role=doc-footnotes] { counter-reset: footnote-counter footnote-marker-counter; }
section#footnotes { display: none; }
section:footnote-content { display: block; font-size: small; }
</style></head>
<body>
<p>Main text with a note.<a class="footnote" href="#fn-1">1</a> Continues.</p>
<section class="fnlist footnotes" role="doc-footnotes" id="footnotes">
  <aside class="footnote" role="doc-footnote" id="fn-1"><label>1</label><p>This is the uniquefootbody text.</p></aside>
</section>
</body></html>`

test("fidus -adapt-template footnote body reaches the PDF (verification)", async ({
    page
}) => {
    const consoleErrors: string[] = []
    page.on("console", m => {
        if (m.type() === "error") consoleErrors.push(m.text())
    })
    page.on("pageerror", e => consoleErrors.push(String(e)))

    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()
    await page.locator("#source").fill(HTML)
    const dp = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const d = await dp
    const bytes = await readFile(await d.path())
    await expect(page.locator("#status")).toContainText("Done")

    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    let text = ""
    for (let i = 1; i <= doc.numPages; i++) {
        const pd = await doc.getPage(i)
        const content = await pd.getTextContent()
        text += content.items
            .map(item => ("str" in item ? item.str : ""))
            .join(" ")
    }
    expect(text).toContain("Main text with a note")
    // The note body was pulled out of the display:none section, materialized
    // into the footnote area by vivliostyle and captured by the emitter.
    expect(text).toContain("This is the uniquefootbody text")
    expect(text).toContain("1. This is the uniquefootbody text")
})