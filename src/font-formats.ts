/**
 * Font format detection and normalization to embeddable sfnt (TrueType /
 * OpenType) bytes.
 *
 * pdf-lib embeds the raw bytes it is given verbatim
 * (`CustomFontEmbedder.serializeFont()` returns the input), so a PDF font
 * program must be a real sfnt binary. WOFF must therefore be unwrapped back
 * into an sfnt file; WOFF2 is not yet supported (fontkit can still decode it
 * for layout, so measured positions stay correct while the fallback font
 * covers the glyphs).
 */

export type FontFormat = "ttf" | "otf" | "woff" | "woff2" | "ttc" | "unknown"

/** Four-byte tag at the start of a font file. */
function tag(bytes: Uint8Array): string {
    if (bytes.byteLength < 4) {
        return ""
    }
    return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
}

/** Sniff the font container format from its magic bytes. */
export function detectFontFormat(bytes: Uint8Array): FontFormat {
    if (bytes.byteLength < 4) {
        return "unknown"
    }
    const t = tag(bytes)
    if (t === "wOFF") return "woff"
    if (t === "wOF2") return "woff2"
    if (t === "ttcf") return "ttc"
    if (t === "OTTO") return "otf"
    if (t === "true" || t === "typ1") return "ttf"
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (dv.getUint32(0) === 0x00010000) return "ttf"
    return "unknown"
}

/** The two container formats pdf-lib can embed verbatim. */
export type EmbeddableFontFormat = "ttf" | "otf"

/**
 * A layout-independent signature of an sfnt font's *content*: the version
 * plus, per table, its tag, length and checksum (offset hashing is excluded,
 * so a font re-laid-out in a different physical order — e.g. a WOFF unwrapped
 * back to sfnt — produces the same signature as the original).
 */
export function sfntTableSignature(bytes: Uint8Array): string {
    if (bytes.byteLength < 12) {
        return ""
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const numTables = dv.getUint16(4)
    const rows: string[] = [`v${dv.getUint32(0).toString(16)}`]
    for (let i = 0; i < numTables; i++) {
        const base = 12 + i * 16
        const tag = String.fromCharCode(
            bytes[base],
            bytes[base + 1],
            bytes[base + 2],
            bytes[base + 3]
        )
        rows.push(
            `${tag}:${dv.getUint32(base + 12)}:${dv
                .getUint32(base + 4)
                .toString(16)}`
        )
    }
    rows.sort()
    return rows.join(",")
}

export type NormalizeResult =
    | {ok: true; bytes: Uint8Array; format: EmbeddableFontFormat}
    | {ok: false; reason: string}

/**
 * Normalize arbitrary font bytes (data URI payload or fetched file) to
 * embeddable sfnt bytes. Returns an error object for formats we cannot embed
 * (WOFF2, TrueType collections, unknown binaries).
 */
export async function normalizeFontBytes(
    bytes: Uint8Array
): Promise<NormalizeResult> {
    switch (detectFontFormat(bytes)) {
        case "ttf":
            return {ok: true, bytes, format: "ttf"}
        case "otf":
            return {ok: true, bytes, format: "otf"}
        case "woff": {
            const sfnt = await woffToSfnt(bytes)
            return {
                ok: true,
                bytes: sfnt,
                format: detectFontFormat(sfnt) === "otf" ? "otf" : "ttf"
            }
        }
        case "woff2":
            return {ok: false, reason: "WOFF2 fonts are not supported yet"}
        case "ttc":
            return {
                ok: false,
                reason: "TrueType collections (.ttc) are not supported"
            }
        default:
            return {ok: false, reason: "Unrecognized font binary"}
    }
}

/** Inflate a zlib-wrapped stream (RFC 1950) using the native CompressionStream API. */
async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
    const fresh = new Uint8Array(data.byteLength)
    fresh.set(data)
    const stream = new Blob([fresh])
        .stream()
        .pipeThrough(new DecompressionStream("deflate"))
    const buffer = await new Response(stream).arrayBuffer()
    return new Uint8Array(buffer)
}

function padTo4Bytes(data: Uint8Array): Uint8Array {
    const remainder = data.byteLength % 4
    if (remainder === 0) {
        return data
    }
    const out = new Uint8Array(data.byteLength + (4 - remainder))
    out.set(data)
    return out
}

/** Sum of big-endian uint32 words (over 4-byte padded data), mod 2^32. */
function tableChecksum(data: Uint8Array): number {
    const padded = padTo4Bytes(data)
    const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength)
    let sum = 0
    for (let i = 0; i < padded.byteLength; i += 4) {
        sum = (sum + dv.getUint32(i)) >>> 0
    }
    return sum
}

/**
 * Unwrap a WOFF container into an sfnt (TrueType/OpenType) file.
 *
 * Follows https://www.w3.org/TR/WOFF/: the table directory points at each
 * table's data, which is zlib-compressed when `compLength < origLength`. The
 * sfnt header, search parameters, per-table checksums (with the `head`
 * checkSumAdjustment per the OpenType spec) and 4-byte padding are rebuilt.
 */
export async function woffToSfnt(woff: Uint8Array): Promise<Uint8Array> {
    const dv = new DataView(woff.buffer, woff.byteOffset, woff.byteLength)
    const flavor = dv.getUint32(4)
    const numTables = dv.getUint16(12)
    const entries: Array<{
        tag: string
        offset: number
        compLength: number
        origLength: number
    }> = []
    for (let i = 0; i < numTables; i++) {
        const base = 44 + i * 20
        entries.push({
            tag: String.fromCharCode(
                woff[base],
                woff[base + 1],
                woff[base + 2],
                woff[base + 3]
            ),
            offset: dv.getUint32(base + 4),
            compLength: dv.getUint32(base + 8),
            origLength: dv.getUint32(base + 12)
        })
    }
    const tables = await Promise.all(
        entries.map(async entry => {
            const raw = woff.subarray(
                entry.offset,
                entry.offset + entry.compLength
            )
            const data =
                entry.compLength < entry.origLength
                    ? await inflateZlib(raw)
                    : raw
            return {tag: entry.tag, data}
        })
    )
    return buildSfnt(flavor, tables)
}

interface SfntTable {
    tag: string
    data: Uint8Array
}

/** Rebuild an sfnt file (offset table + 16-byte table records + data). */
function buildSfnt(flavor: number, tables: SfntTable[]): Uint8Array {
    tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    const numTables = tables.length
    const entrySelector = Math.floor(Math.log2(numTables))
    const searchRange = 16 * 2 ** entrySelector
    const rangeShift = numTables * 16 - searchRange
    const headerSize = 12 + numTables * 16

    const paddedTables = tables.map(table => ({
        tag: table.tag,
        raw: table.data,
        data: padTo4Bytes(table.data)
    }))

    // Assign ascending offsets over 4-byte-aligned data. The table record's
    // length is the *unpadded* byte length (per the TrueType spec).
    let dataOffset = headerSize
    const records = paddedTables.map(table => {
        const record = {tag: table.tag, offset: dataOffset, length: table.raw.byteLength}
        dataOffset += table.data.byteLength
        return record
    })

    const sfnt = new Uint8Array(dataOffset)
    const outDv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength)

    // Offset table.
    outDv.setUint32(0, flavor)
    outDv.setUint16(4, numTables)
    outDv.setUint16(6, searchRange)
    outDv.setUint16(8, entrySelector)
    outDv.setUint16(10, rangeShift)

    // Table directory, sorted by tag (required for TrueType), with each
    // table's checksum. The `head` table checksum is computed with its
    // checkSumAdjustment field (bytes 8..12) zeroed, per the OpenType spec.
    paddedTables.forEach((table, index) => {
        const pos = 12 + index * 16
        for (let byte = 0; byte < 4; byte++) {
            sfnt[pos + byte] = table.tag.charCodeAt(byte)
        }
        let checkable = table.data
        if (table.tag === "head") {
            const copy = new Uint8Array(table.data)
            new DataView(copy.buffer, copy.byteOffset).setUint32(8, 0)
            checkable = copy
        }
        outDv.setUint32(pos + 4, tableChecksum(checkable))
        outDv.setUint32(pos + 8, records[index].offset)
        outDv.setUint32(pos + 12, records[index].length)
    })

    // Table data (byte offset 8 of `head` is still zero here).
    paddedTables.forEach((table, index) => {
        sfnt.set(table.data, records[index].offset)
    })

    // Whole-font checkSumAdjustment: per spec this field makes the sum of
    // all 32-bit big-endian words in the file equal 0xB1B0AFBA, and the
    // field itself is treated as zero while computing the sum.
    // Whole-font checkSumAdjustment: per spec this field makes the sum of
    // all 32-bit big-endian words in the file equal 0xB1B0AFBA, and the
    // field itself is treated as zero while computing the sum. The source
    // font's own adjustment value (still present in the copied `head` data)
    // must be zeroed first.
    const headIndex = tables.findIndex(table => table.tag === "head")
    if (headIndex >= 0) {
        const headFieldOffset = records[headIndex].offset + 8
        outDv.setUint32(headFieldOffset, 0)
        const sum = tableChecksum(sfnt)
        outDv.setUint32(headFieldOffset, (0xb1b0afba - sum) >>> 0)
    }

    return sfnt
}