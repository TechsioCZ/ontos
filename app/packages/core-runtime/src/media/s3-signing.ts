import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { DateTime, Redacted } from 'effect';
import { Hex } from 'effect/encoding';
import { Headers } from 'effect/http';

/*
 * AWS Signature Version 4 for the S3 API, header form, over the hashes the package already depends on. It is
 * pure and synchronous, so it runs unchanged on node and workerd, adds no dependency, and signs the real SHA-256
 * of the payload (so it does not rely on a provider's support of `UNSIGNED-PAYLOAD`). The payload digest is the
 * caller's: a whole body is hashed once with the platform digest, never here.
 */

export interface SignS3RequestInput {
  readonly accessKeyId: Redacted.Redacted;
  /** Extra headers to sign (for example `content-type`, `if-none-match`); names are matched in lower case. */
  readonly headers: Headers.Input;
  readonly method: 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT';
  readonly now: DateTime.Utc;
  /** Lowercase hex SHA-256 of the exact request body (of the empty string when there is none). */
  readonly payloadSha256: string;
  readonly region: string;
  readonly secretAccessKey: Redacted.Redacted;
  readonly url: URL;
}

/** RFC 3986 percent-encoding as SigV4 requires it (unreserved characters only are left as they are). */
const encodeRfc3986 = (text: string): string =>
  encodeURIComponent(text).replaceAll(
    /[!'()*]/gu,
    (character) => `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );

/** S3 canonicalizes the path once: each segment is encoded, the separators stay. */
const canonicalPath = (url: URL): string =>
  url.pathname
    .split('/')
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join('/');

/** Orders text by UTF-16 code unit, as the signature requires. */
const compareText = (left: string, right: string): number => Number(left > right) - Number(left < right);

const canonicalQuery = (url: URL): string =>
  [...url.searchParams.entries()]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .toSorted(
      ([left, leftValue], [right, rightValue]) => compareText(left, right) || compareText(leftValue, rightValue),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

const hmacSha256 = (key: Uint8Array, message: string): Uint8Array => hmac(sha256, key, utf8ToBytes(message));

/** The SigV4 `x-amz-date` form of a moment: `YYYYMMDDTHHMMSSZ`. */
export const amzDate = (now: DateTime.Utc): string =>
  DateTime.formatIso(now)
    .replaceAll(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');

export const sha256HexOf = (bytes: Uint8Array): string => Hex.encode(sha256(bytes));

export const EMPTY_PAYLOAD_SHA256 = sha256HexOf(new Uint8Array(0));

const canonicalHeaderValue = (value: string): string => value.trim().replaceAll(/\s+/gu, ' ');

/**
 * The headers to send: the given ones, `x-amz-content-sha256`, `x-amz-date` and `authorization`. `host` is signed
 * from the URL and is not returned, because the HTTP client derives it from the same URL.
 */
export const signS3Request = (input: SignS3RequestInput): Headers.Headers => {
  const timestamp = amzDate(input.now);
  const date = timestamp.slice(0, 8);
  const toSign = Headers.setAll(Headers.fromInput(input.headers), {
    host: input.url.host,
    'x-amz-content-sha256': input.payloadSha256,
    'x-amz-date': timestamp,
  });
  const names = Object.keys(toSign).toSorted(compareText);
  const canonicalHeaders = names.map((name) => `${name}:${canonicalHeaderValue(toSign[name] ?? '')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    canonicalPath(input.url),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join('\n');
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256HexOf(utf8ToBytes(canonicalRequest))].join('\n');
  const regionKey = hmacSha256(
    hmacSha256(utf8ToBytes(`AWS4${Redacted.value(input.secretAccessKey)}`), date),
    input.region,
  );
  const signingKey = hmacSha256(hmacSha256(regionKey, 's3'), 'aws4_request');
  const signature = Hex.encode(hmacSha256(signingKey, stringToSign));
  const credential = `${Redacted.value(input.accessKeyId)}/${scope}`;
  const authorization = `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return Headers.remove(Headers.set(toSign, 'authorization', authorization), 'host');
};
