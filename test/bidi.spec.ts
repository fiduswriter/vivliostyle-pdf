import {expect, test} from "@playwright/test"
import {splitBidiRuns} from "../src/bidi.js"

const named = (text: string, rtl: boolean) =>
    splitBidiRuns(text, rtl).map(run => ({text: run.text, rtl: run.rtl}))

test("partitions every character and exposes exact offsets", () => {
    const runs = splitBidiRuns("مرحبا123", true)
    expect(runs.length).toBe(2)
    expect(runs[0].rtl).toBe(true)
    expect(runs[1].rtl).toBe(false)
    // Runs partition the input exactly.
    const reassembled = runs.map(run => run.text).join("")
    expect(reassembled).toBe("مرحبا123")
    expect(runs[0].start).toBe(0)
    expect(runs[1].start).toBe(5)
})

test("Arabic plus Western digits yields one RTL run and one LTR digit run", () => {
    expect(named("عدد123", true)).toEqual([
        {text: "عدد", rtl: true},
        {text: "123", rtl: false}
    ])
})

test("Latin text stays LTR even inside an RTL paragraph", () => {
    expect(named("abc", true)).toEqual([{text: "abc", rtl: false}])
    expect(named("123", true)).toEqual([{text: "123", rtl: false}])
})

test("LTR base keeps mixed Hebrew after Latin as one LTR then one RTL run", () => {
    expect(named("helloעולם", false)).toEqual([
        {text: "hello", rtl: false},
        {text: "עולם", rtl: true}
    ])
})

test("leading neutral takes the base direction; spaces stay attached", () => {
    // A leading neutral in an RTL base attaches to the following RTL text.
    expect(named(" –مرحبا", true)[0]).toEqual({text: " –مرحبا", rtl: true})
    // Space-separated whole sentence (not tokenized): words each split.
    const runs = named("مرحبا بالعالم", true)
    expect(runs.map(r => r.rtl).every(Boolean)).toBe(true)
    expect(runs.map(r => r.text).join("")).toBe("مرحبا بالعالم")
})

test("empty input yields no runs", () => {
    expect(splitBidiRuns("", true)).toEqual([])
})