// =============================================================================
// Shared Hono app environment type (Bindings + Variables).
// =============================================================================
// Hono's `c.get()`/`c.set()` are typed off the `Variables` map. Centralizing
// this here lets both the app declaration in src/index.ts and the session
// helper in src/auth/session.ts share the same variable typing — and stages 4+
// (which set `user` / `userId` on the context) extend it in one place.
// =============================================================================
import type { Env } from "./env"
import type { AuthSession } from "../auth/auth"

export interface AppBindings {
  Bindings: Env
}

export interface AppVariables {
  /** Per-request cached Better Auth instance (avoids rebuilding it). */
  __authInstance: unknown
  /** The resolved session (set by Stage 4 session middleware). */
  session: AuthSession
  /** The authenticated user's id — the multi-tenant DO key. */
  userId: string
}

export type AppEnv = AppBindings & { Variables: AppVariables }
