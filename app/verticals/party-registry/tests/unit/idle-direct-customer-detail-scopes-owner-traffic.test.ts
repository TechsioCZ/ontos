// @rstest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { DateTime, Effect, Schema } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
import { acted, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { CounterpartyReadApi, CounterpartyReadResponseSchema } from '../../shared/apis/counterparty-read.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { PartyDetailApi } from '../../shared/apis/party-detail.ts';
import { PartyContactPointsApi } from '../../shared/apis/party-contact-points.ts';
import { PartyOfficialIdentifierHistoryApi } from '../../shared/apis/party-official-identifier-history.ts';
import { customerDetailData } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import type { CustomerDetailSnapshot } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import { customerDetailPageData } from '../../src/routes/[lang]/prodej/zakaznici/customer-detail-page-data.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const instant = '2026-10-15T10:00:00.000Z';
const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: partyId,
  resourceType: 'party.registry.party' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const party = Schema.decodeSync(PartySchema)({
  archivedAt: null,
  businessName: 'Before',
  createdAt: instant,
  displayName: 'Before',
  firstName: null,
  lastName: null,
  partyRef,
  partyType: 'ORGANIZATION',
  revision: 1,
  updatedAt: instant,
});
const snapshot: CustomerDetailSnapshot = {
  contacts: { status: 'ready', value: { items: [] } },
  counterparty: Schema.decodeSync(CounterpartyReadResponseSchema)({
    counterpartyRef,
    createdAt: instant,
    currentRoles: [
      {
        endProvenance: null,
        provenance: {
          evidenceReference: 'contract:2026-42',
          method: 'SIGNED_CONTRACT',
          reason: 'Signed customer agreement',
          source: 'contracts.core',
        },
        recordedAt: instant,
        rolePeriodRef: {
          moduleId: 'party.registry',
          resourceId: '50000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.counterparty-role-period',
          tenantId,
        },
        roleType: 'CUSTOMER',
        state: 'ACTIVE',
        validFrom: instant,
        validTo: null,
      },
    ],
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: '60000000-0000-4000-8000-000000000001',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    party: {
      archived: false,
      canonicalPartyRef: partyRef,
      displayName: 'Before',
      partyType: 'ORGANIZATION',
      storedPartyRef: partyRef,
    },
  }),
  identifiers: { status: 'ready', value: { items: [] } },
  identity: {
    status: 'ready',
    value: {
      currentFactAssertions: [],
      party,
      resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
    },
  },
  now: DateTime.makeUnsafe(instant),
};

const context = {
  legalEntityId: '60000000-0000-4000-8000-000000000001',
  principalId: 'principal-1',
  tenantId,
};
const input = { context, counterpartyId };
const reads: string[] = [];
const CounterpartyApi = CounterpartyReadApi.prefix('/party-registry-api');
const IdentityApi = PartyDetailApi.prefix('/party-registry-api');
const ContactsApi = PartyContactPointsApi.prefix('/party-registry-api');
const IdentifiersApi = PartyOfficialIdentifierHistoryApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
  serveApi(
    CounterpartyApi,
    HttpApiBuilder.group(CounterpartyApi, 'counterpartyRead', (group) =>
      group.handle('execute', () =>
        Effect.sync(() => {
          reads.push('counterparty');
          return snapshot.counterparty;
        }),
      ),
    ),
  ),
  serveApi(
    IdentityApi,
    HttpApiBuilder.group(IdentityApi, 'partyDetail', (group) =>
      group.handle('execute', () =>
        Effect.sync(() => {
          reads.push('identity');
          return {
            currentFactAssertions: [],
            party,
            resolution: {
              aliasChain: [],
              canonicalPartyRef: partyRef,
              kind: 'DIRECT' as const,
              requestedPartyRef: partyRef,
            },
          };
        }),
      ),
    ),
  ),
  serveApi(
    ContactsApi,
    HttpApiBuilder.group(ContactsApi, 'partyContactPoints', (group) =>
      group.handle('execute', () =>
        Effect.sync(() => {
          reads.push('contacts');
          return { items: [] };
        }),
      ),
    ),
  ),
  serveApi(
    IdentifiersApi,
    HttpApiBuilder.group(IdentifiersApi, 'partyOfficialIdentifierHistory', (group) =>
      group.handle('execute', () =>
        Effect.sync(() => {
          reads.push('identifiers');
          return { items: [] };
        }),
      ),
    ),
  ),
);
const useDetailPage = () => {
  const current = useSyncExternalStore(
    (listener) => customerDetailPageData.subscribe(listener, input),
    () => customerDetailPageData.snapshot(input),
  );
  useEffect(() => {
    customerDetailPageData.ensure(input);
  }, []);
  return current;
};
const idle = (seconds: number) => Effect.sleep(`${seconds} seconds`).pipe(Effect.andThen(networkIdle));
const readsPerBusyMinute = (change: () => Event) =>
  Effect.gen(function* busyMinute() {
    yield* pinTestDocument;
    const { result, unmount } = renderHook(useDetailPage);
    yield* waitUntil(() => result.current.state === 'ready');
    yield* networkIdle;
    expect(result.current.state).toBe('ready');
    if (result.current.state === 'ready') {
      expect(result.current.value.counterparty.party.displayName).toBe('Before');
    }
    reads.length = 0;
    for (let event = 0; event < 30; event += 1) {
      yield* acted(() => {
        window.dispatchEvent(change());
      });
      yield* idle(2);
    }
    unmount();
    yield* networkIdle;
    return ['counterparty', 'identity', 'contacts', 'identifiers'].map(
      (kind) => reads.filter((read) => read === kind).length,
    );
  });
beforeEach(() => {
  customerDetailData.invalidate();
  customerDetailPageData.invalidate();
  reads.length = 0;
});
afterEach(() => {
  cleanup();
});
it.layer(network, { excludeTestServices: true })('direct customer detail traffic', (suite) => {
  suite.effect(
    'an idle direct customer detail limits unrelated busy-module traffic to three four-owner reloads per minute',
    () =>
      Effect.gen(function* unrelated() {
        expect(
          yield* readsPerBusyMinute(
            () => new CustomEvent(moduleChangeEvent, { detail: { apps: ['finance-billing', 'merchandise', 'shell'] } }),
          ),
        ).toEqual([3, 3, 3, 3]);
      }),
    90_000,
  );
  suite.effect(
    'every party-registry change revalidates all four direct customer detail sections',
    () =>
      Effect.gen(function* own() {
        expect(
          yield* readsPerBusyMinute(() => new CustomEvent(moduleChangeEvent, { detail: { apps: ['party-registry'] } })),
        ).toEqual([30, 30, 30, 30]);
      }),
    90_000,
  );
  suite.effect(
    'unscoped changes revalidate all four direct customer detail sections',
    () =>
      Effect.gen(function* unscoped() {
        expect(yield* readsPerBusyMinute(() => new Event(moduleChangeEvent))).toEqual([30, 30, 30, 30]);
      }),
    90_000,
  );
});
