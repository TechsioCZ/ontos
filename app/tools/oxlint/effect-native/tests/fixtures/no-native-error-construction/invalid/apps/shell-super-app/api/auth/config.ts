// expect-count: 5
// Mirrors apps/shell-super-app/api/auth/config.ts:52..65 — configuration validation that signals
// every distinct problem with an untyped native Error (audit A4, and A3 for the Config target).
import { Effect } from "effect";

export function parseAuthConfig(environment: Record<string, string | undefined>) {
	const databaseUrl = environment.DATABASE_URL;
	if (databaseUrl === undefined) {
		throw new Error("DATABASE_URL is required");
	}
	if (!databaseUrl.startsWith("postgres")) {
		throw new Error("DATABASE_URL must use PostgreSQL");
	}
	const secret = environment.BETTER_AUTH_SECRET;
	if (secret === undefined || secret.length < 32) {
		throw new RangeError("BETTER_AUTH_SECRET must contain at least 32 characters");
	}
	return { databaseUrl, secret } as const;
}

export const loadAuthConfig = Effect.sync(() => {
	try {
		return parseAuthConfig({});
	} catch (cause) {
		throw new Error(`auth configuration failed: ${String(cause)}`, { cause });
	}
});

export const isNativeFailure = (cause: unknown): boolean => cause instanceof Error;
