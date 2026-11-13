import { CoreDatabase } from '@app/core-runtime/db/client';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Clock, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeAuthDatabase, AuthDatabase } from '../../api/auth/db/client.ts';
import { GatewayDelegationError } from '../../api/auth/gateway-delegation-errors.ts';
import { admitOriginatorSubject } from '../../api/auth/gateway-delegation-issuer.ts';
import { GatewayOriginatorEvidence } from '../../api/auth/gateway-originator-evidence.ts';
import { GatewayOriginatorEvidenceLive } from '../../api/auth/gateway-originator-evidence.service.ts';
import {
  actionInvocations,
  coreRelations,
  domainEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';

/** The Action whose succeeded invocation published the won-opportunity message; the only one the caller acts for. */
const WON_ACTION = 'crm.opportunity.mark-won';

/**
 * One isolated database: two tenants, companies A and B in the first, and one succeeded won-opportunity invocation
 * an agent ran in company A whose domain event Core recorded in company A. The Shell reads it as the runtime role.
 */
const wonOpportunity = Effect.gen(function* wonOpportunityFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: yield* makeApplicationCompositionSnapshotFixture(['catalog']),
    mode: 'schema-only',
    purpose: 'stabilization-1287-shell-auth',
  });
  const admin = yield* makeTestDatabaseFromClient(
    yield* makeTestPgClient(isolated.connections.admin.connectionString),
    coreRelations,
  );
  const core = yield* makeTestDatabaseFromClient(
    yield* makeTestPgClient(isolated.connections.runtime.connectionString),
    coreRelations,
  );
  const auth = yield* makeAuthDatabase({
    connectionString: isolated.connections.runtime.connectionString,
    expectedRole: isolated.connections.runtime.expectedRole,
  });
  const [tenantId, otherTenantId] = [crypto.randomUUID(), crypto.randomUUID()];
  const [companyA, companyB, otherCompany] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const agent = crypto.randomUUID();
  const binding = crypto.randomUUID();
  const invocation = crypto.randomUUID();
  yield* admin.insert(tenants).values(
    [tenantId, otherTenantId].map((id, index) => ({
      defaultLocale: 'cs',
      name: `Won opportunity ${String(index)}`,
      slug: `won-opportunity-${id}`,
      status: 'active',
      tenantId: id,
    })),
  );
  yield* admin.insert(legalEntities).values(
    [
      [companyA, tenantId],
      [companyB, tenantId],
      [otherCompany, otherTenantId],
    ].map(([legalEntityId = '', owner = ''], index) => ({
      legalEntityId,
      legalName: `Won opportunity company ${String(index)}`,
      registrationCountry: 'CZ',
      registrationNumber: `2000000${String(index)}`,
      status: 'active',
      tenantId: owner,
    })),
  );
  yield* admin.insert(principals).values({
    displayName: 'Sales agent',
    kind: 'agent',
    principalId: agent,
    status: 'active',
    tenantId,
  });
  yield* admin.insert(principalAuthBindings).values({
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    principalAuthBindingId: binding,
    principalId: agent,
    provider: 'better_auth',
    providerSubjectId: 'sales-agent-key',
    status: 'active',
    subjectType: 'api_key',
    tenantId,
  });
  yield* admin.insert(actionInvocations).values({
    actionInvocationId: invocation,
    actionKey: WON_ACTION,
    authBindingId: binding,
    authContextRef: 'better-auth-api-key:sales-agent-key',
    authMethod: 'api_key',
    legalEntityId: companyA,
    principalId: agent,
    requestHash: 'won-opportunity',
    status: 'succeeded',
    tenantId,
  });
  yield* admin.insert(domainEvents).values({
    actionInvocationId: invocation,
    eventType: 'crm.opportunity.won',
    legalEntityId: companyA,
    producerModuleKey: 'crm',
    subjectModuleKey: 'crm',
    subjectResourceId: crypto.randomUUID(),
    subjectResourceType: 'opportunity',
    tenantId,
  });
  const evidence = GatewayOriginatorEvidenceLive.pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(CoreDatabase, { executor: core }), Layer.succeed(AuthDatabase, auth))),
  );
  return { companyA, companyB, evidence, invocation, otherCompany, otherTenantId, tenantId };
});

/** A caller's Originator claim as the delegation request carries it on the wire, decoded as the Shell decodes it. */
const originatorClaim = (claim: {
  readonly actionInvocationId: string;
  readonly legalEntityId?: string;
  readonly messageLegalEntityId: string;
  readonly tenantId: string;
}) =>
  Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)({
    audience: 'party-registry',
    compositionRevision: 'a'.repeat(64),
    exchangeId: crypto.randomUUID(),
    legalEntityScope: 'subject',
    subject: { _tag: 'Originator', ...claim },
  }).pipe(
    Effect.flatMap(({ subject }) =>
      subject._tag === 'Originator' ? Effect.succeed(subject) : Effect.die('The claim must be an Originator'),
    ),
  );

/** What the issuer decides for one claim: the company of the context it would issue, or the refusal reason. */
const decide = (claim: Parameters<typeof originatorClaim>[0]) =>
  Effect.gen(function* decideClaim() {
    const subject = yield* originatorClaim(claim);
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return yield* admitOriginatorSubject({
      actionInvocationId: subject.actionInvocationId,
      legalEntityId: subject.legalEntityId,
      messageLegalEntityId: subject.messageLegalEntityId,
      now,
      originatorActions: [WON_ACTION],
      tenantId: subject.tenantId,
    }).pipe(
      Effect.map((admitted) => admitted.principal.legalEntityId ?? null),
      Effect.catchIf(Schema.is(GatewayDelegationError), (refusal) => Effect.succeed(`refused:${refusal.reason}`)),
    );
  });

it.live('lets a won-opportunity message of company A obtain a delegated context for company A only', () =>
  Effect.scoped(
    Effect.gen(function* wonOpportunityIsCompanyBound() {
      const fixture = yield* wonOpportunity;
      const run = (claim: Parameters<typeof originatorClaim>[0]) =>
        decide(claim).pipe(Effect.provide(fixture.evidence));
      const base = { actionInvocationId: fixture.invocation, tenantId: fixture.tenantId };
      // The message is company A's: the context names A, whether the caller restates A or names nothing.
      expect(yield* run({ ...base, messageLegalEntityId: fixture.companyA })).toBe(fixture.companyA);
      expect(yield* run({ ...base, legalEntityId: fixture.companyA, messageLegalEntityId: fixture.companyA })).toBe(
        fixture.companyA,
      );
      // Naming company B beside company A's message is refused.
      expect(yield* run({ ...base, legalEntityId: fixture.companyB, messageLegalEntityId: fixture.companyA })).toBe(
        'refused:originator_company_mismatch',
      );
      // A message claimed for company B, of an invocation Core recorded in company A, is refused as well.
      expect(yield* run({ ...base, messageLegalEntityId: fixture.companyB })).toBe(
        'refused:originator_company_mismatch',
      );
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);

it.live('finds the message company only where Core recorded the event: its company, in its own tenant', () =>
  Effect.scoped(
    Effect.gen(function* messageCompanyLookup() {
      const fixture = yield* wonOpportunity;
      const recorded = (input: { readonly legalEntityId: string; readonly tenantId: string }) =>
        GatewayOriginatorEvidence.pipe(
          Effect.flatMap((evidence) =>
            evidence.messageCompanyRecorded({ actionInvocationId: fixture.invocation, ...input }),
          ),
          Effect.provide(fixture.evidence),
        );
      expect(yield* recorded({ legalEntityId: fixture.companyA, tenantId: fixture.tenantId })).toBe(true);
      expect(yield* recorded({ legalEntityId: fixture.companyB, tenantId: fixture.tenantId })).toBe(false);
      expect(yield* recorded({ legalEntityId: fixture.companyA, tenantId: fixture.otherTenantId })).toBe(false);
      expect(yield* recorded({ legalEntityId: fixture.otherCompany, tenantId: fixture.otherTenantId })).toBe(false);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);
