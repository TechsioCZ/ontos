import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { DateTime, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { validateAuthorizationRolloutContract } from '../authorization/rollout-contract.mts';
import { checkModuleEntrypointBoundaries } from '../check-module-entrypoint-boundaries.mts';

const InventoryBindingSchema = Schema.fromJsonString(
  Schema.Struct({
    inventoryHash: Schema.String,
  }),
);

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

it.effect(
  'the committed rollout baseline matches the current classified workspace inventory',
  Effect.fn(function* currentWorkspaceInventoryBinding() {
    const root = path.resolve(import.meta.dirname, '../..');
    yield* checkModuleEntrypointBoundaries(root).pipe(Effect.provide(NodeServices.layer));
    const fileSystem = yield* FileSystem.FileSystem;
    const inventory = yield* Schema.decodeUnknownEffect(InventoryBindingSchema)(
      yield* fileSystem.readFileString(path.join(root, '.codex/reports/authorization/protected-entrypoints.json')),
    );
    const rollout = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
      yield* fileSystem.readFileString(path.join(root, 'topology/authorization-rollout.json')),
    );
    const validated = validateAuthorizationRolloutContract(rollout, {
      inventoryHash: inventory.inventoryHash,
      nowEpochMs: DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-10T00:00:00.000Z')),
    });
    expect(validated.baselineInventoryHash).toBe(inventory.inventoryHash);
  }, Effect.provide(NodeServices.layer)),
);

it('rollout contract accepts an active configuration bound to the classified inventory', () => {
  expect(validateAuthorizationRolloutContract(contract, context)).toEqual(contract);
});

it('the historical baseline revision does not have to equal the self-referential current commit', () => {
  expect(
    validateAuthorizationRolloutContract(
      { ...contract, baselineSourceRevision: 'historical-baseline-revision' },
      context,
    ).baselineSourceRevision,
  ).toEqual('historical-baseline-revision');
});

it('enforced rollout remains active after the report-only deadline', () => {
  expect(
    validateAuthorizationRolloutContract(
      { ...contract, mode: 'enforced' },
      { ...context, nowEpochMs: Date.parse('2026-11-01T00:00:00.000Z') },
    ).mode,
  ).toBe('enforced');
});

it('rollout contract rejects expiry, stale inventory binding, extra fields, and duplicate baseline entries', () => {
  expect(() =>
    validateAuthorizationRolloutContract(contract, {
      ...context,
      nowEpochMs: Date.parse(expiry),
    }),
  ).toThrow(/inactive or expired/u);
  expect(() =>
    validateAuthorizationRolloutContract(contract, {
      ...context,
      inventoryHash: 'other',
    }),
  ).toThrow(/does not match/u);
  expect(() => validateAuthorizationRolloutContract({ ...contract, arbitrary: true }, context)).toThrow(/malformed/u);
  expect(() =>
    validateAuthorizationRolloutContract(
      {
        ...contract,
        compatibilityEligibleEntrypoints: [entrypointKey, entrypointKey],
      },
      context,
    ),
  ).toThrow(/duplicates/u);
  expect(() =>
    validateAuthorizationRolloutContract(
      {
        ...contract,
        compatibilityEligibleEntrypoints: ['contacts.new-action'],
      },
      context,
    ),
  ).toThrow(/unknown entrypoint/u);
});
