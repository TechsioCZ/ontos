// No configuration provenance: these functions never read the environment and take no environment
// record, so their throws are outside A3 and this rule stays quiet.
export const parseHttpOrigin = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('origin must be https');
  }
  return url;
};

export function assertNonEmpty(values: readonly string[]): void {
  if (values.length === 0) {
    throw new RangeError('values must not be empty');
  }
}

export const buildHeaders = (headers: Record<string, string>): Headers => {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (key.length === 0) {
      throw new TypeError('header names must not be empty');
    }
    result.set(key, value);
  }
  return result;
};
