import { describe, expect, it } from "vitest"
import { redact, registerSecret } from "../src/log.js"
import { fail } from "../src/errors.js"

describe("redact", () => {
  it("removes registered secrets", () => {
    registerSecret("super-secret-password")
    expect(redact("token=super-secret-password")).toBe("token=«redacted»")
  })

  it("masks authorization headers", () => {
    expect(redact('authorization: "Basic abc123"')).not.toContain("abc123")
  })

  it("masks basic auth blobs even when unregistered", () => {
    const out = redact("Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==")
    expect(out).not.toContain("QWxhZGRpbjpvcGVuIHNlc2FtZQ==")
  })

  it("masks password fields in JSON", () => {
    const out = redact('{"password":"hunter2"}')
    expect(out).not.toContain("hunter2")
  })
})

describe("fail()", () => {
  it("returns an isError result with the code", () => {
    const result = fail(new Error("boom"))
    expect(result.isError).toBe(true)
    const text = result.content?.[0]?.text ?? ""
    expect(text).toContain("OPENCODE_ERROR")
    expect(text).toContain("boom")
  })
})
