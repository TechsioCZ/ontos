/**
 * FALSE POSITIVE repro (adversarial review).
 *
 * `COOKIE_ATTRIBUTE` matches a bare `HttpOnly` / `Secure` / `Partitioned` flag that occupies a whole
 * `;`-delimited segment, and `^…$` counts as such a segment — so ANY string literal whose entire
 * value is the word `Secure` (a UI label, a JSX attribute, a status enum member, an i18n key) is
 * reported as a "Hand-built cookie string (Secure)" with no cookie context whatsoever. Same for a
 * prose string that merely starts with `Path=` / `Domain=`.
 *
 * No occurrence exists in tracked source today, but the rule is scoped over every `.tsx` under
 * `apps/**` and `verticals/**` at severity `error`, so this is one label away from firing.
 */
export type ConnectionLevel = 'Insecure' | 'Secure';

export const CONNECTION_LEVEL: ConnectionLevel = 'Secure';

export const MANIFEST_HELP = 'Path=/ is required for the module manifest route';

export const ConnectionBadge = () => <span title="Secure">{CONNECTION_LEVEL}</span>;
