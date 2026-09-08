/**
 * FALSE POSITIVE (regression fixture) — latent, no live occurrence in this workspace yet.
 *
 * `EFFECT_DIAGNOSTICS = /^@effect-diagnostics\b(?<rest>[\s\S]*)$/u` has a word boundary after
 * `diagnostics`, so it also matches `@effect-diagnostics-next-line …` (and any other
 * `@effect-diagnostics-<suffix>`). The eslint/oxlint branch guards this exactly — `parseDirective`
 * rejects a `rest` that starts with `-`, which is what keeps `oxlint-disable-next-line` out of the
 * report — but the Effect-diagnostics branch has no equivalent guard, so the *line-scoped* Effect
 * diagnostic waiver, the narrow form this rule tells authors to write, is reported as if it were the
 * file-wide one.
 *
 * Fix: mirror the eslint branch and bail when `rest.startsWith("-")`.
 */
// @effect-diagnostics-next-line asyncFunction:off
export const loadOnce = async (): Promise<number> => Promise.resolve(1);
