import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Unit tests for the Resend email wrapper (src/auth/resend.ts).
 *
 * These test the sendMagicLinkEmail function in isolation — no real network
 * calls, no Worker runtime. The Resend SDK uses global fetch internally, so we
 * mock fetch to assert:
 *   1. Dev mode (missing key OR missing from) → logs the link, never calls fetch.
 *   2. Prod mode (both set) → calls fetch with the right payload.
 *   3. Resend API error → throws with a descriptive message.
 *   4. The diagnostic message names the SPECIFIC missing value.
 */

// Mock global fetch so Resend's SDK calls don't hit the network.
const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)

// Import AFTER the fetch mock is in place.
const { sendMagicLinkEmail } = await import("../auth/resend")

describe("sendMagicLinkEmail — dev mode (no send)", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it("does not send when RESEND_API_KEY is missing", async () => {
    const result = await sendMagicLinkEmail(
      { to: "user@test.com", url: "https://app/sign-in?token=abc", token: "abc" },
      { apiKey: undefined, from: "agent@test.com" },
    )
    expect(result.sent).toBe(false)
    expect(result.devUrl).toBe("https://app/sign-in?token=abc")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not send when MAIL_FROM is missing", async () => {
    const result = await sendMagicLinkEmail(
      { to: "user@test.com", url: "https://app/sign-in?token=abc", token: "abc" },
      { apiKey: "re_test_key", from: undefined },
    )
    expect(result.sent).toBe(false)
    expect(result.devUrl).toBe("https://app/sign-in?token=abc")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("logs which specific value is missing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await sendMagicLinkEmail(
      { to: "user@test.com", url: "https://app/x", token: "abc" },
      { apiKey: "re_key", from: undefined },
    )
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("MAIL_FROM"),
    )
  })

  it("logs both values when both are missing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await sendMagicLinkEmail(
      { to: "user@test.com", url: "https://app/x", token: "abc" },
      { apiKey: undefined, from: undefined },
    )
    const msg = logSpy.mock.calls[0][0] as string
    expect(msg).toContain("RESEND_API_KEY")
    expect(msg).toContain("MAIL_FROM")
  })
})

describe("sendMagicLinkEmail — production mode (sends)", () => {
  beforeEach(() => fetchMock.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it("calls Resend and returns sent=true on success", async () => {
    // Resend's SDK POSTs to its API and expects { id } on success.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    )
    const result = await sendMagicLinkEmail(
      { to: "user@test.com", url: "https://app/sign-in?token=xyz", token: "xyz" },
      { apiKey: "re_test_key", from: "agent@test.com" },
    )
    expect(result.sent).toBe(true)
    expect(result.devUrl).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Verify the payload sent to Resend includes the magic-link URL.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.to).toBe("user@test.com")
    expect(body.from).toBe("agent@test.com")
    expect(body.html).toContain("https://app/sign-in?token=xyz")
  })

  it("throws a descriptive error when Resend returns an error", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ message: "The sender address is not verified" }),
        { status: 422 },
      ),
    )
    await expect(
      sendMagicLinkEmail(
        { to: "user@test.com", url: "https://app/x", token: "x" },
        { apiKey: "re_key", from: "unverified@test.com" },
      ),
    ).rejects.toThrow(/Resend send failed/)
  })
})
