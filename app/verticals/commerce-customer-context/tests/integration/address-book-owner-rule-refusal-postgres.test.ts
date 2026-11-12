import { randomUUID } from 'node:crypto';

import { ActionPermissionDenied, defineScopedRoutine, runAction } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { mapAddSavedAddressActionProblem } from '../../api/add-saved-address-action-problems.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { addSavedAddressAction } from '../../src/actions/add-saved-address.action.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

/**
 * Stage, 2026-11-12: the tenant owner holds "Plný přístup" and "Proč?" answers ALLOWED for
 * `commerce.customer-context.saved-address.add`, yet adding a saved address to an existing
 * Counterparty purchasing profile answered 403 `action_permission_denied` with no logged reason.
 *
 * The refusal is this owner's own rule (O67-Q1): a Counterparty-governed operation also needs an
 * ACTIVE owner-local Counterparty grant of the exact Counterparty Permission for the acting person,
 * which neither the v2 gate nor "Proč?" sees. The suite runs the stage shape for that decision — the
 * gate answers ALLOWED (as "Proč?" did), no legacy authorization tuple exists, the owner's real
 * overlay reads its real grant table — and proves the refusal now names the rule and the missing
 * right in the error and the 403 body, and that this grant, nothing else, decides it.
 */
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const row = Schema.Struct({ outcome: Schema.String, payload: Schema.Unknown });
const ensureCounterpartyProfile = defineScopedRoutine({
  name: 'ensure_counterparty_profile',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: row,
  routineKey: 'test.address-owner-rule.ensure-profile',
  schema: 'commerce_customer_context',
});
const GrantRowSchema = Schema.Struct({ permission_code: Schema.String, state: Schema.String });
const grantCounterpartyAccess = defineScopedRoutine({
  name: 'grant_access',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: GrantRowSchema,
  routineKey: 'test.address-owner-rule.grant',
  schema: 'commerce_customer_context',
});
const listCounterpartyGrants = defineScopedRoutine({
  name: 'list_access_grants',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
  ],
  resultSchema: GrantRowSchema,
  routineKey: 'test.address-owner-rule.list-grants',
  schema: 'commerce_customer_context',
});
const ProfileSchema = Schema.Struct({
  profileRef: Schema.Struct({ resourceId: Schema.String.pipe(Schema.brand('NativeCounterpartyProfileId')) }),
});
const ownerRuleReasons = ['deny.owner.counterparty_grant_missing', 'requires.counterparty.address_book.manage'];

it.live(
  'refuses a Counterparty address for the full-access owner by the owner grant rule, and says why',
  () =>
    Effect.scoped(
      Effect.gen(function* ownerRuleRefusal() {
        const snapshot = yield* enrollmentApplicationCompositionSnapshot;
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'stabilization-1268-address-plan',
        });
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            // "Proč?" on stage: ALLOWED through "Plný přístup". No legacy action tuple is written.
            access: 'allowed',
            actionKeys: [],
            adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
            allowedAudiences: ['commerce-customer-context'],
            applicationComposition: { load: Effect.succeed(snapshot) },
            authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: snapshot.composition.revision,
            expectedDeployment: ultramodernApiMarker,
            moduleKeys: ['commerce.customer-context'],
            ownerRegistration: commerceCustomerContextRegistration,
            runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
          }),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        const context = yield* Layer.build(
          fixture.layer.pipe(Layer.provide(commerceCustomerContextOwnerAuthorizationOverlayLive)),
        );
        const counterpartyId = randomUUID();
        const [created] = yield* fixture
          .prepareOwner(
            (transaction) =>
              transaction.invoke(ensureCounterpartyProfile, [
                counterpartyId,
                null,
                randomUUID(),
                'native-role-revision',
                '2020-01-01T00:00:00.000Z',
                'AUTHORIZED_ONBOARDING',
                randomUUID(),
                fixture.manager.principalId,
              ]),
            'required',
          )
          .pipe(Effect.provideContext(context));
        if (created === undefined) {
          return yield* Effect.die('Missing native Counterparty purchasing profile');
        }
        const { profileRef } = yield* Schema.decodeUnknownEffect(ProfileSchema)(created.payload);
        const payload = {
          origin: {
            kind: 'COMMERCE_ONLY',
            postalAddress: { addressLine1: '1 Stage Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
          },
          profile: {
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: counterpartyId,
              resourceType: 'party.registry.counterparty',
              tenantId: fixture.tenantId,
            },
            kind: 'COUNTERPARTY',
            profileRef: {
              moduleId: 'commerce.customer-context',
              resourceId: profileRef.resourceId,
              resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
              tenantId: fixture.tenantId,
            },
          },
          purposes: ['DELIVERY'],
          reason: 'Stage owner address refusal',
        } as const;
        const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
        const add = () =>
          runAction({
            payload,
            principal,
            registration: addSavedAddressAction,
            transport: {
              correlationId: randomUUID(),
              idempotencyKey: randomUUID(),
              targetModuleKey: 'commerce.customer-context',
            },
          }).pipe(Effect.provideContext(context), Effect.result);
        const grantsOfOwner = () =>
          fixture
            .prepareOwner(
              (transaction) =>
                transaction.invoke(listCounterpartyGrants, [counterpartyId, fixture.manager.principalId]),
              'required',
            )
            .pipe(Effect.provideContext(context));

        // No owner-local Counterparty grant: the owner rule refuses, and names the rule and the right.
        expect(yield* grantsOfOwner()).toEqual([]);
        const refused = yield* add();
        if (Result.isSuccess(refused)) {
          return yield* Effect.die('The owner rule admitted an owner without a Counterparty grant');
        }
        expect(Schema.is(ActionPermissionDenied)(refused.failure)).toBe(true);
        expect(refused.failure).toMatchObject({ code: 'action_permission_denied', reasons: ownerRuleReasons });
        expect(mapAddSavedAddressActionProblem(refused.failure)).toMatchObject({
          _tag: 'AddSavedAddressActionForbiddenProblem',
          code: 'action_permission_denied',
          reasons: ownerRuleReasons,
          status: 403,
        });

        // The owner rule's own right, written through its own grant routine, is exactly what admits.
        const [grant] = yield* fixture
          .prepareOwner(
            (transaction) =>
              transaction.invoke(grantCounterpartyAccess, [
                counterpartyId,
                fixture.manager.principalId,
                'counterparty.address_book.manage',
                null,
                fixture.manager.principalId,
                randomUUID(),
                'Stage owner address refusal control',
                true,
              ]),
            'required',
          )
          .pipe(Effect.provideContext(context));
        expect(grant).toMatchObject({ permission_code: 'counterparty.address_book.manage', state: 'ACTIVE' });
        const admitted = yield* add();
        if (Result.isFailure(admitted)) {
          return yield* Effect.die(admitted.failure);
        }
        expect(admitted.success.outcome).toBe('ADDED');
        return true;
      }),
    ).pipe(Effect.provide(services)),
  180_000,
);
