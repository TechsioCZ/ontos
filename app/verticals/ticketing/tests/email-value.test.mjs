import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emailMailtoHref, parseEmailValue } from '../shared/email-value.ts';

test('Email activation returns only a fully percent-encoded recipient', () => {
  assert.equal(
    emailMailtoHref("O'Hara!+tag@Example.com"),
    'mailto:O%27Hara%21%2Btag%40Example.com',
  );
});

test('the public Email parser enforces the practical ASCII and punycode grammar bounds', () => {
  const longestAddress = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  const accepted = [
    ['user@example.com', 'user@example.com'],
    ['  First.Last+tag@XN--PUNYCODE-KVA.example  ', 'First.Last+tag@XN--PUNYCODE-KVA.example'],
    [longestAddress, longestAddress],
  ];
  for (const [input, value] of accepted) {
    const parsed = parseEmailValue(input);
    assert.equal(parsed._tag, 'Valid', input);
    assert.equal(parsed.value, value);
    assert.equal(parsed.normalizedValue, value.toLowerCase());
  }

  assert.deepEqual(parseEmailValue('   '), { _tag: 'Empty' });
  const rejected = [
    'user',
    'user@',
    '@example.com',
    'user@example',
    'user @example.com',
    'user@example..com',
    '.user@example.com',
    'user.@example.com',
    'user..name@example.com',
    `${'a'.repeat(65)}@example.com`,
    'user@-example.com',
    'user@example-.com',
    `user@${'a'.repeat(64)}.com`,
    '"user"@example.com',
    'user(comment)@example.com',
    'user@[127.0.0.1]',
    'uživatel@example.com',
    'user@příklad.cz',
    'first@example.com,second@example.com',
    `${longestAddress}x`,
  ];
  for (const input of rejected) {
    assert.equal(parseEmailValue(input)._tag, 'Invalid', input);
  }
});
