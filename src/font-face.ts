/**
 * `@font-face` discovery and CSS font matching.
 *
 * Mirrors how Fidus Writer delivers document-style fonts: the print exporter
 * inlines the style CSS (with asset filenames rewritten to absolute URLs) and
 * the browser loads each font via `@font-face { src: url(...) }`. So the fonts
 * a PDF needs are exactly the `@font-face` rules present in the paginated
 * document. This module enumerates those rules (from a document's stylesheets)
 * and selects the best rule for a text run using CSS font matching (family,
 * style, weight bands).
 */

export interface FontFaceSrc {
    url: string
    /** The `format(...)` hint, lowercased, or null when absent. */
    format: string | null
}

export interface FontFaceDescriptor {
    /** As written in `font-family` (quotes stripped). */
    family: string
    /** Inclusive weight band from the `font-weight` descriptor. */
    weightLower: number
    weightUpper: number
    /** `normal` | `italic` | `oblique[ <angle>]`. */
    style: string
    /** Ordered `src` candidates (later entries are lower priority). */
    srcs: FontFaceSrc[]
}

/**
 * Split a computed `font-family` value into its family tokens, stripping
 * quotes and vivliostyle's generated `Fnt_<n>` aliases (the original family
 * names always survive after them).
 */
export function parseFontFamilyList(fontFamily: string): string[] {
    return fontFamily
        .split(",")
        .map(family => family.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
        .filter(family => !/^fnt_\d+$/i.test(family))
}

/** Parse a `font-weight` descriptor value into an inclusive band. */
export function parseWeightRange(
    weight: string
): {lower: number; upper: number} {
    const trimmed = (weight || "").trim().toLowerCase()
    if (!trimmed || trimmed === "normal" || trimmed === "400") {
        return {lower: 400, upper: 400}
    }
    if (trimmed === "bold" || trimmed === "700") {
        return {lower: 700, upper: 700}
    }
    const parts = trimmed.split(/\s+/).map(Number)
    if (parts.length === 2 && parts.every(Number.isFinite)) {
        return {lower: Math.min(...parts), upper: Math.max(...parts)}
    }
    const single = Number(trimmed)
    if (Number.isFinite(single)) {
        return {lower: single, upper: single}
    }
    return {lower: 400, upper: 400}
}

/**
 * Extract `url(...)` (with optional `format(...)`) tokens from a `src`
 * descriptor string, in declaration order.
 */
export function parseSrc(src: string): FontFaceSrc[] {
    const out: FontFaceSrc[] = []
    const re =
        /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)\s*(?:format\(\s*(?:["']?)([^"')]*)(?:["']?)\s*\))?/g
    let match: RegExpExecArray | null
    while ((match = re.exec(src)) !== null) {
        const url = match[1] ?? match[2] ?? match[3]
        if (url) {
            out.push({
                url: url.trim(),
                format: match[4] ? match[4].trim().toLowerCase() : null
            })
        }
    }
    return out
}

/** Resolve a possibly-relative src URL against a base (absolute URLs pass through). */
export function resolveSrcUrl(url: string, base: string): string {
    try {
        return new URL(url, base).href
    } catch {
        return url
    }
}

/** Extract the descriptor from a CSSFontFaceRule, with src URLs resolved. */
export function parseFontFaceRule(
    rule: CSSFontFaceRule,
    baseUrl: string
): FontFaceDescriptor | null {
    const style = rule.style
    const family = (style.getPropertyValue("font-family") || "")
        .trim()
        .replace(/^["']|["']$/g, "")
    if (!family) {
        return null
    }
    const weight = parseWeightRange(style.getPropertyValue("font-weight"))
    const fontStyle =
        (style.getPropertyValue("font-style") || "").trim() || "normal"
    const srcs = parseSrc(style.getPropertyValue("src") || "")
        .map(src => ({url: resolveSrcUrl(src.url, baseUrl), format: src.format}))
        .filter(src => src.url.length > 0)
    if (!srcs.length) {
        return null
    }
    return {
        family,
        weightLower: weight.lower,
        weightUpper: weight.upper,
        style: fontStyle,
        srcs
    }
}

/**
 * Collect every `@font-face` rule reachable from a document's stylesheets
 * (recursing through `@import` and grouping rules like `@media`). Cross-origin
 * sheets can throw on `cssRules` access; those are skipped so a locked-down
 * remote stylesheet cannot break export.
 */
export function collectFontFaceRules(
    doc: Document,
    baseUrl: string
): FontFaceDescriptor[] {
    const rules: FontFaceDescriptor[] = []
    const seen = new Set<string>()

    const pushRule = (rule: FontFaceDescriptor): void => {
        const sig = `${rule.family}\u0000${rule.weightLower}\u0000${rule.weightUpper}\u0000${rule.style}\u0000${rule.srcs
            .map(src => src.url)
            .join(",")}`
        if (!seen.has(sig)) {
            seen.add(sig)
            rules.push(rule)
        }
    }

    const walk = (ruleList: CSSRuleList | null): void => {
        if (!ruleList) {
            return
        }
        for (const rule of Array.from(ruleList)) {
            if (rule instanceof CSSFontFaceRule) {
                const face = parseFontFaceRule(rule, baseUrl)
                if (face) {
                    pushRule(face)
                }
            } else if (
                rule instanceof CSSImportRule &&
                rule.styleSheet?.cssRules
            ) {
                walk(rule.styleSheet.cssRules)
            } else if (rule instanceof CSSGroupingRule) {
                // @media, @supports, @layer, … — fonts declared inside still
                // apply.
                walk(rule.cssRules)
            }
        }
    }

    for (const sheet of Array.from(doc.styleSheets)) {
        try {
            walk(sheet.cssRules)
        } catch {
            // Cross-origin stylesheet: cannot inspect; skip silently.
        }
    }
    return rules
}

const normalizeFamily = (family: string): string =>
    family.trim().toLowerCase().replace(/^["']|["']$/g, "")

/**
 * CSS font matching (simplified CSS Fonts Level 4 for weight/style) over the
 * given rules:
 *
 * - family names are tried in the computed `font-family` order; a family with
 *   no rule (or no style that can satisfy the request) is skipped;
 * - style is matched exactly first (italic/oblique/normal), with the
 *   spec-adjacent fallbacks;
 * - within the style-matched rules of a family, the weight band closest to
 *   the requested weight wins (exact in-band beats every distance; a tie
 *   prefers the heavier band).
 *
 * Returns the best `@font-face` descriptor, or null when nothing matches.
 */
export function selectFontFace(
    rules: FontFaceDescriptor[],
    familyList: string[],
    requestedWeight: number,
    requestedStyle: string
): FontFaceDescriptor | null {
    const weight = Number.isFinite(requestedWeight) ? requestedWeight : 400
    const isItalic = requestedStyle === "italic"
    const isOblique = requestedStyle === "oblique"

    // Lower rank = better for the requested style.
    const styleRank = (face: FontFaceDescriptor): number => {
        const s = face.style.trim().toLowerCase()
        if (s === "italic") {
            return isItalic ? 0 : isOblique ? 1 : 4
        }
        if (s.startsWith("oblique")) {
            const angleMatch = s.match(/([\d.]+)/)
            const angle = angleMatch ? Number(angleMatch[1]) : 0
            if (isOblique) {
                return angle === 0 ? 0 : 1
            }
            if (isItalic) {
                return 3
            }
            return angle === 0 ? 1 : 2
        }
        // normal
        if (!isItalic && !isOblique) {
            return 0
        }
        return 4
    }

    const weightDistance = (face: FontFaceDescriptor): number => {
        if (weight >= face.weightLower && weight <= face.weightUpper) {
            return 0
        }
        if (weight < face.weightLower) {
            return face.weightLower - weight
        }
        return weight - face.weightUpper
    }

    for (const family of familyList) {
        const familyName = normalizeFamily(family)
        if (!familyName || familyName === "serif" || familyName === "sans-serif" || familyName === "monospace" || familyName === "cursive" || familyName === "fantasy" || familyName === "system-ui") {
            // Generic families are never @font-face families (they were the
            // fallback triggers in the browser); handled by the caller.
            continue
        }
        const candidates = rules.filter(
            face => normalizeFamily(face.family) === familyName
        )
        if (!candidates.length) {
            continue
        }
        candidates.sort((a, b) => styleRank(a) - styleRank(b))
        const bestRank = styleRank(candidates[0])
        if (bestRank === 4) {
            continue // No rule in this family can render the requested style.
        }
        const styleMatched = candidates.filter(face => styleRank(face) === bestRank)
        let chosen = styleMatched[0]
        let chosenDistance = weightDistance(chosen)
        for (const face of styleMatched.slice(1)) {
            const distance = weightDistance(face)
            if (
                distance < chosenDistance ||
                (distance === chosenDistance &&
                    face.weightLower > chosen.weightLower)
            ) {
                chosen = face
                chosenDistance = distance
            }
        }
        return chosen
    }
    return null
}