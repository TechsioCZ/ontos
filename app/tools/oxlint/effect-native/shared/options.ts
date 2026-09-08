/** Option parsers deliberately reject mixed arrays instead of silently dropping invalid entries. */
export function stringArray(
  value: unknown,
  fallback: readonly string[]
): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter(
    (entry): entry is string => typeof entry === 'string'
  );
  return entries.length === value.length ? entries : fallback;
}

/** every-mode preserves the old stringList helper's treatment of sparse arrays. */
export function stringList(
  value: unknown,
  fallback: readonly string[]
): readonly string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
    ? value
    : fallback;
}

export function optionRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function booleanOption(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
export function positiveInteger(
  value: unknown,
  fallback: number,
  minimum = 1
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum
    ? value
    : fallback;
}
export function stringOption(
  value: unknown,
  fallback: string,
  allowEmpty = true
): string {
  return typeof value === 'string' && (allowEmpty || value.length > 0)
    ? value
    : fallback;
}
/** Invalid configured regexes use the caller's known-good fallback, retaining its flags.
 * compile treats empty input as missing; safeRegExp preserves the valid empty expression.
 */
export function compile(value: unknown, fallback: string, flags = 'u'): RegExp {
  return safeRegExp(stringOption(value, fallback, false), fallback, flags);
}
function tryRegExp(source: string, flags: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}
export function safeRegExp(
  source: string,
  fallback: string,
  flags = 'u'
): RegExp {
  return tryRegExp(source, flags) ?? new RegExp(fallback, flags);
}
/** Invalid user patterns are omitted, not replaced with a match-all expression. */
export function compilePatterns(
  sources: readonly string[],
  flags = 'gu'
): readonly RegExp[] {
  return sources
    .map((source) => tryRegExp(source, flags))
    .filter((pattern) => pattern !== null);
}
