import { createHash } from 'node:crypto';

import {
  CustomerProfileSourceForbiddenProblemSchema,
  CustomerProfileSourceRequestSchema,
  CustomerProfileSourceResponseSchema,
  CustomerProfileSourceUnavailableProblemSchema,
} from '@app/commerce-customer-context/api/customer-profile-source';
import {
  SymmyRouteContextRequestSchema,
  SymmyRouteContextResponseSchema,
} from '@app/symmy-integration/api/symmy-route-context';
import { AdmitSymmyJobPayloadSchema } from '@app/symmy-integration/api/admit-symmy-job-action';
import { SymmyGroupCustomerRowsSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import { makeSymmyGovernedDispatch } from '../../api/symmy/governed-dispatch.ts';
import { SymmyClientIdempotencyKeySchema, symmyUnavailableProblem } from '../../api/symmy/contract.ts';
import type { SymmyIngressAdmission } from '../../api/symmy/transport.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const memberRouteId = '33333333-3333-4333-8333-333333333333';
const customerRouteId = '44444444-4444-4444-8444-444444444444';
const customerSourceRouteId = '55555555-5555-4555-8555-555555555555';
const profileId = '66666666-6666-4666-8666-666666666666';
const jobId = '77777777-7777-4777-8777-777777777777';
const symmyBase = '/shell-super-app-api/module-api/symmy-integration/membership-build/symmy-integration-api';
const commerceBase =
  '/shell-super-app-api/module-api/commerce-customer-context/customer-build/commerce-customer-context-api';
const sourceRead = {
  entrypointKey: 'commerce.customer-context.api.customer-profile-source',
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
};
const customerSource = {
  issuer: 'source-issuer',
  mappingRevision: 'customer-mapping-3',
  namespace: 'canonical-customers',
  recordType: 'CUSTOMER',
  route: { id: customerSourceRouteId, revision: 'customer-source-revision-4' },
};
const customersRoute = Schema.decodeUnknownSync(SymmyRouteContextResponseSchema)({
  allowedOwnerOperations: [
    { entrypointKey: 'party.registry.create-party', moduleId: 'party.registry', schemaVersion: '1' },
  ],
  issuerId: customerSource.issuer,
  legalEntityId,
  mappingVersion: 'customer-carrier-mapping-2',
  routeId: customerRouteId,
  routeRevision: 'customer-carrier-revision-2',
  sourceEntityKind: 'CUSTOMER',
  sourceMappingVersion: customerSource.mappingRevision,
  sourceNamespace: customerSource.namespace,
  sourceRouteId: customerSourceRouteId,
  sourceRouteRevision: customerSource.route.revision,
  tenantId,
});
const membershipRoute = (replay = false) => {
  const route = {
    allowedOwnerOperations: replay ? [] : [sourceRead],
    issuerId: customerSource.issuer,
    legalEntityId,
    mappingVersion: 'member-carrier-mapping',
    routeId: memberRouteId,
    routeRevision: 'member-carrier-revision',
    sourceMappingVersion: 'group-source-mapping',
    sourceNamespace: 'memberships',
    sourceRouteId: memberRouteId,
    sourceRouteRevision: 'group-source-revision',
    tenantId,
  };
  if (replay) {
    Object.assign(route, { replayIdempotencyDigest: 'a'.repeat(64) });
  }
  return Schema.decodeUnknownSync(SymmyRouteContextResponseSchema)(route);
};
const customer = (recordId: string, organization: boolean) =>
  Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema.members[1])({
    _tag: 'CURRENT',
    item: {
      icoAuthority: organization ? 'ORGANIZATION' : 'PERSONAL',
      partyRef: { moduleId: 'party.registry', resourceId: profileId, resourceType: 'party.registry.party', tenantId },
      partySourceReference: {
        occurrenceId: `party-${recordId}`,
        recordId,
        source: {
          issuer: customerSource.issuer,
          namespace: 'party-customers',
          recordType: 'CUSTOMER',
          routeRef: customerSourceRouteId,
        },
      },
      profile: {
        profileRef: {
          kind: 'COUNTERPARTY',
          moduleId: 'commerce.customer-context',
          resourceId: profileId,
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
          tenantId,
        },
        revision: 2,
        state: 'ACTIVE',
        subject: {
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: profileId,
            resourceType: 'party.registry.counterparty',
            tenantId,
          },
          kind: 'COUNTERPARTY',
        },
      },
      source: {
        ...customerSource,
        effectId: `profile-${recordId}`,
        occurrenceId: `customer-${recordId}`,
        order: 2,
        recordId,
        revision: 'customer-record-2',
      },
    },
  });
const key = Schema.decodeUnknownSync(SymmyClientIdempotencyKeySchema)('membership-replay-key');
const fixture = (
  options: {
    /** A customer whose current profile read Commerce refuses under Privacy, as it does once Privacy erased it. */
    readonly erased?: string;
    /** A customer record Privacy itself currently refuses, as the owner's own REFUSED result says. */
    readonly refused?: string;
    readonly replay?: boolean;
    readonly response?: typeof CustomerProfileSourceResponseSchema.Type;
    readonly route?: typeof SymmyRouteContextResponseSchema.Encoded;
    readonly selected?: ReturnType<typeof membershipRoute>;
    readonly unavailable?: boolean;
  } = {},
) => {
  const calls: { readonly authorization: string | null; readonly body: Schema.Json; readonly path: string }[] = [];
  const acquisitions: string[] = [];
  const routeSelections: (typeof SymmyRouteContextRequestSchema.Type)[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = Schema.decodeUnknownSync(Schema.Json)(await request.json());
    calls.push({ authorization: request.headers.get('authorization'), body, path });
    if (path.endsWith('/reads/symmy-route-context')) {
      return Response.json(options.route ?? customersRoute);
    }
    if (path.endsWith('/reads/customer-profile-source')) {
      if (options.unavailable === true) {
        return Response.json(
          Schema.encodeSync(CustomerProfileSourceUnavailableProblemSchema)(
            CustomerProfileSourceUnavailableProblemSchema.make({
              detail: 'Current owner unavailable',
              retryable: true,
              status: 503,
              title: 'Unavailable',
              type: 'about:blank',
            }),
          ),
          { headers: { 'content-type': 'application/problem+json' }, status: 503 },
        );
      }
      const query = Schema.decodeUnknownSync(CustomerProfileSourceRequestSchema)(body);
      if (query.mode !== 'CURRENT') {
        return Response.json({}, { status: 500 });
      }
      if (query.recordId === options.erased) {
        return Response.json(
          Schema.encodeSync(CustomerProfileSourceForbiddenProblemSchema)(
            CustomerProfileSourceForbiddenProblemSchema.make({
              detail: 'Current Privacy does not authorize this source Profile read',
              status: 403,
              title: 'Forbidden',
              type: 'about:blank',
            }),
          ),
          { headers: { 'content-type': 'application/problem+json' }, status: 403 },
        );
      }
      if (query.recordId === options.refused) {
        return Response.json({ _tag: 'REFUSED' });
      }
      return Response.json(
        options.response ??
          (query.recordId === 'unknown'
            ? { _tag: 'ABSENT' }
            : customer(query.recordId, query.recordId === 'organization')),
      );
    }
    if (path.endsWith('/actions/admit-symmy-job')) {
      Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(body);
      return Response.json({ jobId, phase: 'admitted' });
    }
    return Response.json({}, { status: 500 });
  };
  const admission: SymmyIngressAdmission = {
    acquireOwnerAssertion: ({ audience }) =>
      Effect.sync(() => {
        acquisitions.push(audience);
        return {
          apiBaseUrl: audience === 'commerce-customer-context' ? commerceBase : symmyBase,
          assertion: Redacted.make(`read-${audience}`),
          compositionRevision: admission.compositionRevision,
        };
      }),
    acquireRouteAssertion: (request) =>
      Effect.sync(() => {
        routeSelections.push(Schema.decodeUnknownSync(SymmyRouteContextRequestSchema)(request));
        return {
          apiBaseUrl: symmyBase,
          assertion: Redacted.make('membership-scoped-credential'),
          compositionRevision: admission.compositionRevision,
          route: options.selected ?? membershipRoute(options.replay),
        };
      }),
    apiBaseUrl: symmyBase,
    assertion: Redacted.make('tenant-context-credential'),
    compositionRevision: 'b'.repeat(64),
  };
  const submit = (...ids: readonly string[]) => {
    const request = {
      code: 'wholesale',
      groupCustomers: Schema.decodeUnknownSync(SymmyGroupCustomerRowsSchema)(ids.map((customerId) => ({ customerId }))),
      idempotencyKey: key,
      route: 'customerGroupCustomersBatch' as const,
      // Extra runtime input is deliberately untrusted. The dispatch must derive facts, never forward this field.
      groupCustomerFacts: [{ forged: true }],
    };
    return makeSymmyGovernedDispatch(Effect.succeed('membership-correlation'))
      .submit({ admission, request })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
  };
  return { acquisitions, calls, routeSelections, submit };
};

describe('membership fresh admission owner reads', () => {
  it.effect(
    'reads actual customer source authority before admission, preserving mixed item order and ignoring payload facts',
    () =>
      Effect.gen(function* fresh() {
        const current = fixture();
        expect(yield* current.submit('person', 'unknown', 'organization')).toBe(jobId);
        expect(current.calls.map(({ path }) => path.split('/').at(-1))).toEqual([
          'symmy-route-context',
          'customer-profile-source',
          'customer-profile-source',
          'customer-profile-source',
          'admit-symmy-job',
        ]);
        expect(current.routeSelections).toEqual([
          { code: 'wholesale', replayIdempotencyKey: key, routeKey: 'customerGroupCustomersBatch' },
        ]);
        expect(current.calls[0]).toMatchObject({
          authorization: 'Bearer tenant-context-credential',
          body: { routeKey: 'customersBatch' },
        });
        const reads = current.calls.slice(1, -1).map(({ body }) => body);
        expect(reads).toEqual(
          ['person', 'unknown', 'organization'].map((recordId) => ({ ...customerSource, mode: 'CURRENT', recordId })),
        );
        const admitted = Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(current.calls.at(-1)?.body);
        expect(
          admitted.groupCustomerFacts?.profiles.map(({ customerSource: source, processingKind }) => [
            source.recordId,
            processingKind,
          ]),
        ).toEqual([
          ['person', 'PERSONAL'],
          ['organization', 'ORG_BUSINESS_REFERENCE'],
        ]);
        expect(admitted.groupCustomers?.map(({ customerId }) => customerId)).toEqual([
          'person',
          'unknown',
          'organization',
        ]);
        expect(current.calls.at(-1)?.authorization).toBe('Bearer membership-scoped-credential');
        expect(current.acquisitions).toEqual([
          'commerce-customer-context',
          'commerce-customer-context',
          'commerce-customer-context',
        ]);
      }),
  );
  it.effect('retains the exact queried authority when every current customer is ABSENT', () =>
    Effect.gen(function* unknownOnly() {
      const current = fixture();
      yield* current.submit('unknown');
      expect(
        Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(current.calls.at(-1)?.body).groupCustomerFacts,
      ).toEqual({ authority: customerSource, profiles: [] });
    }),
  );
  it.effect('skips every current owner read and omits facts on exact replay', () =>
    Effect.gen(function* replay() {
      const current = fixture({ replay: true, unavailable: true });
      yield* current.submit('person');
      expect(current.calls).toHaveLength(1);
      expect(current.acquisitions).toEqual([]);
      expect(
        Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(current.calls[0]?.body).groupCustomerFacts,
      ).toBeUndefined();
    }),
  );
  it.effect('roundtrips raw ERP IDs while reading canonical customer-record wire IDs without normalization', () =>
    Effect.gen(function* canonicalCustomerIds() {
      const current = fixture();
      const ids = ['customer-1', 'x'.repeat(200), 'ž'.repeat(201), ' padded ', 'e\u0301', 'é'];
      const canonicalIds = ids.map((customerId) => {
        if (customerId.length <= 200 && customerId === customerId.trim()) {
          return customerId;
        }
        const hash = createHash('sha256').update(`customer-record\u0000${customerId}`).digest('hex');
        return `symmy-customer:${hash}`;
      });
      const claims = ids.flatMap((customerId, index) => {
        const recordId = canonicalIds[index];
        return recordId?.startsWith('symmy-customer:') === true
          ? [
              {
                ...customerSource,
                recordId,
                tenantId,
                wireDigest: createHash('sha256').update(`customer-record\u0000${customerId}`).digest('hex'),
              },
            ]
          : [];
      });
      yield* current
        .submit(...ids)
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ONTOS_SYMMY_CUSTOMER_RECORD_PROVENANCE: JSON.stringify(claims) }),
          ),
        );
      expect(
        current.calls
          .slice(1, -1)
          .map(({ body }) => Schema.decodeUnknownSync(CustomerProfileSourceRequestSchema)(body)),
      ).toEqual(canonicalIds.map((recordId) => ({ ...customerSource, mode: 'CURRENT', recordId })));
      const admitted = Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(current.calls.at(-1)?.body);
      const roundtrip = Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(
        Schema.encodeSync(AdmitSymmyJobPayloadSchema)(admitted),
      );
      expect(roundtrip.groupCustomerFacts?.profiles.map(({ customerSource: source }) => source.recordId)).toEqual(
        canonicalIds,
      );
      expect(roundtrip.groupCustomers?.map(({ customerId }) => customerId)).toEqual(ids);
    }),
  );
  it.effect('never resolves an erased customer: its refused current read admits no job and names no profile', () =>
    Effect.gen(function* erasedCustomer() {
      const current = fixture({ erased: 'erased' });
      expect(yield* current.submit('person', 'erased').pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(current.calls.map(({ path }) => path.split('/').at(-1))).toEqual([
        'symmy-route-context',
        'customer-profile-source',
        'customer-profile-source',
      ]);
    }),
  );
  it.effect('refuses the whole request when the owner answers that Privacy refuses one of its customers', () =>
    Effect.gen(function* refusedCustomer() {
      const current = fixture({ refused: 'refused' });
      expect(yield* current.submit('person', 'refused').pipe(Effect.flip)).toMatchObject({ status: 403 });
      // Nothing is admitted, so nothing of that customer is planned, pinned or kept.
      expect(current.calls.some(({ path }) => path.endsWith('/actions/admit-symmy-job'))).toBe(false);
    }),
  );
  it.effect('fails before admission when the authoritative owner is unavailable', () =>
    Effect.gen(function* ownerUnavailable() {
      const current = fixture({ unavailable: true });
      expect(yield* current.submit('person').pipe(Effect.flip)).toEqual(symmyUnavailableProblem);
      expect(current.calls.some(({ path }) => path.endsWith('/actions/admit-symmy-job'))).toBe(false);
    }),
  );
  const { sourceEntityKind: _kind, ...withoutKind } = customersRoute;
  for (const route of [
    { ...customersRoute, tenantId: profileId },
    { ...customersRoute, legalEntityId: profileId },
    { ...customersRoute, issuerId: 'another-source' },
    withoutKind,
  ]) {
    it.effect(`refuses mismatched customer route ${JSON.stringify(route)}`, () =>
      Effect.gen(function* wrongRoute() {
        const current = fixture({ route });
        expect(yield* current.submit('person').pipe(Effect.flip)).toMatchObject({ status: 503 });
        expect(current.calls).toHaveLength(1);
        expect(current.acquisitions).toEqual([]);
      }),
    );
  }
  for (const changed of [
    { issuer: 'other-issuer' },
    { namespace: 'other-namespace' },
    { recordId: 'other-customer' },
    { recordType: 'OTHER' },
    { mappingRevision: 'other-mapping' },
    { route: { ...customerSource.route, id: memberRouteId } },
    { route: { ...customerSource.route, revision: 'other-revision' } },
  ]) {
    it.effect(`rejects same-tenant crossed-source current profile ${JSON.stringify(changed)}`, () =>
      Effect.gen(function* crossedSource() {
        const response = customer('person', false);
        const current = fixture({
          response: {
            ...response,
            item: {
              ...response.item,
              source: { ...response.item.source, ...changed },
            },
          },
        });
        expect(yield* current.submit('person').pipe(Effect.flip)).toMatchObject({ status: 503 });
        expect(current.calls).toHaveLength(2);
      }),
    );
  }
  const baseline = customer('person', false);
  const { icoAuthority: _authority, ...unproven } = baseline.item;
  for (const [name, response] of [
    [
      'profile tenant',
      {
        ...baseline,
        item: {
          ...baseline.item,
          profile: {
            ...baseline.item.profile,
            profileRef: { ...baseline.item.profile.profileRef, tenantId: profileId },
          },
        },
      },
    ],
    [
      'Party tenant',
      { ...baseline, item: { ...baseline.item, partyRef: { ...baseline.item.partyRef, tenantId: profileId } } },
    ],
    ['missing Counterparty processing authority', { ...baseline, item: unproven }],
    ['non-CURRENT owner projection', { _tag: 'PAGE', items: [], nextCursor: null }],
  ] as const) {
    it.effect(`fails before admission for ${name}`, () =>
      Effect.gen(function* invalidCurrent() {
        const current = fixture({ response });
        expect(yield* current.submit('person').pipe(Effect.flip)).toMatchObject({ status: 503 });
        expect(current.calls).toHaveLength(2);
        expect(current.calls.some(({ path }) => path.endsWith('/actions/admit-symmy-job'))).toBe(false);
      }),
    );
  }
  it.effect('refuses an inactive profile for its item alone and admits the request', () =>
    Effect.gen(function* inactiveProfile() {
      const current = fixture({
        response: {
          ...baseline,
          item: { ...baseline.item, profile: { ...baseline.item.profile, state: 'SUSPENDED' } },
        },
      });
      expect(yield* current.submit('person')).toBe(jobId);
      const admitted = Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(current.calls.at(-1)?.body);
      expect(admitted.groupCustomerFacts).toEqual({ authority: customerSource, profiles: [] });
      expect(admitted.groupCustomers?.map(({ customerId }) => customerId)).toEqual(['person']);
    }),
  );
  it.effect('requires an explicitly enrolled current-profile read before obtaining owner credentials', () =>
    Effect.gen(function* missingEnrollment() {
      const selected = membershipRoute();
      const current = fixture({
        selected: {
          ...selected,
          allowedOwnerOperations: [
            { ...sourceRead, entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source' },
          ],
        },
      });
      expect(yield* current.submit('person').pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(current.calls).toEqual([]);
      expect(current.acquisitions).toEqual([]);
    }),
  );
});
