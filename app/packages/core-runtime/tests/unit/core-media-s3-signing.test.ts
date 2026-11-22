import { DateTime, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { EMPTY_PAYLOAD_SHA256, amzDate, signS3Request } from '../../src/media/s3-signing.ts';

/*
 * The published AWS Signature Version 4 examples for S3 ("Authenticating Requests: Using the Authorization
 * Header"), which use a documentation-only credential pair. They prove the signer against the specification,
 * independently of any provider.
 */
const accessKeyId = Redacted.make('AKIAIOSFODNN7EXAMPLE');
const secretAccessKey = Redacted.make('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
const now = DateTime.makeUnsafe('2013-05-24T00:00:00.000Z');

const signatureOf = (authorization: string | undefined) =>
  /Signature=(?<signature>[0-9a-f]{64})$/u.exec(authorization ?? '')?.groups?.['signature'];

it('formats the SigV4 timestamp', () => {
  expect(amzDate(now)).toBe('20130524T000000Z');
  expect(EMPTY_PAYLOAD_SHA256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

it('signs the published GET Object example with a Range header', () => {
  const headers = signS3Request({
    accessKeyId,
    headers: { range: 'bytes=0-9' },
    method: 'GET',
    now,
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    region: 'us-east-1',
    secretAccessKey,
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
  });
  expect(signatureOf(headers['authorization'])).toBe(
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  expect(headers['authorization']).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
  expect(headers['authorization']).toContain('Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  expect(headers['host']).toBeUndefined();
});

it('signs the published list-objects example with a query string', () => {
  const headers = signS3Request({
    accessKeyId,
    headers: {},
    method: 'GET',
    now,
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    region: 'us-east-1',
    secretAccessKey,
    url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
  });
  expect(signatureOf(headers['authorization'])).toBe(
    '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
  );
});

it('signs the published PUT Object example with a special-character key and extra headers', () => {
  const headers = signS3Request({
    accessKeyId,
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    method: 'PUT',
    now,
    payloadSha256: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    region: 'us-east-1',
    secretAccessKey,
    url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
  });
  expect(signatureOf(headers['authorization'])).toBe(
    '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
  );
});

const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it('keeps the credential out of everything it returns except the credential scope of the authorization header', () => {
  const headers = signS3Request({
    accessKeyId,
    headers: {},
    method: 'HEAD',
    now,
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    region: 'auto',
    secretAccessKey,
    url: new URL('https://storage.example.test/bucket/key'),
  });
  expect(jsonText(headers)).not.toContain('wJalrXUtnFEMI');
});
