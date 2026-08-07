/* eslint-disable unicorn/no-await-expression-member -- Assertions read the exact Effect result inline. */
import assert from 'node:assert/strict';
// @effect-diagnostics anyUnknownInErrorContext:off asyncFunction:off
import test from 'node:test';
import { Effect } from 'effect';
import {
  classifyActiveLegalEntities,
  classifySelectedLegalEntity,
  makeLegalEntityContext,
} from '../../src/auth/legal-entity-context.ts';
import type {
  LegalEntityContextError,
  LegalEntityContextRecord,
} from '../../src/auth/legal-entity-context.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const activeRecord: LegalEntityContextRecord = {
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  legalName: 'Zeta s.r.o.',
  status: 'active',
  tenantId,
};

const failureTag = async (
  effect: Effect.Effect<unknown, LegalEntityContextError>,
): Promise<string> => (await Effect.runPromise(Effect.flip(effect)))._tag;

test('lists zero, one, and many active legal entities in deterministic safe order', async () => {
  assert.deepEqual(await Effect.runPromise(classifyActiveLegalEntities([], tenantId)), []);
  assert.deepEqual(await Effect.runPromise(classifyActiveLegalEntities([activeRecord], tenantId)), [
    { legalEntityId: activeRecord.legalEntityId, legalName: 'Zeta s.r.o.' },
  ]);
  assert.deepEqual(
    await Effect.runPromise(
      classifyActiveLegalEntities(
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
        tenantId,
      ),
    ),
    [
      {
        legalEntityId: '20000000-0000-4000-8000-000000000002',
        legalName: 'Alpha s.r.o.',
      },
      {
        legalEntityId: '20000000-0000-4000-8000-000000000003',
        legalName: 'Alpha s.r.o.',
      },
      { legalEntityId: activeRecord.legalEntityId, legalName: 'Zeta s.r.o.' },
    ],
  );
});

test('validates exactly one active selection and rejects missing or inactive selections', async () => {
  assert.deepEqual(
    await Effect.runPromise(
      classifySelectedLegalEntity([activeRecord], tenantId, activeRecord.legalEntityId),
    ),
    { legalEntityId: activeRecord.legalEntityId, legalName: activeRecord.legalName },
  );
  assert.equal(
    await failureTag(
      classifySelectedLegalEntity([activeRecord], tenantId, '20000000-0000-4000-8000-000000000099'),
    ),
    'LegalEntityContextMissingError',
  );
  assert.equal(
    await failureTag(
      classifySelectedLegalEntity(
        [{ ...activeRecord, status: 'suspended' }],
        tenantId,
        activeRecord.legalEntityId,
      ),
    ),
    'LegalEntityContextInactiveError',
  );
});

test('rejects cross-tenant, malformed, and duplicate records', async () => {
  assert.equal(
    await failureTag(
      classifyActiveLegalEntities(
        [{ ...activeRecord, tenantId: '10000000-0000-4000-8000-000000000002' }],
        tenantId,
      ),
    ),
    'LegalEntityContextInvalidError',
  );
  assert.equal(
    await failureTag(classifyActiveLegalEntities([{ ...activeRecord, legalName: '' }], tenantId)),
    'LegalEntityContextInvalidError',
  );
  assert.equal(
    await failureTag(classifyActiveLegalEntities([activeRecord, { ...activeRecord }], tenantId)),
    'LegalEntityContextAmbiguousError',
  );
});

test('types database failures as sanitized legal-entity context unavailability', async () => {
  const context = makeLegalEntityContext({
    executor: {
      select: () => {
        throw new Error('secret database diagnostic');
      },
    } as never,
  });
  const error = await Effect.runPromise(Effect.flip(context.listActiveForTenant(tenantId)));
  assert.equal(error._tag, 'LegalEntityContextUnavailableError');
  assert.doesNotMatch(error.reason, /secret database diagnostic/u);
});
