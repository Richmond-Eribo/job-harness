import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Unit tests for the Resend OTP email wrapper (src/auth/resend.ts).
 *
 * These test the sendOtpEmail function in isolation — no real network calls,
 * no Worker runtime. The Resend SDK uses global fetch internally, so we mock
 * fetch to assert:
 *   1. Missing RESEND_API_KEY or MAIL_FROM → throws loudly (NO dev fallback).
 *   2. Both set → calls Resend with the OTP code in the payload.
 *   3. Resend API error → throws with a descriptive message.
 *
 * The old sendMagicLinkEmail had a console-log dev mode; sendOtpEmail does NOT
 * — by design, missing config must surface immediately.
 */

// Mock global fetch so Resend's SDK calls don't hit the network.
const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)

// Import AFTER the fetch mock is in place.
const { sendOtpEmail } = await import("../auth/resend")

describe("sendOtpEmail — missing config throws (no dev fallback)", () => {
  beforeEach(() => fetchMock.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it("throws when RESEND_API_KEY is missing", async () => {
    await expect(
      sendOtpEmail(
        { to: "user@test.com", otp: "123456" },
        { apiKey: undefined, from: "agent@test.com" },
      ),
    ).rejects.toThrow(/RESEND_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("throws when MAIL_FROM is missing", async () => {
    await expect(
      sendOtpEmail(
        { to: "user@test.com", otp: "123456" },
        { apiKey: "re_test_key", from: undefined },
      ),
    ).rejects.toThrow(/MAIL_FROM/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("names both values when both are missing", async () => {
    await expect(
      sendOtpEmail(
        { to: "user@test.com", otp: "123456" },
        { apiKey: undefined, from: undefined },
      ),
    ).rejects.toThrow(/RESEND_API_KEY.*MAIL_FROM|MAIL_FROM.*RESEND_API_KEY/)
  })

  it("never logs the code to the console (no dev-mode leak)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await expect(
      sendOtpEmail(
        { to: "user@test.com", otp: "123456" },
        { apiKey: undefined, from: undefined },
      ),
    ).rejects.toThrow()
    expect(logSpy).not.toHaveBeenCalled()
  })
})

describe("sendOtpEmail — production mode (sends the code)", () => {
  beforeEach(() => fetchMock.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it("calls Resend with the OTP in the payload", async () => {
    // Resend's SDK POSTs to its API and expects { id } on success.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    )
    await sendOtpEmail(
      { to: "user@test.com", otp: "482910" },
      { apiKey: "re_test_key", from: "agent@test.com" },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Verify the payload sent to Resend includes the OTP code — in the BODY
    // only. P3-6/M20 deliberately moved the code out of the subject line:
    // subjects are indexed by some clients and shown in lock-screen
    // notification previews, so they're a higher-leakage channel.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.to).toBe("user@test.com")
    expect(body.from).toBe("agent@test.com")
    expect(body.html).toContain("482910")
    expect(body.text).toContain("482910")
    expect(body.subject).not.toContain("482910")
    expect(body.subject).toContain("verification code")
  })

  it("throws a descriptive error when Resend returns an error", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ message: "The sender address is not verified" }),
        { status: 422 },
      ),
    )
    await expect(
      sendOtpEmail(
        { to: "user@test.com", otp: "482910" },
        { apiKey: "re_key", from: "unverified@test.com" },
      ),
    ).rejects.toThrow(/Resend send failed/)
  })
})
