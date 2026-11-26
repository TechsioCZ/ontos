import { OntosRegisteredWorkloadCallsSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { symmyIntegrationRegisteredWorkloadCalls } from '../../src/registered-workload-calls.ts';

it('publishes an unambiguous source call set and retains exact Catalog localized-facts execution and recovery', () => {
  const calls = Schema.decodeUnknownSync(OntosRegisteredWorkloadCallsSchema)(symmyIntegrationRegisteredWorkloadCalls);
  const selected = calls.filter(
    (call) =>
      call.audience === 'catalog' &&
      (call.declarationKey === 'commerce.catalog.product-localized-facts.set' ||
        call.declarationKey === 'commerce.catalog.set-product-localized-facts-recovery.read'),
  );
  expect(selected).toEqual([
    {
      audience: 'catalog',
      declarationKey: 'commerce.catalog.product-localized-facts.set',
      entrypointKey: 'commerce.catalog.set-product-localized-facts',
      jobKey: 'integration.symmy.execute-symmy-job',
      legalEntityScope: 'forbidden',
      schemaVersion: '1',
      workerKey: 'integration.symmy.execute-symmy-job',
      workloadKey: 'commerce.catalog.symmy-product-import',
    },
    {
      allowHistoricalDeliveryRecovery: true,
      audience: 'catalog',
      declarationKey: 'commerce.catalog.set-product-localized-facts-recovery.read',
      entrypointKey: 'commerce.catalog.api.set-product-localized-facts-recovery',
      jobKey: 'integration.symmy.execute-symmy-job',
      legalEntityScope: 'forbidden',
      recoveryOf: {
        actionKey: 'commerce.catalog.set-product-localized-facts',
        jobKey: 'integration.symmy.execute-symmy-job',
      },
      schemaVersion: '1',
      workerKey: 'integration.symmy.execute-symmy-job',
      workloadKey: 'commerce.catalog.symmy-product-read',
    },
  ]);
  for (const declarationKey of [
    'commerce.catalog.variant-localized-facts.set',
    'commerce.catalog.set-variant-localized-facts-recovery.read',
    'commerce.catalog.sku.assign',
    'commerce.catalog.assign-sku-recovery.read',
  ]) {
    expect(calls.some((call) => call.declarationKey === declarationKey)).toBe(true);
  }
});

it.effect('imports the real owner manifest with unique conditional operation requirements', () =>
  Effect.gen(function* manifestRequirements() {
    const { symmyIntegrationManifest } = yield* Effect.promise(() => import('../../vertical.manifest.ts'));
    expect(symmyIntegrationManifest.module.id).toBe('integration.symmy');
    const requirements = symmyIntegrationManifest.requirements?.operations ?? [];
    expect(new Set(requirements.map((requirement) => requirement.key)).size).toBe(requirements.length);
  }),
);
