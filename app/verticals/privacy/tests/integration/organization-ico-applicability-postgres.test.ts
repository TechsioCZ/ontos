import { ReadHandlerUnavailable } from '@app/core-runtime';
import { executeOrganizationIcoFactsWithAuthorization } from '@app/party-registry/apis/organization-ico-facts/client';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Clock, ConfigProvider, Crypto, DateTime, Effect, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { OrganizationIcoFactsOwner } from '../../src/services/organization-ico-applicability.service.ts';
import { organizationIcoApplicabilityRead } from '../../src/api/organization-ico-applicability.read.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';
import { legalHolds } from '../../src/database/schema.ts';
import { privacyIcoNativeContext } from '../support/privacy-ico-native-composition.ts';
import { makeOrganizationIcoApplicabilityFixture } from '../support/organization-ico-applicability.fixture.ts';

/** Real Privacy ledgers and governed Read. Party HTTP contract is an explicit INTERNAL fixture;
 * combined cross-owner acceptance separately exercises the actual Party receiving gate/storage. */
it.live(
  'checks native organization ICO classification without a dummy person and rechecks current revocation and hold',
  () =>
    Effect.gen(function* nativeOrganizationIco() {
      const nativeTime = yield* Clock.Clock.defaultValue().currentTimeMillis;
      const now = DateTime.makeUnsafe(nativeTime);
      const effectiveFrom = DateTime.formatIso(DateTime.subtract(now, { days: 6 }));
      yield* TestClock.setTime(nativeTime);
      const native = yield* privacyIcoNativeContext('privacy.core.organization-ico-applicability.read');
      const crypto = yield* Crypto.Crypto;
      const { principalId, tenantId } = native.principal;
      const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.legalEntityId));
      const fixture = yield* native
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* actualOwnerFacts() {
            const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
            const purpose = yield* purposes.create(tenantId, legalEntityId, yield* crypto.randomUUIDv4(), {
              businessCode: 'INTERNAL_ORG_ICO',
              effectiveFrom,
              governanceOwnerId: principalId,
              meaning: 'Explicit approved organization-only ICO business field classification',
            });
            const version = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
            const facts = makeOrganizationIcoApplicabilityFixture({
              authMethod: native.principal.authMethod,
              effectiveFrom,
              evaluatedAt: DateTime.formatIso(now),
              legalEntityId,
              principalId,
              purposeId: purpose.purposeRef.resourceId,
              tenantId,
              versionId: version.versionId,
            });
            const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
            yield* repository.assignResponsibility(
              tenantId,
              legalEntityId,
              yield* crypto.randomUUIDv4(),
              facts.responsibility,
            );
            yield* repository.recordApplicabilityPolicy(
              tenantId,
              legalEntityId,
              yield* crypto.randomUUIDv4(),
              facts.policy,
            );
            yield* repository.recordApplicability(
              tenantId,
              legalEntityId,
              yield* crypto.randomUUIDv4(),
              facts.context.decisionRef,
              facts.decision,
            );
            return facts;
          }),
        )
        .pipe(Effect.provide(native.layer));
      const calls: string[] = [];
      let ownerUnavailable = false;
      const proofPort = OrganizationIcoFactsOwner.of({
        resolve: (request, scope) =>
          executeOrganizationIcoFactsWithAuthorization(
            { fieldContractVersion: 'party.registry.organization-ico-business-fields.v1', partyRef: request.partyRef },
            'Bearer INTERNAL_ORG_ICO_CONTRACT_FIXTURE',
            scope.correlationId,
            { baseUrl: 'https://party-organization-facts.internal-fixture.test', compositionRevision: 'a'.repeat(64) },
          ).pipe(
            Effect.mapError((cause) =>
              Object.defineProperty(
                new ReadHandlerUnavailable({
                  code: 'read_handler_unavailable',
                  reason: 'The internal owner fact HTTP fixture is unavailable',
                }),
                'cause',
                { value: cause },
              ),
            ),
          ),
      });
      const read = (contexts = [fixture.context]) =>
        native.runtime
          .runRead({
            input: fixture.request,
            principal: native.principal,
            registration: organizationIcoApplicabilityRead,
            transport: { correlationId: 'internal:organization-ico' },
          })
          .pipe(
            Effect.provide(native.layer),
            Effect.provideService(OrganizationIcoFactsOwner, proofPort),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ ONTOS_PRIVACY_ORGANIZATION_ICO_CONTEXTS: JSON.stringify(contexts) }),
            ),
            Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
              const request = new Request(input, init);
              calls.push(request.url);
              expect(request.headers.get('authorization')).toBe('Bearer INTERNAL_ORG_ICO_CONTRACT_FIXTURE');
              return ownerUnavailable ? new Response('', { status: 503 }) : Response.json(fixture.proof);
            }),
          );
      expect(yield* read()).toMatchObject({
        allowedFields: fixture.request.fields,
        outcome: 'NOT_APPLICABLE',
        partyRevision: 7,
      });
      expect(calls).toHaveLength(1);
      ownerUnavailable = true;
      expect((yield* read()).outcome).toBe('INDETERMINATE');
      ownerUnavailable = false;
      expect((yield* read([])).outcome).toBe('DENIED');
      expect((yield* read([{ ...fixture.context, authorityRevision: 'revoked:new-revision' }])).outcome).toBe('DENIED');
      yield* native
        .prepareOwner((transaction) =>
          Effect.gen(function* currentScopeHold() {
            const hold = {
              actorPrincipalRef: principalId,
              authorityKind: 'LEGAL_HOLD_AUTHORITY',
              authorityRef: 'internal:hold-authority',
              contentScopeRefs: [fixture.context.processingScopeRef.scopeId],
              controllerRef: legalEntityId,
              effectiveFrom,
              effectiveTo: DateTime.formatIso(DateTime.add(now, { days: 24 })),
              evidenceRefs: ['internal:hold-evidence'],
              holdRef: `internal:org-hold:${tenantId}`,
              policyRef: 'internal:hold-policy',
              policyVersion: 1,
              provenanceRef: 'internal:hold-provenance',
              reasonTypeRef: 'internal:hold-reason',
              reasonTypeVersion: 1,
              releaseConditionRef: null,
              releasedAt: null,
              releasedByPrincipalRef: null,
              releaseEvidenceRefs: [],
              releaseReasonRef: null,
              releaseRef: null,
              reviewDueAt: DateTime.formatIso(DateTime.add(now, { days: 13 })),
              reviewedAt: null,
              reviewEvidenceRefs: [],
              reviewRef: 'internal:hold-review',
            };
            yield* transaction.insert(legalHolds).values({
              actionInvocationId: yield* crypto.randomUUIDv4(),
              effectiveFrom: DateTime.toDateUtc(DateTime.makeUnsafe(hold.effectiveFrom)),
              effectiveTo: DateTime.toDateUtc(DateTime.makeUnsafe(hold.effectiveTo)),
              holdRecord: hold,
              holdRef: hold.holdRef,
              legalEntityId,
              recordedAt: DateTime.toDateUtc(yield* DateTime.now),
              tenantId,
            });
          }),
        )
        .pipe(Effect.provide(native.layer));
      expect((yield* read()).outcome).toBe('DENIED');
    }).pipe(Effect.provide(NodeServices.layer), Effect.provide(NodeCrypto.layer), Effect.provide(TestClock.layer())),
);
