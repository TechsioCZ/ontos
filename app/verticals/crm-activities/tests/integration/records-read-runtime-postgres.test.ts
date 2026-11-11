// The governed CRM Activities records read through Core's real Read runtime on PostgreSQL: the registered owner
// entrypoint, the access gate, the scoped runtime-role transaction and the owner factory. One company holds its state
// row; the other never had one, and its first write through the owner creates it.
import { NodeCrypto } from '@effect/platform-node';
import { defineDatabaseIdentityEnrollment, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { relationshipsRelations, relationshipsStates } from '../../src/database/schema.ts';
import { persistenceService } from '../../src/services/persistence.service.ts';
import { crmActivitiesRegistration } from '../../vertical.registration.ts';

type Fixture = Effect.Success<ReturnType<typeof makeNativeReadTestContext>>;
interface Company {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

const companyOf = (principal: TrustedPrincipalContext): Effect.Effect<Company> =>
  principal.legalEntityId === undefined
    ? Effect.die('The native fixture principal names no company')
    : Effect.succeed({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId });

/** One allowing gate, both for Core's runtime decision and for the owner's own rights questions. */
const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });

const nativeActivities = makeNativeReadTestContext({
  accessDecision: gate.bound,
  contextPermissions: [],
  moduleId: 'crm.activities',
  ownerFixtureRetention: 'retain-complete-context',
}).pipe(Effect.provideService(NativeReadTestOwnerRegistration, crmActivitiesRegistration));

const readRecords = (fixture: Fixture) =>
  fixture.runtime
    .runRead({
      input: Schema.decodeUnknownSync(recordsRead.descriptor.inputSchema)({}),
      principal: fixture.principal,
      registration: recordsRead,
      transport: { correlationId: 'crm-activities-records-runtime' },
    })
    .pipe(Effect.provide(fixture.layer), Effect.provideService(AccessDecisionGate, gate.accessDecision));

const stateWhere = (company: Company) =>
  and(eq(relationshipsStates.tenantId, company.tenantId), eq(relationshipsStates.legalEntityId, company.legalEntityId));

it.live(
  'serves the records read through the Core read runtime with and without a state row, and the first write creates it',
  () =>
    Effect.scoped(
      Effect.gen(function* recordsRuntime() {
        const connections = yield* loadDatabaseConnectionPair();
        const admin = yield* makeTestDatabaseFromClient(
          yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 }),
          relationshipsRelations,
        );
        const stored = yield* nativeActivities;
        const empty = yield* nativeActivities;
        const [storedCompany, emptyCompany] = yield* Effect.all([
          companyOf(stored.principal),
          companyOf(empty.principal),
        ]);
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [storedCompany, emptyCompany],
            (company) => admin.delete(relationshipsStates).where(stateWhere(company)),
            { discard: true },
          ).pipe(Effect.orDie),
        );
        // The stored company carries its row the way the demo reset writes it.
        yield* admin.insert(relationshipsStates).values({ ...storedCompany, revision: 3, state: { activities: [] } });

        expect(yield* readRecords(stored)).toMatchObject({ items: [], revision: 3 });
        expect(yield* readRecords(empty)).toMatchObject({ items: [], revision: 0 });
        expect(yield* admin.select().from(relationshipsStates).where(stateWhere(emptyCompany))).toEqual([]);

        // The first write, through the owner's persistence in a runtime-role transaction scoped to the empty company,
        // creates the row; the governed read then answers the activity at revision 1.
        const partyRef = {
          moduleId: 'party.registry',
          resourceId: '60000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.party',
          tenantId: emptyCompany.tenantId,
        } as const;
        const payload = Schema.decodeSync(ApplyCommandPayloadSchema)({
          command: {
            _tag: 'RecordActivity',
            kind: 'CALL',
            occurredAt: '2026-11-10T09:00:00Z',
            ownerPrincipalRef: { principalId: empty.principal.principalId, tenantId: emptyCompany.tenantId },
            partyRef,
            summary: 'První hovor ve firmě',
          },
          expectedRevision: 0,
        });
        const runtimeDb = yield* makeTestDatabaseFromClient(
          yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 1 }),
          relationshipsRelations,
        );
        const scope = { ...empty.principal, correlationId: '70000000-0000-4000-8000-000000000001' };
        const written = yield* runtimeDb.transaction((tx) =>
          Effect.gen(function* firstWrite() {
            const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
            const services = yield* persistenceService(scoped, {
              prepared: { actionInvocationId: scope.correlationId, partyRef, payload },
              scope,
            });
            return yield* services.apply(payload.command, payload.expectedRevision, scope.correlationId);
          }),
        );
        expect(written.revision).toBe(1);
        const afterWrite = yield* readRecords(empty);
        expect({ items: afterWrite.items.length, revision: afterWrite.revision }).toEqual({ items: 1, revision: 1 });
        expect(yield* readRecords(stored)).toMatchObject({ revision: 3 });
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);
