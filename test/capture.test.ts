import { describe, expect, it } from "vitest"
import { countWords, joinFragments, looksLikeAck, mergeTranscription } from "../src/capture"

describe("joinFragments", () => {
  it("spaces latin words and jams CJK together", () => {
    expect(joinFragments("hello", "world")).toBe("hello world")
    expect(joinFragments("こんにちは", "世界")).toBe("こんにちは世界")
    expect(joinFragments("", "first")).toBe("first")
    expect(joinFragments("only", "  ")).toBe("only")
  })
})

describe("countWords", () => {
  it("counts latin words and CJK characters", () => {
    expect(countWords("")).toBe(0)
    expect(countWords("one two three")).toBe(3)
    expect(countWords("こんにちは")).toBe(5)
    expect(countWords("ok ありがとう")).toBe(1 + 5)
  })
})

describe("mergeTranscription", () => {
  it("takes the fresh segment when either side is empty", () => {
    expect(mergeTranscription("kept", "")).toBe("kept")
    expect(mergeTranscription("", "fresh")).toBe("fresh")
  })

  it("extends a clip whose overlap matches word for word", () => {
    const existing = "the quick brown fox jumps"
    const incoming = "the quick brown fox jumps over the lazy dog"
    expect(mergeTranscription(existing, incoming)).toBe(incoming)
  })

  it("does not double a tail re-heard inside the tail budget", () => {
    const existing = "alpha beta gamma delta"
    // The new clip heard the whole sentence again; the tail is kept, not doubled.
    const merged = mergeTranscription(existing, "alpha beta gamma delta epsilon zeta eta theta")
    expect(merged).toBe("alpha beta gamma delta epsilon zeta eta theta")
    const repeat = mergeTranscription("alpha beta gamma delta", "alpha beta gamma delta")
    expect(repeat).toBe("alpha beta gamma delta")
  })

  it("accepts a better reading of the shared tail", () => {
    // Whisper often re-hears the last words with different particles.
    const merged = mergeTranscription("turn left at the corner", "turn left at the corner then stop")
    expect(merged).toBe("turn left at the corner then stop")
  })

  it("replaces wholesale when there is no shared prefix", () => {
    expect(mergeTranscription("hello there friend", "completely different start")).toBe(
      "completely different start",
    )
  })

  it("keeps the older text when the fresh clip adds nothing", () => {
    expect(mergeTranscription("one two three", "one two three")).toBe("one two three")
  })
})

describe("looksLikeAck", () => {
  it("accepts short go-aheads in both languages", () => {
    for (const value of ["Yes.", "ok", "OK!", "yeah", "go ahead", "thanks", "いいよ", "了解", "お願い", "進めて"]) {
      expect(looksLikeAck(value)).toBe(true)
    }
  })

  it("rejects anything longer or unrelated", () => {
    for (const value of ["", "maybe later", "I would like you to refactor the whole module first"]) {
      expect(looksLikeAck(value)).toBe(false)
    }
  })
})
