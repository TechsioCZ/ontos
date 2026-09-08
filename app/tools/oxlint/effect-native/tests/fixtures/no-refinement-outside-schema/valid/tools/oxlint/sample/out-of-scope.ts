// `tools/**` is outside the rule's `include` scope, so even a blatant hand-written refinement here
// must stay silent — plugin and tooling code is not part of the A2 contract surface.
export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
