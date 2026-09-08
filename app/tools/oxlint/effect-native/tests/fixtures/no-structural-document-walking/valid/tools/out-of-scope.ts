/** `tools/**` is outside includePaths: the plugin's own helpers may walk unknown values. */
export const walk = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value;
