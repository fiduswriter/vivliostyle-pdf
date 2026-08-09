# vivliostyle-pdf

**Live demo:** <https://johanneswilm.github.io/vivliostyle-pdf/> — click
"Generate PDF"; everything happens client-side, no print dialog.

Technical prototype: **browser-only PDF export without the print dialog.**

[vivliostyle](https://vivliostyle.org/) paginates an HTML/CSS Paged Media
document inside a hidden iframe. A custom DOM→PDF emitter then walks the
paginated output and re-renders it as a real vector PDF with
[pdf-lib](https://pdf-lib.js.org/). No server, no print dialog.

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
  • embeds Libertinus Serif (Regular/Bold/Italic/BoldItalic) and
    Libertinus Mono (subsetted) via pdf-lib + @pdf-lib/fontkit; monospace
    is detected from the computed font-family (vivliostyle rewrites
    families to e.g. `Fnt_2, "Libertinus Mono", monospace`, but the
    original names survive)
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
src/demo-document.html      rich test document (paged CSS, TOC, footnotes,
                            cross references, external links, 3 tables,
                            3 figures, bibliography)
src/vivliostyle-print.d.ts  types for the untyped @vivliostyle/print
public/fonts/               Libertinus Serif + Libertinus Mono TTFs (OFL)
public/images/              figure SVGs + generated PNG
scripts/gen-assets.mjs      dependency-free PNG generator (node zlib)
scripts/debug-run.mjs       dev helper: run generation, log console, save PDF
test/e2e.spec.ts            Playwright end-to-end test
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
- **external hyperlinks** (vivliostyle.org, pdf-lib.js.org), styled as
  links. In the generated PDF they appear as styled (blue) text but are
  **not clickable** — see Limitations,
- three tables (simple, styled with header background/borders, and one
  spanning a page break) and three figures (two SVG, one PNG),
- inline styles: bold, italic, bold-italic, strikethrough
  (`text-decoration: line-through`, drawn as a vector line by the
  emitter), small caps (synthesized by the emitter), and monospace code
  spans plus a `<pre>` block set in Libertinus Mono,
- headings with CSS-counter numbering, nested lists, a blockquote, inline
  code and a dark `<pre>` block, and a bibliography.

The e2e test (`test/e2e.spec.ts`) verifies these features in the generated
PDF by extracting per-page text with `pdfjs-dist` (pdf-lib cannot extract
text): it checks the running header and page-number footer on every page,
resolved TOC page numbers, cross-reference numbers against the actual pages
of their targets, footnote bodies on the same page as their calls, link
text presence, and that the PDF contains zero annotations.

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
page count > 5 (parsed with pdf-lib), and no console errors.

## Deployment (GitHub Pages)

`.github/workflows/pages.yml` builds and deploys `dist/` to GitHub Pages on
every push to `main`. The vite `base` is `/vivliostyle-pdf/`, so asset URLs
work both on Pages and locally. Requires the repo's Pages source to be set
to "GitHub Actions".

## Limitations (prototype)

- **Approximate baselines**: text is placed at
  `rect.bottom − descent(fontSize)` with fontkit metrics, which can be off
  by a fraction of a point versus the browser's true line boxes.
- **Two font families**: text maps to Libertinus Serif (Regular/Bold/
  Italic/BoldItalic) or, for computed font-families matching `/mono/i`
  (generic `monospace` or a family containing "mono"), to Libertinus Mono
  Regular (bold/italic code falls back to regular mono, which is normal
  for code). Adding another family means: drop the TTFs into
  `public/fonts/`, add entries to `FONT_FILES` in `src/pdf-emitter.ts`,
  and extend the mapping in `pickVariant`.
- **Links are not clickable in the output PDF** (pdf-lib has no annotation
  support). Hyperlinks and cross references render as styled text only —
  cross-reference page numbers *are* resolved correctly, but nothing is
  clickable. There is a `TODO(links)` in `src/pdf-emitter.ts`, and the e2e
  test asserts the output contains zero annotations.
- **Underlines are not painted**: `text-decoration: underline` is dropped
  (line-through IS drawn), so links appear as colored but non-underlined
  text.
- **Small caps are synthesized**: lowercase letters are drawn as uppercase
  glyphs at 80% size, fitted to the measured word width. Real `smcp`
  glyph substitution is not available through pdf-lib.
- **Partial painting**: backgrounds and borders are drawn in document
  order — a simplification of the CSS stacking model. Only solid borders
  and solid background colors are painted; no border-radius, shadows,
  gradients, or outlines.
- **SVGs are rasterized** (2x canvas), not kept vector.
- **List markers are synthesized** approximations (decimal/disc/circle,
  right-aligned left of the item box), since vivliostyle's internal
  `::marker` rendering leaves no DOM text.
- Words that wrap across lines (e.g. at hyphens) are re-grouped per line
  fragment by character measurement; browser-inserted hyphenation hyphens
  would not be reproduced.
- `text-transform: capitalize` is not reproduced.
- No PDF metadata, outlines/bookmarks, or tagged PDF structure.

## Next steps

- Calibrate baselines per line (per-character range pass) instead of the
  descent heuristic.
- Generalize the font registry (font-family/weight/style mapping table,
  OpenType feature support for real small caps via shaping).
- Link annotations via PDF object post-processing (or a PDF writer with
  annotation support), plus document metadata and bookmarks.
- Keep SVGs vector (path extraction or embedding via PDF XObjects).
- Follow the CSS paint-order spec for overlapping content.
- Reuse the emitter for Fidus Writer's client-side PDF export.

## Licenses

- Code: LGPL-3.0 (see `LICENSE`). Note that the runtime dependencies
  carry their own licenses — vivliostyle is AGPL-3.0.
- Libertinus Serif: SIL Open Font License 1.1 (`public/fonts/OFL.txt`).
