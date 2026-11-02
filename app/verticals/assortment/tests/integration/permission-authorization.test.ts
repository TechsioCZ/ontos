import {
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActiveApplicationCompositionSnapshotSchema,
  makeActiveApplicationCompositionLayer,
  ReadPermissionDenied,
} from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeNativeReadTestContext, NativeReadTestError } from '@app/core-runtime/testing/native-reads';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { and, count, eq } from 'drizzle-orm';
import { Config, Crypto, DateTime, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CreateApplicabilityBindingPayloadSchema,
  CreateRulePayloadSchema,
  ReplaceApplicabilityBindingPayloadSchema,
  RetireRulePayloadSchema,
} from '../../shared/actions/policy-administration.ts';
import { ConfigurationRequestSchema } from '../../shared/apis/configuration.ts';
import { createRuleAction } from '../../src/actions/create-rule.action.ts';
import { replaceApplicabilityBindingAction } from '../../src/actions/replace-applicability-binding.action.ts';
import { retireRuleAction } from '../../src/actions/retire-rule.action.ts';
import { configurationRead } from '../../src/api/configuration.read.ts';
import {
  applicabilityBindingEndFacts,
  applicabilityBindings,
  ruleRetirementFacts,
  ruleRevisions,
  stableRules,
} from '../../src/database/schema.ts';
import { assortmentOwnerAuthorizationOverlayLive } from '../../src/services/owner-authorization-current.ts';
import {
  assortmentMeaningFingerprint,
  assortmentPolicyPersistenceForScope,
} from '../../src/services/policy-administration.service.ts';
import { assortmentRegistration } from '../../vertical.registration.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const NativeRuleRevisionIdSchema = Schema.String.pipe(Schema.brand('NativeRuleRevisionId'));
const NativeStableRuleIdSchema = Schema.String.pipe(Schema.brand('NativeStableRuleId'));
const NativeBindingIdSchema = Schema.String.pipe(Schema.brand('NativeBindingId'));
const RulePersistenceSuccessSchema = Schema.Struct({
  created: Schema.Boolean,
  initialRevisionNumber: Schema.Number,
  initialRuleRevisionId: NativeRuleRevisionIdSchema,
  meaningFingerprint: Schema.String,
  stableRuleId: NativeStableRuleIdSchema,
});
const BindingPersistenceSuccessSchema = Schema.Struct({ bindingId: NativeBindingIdSchema, created: Schema.Boolean });

it.live(
  'enforces exact native Assortment grants, revocation, actor isolation and ordered Replace admission without replacing owner handlers',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeAssortmentAuthorization() {
        const snapshotPath = yield* Config.String('NATIVE_1290_COMPOSITION_SNAPSHOT_PATH');
        const fs = yield* FileSystem.FileSystem;
        const snapshot = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
        )(yield* fs.readFileString(snapshotPath));
        const ownerModule = snapshot.composition.modules.find((module) => module.moduleId === 'commerce.assortment');
        if (ownerModule === undefined) {
          return yield* Effect.fail(
            new NativeReadTestError({
              code: 'native_read_test_failed',
              reason: 'The actual built Composition must contain Assortment',
            }),
          );
        }
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1290-assortment-authorization',
        });
        yield* isolated.assertClonedSchema();
        // Clone-local test SQL privileges only; source/base and production ACL readiness remain unchanged.
        yield* isolated.prepareAssortmentAuthorizationRuntime();
        const fixture = yield* makeNativeReadTestContext(
          {
            connections: {
              admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
              runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
            },
            contextPermissions: [],
            expectedDeployment: ownerModule.deployment,
            moduleId: 'commerce.assortment',
            ownerFixtureRetention: 'retain-complete-context',
          },
          assortmentRegistration,
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              assortmentOwnerAuthorizationOverlayLive,
              makeActiveApplicationCompositionLayer(Effect.succeed(snapshot)),
            ),
          ),
        );
        const { actionRuntime } = fixture;
        const { secondaryPrincipal } = fixture;
        if (actionRuntime === undefined || secondaryPrincipal === undefined) {
          return yield* Effect.fail(
            new NativeReadTestError({
              code: 'native_read_test_failed',
              reason: 'The owner fixture must expose its real Action runtime and secondary actor',
            }),
          );
        }
        return yield* Effect.gen(function* runRegisteredOwnerOperations() {
          const crypto = yield* Crypto.Crypto;
          const stableCode = 'authorization.native';
          const created = yield* fixture.prepareOwner((transaction, scope) =>
            Effect.gen(function* seedOwnedMeaning() {
              const persistence = assortmentPolicyPersistenceForScope(transaction, scope);
              const createRule = yield* Schema.decodeUnknownEffect(CreateRulePayloadSchema)({
                effect: 'ALLOW',
                provenanceRef: 'native-authorization:seed-rule',
                purpose: 'PURCHASE',
                reason: 'Seed self-contained owner meaning',
                selector: { kind: 'ALL' },
                stableCode,
              });
              const rule = yield* Schema.decodeUnknownEffect(RulePersistenceSuccessSchema)(
                yield* persistence.createRule({
                  ...createRule,
                  actionInvocationId: yield* crypto.randomUUIDv4(),
                  actorPrincipalId: scope.principalId,
                  tenantId: scope.tenantId,
                }),
              );
              const ruleRevisionRef = {
                ownerModuleId: 'commerce.assortment',
                revision: String(rule.initialRevisionNumber),
                sourceRef: {
                  moduleId: 'commerce.assortment',
                  resourceId: rule.initialRuleRevisionId,
                  resourceType: 'commerce.assortment.rule-revision',
                  tenantId: scope.tenantId,
                },
              };
              const commercialScope = {
                channelRef: {
                  moduleId: 'commerce.channel',
                  resourceId: 'native-channel',
                  resourceType: 'commerce.channel.channel',
                  tenantId: scope.tenantId,
                },
                sellingLegalEntityRef: {
                  moduleId: 'party.registry',
                  resourceId: scope.legalEntityId,
                  resourceType: 'party.registry.legal-entity',
                  tenantId: scope.tenantId,
                },
              };
              const createBinding = yield* Schema.decodeUnknownEffect(CreateApplicabilityBindingPayloadSchema)({
                audience: { kind: 'SHARED' },
                commercialScope,
                effectiveFrom: '2000-01-01T00:00:00.000Z',
                provenanceRef: 'native-authorization:seed-binding',
                reason: 'Seed the existing side of a replacement',
                ruleRevisionRef,
              });
              if (scope.legalEntityId === undefined) {
                return yield* Effect.fail(
                  new NativeReadTestError({
                    code: 'native_read_test_failed',
                    reason: 'Binding producer requires the verified Legal Entity',
                  }),
                );
              }
              const binding = yield* Schema.decodeUnknownEffect(BindingPersistenceSuccessSchema)(
                yield* persistence.createBinding({
                  ...createBinding,
                  actionInvocationId: yield* crypto.randomUUIDv4(),
                  actorPrincipalId: scope.principalId,
                  legalEntityId: scope.legalEntityId,
                  tenantId: scope.tenantId,
                }),
              );
              const [row] = yield* transaction
                .select()
                .from(applicabilityBindings)
                .where(
                  and(
                    eq(applicabilityBindings.tenantId, scope.tenantId),
                    eq(applicabilityBindings.applicabilityBindingId, binding.bindingId),
                  ),
                )
                .limit(1);
              if (row === undefined) {
                return yield* Effect.fail(
                  new NativeReadTestError({
                    code: 'native_read_test_failed',
                    reason: 'The actual owner producer must persist its Binding',
                  }),
                );
              }
              return {
                binding,
                bindingBasis: assortmentMeaningFingerprint({
                  bindingKind: row.bindingKind,
                  channelResourceId: row.channelResourceId,
                  customerGroupResourceId: row.customerGroupResourceId,
                  effectiveFrom: DateTime.formatIso(DateTime.makeUnsafe(row.effectiveFrom)),
                  marketResourceId: row.marketResourceId,
                  ruleRevisionId: row.ruleRevisionId,
                  storefrontResourceId: row.storefrontResourceId,
                  subjectKind: row.subjectKind,
                  subjectResourceId: row.subjectResourceId,
                }),
                commercialScope,
                rule,
                ruleRevisionRef,
              };
            }),
          );
          expect(created.rule.created).toBe(true);
          expect(created.binding.created).toBe(true);
          const history = () =>
            fixture
              .prepareOwner((transaction, scope) =>
                Effect.all(
                  {
                    bindingEnds: transaction
                      .select({ total: count() })
                      .from(applicabilityBindingEndFacts)
                      .where(eq(applicabilityBindingEndFacts.tenantId, scope.tenantId)),
                    bindings: transaction
                      .select({ total: count() })
                      .from(applicabilityBindings)
                      .where(eq(applicabilityBindings.tenantId, scope.tenantId)),
                    retirements: transaction
                      .select({ total: count() })
                      .from(ruleRetirementFacts)
                      .where(eq(ruleRetirementFacts.tenantId, scope.tenantId)),
                    revisions: transaction
                      .select({ total: count() })
                      .from(ruleRevisions)
                      .where(eq(ruleRevisions.tenantId, scope.tenantId)),
                    rules: transaction
                      .select({ total: count() })
                      .from(stableRules)
                      .where(eq(stableRules.tenantId, scope.tenantId)),
                  },
                  { concurrency: 1 },
                ),
              )
              .pipe(
                Effect.zipWith(fixture.ownerOutboxCount(), (ownerHistory, outbox) => ({ ...ownerHistory, outbox })),
              );
          const stableRuleRef = {
            moduleId: 'commerce.assortment',
            resourceId: created.rule.stableRuleId,
            resourceType: 'commerce.assortment.stable-rule',
            tenantId: fixture.principal.tenantId,
          };
          const readInput = yield* Schema.decodeUnknownEffect(Schema.toEncoded(ConfigurationRequestSchema))({
            resource: stableRuleRef,
          });
          yield* fixture.grantReadOwnerPermission(configurationRead, readInput);
          const read = yield* fixture.runtime.runRead({
            audience: ownerModule.deployment.appId,
            input: readInput,
            principal: fixture.principal,
            registration: configurationRead,
            transport: { correlationId: 'native-assortment-read-allowed' },
          });
          expect(read).toMatchObject({ configuration: { kind: 'RULE', value: { stableRuleRef } } });
          const otherActorDenied = yield* fixture.runtime
            .runRead({
              audience: ownerModule.deployment.appId,
              input: readInput,
              principal: secondaryPrincipal,
              registration: configurationRead,
              transport: { correlationId: 'native-assortment-secondary-denied' },
            })
            .pipe(Effect.flip);
          expect(Schema.is(ReadPermissionDenied)(otherActorDenied)).toBe(true);
          yield* fixture.revokeReadOwnerPermission(configurationRead, readInput);
          const revoked = yield* fixture.runtime
            .runRead({
              audience: ownerModule.deployment.appId,
              input: readInput,
              principal: fixture.principal,
              registration: configurationRead,
              transport: { correlationId: 'native-assortment-read-revoked' },
            })
            .pipe(Effect.flip);
          expect(Schema.is(ReadPermissionDenied)(revoked)).toBe(true);

          const { legalEntityId: selectedLegalEntityId, ...tenantPrincipal } = fixture.principal;
          expect(selectedLegalEntityId).toBeDefined();
          const effectiveAt = DateTime.formatIso(yield* DateTime.now);
          const retirePayload = yield* Schema.decodeUnknownEffect(Schema.toEncoded(RetireRulePayloadSchema))({
            effectiveAt,
            expectedBasisFingerprint: assortmentMeaningFingerprint({
              latestRevisionId: created.rule.initialRuleRevisionId,
              latestRevisionNumber: created.rule.initialRevisionNumber,
              retired: false,
              stableCode,
            }),
            provenanceRef: 'native-authorization:retire',
            reason: 'Exercise the actual registered retirement',
            stableRuleRef,
          });
          yield* fixture.grantActionExecution(retireRuleAction);
          const beforeRetireDenied = yield* history();
          const retireDenied = yield* actionRuntime
            .runAction({
              audience: ownerModule.deployment.appId,
              payload: retirePayload,
              principal: tenantPrincipal,
              registration: retireRuleAction,
              transport: {
                correlationId: 'native-assortment-retire-denied',
                idempotencyKey: 'native-assortment-retire-denied',
              },
            })
            .pipe(Effect.flip);
          expect(Schema.is(ActionPermissionDenied)(retireDenied)).toBe(true);
          expect(yield* history()).toEqual(beforeRetireDenied);

          const replacePayload = yield* Schema.decodeUnknownEffect(
            Schema.toEncoded(ReplaceApplicabilityBindingPayloadSchema),
          )({
            effectiveAt,
            existingBindingRef: {
              moduleId: 'commerce.assortment',
              resourceId: created.binding.bindingId,
              resourceType: 'commerce.assortment.applicability-binding',
              tenantId: fixture.principal.tenantId,
            },
            expectedExistingBasisFingerprint: created.bindingBasis,
            proposedAudience: { kind: 'SHARED' },
            proposedCommercialScope: created.commercialScope,
            proposedEffectiveFrom: effectiveAt,
            proposedRuleRevisionRef: created.ruleRevisionRef,
            provenanceRef: 'native-authorization:replace',
            reason: 'An old End grant cannot authorize proposed Create',
          });
          yield* fixture.grantActionExecution(replaceApplicabilityBindingAction);
          yield* fixture.grantActionOwnerPermission(replaceApplicabilityBindingAction, replacePayload, 0);
          const beforeReplace = yield* history();
          const replaceDenied = yield* actionRuntime
            .runAction({
              audience: ownerModule.deployment.appId,
              payload: replacePayload,
              principal: fixture.principal,
              registration: replaceApplicabilityBindingAction,
              transport: {
                correlationId: 'native-assortment-replace-denied',
                idempotencyKey: 'native-assortment-replace-denied',
              },
            })
            .pipe(Effect.flip);
          expect(Schema.is(ActionPermissionDenied)(replaceDenied)).toBe(true);
          expect(yield* history()).toEqual(beforeReplace);

          yield* fixture.grantActionOwnerPermission(retireRuleAction, retirePayload);
          const retired = yield* actionRuntime.runAction({
            audience: ownerModule.deployment.appId,
            payload: retirePayload,
            principal: tenantPrincipal,
            registration: retireRuleAction,
            transport: {
              correlationId: 'native-assortment-retire-allowed',
              idempotencyKey: 'native-assortment-retire-allowed',
            },
          });
          expect(retired).toMatchObject({ retired: true, stableRuleRef });
          expect((yield* history()).retirements).toEqual([{ total: 1 }]);

          const createPayload = yield* Schema.decodeUnknownEffect(Schema.toEncoded(CreateRulePayloadSchema))({
            effect: 'ALLOW',
            provenanceRef: 'native-authorization:create-unavailable',
            purpose: 'PURCHASE',
            reason: 'A grant cannot fabricate Current create proof',
            selector: { kind: 'ALL' },
            stableCode: 'authorization.unavailable',
          });
          yield* fixture.grantActionExecution(createRuleAction);
          yield* fixture.grantActionOwnerPermission(createRuleAction, createPayload);
          const beforeCreate = yield* history();
          const createUnavailable = yield* actionRuntime
            .runAction({
              audience: ownerModule.deployment.appId,
              payload: createPayload,
              principal: tenantPrincipal,
              registration: createRuleAction,
              transport: {
                correlationId: 'native-assortment-create-unavailable',
                idempotencyKey: 'native-assortment-create-unavailable',
              },
            })
            .pipe(Effect.flip);
          expect(Schema.is(ActionPermissionCheckError)(createUnavailable)).toBe(true);
          expect(yield* history()).toEqual(beforeCreate);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ).pipe(Effect.provide(nativeServices)),
);
