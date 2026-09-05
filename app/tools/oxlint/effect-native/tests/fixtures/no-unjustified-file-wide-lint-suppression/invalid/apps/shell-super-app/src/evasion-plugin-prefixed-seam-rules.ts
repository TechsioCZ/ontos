// expect-count: 2
// EVASION: oxlint honours plugin-qualified rule names in disable directives (verified: a file-wide
// `oxlint-disable eslint/no-await-in-loop` really does suppress `eslint(no-await-in-loop)`), but
// `normaliseRuleName` only strips `@` / `typescript-eslint/`, so an `eslint/`-prefixed seam rule
// never intersects `effectSeamRules` and the waiver passes as governed.
/* oxlint-disable eslint/no-await-in-loop -- Sequential scoped-client cases verify finalization independently. expires: 2030-01-01 */
/* eslint-disable eslint/max-classes-per-file -- One closed failure vocabulary per boundary. remove-when: A2 typed failures land */

export async function drain(xs: readonly number[]): Promise<void> {
	for (const x of xs) {
		await Promise.resolve(x);
	}
}
