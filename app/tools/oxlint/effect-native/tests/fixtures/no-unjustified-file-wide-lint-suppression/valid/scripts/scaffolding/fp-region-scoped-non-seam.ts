/**
 * FALSE POSITIVE (regression fixture).
 *
 * Reproduces `scripts/scaffolding/shared.mts:8` — a five-line `eslint-disable` / `eslint-enable`
 * region wrapping one `Number.parseInt` call, with a justification. The rule reports it as a
 * "File-wide lint suppression" that "keeps the whole file exempt forever"; the waiver is closed on
 * line 13 of the real file and covers a single expression.
 *
 * `scripts/scaffolding/governed-contribution/scaffold.mts:554`, `:844` and `:867` are the same shape
 * (`:867` additionally names the seam rule `complexity`, so it takes the `ungovernedSeamSuppression`
 * message path — a fix must cover both messages).
 */
export const CONTRACT_SCHEMA_VERSION = "3";

/* eslint-disable unicorn/prefer-number-coercion -- The schema version is parsed as a base-10 integer by contract. */
export const PACKAGE_SCHEMA_VERSION = Number.parseInt(CONTRACT_SCHEMA_VERSION, 10);
/* eslint-enable unicorn/prefer-number-coercion */

export const alsoStillLinted = Number.parseInt(CONTRACT_SCHEMA_VERSION, 10);
