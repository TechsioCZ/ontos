import type { AssetDownloadAuthorization } from './download-contract.ts';

/*
 * The response headers of a download. They are built from the recorded metadata only, as an allow-list: no
 * provider header, no ETag, no range support and nothing a shared cache could keep. A recorded display name is an
 * untrusted string, so it never reaches a header unencoded.
 */

const FALLBACK_TYPE = 'application/octet-stream';
const FALLBACK_NAME = 'download';
/** A media type token pair; anything else (parameters, control characters, spaces) is not presented. */
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u;
const MAX_NAME_CHARACTERS = 200;

/** The recorded type when it is a plain `type/subtype`, the generic binary type otherwise. */
export const downloadContentType = (mimeType: string): string => (MEDIA_TYPE.test(mimeType) ? mimeType : FALLBACK_TYPE);

/** RFC 5987 `attr-char`: everything else is percent-encoded from the name's UTF-8 bytes. */
const encodeExtended = (name: string): string =>
  [...new TextEncoder().encode(name)]
    .map((byte) => {
      const char = String.fromCodePoint(byte);
      return byte < 0x80 && /[A-Za-z0-9!#$&+.^_`|~-]/u.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');

/** Separators and characters a header or a path must never carry. */
const SEPARATORS = String.raw`\/"<>:*?|;%`;

/** Control and bidirectional-format characters never reach a header: they hide or inject, whatever they look like. */
const isInvisibleControl = (char: string): boolean =>
  char < '\u0020' ||
  (char >= '\u007F' && char <= '\u009F') ||
  char === '\u200E' ||
  char === '\u200F' ||
  (char >= '\u202A' && char <= '\u202E') ||
  (char >= '\u2066' && char <= '\u2069');

const isUnsafeNameCharacter = (char: string): boolean => isInvisibleControl(char) || SEPARATORS.includes(char);

/** The name as one safe path-free text line: control and bidi characters and separators become `_`, the length is bounded. */
const safeName = (displayFilename: string): string => {
  const cleaned = displayFilename
    .split('')
    .map((char) => (isUnsafeNameCharacter(char) ? '_' : char))
    .join('')
    .trim();
  const bounded = cleaned.split('').slice(0, MAX_NAME_CHARACTERS).join('').replace(/^\.+/u, '_');
  return bounded.length === 0 ? FALLBACK_NAME : bounded;
};

/** `attachment` with an ASCII fallback and the exact UTF-8 name, so a name can never inject a header or a path. */
export const downloadContentDisposition = (displayFilename: string): string => {
  const name = safeName(displayFilename);
  const ascii = name
    .split('')
    .map((char) => (/[ -~]/u.test(char) ? char : '_'))
    .join('');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeExtended(name)}`;
};

/** The complete header set of a download response. */
export const downloadResponseHeaders = (authorization: AssetDownloadAuthorization) => ({
  'cache-control': 'private, no-store',
  'content-disposition': downloadContentDisposition(authorization.displayFilename),
  'content-length': String(authorization.byteSize),
  'content-security-policy': "default-src 'none'; sandbox",
  'content-type': downloadContentType(authorization.mimeType),
  'x-content-type-options': 'nosniff',
});
