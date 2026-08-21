import {expect, test} from "@playwright/test"
import {readFile} from "node:fs/promises"
import * as zlib from "node:zlib"
import * as fontkit from "fontkit"
import {
    detectFontFormat,
    normalizeFontBytes,
    woffToSfnt
} from "../src/font-formats.js"

/** 32-bit big-endian checksum over 4-byte-padded data (OpenType table checksum). */
function checksum(data: Buffer): number {
    const padded = data.byteLength % 4
        ? Buffer.concat([data, Buffer.alloc(4 - (data.byteLength % 4))])
        : data
    let sum = 0
    for (let i = 0; i < padded.length; i += 4) {
        sum = (sum + padded.readUInt32BE(i)) >>> 0
    }
    return sum
}

/** Build a minimal-but-valid WOFF container from a TrueType file. */
function ttfToWoff(ttf: Buffer): Buffer {
    const numTables = ttf.readUInt16BE(4)
    const records: Array<{tag: string; offset: number; length: number}> = []
    for (let i = 0; i < numTables; i++) {
        const base = 12 + i * 16
        records.push({
            tag: ttf.toString("latin1", base, base + 4),
            offset: ttf.readUInt32BE(base + 8),
            length: ttf.readUInt32BE(base + 12)
        })
    }
    const directoryBase = 44
    let dataOffset = directoryBase + records.length * 20
    const entries: Array<{
        tag: string
        offset: number
        compLength: number
        origLength: number
        origChecksum: number
    }> = []
    const chunks: Buffer[] = []
    for (const record of records) {
        if (record.offset + record.length > ttf.length) {
            continue
        }
        const table = ttf.subarray(record.offset, record.offset + record.length)
        const compressed = zlib.deflateSync(table)
        const stored = compressed.length < table.length ? compressed : table
        entries.push({
            tag: record.tag,
            offset: dataOffset,
            compLength: stored.length,
            origLength: table.length,
            origChecksum: checksum(table)
        })
        chunks.push(stored)
        dataOffset += stored.length
    }
    const header = Buffer.alloc(directoryBase)
    header.write("wOFF", 0, "latin1")
    header.writeUInt32BE(0x00010000, 4) // flavor: TrueType
    header.writeUInt32BE(dataOffset, 8) // total file length
    header.writeUInt16BE(entries.length, 12)
    header.writeUInt16BE(0, 14) // reserved
    header.writeUInt32BE(0, 16) // totalSfntSize (ignored by readers)
    header.writeUInt16BE(1, 20) // majorVersion
    const dir = Buffer.alloc(entries.length * 20)
    entries.forEach((entry, i) => {
        const base = i * 20
        dir.write(entry.tag, base, "latin1")
        dir.writeUInt32BE(entry.offset, base + 4)
        dir.writeUInt32BE(entry.compLength, base + 8)
        dir.writeUInt32BE(entry.origLength, base + 12)
        dir.writeUInt32BE(entry.origChecksum, base + 16)
    })
    return Buffer.concat([header, dir, ...chunks])
}

test("detectFontFormat sniffs container magic", async () => {
    const ttf = await readFile("public/fonts/LibertinusSerif-Regular.ttf")
    expect(detectFontFormat(new Uint8Array(ttf))).toBe("ttf")
    const woff = ttfToWoff(ttf)
    expect(detectFontFormat(new Uint8Array(woff))).toBe("woff")
    expect(detectFontFormat(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBe(
        "woff2"
    )
    expect(detectFontFormat(new Uint8Array([1, 2, 3]))).toBe("unknown")
})

/** Table directory of an sfnt, as {tag, checksum, offset, length}. */
const directory = (b: Buffer): Array<Record<string, number | string>> =>
    Array.from({length: b.readUInt16BE(4)}, (_v, i) => {
        const base = 12 + i * 16
        return {
            tag: b.toString("latin1", base, base + 4),
            checksum: b.readUInt32BE(base + 4),
            offset: b.readUInt32BE(base + 8),
            length: b.readUInt32BE(base + 12)
        }
    })

test("woffToSfnt rebuilds a valid, metric-equivalent TrueType file", async () => {
    const ttf = await readFile("public/fonts/LibertinusSerif-Regular.ttf")
    const woff = ttfToWoff(ttf)
    const rebuilt = Buffer.from(await woffToSfnt(new Uint8Array(woff)))

    // The rebuild re-lays the tables out in sorted-tag order with its own
    // offsets — byte identity is not expected. Everything semantic must be:
    expect(rebuilt.length).toBe(ttf.length)
    expect(rebuilt.readUInt32BE(0)).toBe(ttf.readUInt32BE(0)) // sfnt version
    expect(rebuilt.readUInt16BE(6)).toBe(ttf.readUInt16BE(6)) // searchRange
    expect(rebuilt.readUInt16BE(8)).toBe(ttf.readUInt16BE(8)) // entrySelector
    expect(rebuilt.readUInt16BE(10)).toBe(ttf.readUInt16BE(10)) // rangeShift
    // Same tags in the same (sorted) order, with identical checksums/lengths.
    expect(
        directory(rebuilt).map(({tag, checksum, length}) => ({
            tag,
            checksum,
            length
        }))
    ).toEqual(
        directory(ttf).map(({tag, checksum, length}) => ({
            tag,
            checksum,
            length
        }))
    )
    // Valid whole-font checksum per the OpenType spec.
    expect(checksum(rebuilt)).toBe(0xb1b0afba)

    // fontkit can read it and metrics match the source font.
    interface FkFontLike {
        postscriptName?: string
        unitsPerEm?: number
        numGlyphs?: number
        ascent?: number
        descent?: number
        glyphForCodePoint?: (cp: number) => {advanceWidth?: number}
    }
    const orig = fontkit.create(ttf) as unknown as FkFontLike
    const again = fontkit.create(rebuilt) as unknown as FkFontLike
    expect(again.postscriptName).toBe(orig.postscriptName)
    expect(again.unitsPerEm).toBe(orig.unitsPerEm)
    expect(again.numGlyphs).toBe(orig.numGlyphs)
    expect(again.ascent).toBe(orig.ascent)
    expect(again.descent).toBe(orig.descent)
    expect(again.glyphForCodePoint?.(0x41).advanceWidth).toBe(
        orig.glyphForCodePoint?.(0x41).advanceWidth
    )
})

test("normalizeFontBytes embeds TTF directly and unwraps WOFF", async () => {
    const ttf = await readFile("public/fonts/LibertinusSerif-Italic.ttf")
    const direct = await normalizeFontBytes(new Uint8Array(ttf))
    expect(direct).toEqual({ok: true, bytes: new Uint8Array(ttf), format: "ttf"})

    const woff = ttfToWoff(ttf)
    const unwrapped = await normalizeFontBytes(new Uint8Array(woff))
    expect(unwrapped.ok).toBe(true)
    if (unwrapped.ok) {
        expect(checksum(Buffer.from(unwrapped.bytes))).toBe(0xb1b0afba)
        expect(Buffer.from(unwrapped.bytes).readUInt32BE(0)).toBe(0x00010000)
        expect(unwrapped.format).toBe("ttf")
    }

    const junk = await normalizeFontBytes(new Uint8Array([0xff, 0xfe]))
    expect(junk.ok).toBe(false)
})

test("normalizeFontBytes decodes a real WOFF2 font via fonteditor-core", async () => {
    const ttf = await readFile("public/fonts/LibertinusSerif-Regular.ttf")
    const {woff2} = await import("fonteditor-core")
    // Node: fonteditor-core resolves its own packaged woff2.wasm.
    await woff2.init()
    const woff2Bytes = woff2.encode(new Uint8Array(ttf) as unknown as number[])

    // The encode→decode round-trip produces a valid sfnt with matching metrics.
    const decoded = await normalizeFontBytes(new Uint8Array(woff2Bytes))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
        expect(checksum(Buffer.from(decoded.bytes))).toBe(0xb1b0afba)
        expect(Buffer.from(decoded.bytes).readUInt32BE(0)).toBe(0x00010000)
        expect(decoded.format).toBe("ttf")
    }

    // Garbage with only the wOF2 magic must degrade gracefully.
    const bad = await normalizeFontBytes(
        new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00])
    )
    expect(bad.ok).toBe(false)
})