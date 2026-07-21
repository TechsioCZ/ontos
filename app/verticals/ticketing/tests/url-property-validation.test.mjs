import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InvalidUrlPropertyValueError,
  maximumUrlUtf8Bytes,
  validateUrlPropertyValue,
} from '../src/url-property.ts';

test('the URL grammar accepts the bounded WHATWG HTTP(S) host profile without rewriting', () => {
  const accepted = [
    'http://localhost',
    'https://127.0.0.1:8443/path',
    'https://[2001:db8::1]/resource',
    'https://p\u0159\u00EDklad.cz/Cesta?Q=Jedna#Část',
    'HTTPS://Example.com/%7EUser?Q=One#Part',
  ];

  for (const value of accepted) {
    assert.equal(validateUrlPropertyValue(`\u2003${value}\u00A0`), value);
  }
  assert.equal(validateUrlPropertyValue(' \t\n '), null);

  const prefix = 'https://example.com/';
  const boundary = `${prefix}${'x'.repeat(maximumUrlUtf8Bytes - prefix.length)}`;
  assert.equal(validateUrlPropertyValue(boundary), boundary);
});

test('the URL grammar atomically rejects unsupported, credentialed, split, and over-limit input', () => {
  const prefix = 'https://example.com/';
  const rejected = [
    'example.com/path',
    'ftp://example.com/file',
    'https://',
    'https://user@example.com/private',
    'https://:secret@example.com/private',
    'https://@example.com/private',
    'https://example.com/internal space',
    'https://example.com\u0000hidden',
    'https://one.example https://two.example',
    'https://example.com:99999/path',
    'http://[2001:db8:::1]/',
    `${prefix}${'x'.repeat(maximumUrlUtf8Bytes - prefix.length + 1)}`,
  ];

  for (const value of rejected) {
    assert.throws(() => validateUrlPropertyValue(value), InvalidUrlPropertyValueError, value);
  }
});
