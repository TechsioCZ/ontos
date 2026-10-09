import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { CatalogExternalSourceRecordRefSchema } from '../../shared/domain/external-identifier-boundary.ts';
import type {
  CatalogExternalTargetRequest,
  CatalogResolvedExternalTarget,
} from '../../shared/domain/external-target-resolution.ts';
import { resolveCatalogSourceAuthority } from '../../src/domain/catalog-source-authority.ts';
import type { CatalogSourceAuthorityRequest } from '../../src/domain/catalog-source-authority.ts';
import type { CatalogLocalOverride, CatalogSourceAssertion } from '../../src/domain/catalog-source-resolution.ts';
import {
  makeCatalogImportAcceptanceService,
  summarizeCatalogImportItems,
} from '../../src/persistence/catalog-import-acceptance-service.ts';
import type { CatalogImportDeliveredItem } from '../../src/persistence/catalog-import-acceptance-service.ts';
import type { ExternalCorrelationResolutionFailure } from '../../src/persistence/external-correlation-resolver.ts';
import { ExternalCorrelationMissingLink } from '../../src/persistence/external-correlation-missing-link.ts';
import type { CatalogSourceResolutionPorts } from '../../src/persistence/catalog-source-resolution-ports.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-09-18T12:00:00.000Z');
const scope = { factKey: 'height', targetId: productId, targetKind: 'PRODUCT', tenantId } as const;

const decodeTarget = Schema.decodeUnknownSync(CatalogResourceRefSchema, { onExcessProperty: 'error' });
const decodeSource = Schema.decodeUnknownSync(CatalogExternalSourceRecordRefSchema, { onExcessProperty: 'error' });

const target = decodeTarget({
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
});
const productRef = { ...target, resourceType: 'commerce.catalog.product' as const };
const sourceRecord = decodeSource({
  issuerId: 'source-1',
  issuerKind: 'EXTERNAL_BUSINESS_SYSTEM',
  recordId: 'record-1',
  recordNamespace: 'product',
  tenantId,
});
const resolvedTarget: CatalogResolvedExternalTarget = {
  capture: 'ALREADY_OWNER_CONFIRMED',
  correlationRef: 'corr-1',
  factAuthority: 'TARGET_ONLY',
  source: 'OWNER_CORRELATION',
  status: 'RESOLVED',
  target,
  targetKind: 'PRODUCT',
};

const base80: CatalogSourceAssertion<string> = {
  assertionId: 'assertion-r1',
  effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
  evidencedAt: new Date('2026-09-02T00:00:00.000Z'),
  issuerSystemId: 'source-1',
  scope,
  sourceRecordId: 'record-1',
  sourceRevision: 1n,
  value: '80 cm',
  valueFingerprint: 'height:80cm',
};
const base95: CatalogSourceAssertion<string> = {
  ...base80,
  assertionId: 'assertion-r2',
  sourceRevision: 2n,
  value: '95 cm',
  valueFingerprint: 'height:95cm',
};
const override90: CatalogLocalOverride<string> = {
  actorPrincipalId: 'principal-1',
  evidenceRef: 'evidence-1',
  lifecycle: 'ACTIVE',
  reason: 'Measured correction',
  revision: 1n,
  scope,
  value: '90 cm',
};

const correctionFor = (assertion: CatalogSourceAssertion<string>) => ({
  affectsOpenSelection: true as const,
  evidenceRefs: [assertion.assertionId] as const,
  kind: 'COSMETIC_CORRECTION' as const,
  productRef,
  reason: 'The source corrects the recorded height of the same Product',
});

const delivered = (
  assertion: CatalogSourceAssertion<string>,
  classification?: ReturnType<typeof correctionFor>,
): CatalogImportDeliveredItem<string> => {
  const item = { assertion, captureConfirmed: true, recordMeaning: 'PRODUCT' as const, sourceRecord };
  return classification === undefined ? item : { ...item, classification };
};

const deliveredFrom = (
  assertion: CatalogSourceAssertion<string>,
  deliveredSourceRecord: typeof sourceRecord,
  classification?: ReturnType<typeof correctionFor>,
) => ({ ...delivered(assertion, classification), sourceRecord: deliveredSourceRecord });

const createStore = (seed?: {
  readonly bases?: readonly CatalogSourceAssertion<string>[];
  readonly overrides?: readonly CatalogLocalOverride<string>[];
}) => {
  const bases = [...(seed?.bases ?? [])];
  const overrides = [...(seed?.overrides ?? [])];
  const ports: CatalogSourceResolutionPorts<string> = {
    appendAcceptedBase: ({ assertion }) =>
      Effect.sync(() => {
        const exists = bases.some(
          (base) => base.assertionId === assertion.assertionId && base.sourceRevision === assertion.sourceRevision,
        );
        if (exists) {
          return { status: 'ALREADY_PRESENT' as const };
        }
        bases.push(assertion);
        return { status: 'INSERTED' as const };
      }),
    appendOverrideRevision: () =>
      Effect.sync(() => ({ activeRevision: null, reason: 'unsupported in this fixture', status: 'CONFLICT' as const })),
    readAcceptedBases: () => Effect.succeed([...bases]),
    readOverrides: () => Effect.succeed([...overrides]),
  };
  return { bases, overrides, ports };
};

const createEvents = () => {
  const emitted: { readonly cause: string }[] = [];
  return {
    emitted,
    ports: {
      emitResolvedCurrentChanged: (input: { readonly cause: string }) =>
        Effect.sync(() => {
          emitted.push({ cause: input.cause });
        }),
    },
  };
};

const authorityPorts = {
  resolveAuthority: (request: CatalogSourceAuthorityRequest) =>
    Effect.succeed(
      Option.fromNullishOr(
        resolveCatalogSourceAuthority(
          [{ factKey: 'height', issuerSystemId: 'source-1', targetKind: 'PRODUCT', tenantId }],
          request,
        ),
      ),
    ),
};

const admissionPorts = (input?: { readonly valueValid?: (assertionId: string) => boolean }) => ({
  authorizeOverrideOperation: () => Effect.succeed(true),
  isAssertionValueValid: (request: { readonly assertion: CatalogSourceAssertion<string> }) =>
    Effect.succeed(input?.valueValid?.(request.assertion.assertionId) ?? true),
  isOverrideValueValid: () => Effect.succeed(true),
  readAdmission: () =>
    Effect.succeed(
      Option.some({
        assertionAdmission: 'EXTERNAL_SOURCE' as const,
        factOwnership: 'CATALOG_LOCAL' as const,
        overridePermitted: true,
        overrideValueValid: true,
      }),
    ),
});

const makeService = (input: {
  readonly events: ReturnType<typeof createEvents>;
  readonly store: ReturnType<typeof createStore>;
  readonly target?: (
    request: CatalogExternalTargetRequest,
  ) => Effect.Effect<CatalogResolvedExternalTarget, ExternalCorrelationResolutionFailure>;
  readonly valueValid?: (assertionId: string) => boolean;
}) =>
  makeCatalogImportAcceptanceService<string>({
    admission: admissionPorts(input.valueValid === undefined ? undefined : { valueValid: input.valueValid }),
    authority: authorityPorts,
    events: input.events.ports,
    resolveTarget: input.target ?? (() => Effect.succeed(resolvedTarget)),
    store: input.store.ports,
    valuesEqual: (left, right) => left === right,
  });

describe('Catalog import acceptance service', () => {
  it.effect('accepts a newer base beneath an active override without claiming a resolved-Current change', () =>
    Effect.gen(function* testOverrideHidesBaseChange() {
      const store = createStore({ bases: [base80], overrides: [override90] });
      const events = createEvents();
      const service = makeService({ events, store });
      const result = yield* service.acceptBatch({ at, items: [delivered(base95, correctionFor(base95))] });
      expect(result.items[0]).toMatchObject({
        classification: { kind: 'COSMETIC_CORRECTION' },
        resolvedCurrentChanged: false,
        status: 'ACCEPTED_BASE',
      });
      expect(store.bases.map(({ sourceRevision }) => sourceRevision)).toEqual([1n, 2n]);
      expect(events.emitted).toEqual([]);
    }),
  );

  it.effect('emits exactly one resolved-Current change when a base actually moves Current', () =>
    Effect.gen(function* testBaseChangeEmits() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const service = makeService({ events, store });
      const result = yield* service.acceptBatch({ at, items: [delivered(base95, correctionFor(base95))] });
      expect(result.items[0]).toMatchObject({ resolvedCurrentChanged: true, status: 'ACCEPTED_BASE' });
      expect(events.emitted).toEqual([{ cause: 'IMPORT_ACCEPTED' }]);
    }),
  );

  it.effect('requires an evidenced classification before a changed Product fact is accepted', () =>
    Effect.gen(function* testClassificationRequired() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const service = makeService({ events, store });
      const result = yield* service.acceptBatch({ at, items: [delivered(base95)] });
      expect(result.items[0]).toMatchObject({ status: 'RECONCILIATION_REQUIRED' });
      expect(store.bases).toEqual([base80]);
      expect(events.emitted).toEqual([]);
    }),
  );

  it.effect('treats duplicate delivery as a no-op and keeps an older revision stale', () =>
    Effect.gen(function* testDuplicateAndStale() {
      const store = createStore({ bases: [base95] });
      const events = createEvents();
      const service = makeService({ events, store });
      const result = yield* service.acceptBatch({ at, items: [delivered(base95), delivered(base80)] });
      expect(result.items.map(({ status }) => status)).toEqual(['DUPLICATE', 'STALE']);
      expect(store.bases).toHaveLength(1);
      expect(events.emitted).toEqual([]);
    }),
  );

  it.effect('holds an unknown external ID and never creates a Product', () =>
    Effect.gen(function* testUnknownExternalId() {
      const store = createStore();
      const events = createEvents();
      const service = makeService({
        events,
        store,
        target: () => Effect.fail(new ExternalCorrelationMissingLink({ sourceRecord })),
      });
      const result = yield* service.acceptBatch({ at, items: [delivered(base80)] });
      expect(result.items[0]).toMatchObject({ status: 'HELD' });
      expect(store.bases).toEqual([]);
    }),
  );

  it.effect('does not treat omission of a record as deletion', () =>
    Effect.gen(function* testOmissionIsNotDeletion() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const service = makeService({ events, store });
      const result = yield* service.acceptBatch({ at, items: [] });
      expect(result.items).toEqual([]);
      expect(store.bases).toHaveLength(1);
    }),
  );

  it.effect('rejects an assertion whose scope does not match the confirmed target', () =>
    Effect.gen(function* testScopeTargetMismatch() {
      const store = createStore();
      const events = createEvents();
      const service = makeService({ events, store });
      const mismatched: CatalogSourceAssertion<string> = {
        ...base80,
        scope: { ...scope, targetId: '33333333-3333-4333-8333-333333333333' },
      };
      const result = yield* service.acceptBatch({ at, items: [delivered(mismatched)] });
      expect(result.items[0]).toMatchObject({ status: 'INVALID_TARGET' });
      expect(store.bases).toEqual([]);
    }),
  );

  it.effect('rejects a source with no verified authority for the exact fact', () =>
    Effect.gen(function* testNoAuthority() {
      const store = createStore();
      const events = createEvents();
      const service = makeService({ events, store });
      const foreign: CatalogSourceAssertion<string> = { ...base80, issuerSystemId: 'source-2' };
      const result = yield* service.acceptBatch({
        at,
        items: [deliveredFrom(foreign, decodeSource({ ...sourceRecord, issuerId: 'source-2' }))],
      });
      expect(result.items[0]).toMatchObject({ status: 'NO_AUTHORITY' });
      expect(store.bases).toEqual([]);
    }),
  );

  it.effect('returns one typed result per item so a batch cannot hide partial rejection', () =>
    Effect.gen(function* testPartialRejection() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const service = makeService({
        events,
        store,
        valueValid: (assertionId) => assertionId !== 'assertion-r-invalid',
      });
      const invalid: CatalogSourceAssertion<string> = {
        ...base80,
        assertionId: 'assertion-r-invalid',
        value: '200 cm',
        valueFingerprint: 'height:200cm',
      };
      const result = yield* service.acceptBatch({
        at,
        items: [delivered(base95, correctionFor(base95)), delivered(base80), delivered(invalid)],
      });
      expect(result.items.map(({ status }) => status)).toEqual(['ACCEPTED_BASE', 'STALE', 'INVALID_VALUE']);
      expect(result.summary).toMatchObject({
        acceptedBases: 1,
        allItemsResolved: true,
        rejected: 1,
        stale: 1,
      });
    }),
  );
});

describe('Catalog import batch summary', () => {
  it('makes held and reconciliation items visible instead of reporting batch success', () => {
    const summary = summarizeCatalogImportItems<string>([
      { reason: 'unknown external record', status: 'HELD' },
      { reason: 'ambiguous target', status: 'RECONCILIATION_REQUIRED' },
      { reason: 'registry unavailable', status: 'UNVERIFIABLE' },
    ]);
    expect(summary).toMatchObject({ allItemsResolved: false, held: 1, reconciliationRequired: 1, unverifiable: 1 });
  });
});
