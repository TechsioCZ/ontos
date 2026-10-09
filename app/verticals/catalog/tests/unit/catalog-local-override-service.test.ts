import { Effect, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  CatalogFactAdmission,
  CatalogLocalOverride,
  CatalogSourceAssertion,
} from '../../src/domain/catalog-source-resolution.ts';
import { resolveCatalogSourceFact } from '../../src/domain/catalog-source-resolution.ts';
import { catalogLocalOverridePermission } from '../../src/domain/catalog-local-override.ts';
import { makeCatalogLocalOverrideService } from '../../src/persistence/catalog-local-override-service.ts';
import type { CatalogSourceResolutionPorts } from '../../src/persistence/catalog-source-resolution-ports.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-09-18T12:00:00.000Z');
const scope = { factKey: 'height', targetId: productId, targetKind: 'PRODUCT', tenantId } as const;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const correction = (evidenceRef: string, reason: string) =>
  ({
    affectsOpenSelection: true,
    evidenceRefs: [evidenceRef],
    kind: 'COSMETIC_CORRECTION',
    productRef,
    reason,
  }) as const;

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

const createStore = (seed?: { readonly bases?: readonly CatalogSourceAssertion<string>[] }) => {
  const overrides: CatalogLocalOverride<string>[] = [];
  const bases = [...(seed?.bases ?? [])];
  const activeRevision = (): bigint | null => {
    let latest: bigint | null = null;
    for (const override of overrides) {
      if (override.lifecycle === 'ACTIVE' && (latest === null || override.revision > latest)) {
        latest = override.revision;
      }
    }
    return latest;
  };
  const ports: CatalogSourceResolutionPorts<string> = {
    appendAcceptedBase: () => Effect.succeed({ status: 'INSERTED' as const }),
    appendOverrideRevision: ({ expectedRevision, override }) =>
      Effect.sync(() => {
        const current = activeRevision();
        if ((expectedRevision ?? null) !== current) {
          return { activeRevision: current, reason: 'Compare-and-set conflict', status: 'CONFLICT' as const };
        }
        overrides.push(override);
        return { status: 'APPLIED' as const };
      }),
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

const createAdmission = (input?: {
  readonly admission?: CatalogFactAdmission | null;
  readonly allowedPermissions?: readonly string[];
  readonly valueValid?: boolean;
}) => {
  const requestedPermissions: string[] = [];
  const allowed = new Set(input?.allowedPermissions ?? Object.values(catalogLocalOverridePermission));
  const admission =
    input?.admission === undefined
      ? {
          assertionAdmission: 'NONE' as const,
          factOwnership: 'CATALOG_LOCAL' as const,
          overridePermitted: true,
          overrideValueValid: true,
        }
      : input.admission;
  return {
    ports: {
      authorizeOverrideOperation: (request: { readonly permissionKey: string }) => {
        requestedPermissions.push(request.permissionKey);
        return Effect.succeed(allowed.has(request.permissionKey));
      },
      isAssertionValueValid: () => Effect.succeed(true),
      isOverrideValueValid: () => Effect.succeed(input?.valueValid ?? true),
      readAdmission: () => Effect.succeed(Option.fromNullishOr(admission)),
    },
    requestedPermissions,
  };
};

const makeService = (input: {
  readonly admission: ReturnType<typeof createAdmission>;
  readonly casConflict?: boolean;
  readonly events: ReturnType<typeof createEvents>;
  readonly store: ReturnType<typeof createStore>;
}) => {
  const store =
    input.casConflict === true
      ? {
          ...input.store.ports,
          appendOverrideRevision: () =>
            Effect.succeed({ activeRevision: null, reason: 'Concurrent release', status: 'CONFLICT' as const }),
        }
      : input.store.ports;
  return makeCatalogLocalOverrideService<string>({
    admission: input.admission.ports,
    events: input.events.ports,
    store,
    valuesEqual: (left, right) => left === right,
  });
};

describe('Catalog Local Override service', () => {
  it.effect('activates one override and emits a resolved-Current change', () =>
    Effect.gen(function* testActivate() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const admission = createAdmission();
      const service = makeService({ admission, events, store });
      const result = yield* service.activate({
        at,
        classification: correction('evidence-1', 'Measured correction'),
        evidenceRef: 'evidence-1',
        principalId: 'principal-1',
        reason: 'Measured correction',
        scope,
        value: '90 cm',
      });
      expect(result).toMatchObject({
        action: 'ACTIVATE',
        classification: { kind: 'COSMETIC_CORRECTION' },
        resolved: { source: 'LOCAL_OVERRIDE', status: 'CURRENT', value: '90 cm' },
        resolvedCurrentChanged: true,
        status: 'APPLIED',
      });
      expect(events.emitted).toEqual([{ cause: 'OVERRIDE_ACTIVATED' }]);
      expect(admission.requestedPermissions).toEqual(['commerce.catalog.activate-local-override']);
    }),
  );

  it.effect('keeps a single active winner and refuses a second activation', () =>
    Effect.gen(function* testSingleWinner() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const admission = createAdmission();
      const service = makeService({ admission, events, store });
      yield* service.activate({
        at,
        classification: correction('evidence-1', 'Measured correction'),
        evidenceRef: 'evidence-1',
        principalId: 'principal-1',
        reason: 'Measured correction',
        scope,
        value: '90 cm',
      });
      const second = yield* service.activate({
        at,
        evidenceRef: 'evidence-2',
        principalId: 'principal-2',
        reason: 'Another correction',
        scope,
        value: '91 cm',
      });
      expect(second.status).toBe('ALREADY_ACTIVE');
      expect(store.overrides).toHaveLength(1);
      expect(events.emitted).toHaveLength(1);
    }),
  );

  it.effect('requires compare-and-set for change and distinct permissions per operation', () =>
    Effect.gen(function* testChange() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const admission = createAdmission();
      const service = makeService({ admission, events, store });
      yield* service.activate({
        at,
        classification: correction('evidence-1', 'Measured correction'),
        evidenceRef: 'evidence-1',
        principalId: 'principal-1',
        reason: 'Measured correction',
        scope,
        value: '90 cm',
      });
      const stale = yield* service.change({
        at,
        evidenceRef: 'evidence-2',
        expectedRevision: 99n,
        principalId: 'principal-1',
        reason: 'Retry with a stale editor',
        scope,
        value: '91 cm',
      });
      expect(stale.status).toBe('STALE_EDITOR');
      const changed = yield* service.change({
        at,
        classification: correction('evidence-3', 'Corrected again'),
        evidenceRef: 'evidence-3',
        expectedRevision: 1n,
        principalId: 'principal-1',
        reason: 'Corrected again',
        scope,
        value: '91 cm',
      });
      expect(changed).toMatchObject({ resolvedCurrentChanged: true, status: 'APPLIED' });
      expect(admission.requestedPermissions).toEqual([
        'commerce.catalog.activate-local-override',
        'commerce.catalog.change-local-override',
        'commerce.catalog.change-local-override',
      ]);
    }),
  );

  it.effect('releases to the newest usable accepted base rather than the pre-override value', () =>
    Effect.gen(function* testReleaseToLatestBase() {
      const store = createStore({ bases: [base80, base95] });
      const events = createEvents();
      const admission = createAdmission();
      const service = makeService({ admission, events, store });
      yield* service.activate({
        at,
        classification: correction('evidence-1', 'Measured correction'),
        evidenceRef: 'evidence-1',
        principalId: 'principal-1',
        reason: 'Measured correction',
        scope,
        value: '90 cm',
      });
      const released = yield* service.release({
        at,
        evidenceRef: 'evidence-2',
        expectedRevision: 1n,
        principalId: 'principal-1',
        reason: 'Upstream corrected',
        scope,
      });
      expect(released).toMatchObject({
        resolved: { source: 'BASE', status: 'CURRENT', value: '95 cm' },
        resolvedCurrentChanged: true,
        status: 'APPLIED',
      });
      expect(store.overrides.at(-1)).toMatchObject({ lifecycle: 'RELEASED', revision: 2n, value: '90 cm' });
    }),
  );

  it.effect('requires the same evidenced classification before changing a Product fact', () =>
    Effect.gen(function* testClassificationRequired() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const admission = createAdmission();
      const service = makeService({ admission, events, store });
      const result = yield* service.activate({
        at,
        evidenceRef: 'evidence-1',
        principalId: 'principal-1',
        reason: 'Measured correction',
        scope,
        value: '90 cm',
      });
      expect(result).toMatchObject({ status: 'INVALID' });
      expect(store.overrides).toEqual([]);
      expect(events.emitted).toEqual([]);
    }),
  );

  it.effect('declares absence on release without a usable base and leaves nothing secretly active', () =>
    Effect.gen(function* testReleaseWithoutBase() {
      const store = createStore();
      const events = createEvents();
      const admission = createAdmission();
      const service = makeService({ admission, events, store });
      yield* service.activate({
        at,
        evidenceRef: 'evidence-1',
        principalId: 'principal-1',
        reason: 'Measured correction',
        scope,
        value: '90 cm',
      });
      const released = yield* service.release({
        at,
        evidenceRef: 'evidence-2',
        expectedRevision: 1n,
        principalId: 'principal-1',
        reason: 'Upstream retracted',
        scope,
      });
      expect(released.status).toBe('APPLIED');
      expect(released.status === 'APPLIED' && released.resolved.status).toBe('ABSENT');
      expect(
        resolveCatalogSourceFact({
          acceptedBases: store.bases,
          admission: {
            assertionAdmission: 'NONE',
            factOwnership: 'CATALOG_LOCAL',
            overridePermitted: true,
            overrideValueValid: true,
          },
          at,
          overrides: store.overrides,
          scope,
          valuesEqual: (left, right) => left === right,
        }).status,
      ).toBe('ABSENT');
    }),
  );

  it.effect('refuses Price and other foreign-owned facts and required permissions', () =>
    Effect.gen(function* testGuards() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const admission = createAdmission();
      const service = makeService({ admission, events, store });
      const forbidden = yield* service.activate({
        at,
        evidenceRef: 'evidence-1',
        principalId: 'principal-1',
        reason: 'Not allowed',
        scope: { ...scope, factKey: 'price.amount' },
        value: '100 EUR',
      });
      expect(forbidden.status).toBe('FORBIDDEN_FACT');
      const foreignOwner = createAdmission({
        admission: {
          assertionAdmission: 'EXTERNAL_SOURCE',
          factOwnership: 'EXTERNAL_SOURCE',
          overridePermitted: false,
          overrideValueValid: false,
        },
      });
      const foreignService = makeService({ admission: foreignOwner, events, store });
      expect(
        (yield* foreignService.activate({
          at,
          evidenceRef: 'evidence-1',
          principalId: 'principal-1',
          reason: 'Not allowed',
          scope,
          value: '90 cm',
        })).status,
      ).toBe('NO_AUTHORITY');
      const noPermission = createAdmission({ allowedPermissions: [] });
      const deniedService = makeService({ admission: noPermission, events, store });
      expect(
        (yield* deniedService.activate({
          at,
          evidenceRef: 'evidence-1',
          principalId: 'principal-1',
          reason: 'Not allowed',
          scope,
          value: '90 cm',
        })).status,
      ).toBe('PERMISSION_REQUIRED');
    }),
  );

  it.effect('rejects an invalid override value and never writes it', () =>
    Effect.gen(function* testInvalidValue() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const admission = createAdmission({ valueValid: false });
      const service = makeService({ admission, events, store });
      const result = yield* service.activate({
        at,
        classification: correction('evidence-1', 'Measured correction'),
        evidenceRef: 'evidence-1',
        principalId: 'principal-1',
        reason: 'Invalid',
        scope,
        value: 'not a height',
      });
      expect(result.status).toBe('INVALID');
      expect(store.overrides).toEqual([]);
      expect(events.emitted).toEqual([]);
    }),
  );

  it.effect('reports a concurrent compare-and-set conflict without emitting a change', () =>
    Effect.gen(function* testCasConflict() {
      const store = createStore({ bases: [base80] });
      const events = createEvents();
      const admission = createAdmission();
      const service = makeService({ admission, casConflict: true, events, store });
      const result = yield* service.activate({
        at,
        classification: correction('evidence-1', 'Measured correction'),
        evidenceRef: 'evidence-1',
        principalId: 'principal-1',
        reason: 'Measured correction',
        scope,
        value: '90 cm',
      });
      expect(result.status).toBe('CONFLICT');
      expect(events.emitted).toEqual([]);
    }),
  );
});
