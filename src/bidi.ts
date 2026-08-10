/**
 * Minimal Unicode-direction run splitter.
 *
 * pdf-lib's drawText lays a whole string out with a single auto-detected
 * text direction (via fontkit), so a mixed-bidi string — e.g. an Arabic word
 * containing Latin letters or digits — would be shaped with one wrong
 * direction. The emitter therefore splits every "word" token into
 * direction-homogeneous runs and measures/draws each run at its own rect
 * (the browser has already run the full Unicode Bidi Algorithm, so per-run
 * rects are exact).
 *
 * This is a deliberately small approximation of the UBA: strong RTL / strong
 * LTR / digits are classified, neutral characters (spaces, punctuation)
 * inherit the direction of the preceding character, and leading neutrals
 * take the paragraph direction. It does not implement explicit formatting
 * characters or the embedding algorithm.
 */

export interface BidiRun {
    text: string
    /** Offset of the run within the original string. */
    start: number
    /** True when the run should be laid out right-to-left. */
    rtl: boolean
}

const RTL_STRONG =
    /[\u0590-\u08ff\u{fb1d}-\u{fdfd}\u{fe70}-\u{fefc}\u{1e800}-\u{1e8cf}]/u
const LTR_STRONG = /[A-Za-z\u00c0-\u02af\u0370-\u052f\u2c00-\u2fef0-9]/

/**
 * Split `text` into maximal runs whose characters share one direction.
 * Every character of the input is assigned to exactly one run (the runs
 * partition the string, so `slice(run.start, run.end)` is never empty and
 * offsets can be fed directly to Range.setStart/setEnd).
 *
 * @param baseRtl  paragraph direction (e.g. `direction: rtl`); true → RTL.
 */
export function splitBidiRuns(text: string, baseRtl = false): BidiRun[] {
    if (text.length === 0) {
        return []
    }

    const carry: boolean[] = new Array(text.length)
    let current = baseRtl
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (RTL_STRONG.test(ch)) {
            current = true
        } else if (LTR_STRONG.test(ch)) {
            current = false
        }
        carry[i] = current
    }

    const runs: BidiRun[] = []
    let start = 0
    let runRtl = carry[0]
    for (let i = 1; i < text.length; i++) {
        if (carry[i] !== runRtl) {
            runs.push({text: text.slice(start, i), start, rtl: runRtl})
            start = i
            runRtl = carry[i]
        }
    }
    runs.push({text: text.slice(start), start, rtl: current})
    return runs
}