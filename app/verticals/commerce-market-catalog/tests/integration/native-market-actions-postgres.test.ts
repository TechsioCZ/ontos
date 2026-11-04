import { Crypto, DateTime, Effect, Exit, Option, Redacted, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { executeActivateMarketWithAuthorization } from '../../src/api/activate-market-action-client.ts';
import { executeAssociateStorefrontWithAuthorization } from '../../src/api/associate-storefront-action-client.ts';
import { executeCreateMarketWithAuthorization } from '../../src/api/create-market-action-client.ts';
import { executeCurrentMarketCatalogWithAuthorization } from '../../src/api/current-market-catalog-client.ts';
import { executeMarketHistoryWithAuthorization } from '../../src/api/market-history-client.ts';
import { executeRemoveStorefrontAssociationWithAuthorization } from '../../src/api/remove-storefront-association-action-client.ts';
import { executeRetireMarketWithAuthorization } from '../../src/api/retire-market-action-client.ts';
import { executeReviseMarketDefinitionWithAuthorization } from '../../src/api/revise-market-definition-action-client.ts';
import { executeReviseStorefrontAssociationWithAuthorization } from '../../src/api/revise-storefront-association-action-client.ts';
import { executeSuspendMarketWithAuthorization } from '../../src/api/suspend-market-action-client.ts';
import { makeMarketRevisionNativeFixture, marketRevisionNativeServices } from '../fixtures/market-revision-native.ts';

it.layer(marketRevisionNativeServices, { excludeTestServices: true })((suite) =>
  suite.effect(
    'runs all eight public Market Actions with original-actor owner receiving and exact retirement recovery',
    () =>
      Effect.gen(function* nativeMarketAdministration() {
        const owner = yield* makeMarketRevisionNativeFixture();
        expect(owner.relaySourcePrincipalId).not.toBe(owner.principal.principalId);
        const admit = Effect.fn('NativeMarketActions.admit')(function* admit(
          requestCorrelation: string,
          idempotencyKey = requestCorrelation,
        ) {
          const admitted = yield* owner.issue({
            audience: 'commerce-market-catalog',
            compositionRevision: owner.compositionRevision,
            legalEntityId: owner.legalEntityId,
            requestCorrelation,
          });
          return {
            authorization: Redacted.value(admitted.credential),
            options: { baseUrl: admitted.baseUrl, compositionRevision: owner.compositionRevision, idempotencyKey },
            requestCorrelation,
          };
        });
        const at = (offset: number) => DateTime.makeUnsafe(DateTime.toEpochMillis(owner.now) + offset);
        const createPayload = {
          channels: ['B2C'] as const,
          effectivePeriod: { startsAt: at(-3_600_000) },
          jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' as const }],
          lifecycle: 'ACTIVE' as const,
          marketCode: 'NATIVE_HTTP',
          marketId: owner.marketRef.resourceId,
          purpose: 'Public native Market acceptance',
          reason: 'Create the real owner Market',
          sellingLegalEntityRef: owner.sellerRef,
          supportedLocales: ['cs-CZ'],
        };
        const crypto = yield* Crypto.Crypto;
        const foreignTenantId = yield* crypto.randomUUIDv4();
        const crossScope = yield* admit('native-cross-scope');
        const crossScopeCreation = yield* executeCreateMarketWithAuthorization(
          { ...createPayload, sellingLegalEntityRef: { ...owner.sellerRef, tenantId: foreignTenantId } },
          crossScope.authorization,
          crossScope.requestCorrelation,
          crossScope.options,
        ).pipe(Effect.result);
        expect(Result.isFailure(crossScopeCreation)).toBe(true);
        const creation = yield* admit('native-create');
        const created = yield* executeCreateMarketWithAuthorization(
          createPayload,
          creation.authorization,
          creation.requestCorrelation,
          creation.options,
        );
        expect(created).toMatchObject({ created: true, marketRef: owner.marketRef, revision: 1 });
        const creationRetry = yield* admit('native-create-retry', 'native-create');
        const repeatedCreation = yield* executeCreateMarketWithAuthorization(
          createPayload,
          creationRetry.authorization,
          creationRetry.requestCorrelation,
          creationRetry.options,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(repeatedCreation)).toBe(true);

        const associationPayload = {
          associationId: owner.associationRef.resourceId,
          channel: 'B2C',
          effectivePeriod: { startsAt: owner.now },
          expectedMarketDefinitionRevisionRef: created.definitionRevisionRef,
          marketRef: owner.marketRef,
          provenance: { kind: 'CONFIGURATION_ACTION', reference: 'native-http' },
          reason: 'Use actual registered Storefront evidence',
          sellingLegalEntityRef: owner.sellerRef,
          storefrontRef: owner.storefrontRef,
        } as const;
        const observeMarket = Effect.fn('NativeMarketActions.observeMarket')(function* observeMarket(suffix: string) {
          const read = yield* admit(`native-boundary-${suffix}`);
          const history = yield* executeMarketHistoryWithAuthorization(
            { marketRef: owner.marketRef },
            read.authorization,
            read.requestCorrelation,
            read.options,
          );
          const { outboxCount } = yield* owner.evidence();
          return { history, outboxCount };
        });
        const beforeBoundaryProbes = yield* observeMarket('before');
        const incompatibleAssociation = yield* admit('native-cross-scope-association');
        // These are internally coherent incompatible claims, not facts about foreign owners.
        // Keeping all reference tenants equal passes client validation and reaches receiving scope checks.
        const crossScopeAssociation = yield* executeAssociateStorefrontWithAuthorization(
          {
            ...associationPayload,
            expectedMarketDefinitionRevisionRef: { ...created.definitionRevisionRef, tenantId: foreignTenantId },
            marketRef: { ...owner.marketRef, tenantId: foreignTenantId },
            sellingLegalEntityRef: { ...owner.sellerRef, tenantId: foreignTenantId },
            storefrontRef: { ...owner.storefrontRef, tenantId: foreignTenantId },
          },
          incompatibleAssociation.authorization,
          incompatibleAssociation.requestCorrelation,
          incompatibleAssociation.options,
        ).pipe(Effect.result);
        expect(Result.isFailure(crossScopeAssociation)).toBe(true);
        expect(crossScopeAssociation).toMatchObject({ failure: { status: expect.any(Number) } });
        expect(yield* observeMarket('after-incompatible-association')).toEqual(beforeBoundaryProbes);

        const deniedResource = yield* admit('native-ungranted-market-suspend');
        const ungrantedMarketRef = { ...owner.marketRef, resourceId: yield* crypto.randomUUIDv4() };
        const deniedSuspension = yield* executeSuspendMarketWithAuthorization(
          {
            effectiveAt: owner.now,
            expectedCurrentDefinitionRevisionRef: created.definitionRevisionRef,
            expectedRevision: created.revision,
            marketRef: ungrantedMarketRef,
            reason: 'Reject a real actor without the exact resource write grant',
          },
          deniedResource.authorization,
          deniedResource.requestCorrelation,
          deniedResource.options,
        ).pipe(Effect.result);
        expect(Result.isFailure(deniedSuspension)).toBe(true);
        expect(deniedSuspension).toMatchObject({ failure: { status: 403 } });
        expect(yield* observeMarket('after-ungranted-resource')).toEqual(beforeBoundaryProbes);

        const association = yield* admit('native-associate');
        const associated = yield* executeAssociateStorefrontWithAuthorization(
          associationPayload,
          association.authorization,
          association.requestCorrelation,
          association.options,
        );
        expect(associated).toMatchObject({ associationRef: owner.associationRef, changed: true, revision: 1 });
        const definition = yield* admit('native-revise');
        const revisionPayload = {
          channels: ['B2C'],
          effectivePeriod: { startsAt: at(1) },
          expectedCurrentDefinitionRevisionRef: created.definitionRevisionRef,
          expectedRevision: created.revision,
          jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
          marketRef: owner.marketRef,
          purpose: 'Revised public native Market',
          reason: 'Retain the original definition in history',
          supportedLocales: ['cs-CZ'],
        } as const;
        const concurrentDefinition = yield* admit('native-revise-concurrent');
        const revisions = yield* Effect.all(
          [
            executeReviseMarketDefinitionWithAuthorization(
              revisionPayload,
              definition.authorization,
              definition.requestCorrelation,
              definition.options,
            ).pipe(Effect.result),
            executeReviseMarketDefinitionWithAuthorization(
              revisionPayload,
              concurrentDefinition.authorization,
              concurrentDefinition.requestCorrelation,
              concurrentDefinition.options,
            ).pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        const successfulRevisions = revisions.filter(Result.isSuccess);
        expect(successfulRevisions).toHaveLength(1);
        expect(revisions.filter(Result.isFailure)).toHaveLength(1);
        const [winningRevision] = successfulRevisions;
        if (winningRevision === undefined) {
          return;
        }
        const revised = winningRevision.success;
        const suspension = yield* admit('native-suspend');
        const suspended = yield* executeSuspendMarketWithAuthorization(
          {
            effectiveAt: at(2),
            expectedCurrentDefinitionRevisionRef: revised.definitionRevisionRef,
            expectedRevision: revised.revision,
            marketRef: owner.marketRef,
            reason: 'Suspend the real Market',
          },
          suspension.authorization,
          suspension.requestCorrelation,
          suspension.options,
        );
        expect(suspended.lifecycle).toBe('SUSPENDED');
        const activation = yield* admit('native-activate');
        const activated = yield* executeActivateMarketWithAuthorization(
          {
            effectiveAt: at(3),
            expectedCurrentDefinitionRevisionRef: suspended.definitionRevisionRef,
            expectedRevision: suspended.revision,
            marketRef: owner.marketRef,
            reason: 'Explicitly reactivate the Market',
          },
          activation.authorization,
          activation.requestCorrelation,
          activation.options,
        );
        expect(activated.lifecycle).toBe('ACTIVE');
        const associationRevision = yield* admit('native-revise-association');
        const revisedAssociation = yield* executeReviseStorefrontAssociationWithAuthorization(
          {
            associationRef: associated.associationRef,
            channel: 'B2C',
            effectivePeriod: { startsAt: at(4) },
            expectedRevision: associated.revision,
            marketRef: owner.marketRef,
            provenance: { kind: 'CONFIGURATION_ACTION', reference: 'native-http-revised' },
            reason: 'Revalidate the actual Storefront',
            storefrontRef: owner.storefrontRef,
          },
          associationRevision.authorization,
          associationRevision.requestCorrelation,
          associationRevision.options,
        );
        const removal = yield* admit('native-remove-association');
        const removed = yield* executeRemoveStorefrontAssociationWithAuthorization(
          {
            associationRef: associated.associationRef,
            effectiveAt: at(5),
            expectedRevision: revisedAssociation.revision,
            marketRef: owner.marketRef,
            reason: 'End the owned association',
            storefrontRef: owner.storefrontRef,
          },
          removal.authorization,
          removal.requestCorrelation,
          removal.options,
        );
        expect(removed).toMatchObject({ changed: true, revision: revisedAssociation.revision + 1 });
        const beforeOutageRead = yield* admit('native-before-storefront-outage');
        const beforeOutageHistory = yield* executeMarketHistoryWithAuthorization(
          { marketRef: owner.marketRef },
          beforeOutageRead.authorization,
          beforeOutageRead.requestCorrelation,
          beforeOutageRead.options,
        );
        const beforeOutageEvidence = yield* owner.evidence();
        yield* owner.closeStorefront();
        const unavailableAssociation = yield* admit('native-storefront-unavailable');
        const rejectedAssociation = yield* executeReviseStorefrontAssociationWithAuthorization(
          {
            associationRef: associated.associationRef,
            channel: 'B2C',
            effectivePeriod: { startsAt: at(4) },
            expectedRevision: removed.revision,
            marketRef: owner.marketRef,
            provenance: { kind: 'CONFIGURATION_ACTION', reference: 'native-owner-unavailable-after-removal' },
            reason: 'Prove actual Storefront outage does not write Market truth',
            storefrontRef: owner.storefrontRef,
          },
          unavailableAssociation.authorization,
          unavailableAssociation.requestCorrelation,
          unavailableAssociation.options,
        ).pipe(Effect.result);
        expect(rejectedAssociation).toMatchObject({
          failure: { code: 'storefront_application_validation_unavailable', status: 503 },
        });
        const afterOutageRead = yield* admit('native-after-storefront-outage');
        const afterOutageHistory = yield* executeMarketHistoryWithAuthorization(
          { marketRef: owner.marketRef },
          afterOutageRead.authorization,
          afterOutageRead.requestCorrelation,
          afterOutageRead.options,
        );
        expect(afterOutageHistory).toEqual(beforeOutageHistory);
        const afterOutageEvidence = yield* owner.evidence();
        expect(afterOutageEvidence.outboxCount).toBe(beforeOutageEvidence.outboxCount);
        const retirePayload = {
          effectiveAt: at(6),
          expectedCurrentDefinitionRevisionRef: activated.definitionRevisionRef,
          expectedRevision: activated.revision,
          marketRef: owner.marketRef,
          reason: 'Retire with real CCC admission and finalization',
        };
        const retirement = yield* admit('native-retire');
        const retirementResult = yield* executeRetireMarketWithAuthorization(
          retirePayload,
          retirement.authorization,
          retirement.requestCorrelation,
          retirement.options,
        ).pipe(Effect.result);
        if (Result.isFailure(retirementResult)) {
          yield* Effect.logInfo('Native retirement stage metadata', yield* owner.evidence());
          expect(Result.isSuccess(retirementResult)).toBe(true);
          return;
        }
        const retired = retirementResult.success;
        expect(retired).toMatchObject({ changed: true, lifecycle: 'RETIRED', marketRef: owner.marketRef });
        const retirementRetry = yield* admit('native-retire-retry', 'native-retire');
        const recovered = yield* executeRetireMarketWithAuthorization(
          retirePayload,
          retirementRetry.authorization,
          retirementRetry.requestCorrelation,
          retirementRetry.options,
        );
        expect(recovered).toEqual(retired);
        const readback = yield* admit('native-readback');
        const history = yield* executeMarketHistoryWithAuthorization(
          { marketRef: owner.marketRef },
          readback.authorization,
          readback.requestCorrelation,
          readback.options,
        );
        expect(
          history.definitions.some(
            (value) => value.definitionRevisionRef.resourceId === created.definitionRevisionRef.resourceId,
          ),
        ).toBe(true);
        expect(
          history.definitions.some(
            (value) => value.definitionRevisionRef.resourceId === revised.definitionRevisionRef.resourceId,
          ),
        ).toBe(true);
        const currentAdmission = yield* admit('native-current');
        const current = yield* executeCurrentMarketCatalogWithAuthorization(
          { at: at(7) },
          currentAdmission.authorization,
          currentAdmission.requestCorrelation,
          currentAdmission.options,
        );
        expect(
          current.markets.find((value) => value.marketRef.resourceId === owner.marketRef.resourceId),
        ).toMatchObject({
          definitionRevisionRef: revised.definitionRevisionRef,
          lifecycle: 'RETIRED',
          marketRef: owner.marketRef,
        });
        expect(retired.revision).toBe(activated.revision + 1);
        expect(history.definitions).toHaveLength(2);
        const evidence = yield* owner.evidence();
        expect(evidence.admissions).toEqual([{ status: 'COMMITTED' }]);
        expect(evidence.outboxCount).toBeGreaterThan(0);
        const publicActions = [
          'create-market',
          'associate-storefront',
          'revise-market-definition',
          'suspend-market',
          'activate-market',
          'revise-storefront-association',
          'remove-storefront-association',
          'retire-market',
        ];
        for (const action of publicActions) {
          const invocations = evidence.invocations.filter(
            (value) => value.actionKey === `commerce.market-catalog.${action}` && value.status === 'succeeded',
          );
          expect(invocations).toHaveLength(1);
          for (const invocation of invocations) {
            expect(invocation.principalId).toEqual(Option.some(owner.principal.principalId));
            expect(
              evidence.audits.some(
                (audit) =>
                  Option.contains(audit.actionInvocationId, invocation.actionInvocationId) &&
                  Option.contains(audit.principalId, owner.principal.principalId) &&
                  audit.outcome === 'succeeded',
              ),
            ).toBe(true);
          }
        }
        for (const module of ['commerce.storefront-registry', 'commerce.customer-context']) {
          const accesses = evidence.accesses.filter((value) => value.servingModuleKey === module);
          expect(accesses.length).toBeGreaterThan(0);
          expect(accesses.every((value) => value.principalId === owner.principal.principalId)).toBe(true);
          expect(accesses.some((value) => value.outcome === 'allowed')).toBe(true);
        }
      }).pipe(Effect.scoped),
  ),
);

it.layer(marketRevisionNativeServices, { excludeTestServices: true })((suite) =>
  suite.effect('keeps an installed suspended Customer Context owner mandatory without future dummy providers', () =>
    Effect.gen(function* suspendedInstalledReferenceOwner() {
      const owner = yield* makeMarketRevisionNativeFixture();
      expect(owner.snapshot.composition.modules).toHaveLength(3);
      expect(owner.snapshot.composition.modules.map((module) => module.moduleId)).toEqual(
        expect.arrayContaining([
          'commerce.customer-context',
          'commerce.market-catalog',
          'commerce.storefront-registry',
        ]),
      );
      const admit = Effect.fn('NativeSuspendedOwner.admit')(function* admit(suffix: string) {
        const requestCorrelation = `native-suspended-${suffix}`;
        const admitted = yield* owner.issue({
          audience: 'commerce-market-catalog',
          compositionRevision: owner.compositionRevision,
          legalEntityId: owner.legalEntityId,
          requestCorrelation,
        });
        return {
          authorization: Redacted.value(admitted.credential),
          options: {
            baseUrl: admitted.baseUrl,
            compositionRevision: owner.compositionRevision,
            idempotencyKey: requestCorrelation,
          },
          requestCorrelation,
        };
      });
      const creation = yield* admit('create');
      const created = yield* executeCreateMarketWithAuthorization(
        {
          channels: ['B2C'],
          effectivePeriod: { startsAt: DateTime.makeUnsafe(DateTime.toEpochMillis(owner.now) - 3_600_000) },
          jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
          lifecycle: 'ACTIVE',
          marketCode: 'NATIVE_SUSPENDED_OWNER',
          marketId: owner.marketRef.resourceId,
          purpose: 'Retain installed reference-owner obligations',
          reason: 'Create a Market without future Cart or Order providers',
          sellingLegalEntityRef: owner.sellerRef,
          supportedLocales: ['cs-CZ'],
        },
        creation.authorization,
        creation.requestCorrelation,
        creation.options,
      );
      const before = yield* owner.evidence();
      yield* owner.setCustomerContextState('suspended');
      const retirementPayload = {
        effectiveAt: DateTime.makeUnsafe(DateTime.toEpochMillis(owner.now) + 1),
        expectedCurrentDefinitionRevisionRef: created.definitionRevisionRef,
        expectedRevision: created.revision,
        marketRef: owner.marketRef,
        reason: 'Require the installed Customer Context owner even while suspended',
      };
      const blockedAdmission = yield* admit('blocked');
      const blocked = yield* executeRetireMarketWithAuthorization(
        retirementPayload,
        blockedAdmission.authorization,
        blockedAdmission.requestCorrelation,
        blockedAdmission.options,
      ).pipe(Effect.result);
      expect(blocked).toMatchObject({
        failure: { code: 'market_retirement_impact_assessment_unavailable', status: 503 },
      });
      const blockedEvidence = yield* owner.evidence();
      expect(blockedEvidence.admissions).toEqual([]);
      expect(blockedEvidence.outboxCount).toBe(before.outboxCount);
      const readback = yield* admit('readback');
      const current = yield* executeCurrentMarketCatalogWithAuthorization(
        { at: DateTime.makeUnsafe(DateTime.toEpochMillis(owner.now) + 2) },
        readback.authorization,
        readback.requestCorrelation,
        readback.options,
      );
      expect(current.markets.find((value) => value.marketRef.resourceId === owner.marketRef.resourceId)).toMatchObject({
        definitionRevisionRef: created.definitionRevisionRef,
        lifecycle: 'ACTIVE',
        marketRef: owner.marketRef,
      });
      const historyAdmission = yield* admit('history');
      const history = yield* executeMarketHistoryWithAuthorization(
        { marketRef: owner.marketRef },
        historyAdmission.authorization,
        historyAdmission.requestCorrelation,
        historyAdmission.options,
      );
      expect(history.definitions).toHaveLength(1);
      yield* owner.setCustomerContextState('active');
      const restoredAdmission = yield* admit('restored');
      const retired = yield* executeRetireMarketWithAuthorization(
        retirementPayload,
        restoredAdmission.authorization,
        restoredAdmission.requestCorrelation,
        restoredAdmission.options,
      );
      expect(retired).toMatchObject({ changed: true, lifecycle: 'RETIRED', marketRef: owner.marketRef });
      const restoredEvidence = yield* owner.evidence();
      expect(restoredEvidence.admissions).toEqual([{ status: 'COMMITTED' }]);
      expect(restoredEvidence.outboxCount).toBeGreaterThan(before.outboxCount);
      expect(owner.compositionRevision).toBe(owner.snapshot.composition.revision);
    }).pipe(Effect.scoped),
  ),
);

it.layer(marketRevisionNativeServices, { excludeTestServices: true })((suite) =>
  suite.effect('denies private retirement management for the real actor while retaining public Retire rights', () =>
    Effect.gen(function* deniedRetirementManagement() {
      const owner = yield* makeMarketRevisionNativeFixture({ retirementManagementExecutor: 'denied' });
      expect(owner.relaySourcePrincipalId).not.toBe(owner.principal.principalId);
      const admit = Effect.fn('NativeManageDenial.admit')(function* admit(suffix: string) {
        const requestCorrelation = `native-manage-denied-${suffix}`;
        const proof = yield* owner.issue({
          audience: 'commerce-market-catalog',
          compositionRevision: owner.compositionRevision,
          legalEntityId: owner.legalEntityId,
          requestCorrelation,
        });
        return {
          authorization: Redacted.value(proof.credential),
          options: {
            baseUrl: proof.baseUrl,
            compositionRevision: owner.compositionRevision,
            idempotencyKey: requestCorrelation,
          },
          requestCorrelation,
        };
      });
      const create = yield* admit('create');
      const created = yield* executeCreateMarketWithAuthorization(
        {
          channels: ['B2C'],
          effectivePeriod: { startsAt: owner.now },
          jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
          lifecycle: 'ACTIVE',
          marketCode: 'MANAGE_DENIED',
          marketId: owner.marketRef.resourceId,
          purpose: 'Verify the independent management executor boundary',
          reason: 'Create the same real actor-owned Market before denying management',
          sellingLegalEntityRef: owner.sellerRef,
          supportedLocales: ['cs-CZ'],
        },
        create.authorization,
        create.requestCorrelation,
        create.options,
      );
      const before = yield* owner.evidence();
      const historyBeforeProof = yield* admit('history-before');
      const historyBefore = yield* executeMarketHistoryWithAuthorization(
        { marketRef: owner.marketRef },
        historyBeforeProof.authorization,
        historyBeforeProof.requestCorrelation,
        historyBeforeProof.options,
      );
      const retire = yield* admit('retire');
      const denial = yield* executeRetireMarketWithAuthorization(
        {
          effectiveAt: DateTime.makeUnsafe(DateTime.toEpochMillis(owner.now) + 1),
          expectedCurrentDefinitionRevisionRef: created.definitionRevisionRef,
          expectedRevision: created.revision,
          marketRef: owner.marketRef,
          reason: 'Retire is granted but the independent private Manage executor is absent',
        },
        retire.authorization,
        retire.requestCorrelation,
        retire.options,
      ).pipe(Effect.result);
      expect(denial).toMatchObject({ failure: { code: 'action_permission_denied', status: 403 } });
      const after = yield* owner.evidence();
      expect(after.admissions).toEqual(before.admissions);
      expect(after.outboxCount).toBe(before.outboxCount);
      expect(
        after.invocations.filter(
          (invocation) => invocation.actionKey === 'commerce.customer-context.reserve-market-retirement',
        ),
      ).toEqual(
        before.invocations.filter(
          (invocation) => invocation.actionKey === 'commerce.customer-context.reserve-market-retirement',
        ),
      );
      expect(after.accesses.filter((access) => access.servingModuleKey === 'commerce.customer-context')).toEqual(
        before.accesses.filter((access) => access.servingModuleKey === 'commerce.customer-context'),
      );
      expect(
        after.invocations.filter(
          (invocation) =>
            invocation.actionKey === 'commerce.market-catalog.retire-market' && invocation.status === 'succeeded',
        ),
      ).toEqual([]);
      const historyAfterProof = yield* admit('history-after');
      const historyAfter = yield* executeMarketHistoryWithAuthorization(
        { marketRef: owner.marketRef },
        historyAfterProof.authorization,
        historyAfterProof.requestCorrelation,
        historyAfterProof.options,
      );
      expect(historyAfter).toEqual(historyBefore);
    }).pipe(Effect.scoped),
  ),
);
