import { DateTime, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { freezeCommand } from '../../src/access/approvals/command.ts';
import type { FrozenCommand } from '../../src/access/approvals/command.ts';
import { ActionKeySchema, verifyFrozenCommand } from '../../src/access/approvals/frozen-command.ts';
import type { FrozenCommandRecord } from '../../src/access/approvals/frozen-command.ts';
import { SCOPE, TENANT, capabilityKey, commandDigest, proposalId, recordKey } from './access-approvals-fixtures.ts';

const KEY = capabilityKey('finance.invoice.void');
const ACTION_KEY = Schema.decodeSync(ActionKeySchema)('finance.invoice.void');

const frozen = (command: FrozenCommand): FrozenCommandRecord => {
  const digest = freezeCommand(command);
  if (Result.isFailure(digest)) {
    return expect.unreachable(`the fixture command must be canonical: ${digest.failure.code}`);
  }
  return {
    actionKey: ACTION_KEY,
    command,
    commandDigest: digest.success,
    frozenAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T09:00:00.000Z')),
    proposalId: proposalId(11),
    scopeId: SCOPE,
    tenantId: TENANT,
  };
};

const refusalOf = (result: Result.Result<unknown, { readonly code: string }>) =>
  Result.isFailure(result) ? result.failure.code : expect.unreachable('expected a refusal');

const COMMAND: FrozenCommand = {
  capabilityKey: KEY,
  payload: { amountMinor: 125_000, currency: 'CZK', note: 'Faktura 2026/118' },
  target: recordKey('invoice-118'),
};

it('accepts a stored command that still hashes to the frozen digest', () => {
  const record = frozen(COMMAND);
  expect(Result.isSuccess(verifyFrozenCommand(record))).toBe(true);
  // The same document after a JSONB round trip keeps its digest, so storage cannot invalidate it.
  expect(Result.isSuccess(verifyFrozenCommand({ ...record, command: structuredClone(record.command) }))).toBe(true);
});

it('refuses a stored payload that no longer matches the approved digest', () => {
  const record = frozen(COMMAND);
  const edited: FrozenCommandRecord = {
    ...record,
    command: { ...record.command, payload: { amountMinor: 125_000, currency: 'CZK', note: 'Faktura 2026/119' } },
  };
  expect(refusalOf(verifyFrozenCommand(edited))).toBe('frozen_command_integrity');
});

it('refuses a record whose digest was replaced by another command’s digest', () => {
  const first = frozen(COMMAND);
  const second = frozen({ ...COMMAND, payload: { amountMinor: 1, currency: 'CZK' } });
  expect(refusalOf(verifyFrozenCommand({ ...first, commandDigest: second.commandDigest }))).toBe(
    'frozen_command_integrity',
  );
});

it('refuses a stored command the canonical form cannot represent, without throwing', () => {
  const record = frozen(COMMAND);
  const broken: FrozenCommandRecord = {
    ...record,
    command: { ...record.command, payload: { note: 'lone \uD800 half' } },
  };
  expect(refusalOf(verifyFrozenCommand(broken))).toBe('frozen_command_integrity');
});

it('recomputes the digest and never trusts the stored one', () => {
  const record = frozen(COMMAND);
  // A digest that is the right shape but not this command's own: the only thing that senses it is
  // the recomputation, so a store that skipped it would execute a command nobody approved.
  const zero = commandDigest('0'.repeat(64));
  expect(refusalOf(verifyFrozenCommand({ ...record, commandDigest: zero }))).toBe('frozen_command_integrity');
  expect(record.commandDigest).not.toBe(zero);
});
