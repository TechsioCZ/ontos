import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { refuseInsideDatabaseTransaction } from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { counterpartyOrderHistoryRead } from '../../src/api/counterparty-order-history.read.ts';
import { customerHistoryPortsAfterCommit } from '../../src/history-production-services.ts';
import { CustomerHistoryPortsService, unavailableCustomerHistoryPorts } from '../../shared/domain/history-ports.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const compositionRevision = 'a'.repeat(64);
const at = '2026-11-07T10:00:00.000Z';
const principal = trustVerifiedGatewayPrincipalContext(
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '44444444-4444-4444-8444-444444444444',
    authContextRef: 'better-auth-session:history-native-phase',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  compositionRevision,
);
const scope = { ...principal, correlationId: 'history-native-phase' };
const input = {
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  },
} as const;

it.layer(NodeCrypto.layer)('registered history load/finish', (test) => {
  for (const scenario of ['CURRENT', 'OTHER_COUNTERPARTY', 'OTHER_COMPANY', 'GATE_DENIED'] as const) {
    test.effect(`${scenario} retains the owner association and releases SQL before external history`, () =>
      Effect.gen(function* registeredHistory() {
        let externalReads = 0;
        let orderReads = 0;
        const harness = yield* makeReadTestHarness({
          access: scenario === 'GATE_DENIED' ? 'denied' : 'allowed',
          compositionRevision,
          executeOwnerQuery: ({ sql }) => {
            if (!sql.includes('read_customer_profile')) {
              return Effect.die(`Unexpected owner query: ${sql}`);
            }
            return Effect.succeed([
              {
                outcome: 'PROFILE_AVAILABLE',
                payload: {
                  createdAt: at,
                  profileId: input.profileRef.resourceId,
                  profileKind: 'COUNTERPARTY',
                  revision: 3,
                  scopeLegalEntityId:
                    scenario === 'OTHER_COMPANY' ? '77777777-7777-4777-8777-777777777777' : legalEntityId,
                  state: 'SUSPENDED',
                  subject: {
                    counterpartyResourceId:
                      scenario === 'OTHER_COUNTERPARTY'
                        ? '88888888-8888-4888-8888-888888888888'
                        : input.counterpartyRef.resourceId,
                    counterpartyResourceRevision: 'counterparty:7',
                    customerRoleResourceId: 'role-1',
                    customerRoleResourceRevision: 'role:4',
                    kind: 'COUNTERPARTY',
                  },
                  updatedAt: at,
                },
              },
            ]);
          },
          operationTime: new Date(at),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: commerceCustomerContextRegistration,
          scope,
        });
        const outside = refuseInsideDatabaseTransaction('module-transport', 'history-owner').pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(harness.snapshot().statements.at(-1)?.trim().toLowerCase()).toBe('commit');
              externalReads += 1;
            }),
          ),
        );
        const base = unavailableCustomerHistoryPorts();
        const ports = {
          ...base,
          access: {
            ...base.access,
            counterparty: () =>
              outside.pipe(
                Effect.as({
                  access: 'CURRENT' as const,
                  archivePermission: 'ABSENT' as const,
                  historyPermission: 'counterparty.history.read_own' as const,
                  policy: 'ALLOWED' as const,
                  purchasePermission: 'ABSENT' as const,
                }),
              ),
          },
          orders: {
            ...base.orders,
            listCounterparty: () =>
              outside.pipe(
                Effect.tap(
                  Effect.sync(() => {
                    orderReads += 1;
                  }),
                ),
                Effect.as([]),
              ),
          },
        };
        const outcome = yield* harness.runtime
          .runRead({
            input,
            principal,
            registration: counterpartyOrderHistoryRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(Effect.provideService(CustomerHistoryPortsService, ports), Effect.exit);
        if (scenario === 'CURRENT') {
          expect(Exit.isSuccess(outcome)).toBe(true);
          expect(orderReads).toBe(1);
          expect(harness.snapshot().evidenceWrites).toBeGreaterThan(0);
        } else {
          expect(Exit.isFailure(outcome)).toBe(true);
          expect(orderReads).toBe(0);
        }
        if (scenario === 'GATE_DENIED') {
          expect(externalReads).toBe(0);
          expect(harness.snapshot().ownerQueries).toEqual([]);
        }
      }),
    );
  }
});

it.effect('cannot reuse a loaded association for a different actor, company, tenant or selector', () =>
  Effect.gen(function* exactAssociationBinding() {
    const snapshot = { outcome: Exit.succeed('CURRENT' as const), refs: input, scope };
    const base = unavailableCustomerHistoryPorts();
    const current = yield* customerHistoryPortsAfterCommit(base, snapshot, scope);
    expect(yield* current.counterpartyProfiles.current(input)).toBe('CURRENT');
    for (const changed of [
      { ...scope, principalId: 'other-actor' },
      { ...scope, legalEntityId: 'other-company' },
      { ...scope, tenantId: 'other-tenant' },
    ]) {
      const ports = yield* customerHistoryPortsAfterCommit(base, snapshot, changed);
      expect((yield* ports.counterpartyProfiles.current(input).pipe(Effect.flip))._tag).toBe('HistoryOwnerUnavailable');
    }
    expect(
      (yield* current.counterpartyProfiles
        .current({ ...input, profileRef: { ...input.profileRef, resourceId: 'unrelated-profile' } })
        .pipe(Effect.flip))._tag,
    ).toBe('HistoryOwnerUnavailable');
  }),
);
