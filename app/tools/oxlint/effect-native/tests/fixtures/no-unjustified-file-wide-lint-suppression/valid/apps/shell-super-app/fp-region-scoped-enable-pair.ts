/**
 * FALSE POSITIVE (regression fixture).
 *
 * Reproduces `apps/shell-super-app/modern.config.ts:49` and `verticals/contacts/modern.config.ts:49`
 * verbatim in shape: an `oxlint-disable` that is closed by a matching `oxlint-enable` twenty lines
 * later. The waiver is NOT file-wide — it covers exactly one Rspack `externals` callback adapter,
 * which is the "Promise adapters forced by React, TanStack, Modern.js, Playwright, Drizzle, and Node
 * process entrypoints" case the audit's D tier leaves alone, and the "single outer process/framework
 * adapter seam" its "Existing patterns to preserve" section blesses.
 *
 * The rule has no notion of `oxlint-enable` / `eslint-enable`, so it reports this bounded region with
 * the message "an unexpiring file-wide waiver keeps the whole file exempt forever" — which is false
 * here: the rule is back in force from the `oxlint-enable` line onward, and `callback()` below is
 * still linted. This is the narrow, region-scoped shape the rule itself asks authors to produce.
 */
/* oxlint-disable promise/prefer-await-to-callbacks -- Rspack externals use a callback API. */
export const cloudflareRuntimeExternal = (
	{ request }: { request?: string },
	callback: (error?: Error, result?: string) => void,
): void => {
	if (request === "cloudflare:sockets") {
		callback(undefined, request);
		return;
	}
	callback();
};
/* oxlint-enable promise/prefer-await-to-callbacks */

export const stillLinted = (done: (value: number) => void): void => {
	done(1);
};
