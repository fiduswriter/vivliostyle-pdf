# vivliostyle-pdf

**Live demo:** <https://johanneswilm.github.io/vivliostyle-pdf/> — click
"Generate PDF"; everything happens client-side, no print dialog.

Technical prototype: **browser-only PDF export without the print dialog.**

[vivliostyle](https://vivliostyle.org/) paginates an HTML/CSS Paged Media
document inside a hidden iframe. A custom DOM→PDF emitter then walks the
paginated output and re-renders it as a real vector PDF with
[@pdfme/pdf-lib](https://github.com/pdfme/pdf-lib) (an API-compatible,
actively maintained fork of pdf-lib). No server, no print dialog.

## Architecture

```
HTML + CSS Paged Media
        │
        ▼  printHTML() from @vivliostyle/print
vivliostyle pagination (hidden iframe, one container div per page,
including running headers, page counters, footnotes, TOC page refs)
        │
        ▼  printCallback fires when pagination completes
DOM→PDF emitter (src/pdf-emitter.ts)
  • measures each page container (px → pt, 1 px = 0.75 pt, Y flipped)
  • paints background-color rects, then solid borders, then images
    (PNG/JPEG embedded directly, SVG rasterized via canvas at 2x)
  • positions every word individually from Range.getClientRects(), so
    browser line breaking/justification is preserved exactly
  • draws strike lines for text-decoration: line-through, and synthesizes
    small caps (Chromium applies font-variant-caps only at render time;
    the DOM keeps lowercase text) fitted to the measured word width
  • synthesizes list markers (vivliostyle renders ::marker internally,
    invisible to a DOM walk)
  • attaches link annotations, hand-built as PDF dictionaries via the
    low-level object API (doc.context.obj/register + page.node.addAnnot):
    external links get URI actions, internal links GoTo destinations to
    the page+top of their target element (two-pass, since a target may
    be emitted after the link; vivliostyle rewrites internal hrefs to
    "#viv-id-<encoded doc URL>:0023id" — the emitter strips that prefix)
  • sets document metadata (Title/Author/Subject/Keywords/Creator/
    Producer/Language, from the source document's <title>/<meta> tags),
    builds a nested PDF outline (bookmarks) from the h1–h6 headings with
    XYZ destinations, sets viewer preferences (PageMode /UseOutlines,
    DisplayDocTitle), and embeds the pre-pagination source HTML as a
    file attachment
  • resolves fonts the way the browser does: every `@font-face` rule in
    the paginated document (inlined by the Fidus print exporter, with
    `documentstylefile_set` asset URLs already absolute) is discovered,
    fetched, normalized to embeddable sfnt bytes (WOFF unwrapped in pure JS;
    WOFF2 skipped with a warning) and embedded subsetted via @pdfme/pdf-lib
    + foliojs fontkit — then CSS font matching (family → style → weight
    band, vivliostyle `Fnt_n` aliases stripped) picks the right cut per text
    run. Identical fonts are embedded once (semantic dedup). Libertinus
    Serif/Mono TTFs in public/fonts/ serve only as the last-resort fallback
    and as the demo's active font.
        │
        ▼
Uint8Array → Blob → download as demo.pdf
```

Implementation notes:

- `@vivliostyle/print` does **not** await `printCallback` (verified in the
  installed dist bundle). The app therefore passes `removeIframe: false`,
  runs the async emitter inside the callback, and removes the iframe itself
  afterwards.
- vivliostyle's viewer only displays the first page on screen (the rest
  would be revealed by print CSS, which never runs). The emitter restores
  `display: block` on hidden page containers before measuring.
- The paginated document is loaded from a `blob:` URL and vivliostyle
  resolves resource URLs against it (ignoring `<base>`), so the demo
  document uses a `__BASE__` placeholder that `src/main.ts` expands to the
  app's absolute deployment root.
- Baselines are approximated as `rect.bottom − descent(fontSize)` using
  fontkit metrics — see Limitations.

## Repository layout

```
index.html                  demo page (vite entry)
src/main.ts                 wiring: paginate → emit → download
src/pdf-emitter.ts          the DOM→PDF emitter (public API:
                            emitPdfFromVivliostyleWindow(win))
src/font-face.ts            @font-face discovery + CSS font matching
src/font-formats.ts         font format sniffing + WOFF→sfnt normalization
src/demo-document.html      rich test document (paged CSS, TOC, footnotes,
                            cross references, external links, 3 tables,
                            3 figures, bibliography)
src/vivliostyle-print.d.ts  types for the untyped @vivliostyle/print
public/fonts/               Libertinus Serif + Libertinus Mono TTFs (OFL) plus
                            Noto Sans Arabic/Hebrew test fonts (OFL)
public/images/              figure SVGs + generated PNG
scripts/gen-assets.mjs      dependency-free PNG generator (node zlib)
scripts/debug-run.mjs       dev helper: run generation, log console, save PDF
test/e2e.spec.ts            Playwright end-to-end test
test/math.spec.ts           MathML translation verification (known gap)
test/fonts.spec.ts          dynamic font resolution e2e (matching, WOFF, dedup)
test/font-formats.spec.ts   node tests for font sniffing + WOFF round-trip
test/bidi.spec.ts           node tests for the bidi-run splitter
test/rtl.spec.ts            RTL/bidi end-to-end (positions, mixed runs)
test/decor.spec.ts          text-decoration + border-style breadth vector ops
test/markers.spec.ts        list-marker fidelity (inside/outside, ::marker)
test/list-style-image.spec.ts list-style-image markers + Chromium probe
test/outline.spec.ts        outline h1–h6 nesting
test/adapt-template.spec.ts fidus -adapt-template footnote verification
.github/workflows/pages.yml GitHub Pages deployment
```

## Demo document coverage

The demo document (`src/demo-document.html`) deliberately exercises:

- running page headers (`string-set` + `@top-center`) and page-number
  footers (`@bottom-center` + `counter(page)`/`counter(pages)`),
- footnotes (`float: footnote`, `::footnote-call`, `::footnote-marker`),
- a table of contents with `target-counter(attr(href url), page)` and
  leader dots,
- **cross references** in the body text ("Table 2 (page N)", "Section 2
  (page N)", "Figure 1 (page N)") — forward and backward, pointing at a
  heading, a table, and figures — using the same `target-counter` mechanism
  as the TOC,
- **external hyperlinks** (vivliostyle.org, pdf-lib.js.org) — in the
  generated PDF these are clickable Link annotations (URI actions), as
  are the TOC entries and cross references (internal GoTo jumps),
- three tables (simple, styled with header background/borders, and one
  spanning a page break) and three figures (two SVG, one PNG),
- inline styles: bold, italic, bold-italic, strikethrough
  (`text-decoration: line-through`, drawn as a vector line by the
  emitter), small caps (synthesized by the emitter), and monospace code
  spans plus a `<pre>` block set in Libertinus Mono,
- headings with CSS-counter numbering, nested lists, a blockquote, inline
  code and a dark `<pre>` block, and a bibliography,
- a "Typography, Direction & Decoration" section exercising the added
  features: **custom `@font-face` families** (DejaVu Sans, Noto Sans
  Arabic/Hebrew — discovered by the emitter, no hardcoded registry),
  **right-to-left text** (Arabic and Hebrew, including Arabic mixed with a
  Western number), **text-decoration breadth** (dashed/dotted/double/wavy
  underlines, overline, dotted strikethrough), **border-style breadth**
  (dashed/dotted/double boxes) and **rounded chips/badges**, and **deep
  outline levels** (h4–h6 bookmarks).

The e2e test (`test/e2e.spec.ts`) verifies these features in the generated
PDF by extracting per-page text and annotations with `pdfjs-dist`
(@pdfme/pdf-lib, like pdf-lib, cannot read them back): it checks the
running header and page-number footer on every page, resolved TOC page
numbers, cross-reference numbers against the actual pages of their
targets, footnote bodies on the same page as their calls, external Link
annotations for both URLs, GoTo annotations whose resolved destinations
match the targets' actual pages, small-caps/strikethrough/code text
presence, metadata fields, the outline tree (nesting + resolved
destinations), the embedded HTML attachment, the PageMode/Lang/
DisplayDocTitle catalog entries, and zero console errors.

## Develop

```bash
pnpm install
pnpm run gen:assets   # regenerate public/images/figure-2.png
pnpm run dev          # vite dev server at /vivliostyle-pdf/
pnpm run build        # tsc + vite build → dist/
pnpm run preview      # serve dist/ at /vivliostyle-pdf/
```

## Test

```bash
pnpm exec playwright install chromium   # once
pnpm run test:e2e
```

The e2e test builds the app, serves `dist/`, clicks "Generate PDF" in
chromium, captures the download and asserts: `%PDF-` magic, size > 20 KB,
page count > 5 (parsed with @pdfme/pdf-lib), and no console errors — plus
the feature-level text/annotation assertions described above.

## Deployment (GitHub Pages)

`.github/workflows/pages.yml` builds and deploys `dist/` to GitHub Pages on
every push to `main`. The vite `base` is `/vivliostyle-pdf/`, so asset URLs
work both on Pages and locally. Requires the repo's Pages source to be set
to "GitHub Actions".

## Beyond the print dialog

Because the emitter writes the PDF itself, it can add structures that
`window.print()` never produces:

- **Document metadata**: Title, Author, Subject and Keywords come from
  the source document's `<title>` and `<meta name="author|description|
  keywords">` tags (parsed from the raw HTML — vivliostyle's iframe does
  not retain the source `<head>`); Creator, Producer, the document
  language (`/Lang en-US`) and creation/modification dates are set too.
- **Outline (bookmarks)**: every h1–h6 heading becomes a bookmark,
  nested by heading level, with an XYZ destination to the page and
  vertical position of the heading. The outline tree is built with the
  low-level object API (all item refs are registered first, then
  Title/Parent/Dest/Prev/Next/First/Last/Count are wired up), and the
  catalog's `PageMode` is set to `/UseOutlines` so viewers open the
  bookmarks sidebar automatically.
- **Viewer preferences**: `DisplayDocTitle` makes viewers show the
  document title (rather than the file name) in the window title bar.
- **Source attachment**: the pre-pagination HTML source is embedded as
  a file attachment (`demo-document.html`), so the PDF is self-contained
  and its source can be extracted with any PDF tool (`pdfdetach`,
  Acrobat's attachments panel, etc.).

## Limitations

- **Approximate baselines**: text is placed at `rect.bottom − descent(fontSize)`
  using fontkit metrics, which can be off by a fraction of a point versus the
  browser's true line boxes. This is intentionally kept rather than a shared
  per-line baseline, because each run's measured rect already reflects its own
  line box and descent (forcing one baseline would regress sized runs).
- **Fallback fonts**: text maps to the document's own `@font-face` fonts (any
  family/weight/style; weight ranges and italic/oblique matched per CSS Fonts
  4, vivliostyle `Fnt_n` aliases stripped). When nothing matches — or a
  configured font can't be embedded — text falls back to Libertinus Serif
  (Regular/Bold/Italic/BoldItalic) or Libertinus Mono Regular. WOFF is
  unwrapped to sfnt in pure JS and embedded; **WOFF2 and font collections are
  not yet embeddable** (they still influence layout via the browser, so
  positions are right, but the glyphs come from the fallback font). To add a
  fallback family, drop the TTFs into `public/fonts/` and extend
  `FALLBACK_FONT_FILES` in `src/pdf-emitter.ts`.
- **Small caps are synthesized**: lowercase is drawn as uppercase at 80% size,
  fitted to the measured width; real `smcp` glyph substitution isn't available
  through pdf-lib/@pdfme/pdf-lib.
- **Partial painting**: backgrounds/borders are painted in document order — a
  simplification of the CSS stacking model. Solid, dashed, dotted and double
  borders and solid background colors are drawn, with rounded corners on
  background fills; box-shadow, text-shadow, gradients, outlines, and
  groove/ridge/inset/outset borders are not.
- **SVGs are rasterized** (2× canvas), not kept vector.
- **Browser-inserted hyphenation** hyphens are not in the DOM, so a line broken
  at an auto-hyphen is drawn without the hyphen glyph.
- **Marker image sizing**: `list-style-image` markers are embedded at their
  natural size; if a browser scales them (e.g. `::marker` with a sized image)
  the PDF uses the intrinsic size instead.
- **No tagged PDF structure** (accessibility).

## Next steps

- `sup`/`sub` (and mixed-size runs) keep the per-run descent heuristic; a
  line-dominant shared baseline is intentionally not applied because it would
  regress sized runs (see FEATURES.md §9).
- Border-radius on bordered outlines (backgrounds are rounded already);
  groove/ridge/inset/outset border styles; box-shadow/text-shadow/outline.
- Math via MathLive/SVG (inline + display equations) instead of native MathML
  token copying.
- Per-codepoint glyph fallback (Latin/CJK inside a script font whose cut lacks
  them), WOFF2 embedding, `unicode-range`, `size-adjust`/descent-override
  descriptors, OpenType feature control.
- Keep SVGs vector (@pdfme/pdf-lib `page.drawSvg()` drops `<marker>` arrowheads
  and sizes `<text>` with fallback metrics today) and follow the CSS paint-order
  spec for overlapping content.
- Reuse the emitter for Fidus Writer's client-side PDF export.

## Licenses

- Code: LGPL-3.0 (see `LICENSE`). Note that the runtime dependencies
  carry their own licenses — vivliostyle is AGPL-3.0; @pdfme/pdf-lib is
  MIT (like the pdf-lib it forks); fontkit is MIT; pdfjs-dist (dev/test
  only) is Apache-2.0.
- Libertinus Serif + Libertinus Mono: SIL Open Font License 1.1
  (`public/fonts/OFL.txt`).
- Noto Sans Arabic + Noto Sans Hebrew (demo/test RTL coverage): SIL Open Font
  License 1.1 (also covered by `public/fonts/OFL.txt`; attribution in
  `public/fonts/NOTICE-Noto.txt`).
- DejaVu Sans (demo/test custom-font coverage): **Bitstream Vera / Arev Fonts
  license** (permissive, NOT OFL) — see `public/fonts/NOTICE-DejaVu.txt`.
