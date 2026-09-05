// expect-count: 1
// EVASION: `*` is a documented Effect language-service wildcard ("@effect/language-service" README:
// `// @effect-diagnostics *:off` -> "No diagnostics will be reported from this point on"). It is the
// blanket waiver the eslint branch reports unconditionally under criterion (a) "names no rules", but
// the Effect branch accepts it as soon as it carries a justification and an expiry.
// @effect-diagnostics *:off -- The bootstrap seam owns every ambient edge in this file. remove-when: A5 script runtime lands

export const bootstrapped = true;
