import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';

import type { LegalEntityContextRecord } from '../../src/auth/legal-entity-context.ts';
import {
  classifyActiveLegalEntities,
  classifySelectedLegalEntity,
  makeLegalEntityContext,
} from '../../src/auth/legal-entity-context.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';

const activeRecord: LegalEntityContextRecord = {
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  legalName: 'Zeta s.r.o.',
  status: 'active',
  tenantId,
};

it.effect(
  'lists zero, one, and many active legal entities in deterministic safe order',
  () =>
    Effect.gen(function* listsActiveLegalEntities() {
      expect(yield* classifyActiveLegalEntities([], tenantId)).toEqual([]);
      expect(
        yield* classifyActiveLegalEntities([activeRecord], tenantId)
      ).toEqual([
        { legalEntityId: activeRecord.legalEntityId, legalName: 'Zeta s.r.o.' },
      ]);
      expect(
        yield* classifyActiveLegalEntities(
          [
            activeRecord,
            {
              ...activeRecord,
              legalEntityId: '20000000-0000-4000-8000-000000000003',
              legalName: 'Alpha s.r.o.',
            },
            {
              ...activeRecord,
              legalEntityId: '20000000-0000-4000-8000-000000000002',
              legalName: 'Alpha s.r.o.',
            },
            {
              ...activeRecord,
              legalEntityId: '20000000-0000-4000-8000-000000000004',
              legalName: 'Suspended s.r.o.',
              status: 'suspended',
            },
            {
              ...activeRecord,
              legalEntityId: '20000000-0000-4000-8000-000000000005',
              legalName: 'Archived s.r.o.',
              status: 'archived',
            },
          ],
          tenantId
        )
      ).toEqual([
        {
          legalEntityId: '20000000-0000-4000-8000-000000000002',
          legalName: 'Alpha s.r.o.',
        },
        {
          legalEntityId: '20000000-0000-4000-8000-000000000003',
          legalName: 'Alpha s.r.o.',
        },
        { legalEntityId: activeRecord.legalEntityId, legalName: 'Zeta s.r.o.' },
      ]);
    })
);

it.effect(
  'validates exactly one active selection and rejects missing or inactive selections',
  () =>
    Effect.gen(function* validatesLegalEntitySelection() {
      expect(
        yield* classifySelectedLegalEntity(
          [activeRecord],
          tenantId,
          activeRecord.legalEntityId
        )
      ).toEqual({
        legalEntityId: activeRecord.legalEntityId,
        legalName: activeRecord.legalName,
      });
      expect(
        Predicate.isTagged(
          yield* Effect.flip(
            classifySelectedLegalEntity(
              [activeRecord],
              tenantId,
              '20000000-0000-4000-8000-000000000099'
            )
          ),
          'LegalEntityContextMissingError'
        )
      ).toBe(true);
      expect(
        Predicate.isTagged(
          yield* Effect.flip(
            classifySelectedLegalEntity(
              [{ ...activeRecord, status: 'suspended' }],
              tenantId,
              activeRecord.legalEntityId
            )
          ),
          'LegalEntityContextInactiveError'
        )
      ).toBe(true);
    })
);

it.effect('rejects cross-tenant, malformed, and duplicate records', () =>
  Effect.gen(function* rejectsInvalidLegalEntityRecords() {
    expect(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyActiveLegalEntities(
            [
              {
                ...activeRecord,
                tenantId: '10000000-0000-4000-8000-000000000002',
              },
            ],
            tenantId
          )
        ),
        'LegalEntityContextInvalidError'
      )
    ).toBe(true);
    expect(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyActiveLegalEntities(
            [{ ...activeRecord, legalName: '' }],
            tenantId
          )
        ),
        'LegalEntityContextInvalidError'
      )
    ).toBe(true);
    expect(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyActiveLegalEntities(
            [activeRecord, { ...activeRecord }],
            tenantId
          )
        ),
        'LegalEntityContextAmbiguousError'
      )
    ).toBe(true);
  })
);

it.effect(
  'types database failures as sanitized legal-entity context unavailability',
  () =>
    Effect.gen(function* sanitizesLegalEntityDatabaseFailure() {
      const context = makeLegalEntityContext({
        executor: yield* makeTestDatabase(() =>
          Effect.fail(
            new SqlError({
              reason: new ConnectionError({
                cause: new Error('secret database diagnostic'),
              }),
            })
          )
        ),
      });
      const error = yield* Effect.flip(context.listActiveForTenant(tenantId));
      expect(
        Predicate.isTagged(error, 'LegalEntityContextUnavailableError')
      ).toBe(true);
      expect(
        Predicate.isTagged(error, 'LegalEntityContextUnavailableError')
          ? error.reason
          : undefined
      ).not.toMatch(/secret database diagnostic/u);
    })
);
