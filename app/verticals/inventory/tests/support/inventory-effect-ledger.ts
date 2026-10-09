import { Effect, Option } from 'effect';

import type { InventoryEffectLedgerRecord } from '../../shared/domain/inventory-effect-ledger.ts';
import type { InventoryEffectLedgerPersistence } from '../../src/services/inventory-effect-ledger.service.ts';
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Focused tests construct the in-memory ledger owner at the tested service seam; expires: 2027-03-31.
import { makeInventoryEffectLedgerService } from '../../src/services/inventory-effect-ledger.service.ts';

export const makeInMemoryInventoryEffectLedger = (now: string) => {
  const records = new Map<string, InventoryEffectLedgerRecord>();
  const persistence: InventoryEffectLedgerPersistence = {
    createOrRead: (candidate) =>
      Effect.sync(() => {
        const existing = records.get(`${candidate.tenantId}:${candidate.effectId}`);
        if (existing !== undefined) {
          return { outcome: 'EXISTING' as const, record: existing };
        }
        records.set(`${candidate.tenantId}:${candidate.effectId}`, candidate);
        return { outcome: 'INSERTED' as const, record: candidate };
      }),
    read: (effectId) =>
      Effect.sync(() => Option.fromNullishOr([...records.values()].find((record) => record.effectId === effectId))),
    save: (expected, next) =>
      Effect.sync(() => {
        const key = `${expected.tenantId}:${expected.effectId}`;
        const current = records.get(key);
        if (current?.revision !== expected.revision) {
          return Option.none<InventoryEffectLedgerRecord>();
        }
        records.set(key, next);
        return Option.some(next);
      }),
  };
  return makeInventoryEffectLedgerService(persistence, Effect.succeed(now));
};
