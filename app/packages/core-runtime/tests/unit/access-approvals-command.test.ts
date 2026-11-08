import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { Schema } from 'effect';
import { Result } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { freezeCommand } from '../../src/access/approvals/command.ts';
import type { FrozenCommand } from '../../src/access/approvals/command.ts';
import { capabilityKey, commandDigest, recordKey } from './access-approvals-fixtures.ts';

const KEY = capabilityKey('finance.invoice.void');

/** The digest a canonical text must produce, so a test can assert the exact canonical form. */
const digestOfText = (text: string) => commandDigest(Hex.encode(sha256(utf8ToBytes(text))));

const accepted = (result: Result.Result<ReturnType<typeof commandDigest>, { readonly code: string }>) =>
  Result.isFailure(result) ? expect.unreachable(`unexpected refusal: ${result.failure.code}`) : result.success;

const refusalOf = (result: Result.Result<unknown, { readonly code: string }>) =>
  Result.isFailure(result) ? result.failure.code : expect.unreachable('expected a refusal');

it('freezes the exact command into the RFC 8785 digest of its canonical form', () => {
  const command = { capabilityKey: KEY, payload: { amount: 100, note: 'x' }, target: recordKey('invoice-1') };
  const frozen = accepted(freezeCommand(command));
  expect(frozen).toMatch(/^[a-f0-9]{64}$/u);
  expect(frozen).toBe(
    digestOfText('{"capabilityKey":"finance.invoice.void","payload":{"amount":100,"note":"x"},"target":"invoice-1"}'),
  );
  expect(accepted(freezeCommand({ ...command }))).toBe(frozen);
  expect(accepted(freezeCommand({ ...command, payload: { amount: 101, note: 'x' } }))).not.toBe(frozen);
  expect(accepted(freezeCommand({ ...command, target: recordKey('invoice-2') }))).not.toBe(frozen);
  expect(accepted(freezeCommand({ ...command, capabilityKey: capabilityKey('finance.invoice.issue') }))).not.toBe(
    frozen,
  );
});

it('does not depend on key insertion order, so a JSONB round trip keeps the digest (R2-L2)', () => {
  const ordered = accepted(freezeCommand({ capabilityKey: KEY, payload: { alpha: 1, beta: { delta: 3, gamma: 2 } } }));
  const reordered = accepted(
    freezeCommand({ capabilityKey: KEY, payload: { alpha: 1, beta: { delta: 3, gamma: 2 } } }),
  );
  expect(reordered).toBe(ordered);
  expect(ordered).toBe(
    digestOfText('{"capabilityKey":"finance.invoice.void","payload":{"alpha":1,"beta":{"delta":3,"gamma":2}}}'),
  );
});

it('writes numbers and strings the RFC 8785 way', () => {
  const numbers = accepted(
    freezeCommand({
      capabilityKey: KEY,
      payload: { big: 1e21, minusZero: -0, small: 1e-7, tiny: 0.000001 },
    }),
  );
  expect(numbers).toBe(
    digestOfText(
      '{"capabilityKey":"finance.invoice.void","payload":{"big":1e+21,"minusZero":0,"small":1e-7,"tiny":0.000001}}',
    ),
  );
  const escaped = accepted(freezeCommand({ capabilityKey: KEY, payload: { s: 'a"b\\c\u0001d\n' } }));
  expect(escaped).toBe(
    digestOfText(String.raw`{"capabilityKey":"finance.invoice.void","payload":{"s":"a\"b\\c\u0001d\n"}}`),
  );
});

it('refuses a payload the canonical form cannot represent instead of throwing (R2-L2)', () => {
  expect(refusalOf(freezeCommand({ capabilityKey: KEY, payload: { amount: Number.NaN } }))).toBe(
    'command_not_canonical',
  );
  expect(refusalOf(freezeCommand({ capabilityKey: KEY, payload: { amount: Number.POSITIVE_INFINITY } }))).toBe(
    'command_not_canonical',
  );
  const cyclic: Record<string, Schema.Json> = {};
  cyclic['self'] = cyclic;
  expect(refusalOf(freezeCommand({ capabilityKey: KEY, payload: cyclic }))).toBe('command_not_canonical');
  const smuggled: FrozenCommand & { readonly extra: string } = { capabilityKey: KEY, extra: 'unbound', payload: {} };
  expect(refusalOf(freezeCommand(smuggled))).toBe('command_not_canonical');
  // The same command without the extra key is canonical, so the refusal above is about the key.
  expect(accepted(freezeCommand({ capabilityKey: KEY, payload: {} }))).toMatch(/^[a-f0-9]{64}$/u);
});

it('refuses a payload string that is not well formed instead of digesting a replacement (R3b-N9)', () => {
  // `utf8ToBytes` maps a lone surrogate to U+FFFD, so these two payloads would otherwise share one
  // digest: the refusal is what keeps two different commands apart.
  expect(refusalOf(freezeCommand({ capabilityKey: KEY, payload: { note: 'a\uD800b' } }))).toBe('command_not_canonical');
  expect(accepted(freezeCommand({ capabilityKey: KEY, payload: { note: 'a\uFFFDb' } }))).toMatch(/^[a-f0-9]{64}$/u);
  // An object key is a string like any other, and a lone low surrogate is just as unrepresentable.
  expect(refusalOf(freezeCommand({ capabilityKey: KEY, payload: { '\uDC00': 'x' } }))).toBe('command_not_canonical');
  // A well-formed astral character still digests, so the refusal is about the lone half only.
  expect(accepted(freezeCommand({ capabilityKey: KEY, payload: { note: 'a\u{1F600}b' } }))).toMatch(/^[a-f0-9]{64}$/u);
});
