// @effect-diagnostics extendsNativeError:off
export const maximumUrlUtf8Bytes = 8000;

export type ValidatedUrlPropertyValue = string | null;

export class InvalidUrlPropertyValueError extends Error {
  readonly code = 'ticketing.updateUrlPropertyValue.invalid_url';

  override readonly name = 'InvalidUrlPropertyValueError';
}

export const validateUrlPropertyValue = (candidate: string): ValidatedUrlPropertyValue => {
  const value = candidate.trim();
  if (value.length === 0) {
    return null;
  }
  if (new TextEncoder().encode(value).byteLength > maximumUrlUtf8Bytes) {
    throw new InvalidUrlPropertyValueError('URL values must contain at most 8000 UTF-8 bytes.');
  }
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
  if (/\p{White_Space}/u.test(value) || containsControlCharacter) {
    throw new InvalidUrlPropertyValueError(
      'Enter one absolute HTTP(S) URL without internal whitespace or control characters.',
    );
  }
  if (!/^https?:\/\//iu.test(value)) {
    throw new InvalidUrlPropertyValueError(
      'Enter one absolute URL beginning with http:// or https://.',
    );
  }
  const authority =
    value
      .slice(value.indexOf('//') + 2)
      .split(/[/?#]/u, 1)
      .at(0) ?? '';
  if (authority.includes('@')) {
    throw new InvalidUrlPropertyValueError('URL values must not contain credentials.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidUrlPropertyValueError('Enter one valid absolute HTTP(S) URL.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new InvalidUrlPropertyValueError(
      'Enter one absolute HTTP(S) URL with a host and without credentials.',
    );
  }

  return value;
};
