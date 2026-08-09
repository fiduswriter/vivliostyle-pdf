/**
 * Generates public/images/figure-2.png without any dependencies:
 * a 600x400 RGB "experimental results" style chart (gradient background,
 * axis lines and data bars), hand-encoded as a minimal PNG using zlib.
 */
import { deflateSync } from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const WIDTH = 600
const HEIGHT = 400

const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../public/images/figure-2.png"
)

// --- CRC32 (PNG requirement) ---------------------------------------------
const crcTable = new Int32Array(256)
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    crcTable[n] = c
}
function crc32(buf) {
    let c = -1
    for (const byte of buf) {
        c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    }
    return (c ^ -1) >>> 0
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii")
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(data.length)
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

// --- Pixel data -----------------------------------------------------------
// Scanlines: filter byte 0 followed by RGB triplets.
const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3))
const bars = [0.35, 0.62, 0.5, 0.81, 0.72, 0.93, 0.58, 0.44]
const margin = 50
const plotW = WIDTH - margin * 2
const plotH = HEIGHT - margin * 2

for (let y = 0; y < HEIGHT; y++) {
    const rowStart = y * (1 + WIDTH * 3)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < WIDTH; x++) {
        const o = rowStart + 1 + x * 3
        // soft vertical gradient background
        let r = 255 - Math.round((y / HEIGHT) * 30)
        let g = 255 - Math.round((y / HEIGHT) * 20)
        let b = 255

        const inPlot =
            x >= margin && x < WIDTH - margin && y >= margin && y < HEIGHT - margin
        if (inPlot) {
            r = 250
            g = 250
            b = 248
            // horizontal grid lines every quarter
            const relY = y - margin
            if (relY % Math.round(plotH / 4) === 0) {
                r = 210
                g = 210
                b = 210
            }
            // data bars
            const barW = plotW / bars.length
            const idx = Math.floor((x - margin) / barW)
            const inner = (x - margin) % barW
            if (inner > barW * 0.2 && inner < barW * 0.8) {
                const barTop = margin + plotH * (1 - bars[idx])
                if (y >= barTop) {
                    r = 36
                    g = 86
                    b = 166
                }
            }
        }
        // axes
        if (
            (x === margin && y >= margin && y < HEIGHT - margin) ||
            (y === HEIGHT - margin && x >= margin && x < WIDTH - margin)
        ) {
            r = 40
            g = 40
            b = 40
        }
        raw[o] = r
        raw[o + 1] = g
        raw[o + 2] = b
    }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(WIDTH, 0)
ihdr.writeUInt32BE(HEIGHT, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: truecolor RGB
// compression, filter, interlace all 0

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
])

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, png)
console.log(`wrote ${outPath} (${png.length} bytes)`)
