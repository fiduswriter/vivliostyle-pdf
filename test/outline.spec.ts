import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

/*
 * The PDF outline (bookmarks) should include every heading level the Fidus
 * schema supports (h1–h6), nested by depth.
 */
const HTML = `<!doctype html>
<html lang="en-US"><head><meta charset="UTF-8" /><title>Outline test</title><style>
@page { size: A4; margin: 20mm; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; margin: 8pt 0 4pt; }
</style></head><body>
<h1>Level One</h1>
<h2>Level Two</h2>
<h3>Level Three</h3>
<h4>Level Four</h4>
<h5>Level Five</h5>
<h6>Level Six</h6>
<p>Body text.</p>
</body></html>`

test("outline includes h1–h6 nested by depth", async ({page}) => {
    await page.goto("/")
    await expect(page.locator("#generate")).toBeVisible()
    await page.locator("#source").fill(HTML)
    const dp = page.waitForEvent("download", {timeout: 90_000})
    await page.click("#generate")
    const d = await dp
    const bytes = await readFile(await d.path())

    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes)}).promise
    interface OutlineItem {
        title: string
        items?: OutlineItem[]
    }
    const outline = (await doc.getOutline()) as OutlineItem[] | null

    const titles: string[] = []
    const walk = (items: OutlineItem[] | null | undefined): void => {
        for (const item of items ?? []) {
            titles.push(item.title)
            walk(item.items)
        }
    }
    walk(outline)
    for (const t of [
        "Level One",
        "Level Two",
        "Level Three",
        "Level Four",
        "Level Five",
        "Level Six"
    ]) {
        expect(titles).toContain(t)
    }

    // Nested: each deeper level is a child of the previous.
    const find = (
        items: OutlineItem[] | null | undefined,
        title: string
    ): OutlineItem | null => {
        for (const item of items ?? []) {
            if (item.title === title) return item
            const sub = find(item.items, title)
            if (sub) return sub
        }
        return null
    }
    expect(find(outline, "Level Two")?.items?.[0]?.title).toBe("Level Three")
    expect(find(outline, "Level Three")?.items?.[0]?.title).toBe("Level Four")
    expect(find(outline, "Level Five")?.items?.[0]?.title).toBe("Level Six")
})