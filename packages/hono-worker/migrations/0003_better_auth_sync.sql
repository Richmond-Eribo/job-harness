-- 0003 — sync D1 with the Better Auth CLI-generated canonical schema.
-- Generated via: npx @better-auth/cli generate --config src/auth/auth.cli.ts
--                --output ./migrations/cli-schema.ts --yes
-- (see db:generate npm script)
--
-- Diff against 0001/0002: the only drift is a missing index on
-- verification(identifier). Better Auth queries this column on every OTP
-- lookup (findVerificationByIdentifier), so the index matters at scale. All
-- table/column definitions already match the CLI output (camelCase, same
-- types, same constraints, onboardingComplete additional field present).
--
-- This migration is idempotent (IF NOT EXISTS) and safe to re-run.

CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");
