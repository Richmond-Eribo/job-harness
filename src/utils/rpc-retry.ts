// =============================================================================
// RPC retry helper — used by sub-agent delegation tools.
// =============================================================================
// Why: a transient failure during `discover_jobs` / `research` currently kills
// that tool call permanently for the run (DO eviction, brief network blip).
// The fix from the gap analysis (P1 #4): at least 1 retry with backoff for
// ResearchAgent / JobApplicationAgent delegation.
//
// Kept tiny and dependency-free so it's easy to audit. Not a general-purpose
// retry library — it exists to wrap one specific shape: a thunk that returns
// a Promise<T> and may throw on transient RPC errors.
// =============================================================================

const DEFAULT_MAX_ATTEMPTS = 2 // 1 initial + 1 retry
const DEFAULT_BASE_DELAY_MS = 400

/**
 * Run `fn` up to `maxAttempts` times, sleeping with exponential backoff
 * between attempts. Re-throws the LAST error if every attempt fails.
 *
 * @param fn         The async operation to retry (typically a DO RPC call).
 * @param maxAttempts Total attempts including the first. Default 2.
 * @param baseDelayMs Base delay for backoff (delay = baseDelayMs * 2^attempt).
 *                    Default 400ms.
 */
export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // Don't sleep after the final attempt — just rethrow below.
      if (attempt < maxAttempts - 1) {
        const delayMs = baseDelayMs * Math.pow(2, attempt)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastErr
}
