import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAuthorizationRolloutContract } from '../authorization/rollout-contract.mts';

const entrypointKey = 'contacts.create-contact';
const inventoryHash = 'inventory';
const expiry = '2026-10-01T00:00:00.000Z';

const contract = {
  activatedAt: '2026-09-01T00:00:00.000Z',
  baselineInventoryHash: inventoryHash,
  baselineSourceRevision: 'revision',
  compatibilityEligibleEntrypoints: [entrypointKey],
  decisionReference: 'https://github.com/TechsioCZ/ontos/issues/169',
  expiresAt: expiry,
  mode: 'report_only',
  schemaVersion: 1,
};
const context = {
  entrypointKeys: new Set([entrypointKey]),
  inventoryHash,
  nowEpochMs: Date.parse('2026-09-10T00:00:00.000Z'),
};

await test('rollout contract accepts an active configuration bound to the classified inventory', () => {
  assert.deepEqual(
    validateAuthorizationRolloutContract(contract, context),
    contract
  );
});

await test('the historical baseline revision does not have to equal the self-referential current commit', () => {
  assert.deepEqual(
    validateAuthorizationRolloutContract(
      { ...contract, baselineSourceRevision: 'historical-baseline-revision' },
      context
    ).baselineSourceRevision,
    'historical-baseline-revision'
  );
});

await test('enforced rollout remains active after the report-only deadline', () => {
  assert.equal(
    validateAuthorizationRolloutContract(
      { ...contract, mode: 'enforced' },
      { ...context, nowEpochMs: Date.parse('2026-11-01T00:00:00.000Z') }
    ).mode,
    'enforced'
  );
});

await test('rollout contract rejects expiry, stale inventory binding, extra fields, and duplicate baseline entries', () => {
  assert.throws(
    () =>
      validateAuthorizationRolloutContract(contract, {
        ...context,
        nowEpochMs: Date.parse(expiry),
      }),
    /inactive or expired/u
  );
  assert.throws(
    () =>
      validateAuthorizationRolloutContract(contract, {
        ...context,
        inventoryHash: 'other',
      }),
    /does not match/u
  );
  assert.throws(
    () =>
      validateAuthorizationRolloutContract(
        { ...contract, arbitrary: true },
        context
      ),
    /malformed/u
  );
  assert.throws(
    () =>
      validateAuthorizationRolloutContract(
        {
          ...contract,
          compatibilityEligibleEntrypoints: [entrypointKey, entrypointKey],
        },
        context
      ),
    /duplicates/u
  );
  assert.throws(
    () =>
      validateAuthorizationRolloutContract(
        {
          ...contract,
          compatibilityEligibleEntrypoints: ['contacts.new-action'],
        },
        context
      ),
    /unknown entrypoint/u
  );
});
