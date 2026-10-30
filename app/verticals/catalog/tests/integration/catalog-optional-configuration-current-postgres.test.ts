import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  makeContextPermissionRelationshipMutationLive,
} from '@app/core-runtime';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { FetchHttpClient } from 'effect/http';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { selectionEvidenceReadApiLive } from '../../api/selection-evidence-read-server.ts';
import { catalogApi } from '../../shared/api.ts';
import {
  SelectionEvidenceAuthenticationProblemSchema,
  SelectionEvidenceForbiddenProblemSchema,
  SelectionEvidenceUnavailableProblemSchema,
} from '../../shared/apis/selection-evidence.ts';
import { executeSelectionEvidenceWithAuthorization } from '../../src/api/selection-evidence-client.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { AttributeDefinitionRefSchema } from '../../shared/resources/attribute-definition.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CartOpenSelectionPopulationPort } from '../../shared/domain/catalog-open-selection-population.ts';
import { ProductUnitRefSchema } from '../../shared/resources/product-unit.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { attributeApplicabilityPersistenceForScope } from '../../src/persistence/attribute-applicability-persistence.ts';
import { attributePersistenceForScope } from '../../src/persistence/attribute-persistence.ts';
import { attributeValuesPersistenceForScope } from '../../src/persistence/attribute-values-persistence.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import { productConfigurationSelectionImpactForScope } from '../../src/persistence/catalog-selection-change-impact.ts';
import { catalogSelectionPackageUnitBasisForScope } from '../../src/persistence/catalog-selection-package-unit-basis.ts';
import { catalogSelectionEvidenceForScope } from '../../src/persistence/catalog-selection-evidence-service.ts';
import { categoryPersistenceForScope } from '../../src/persistence/category-persistence.ts';
import { localizedProductFactsPersistenceForScope } from '../../src/persistence/localized-product-facts-persistence.ts';
import { productConfigurationPersistenceForScope } from '../../src/persistence/product-configuration-persistence.ts';
import { productTypeAssignmentPersistenceForScope } from '../../src/persistence/product-type-assignment-persistence.ts';
import { productTypeCreatePersistenceForScope } from '../../src/persistence/product-type-create-persistence.ts';
import { productUnitPersistenceForScope } from '../../src/persistence/product-unit-persistence.ts';
import { productUnitTargetBasisForScope } from '../../src/persistence/product-unit-target-basis.ts';
import { variantAxisPersistenceForScope } from '../../src/persistence/variant-axis-persistence.ts';
import { variantPersistenceForScope } from '../../src/persistence/variant-persistence.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

it.live(
  'accepts an omitted optional Configuration choice from genuine current owner revisions',
  () =>
    Effect.gen(function* optionalConfigurationNative() {
      const composition = yield* makeApplicationCompositionSnapshotFixture(
        ['catalog'],
        ultramodernApiMarker.buildMarker,
      );
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: composition,
        mode: 'schema-only',
        purpose: 'stabilization-1263-optional-configuration',
      });
      yield* isolated.assertClonedSchema();
      const adminContext = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      );
      const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionKeys: [],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          allowedAudiences: ['catalog'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.composition.revision,
          moduleKeys: ['commerce.catalog'],
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      const fixtureContext = yield* Layer.build(fixture.layer);
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      const principal = { principalId: fixture.manager.principalId, tenantId: fixture.tenantId };
      const targets = [
        { moduleId: 'commerce.catalog', permission: 'module.access' as const },
        { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.selection-evidence' as const },
      ];
      yield* Effect.forEach(
        targets,
        (target) => permissions.mutate({ operation: 'grant', principal, target, tenantId: fixture.tenantId }),
        { concurrency: 1 },
      );
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          targets,
          (target) => permissions.mutate({ operation: 'revoke', principal, target, tenantId: fixture.tenantId }),
          { concurrency: 1 },
        ).pipe(Effect.asVoid, Effect.orDie),
      );
      const selected = yield* fixture
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* produceCatalogSelection() {
            const { principalId } = fixture.manager;
            const reason = 'Document observed native fixture product and its permitted configuration';
            const evidenceRefs: readonly [string, ...string[]] = ['fixture:1263:observed-matte-sample'];
            const effectiveAt = DateTime.toDateUtc(composition.observedAt);
            const absentText = Option.getOrUndefined(Option.none<string>());
            const catalog = yield* catalogPersistenceForScope(transaction, scope);
            const created = yield* catalog.create({
              actionInvocationId: yield* nextId,
              description: absentText,
              name: 'Observed sample',
              principalId,
              reason,
              tenantId: scope.tenantId,
              variantId: absentText,
            });
            const createdResult = Match.value(created).pipe(
              Match.tag('created', (result) => result),
              Match.orElse((failure) => assert.fail(JSON.stringify(failure))),
            );
            const { productRef } = createdResult.product;
            const variantRef = yield* Schema.decodeUnknownEffect(VariantRefSchema)({
              moduleId: 'commerce.catalog',
              resourceId: createdResult.variantId,
              resourceType: 'commerce.catalog.variant',
              tenantId: scope.tenantId,
            });
            const attributes = yield* attributePersistenceForScope(transaction, scope);
            const definition = yield* attributes.createDefinition({
              actionInvocationId: yield* nextId,
              allowsNone: false,
              allowsNotApplicable: false,
              allowsUnknown: false,
              applicableLevels: ['VARIANT'],
              effectiveAt,
              meaning: 'Observed surface finish distinguishing physical variants',
              multiplicity: 'SINGLE',
              name: 'Surface finish',
              principalId,
              reason,
              valueKind: 'TEXT',
            });
            const attributeDefinitionRef = yield* Schema.decodeUnknownEffect(AttributeDefinitionRefSchema)(
              definition.attributeDefinitionRef,
            );
            const types = yield* productTypeCreatePersistenceForScope(transaction, scope);
            const type = yield* types.create({
              actionInvocationId: yield* nextId,
              effectiveAt,
              name: 'Observed sample type',
              principalId,
              reason,
              rules: [{ attributeDefinitionRef, level: 'VARIANT', required: true }],
            });
            // Explicit bounded Cart TEST population prerequisite. Real Catalog validators consume
            // the token; production's absent Cart provider remains unavailable. No Cart call
            // participates in the eventual PRICING Selection Read.
            const population: CartOpenSelectionPopulationPort = {
              read: () =>
                Effect.succeed({
                  complete: true,
                  observedAt: effectiveAt.toISOString(),
                  revisionToken: '1263-owned-empty-population',
                  selections: [],
                  tenantId: scope.tenantId,
                }),
            };
            const assignment = yield* productTypeAssignmentPersistenceForScope(transaction, scope, {
              openSelections: population,
            });
            const assigned = yield* assignment.set({
              actionInvocationId: yield* nextId,
              expectedProductRevision: createdResult.product.revision,
              impactBasis: '1263-owned-empty-population',
              nextProductTypeRef: type.productTypeRef,
              principalId,
              productId: productRef.resourceId,
              reason,
            });
            const applicability = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
            yield* applicability.change({
              actionInvocationId: yield* nextId,
              attributeDefinitionRef,
              expectedRevision: null,
              principalId,
              productLevel: false,
              productRef,
              reason,
              variantLevel: true,
            });
            const values = yield* attributeValuesPersistenceForScope(transaction, scope);
            yield* values.setVariantOverride({
              actionInvocationId: yield* nextId,
              attributeDefinitionRef,
              classification: {
                evidenceRefs,
                kind: 'NON_MATERIAL',
                reason: 'First observation of the existing WIP sample; no realization changed',
              },
              expectedRevision: null,
              principalId,
              productRef,
              reason,
              values: [{ kind: 'TEXT', text: 'matte' }],
              variantRef,
            });
            const axes = variantAxisPersistenceForScope(transaction, scope);
            const governed = yield* axes.govern({
              actionInvocationId: yield* nextId,
              axes: [
                {
                  attributeDefinitionId: definition.attributeDefinitionRef.resourceId,
                  definitionRevision: definition.revision,
                  expectedAllowanceRevision: 0,
                },
              ],
              change: { evidenceRefs, kind: 'AXIS_ADDITION', reason },
              expectedAxisRevision: 0,
              principalId,
              productRef,
              reason,
            });
            expect(governed).toEqual({ axisRevision: 1, changed: true });
            const allowed = yield* axes.governAllowedValues({
              actionInvocationId: yield* nextId,
              attributeDefinitionId: definition.attributeDefinitionRef.resourceId,
              definitionRevision: definition.revision,
              evidenceRefs,
              expectedAllowanceRevision: 0,
              expectedAxisRevision: 1,
              principalId,
              productRef,
              reason,
              values: [{ kind: 'TEXT', text: 'matte' }],
            });
            expect(
              Match.value(allowed).pipe(
                Match.tag('governed', () => true),
                Match.orElse(() => false),
              ),
            ).toBe(true);
            const confirmed = yield* variantPersistenceForScope(transaction, scope).confirm({
              actionInvocationId: yield* nextId,
              evidenceRefs,
              expectedAxisRevision: 1,
              expectedVariantRevision: 1,
              principalId,
              productRef,
              reason,
              variantRef,
            });
            const confirmedResult = Match.value(confirmed).pipe(
              Match.tag('confirmed', (result) => result),
              Match.orElse((failure) => assert.fail(JSON.stringify(failure))),
            );
            const localized = yield* localizedProductFactsPersistenceForScope(transaction, scope).changeProduct({
              actionInvocationId: yield* nextId,
              evidenceRefs,
              expectedRevision: 0,
              locale: 'en',
              principalId,
              productRef,
              reason,
              value: { facts: { name: 'Observed sample' }, kind: 'SET' },
            });
            expect(localized.kind).toBe('CHANGED');
            const activated = yield* catalog.update({
              actionInvocationId: yield* nextId,
              activateVariantId: absentText,
              expectedRevision: assigned.revision,
              principalId,
              productId: productRef.resourceId,
              reason,
              targetLifecycle: 'ACTIVE',
              tenantId: scope.tenantId,
            });
            const activatedResult = Match.value(activated).pipe(
              Match.tag('updated', (result) => result),
              Match.orElse((failure) => assert.fail(JSON.stringify(failure))),
            );
            const unitRef = yield* Schema.decodeUnknownEffect(ProductUnitRefSchema)({
              moduleId: 'commerce.catalog',
              resourceId: yield* nextId,
              resourceType: 'commerce.catalog.product-unit',
              tenantId: scope.tenantId,
            });
            const units = productUnitPersistenceForScope(
              transaction,
              scope,
              productUnitTargetBasisForScope(transaction, scope),
            );
            yield* units.create({
              actionInvocationId: yield* nextId,
              payload: {
                code: 'sample',
                evidenceRefs,
                label: 'Sample piece',
                reason,
                rule: { rounding: 'UP', step: '1' },
                unitRef,
              },
              principalId,
            });
            yield* units.setTargetDivisibility({
              actionInvocationId: yield* nextId,
              payload: {
                divisible: false,
                evidenceRefs,
                expectedSources: {
                  product: {
                    resourceRef: productRef,
                    revision: yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(
                      activatedResult.product.revision,
                    ),
                  },
                  variant: {
                    resourceRef: variantRef,
                    revision: yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(confirmedResult.revision),
                  },
                },
                reason,
                target: {
                  targetId: variantRef.resourceId,
                  targetType: 'commerce.catalog.variant',
                  tenantId: scope.tenantId,
                  unit: unitRef,
                },
              },
              principalId,
            });
            const categories = yield* categoryPersistenceForScope(transaction, scope);
            const categoryId = yield* nextId;
            yield* categories.createCategory({
              actionInvocationId: yield* nextId,
              categoryId,
              name: 'Samples',
              principalId,
              reason,
              tenantId: scope.tenantId,
            });
            yield* categories.addAssignment({
              actionInvocationId: yield* nextId,
              categoryId,
              principalId,
              productId: productRef.resourceId,
              reason,
              tenantId: scope.tenantId,
            });
            const definitionId = yield* nextId;
            const configurations = productConfigurationPersistenceForScope(
              transaction,
              scope,
              productConfigurationSelectionImpactForScope(transaction, scope, population),
            );
            const published = yield* configurations.publish({
              actionInvocationId: yield* nextId,
              choices: ['mount', 'finish'].map((choiceKey) => ({
                choiceKey,
                kind: 'SINGLE_CHOICE' as const,
                label: choiceKey,
                meaning: `Customer ${choiceKey} option`,
                options: [{ label: 'A', meaning: `Option A for ${choiceKey}`, optionKey: 'A' }],
                required: choiceKey === 'mount',
              })),
              compatibilityRules: [],
              definitionId,
              effectiveFrom: effectiveAt,
              evidenceRefs,
              expectedRevision: 0,
              measuredRules: [],
              optionAllowances: ['mount', 'finish'].map((choiceKey) => ({
                allowed: true,
                choiceKey,
                evidenceRefs,
                optionKey: 'A',
              })),
              principalId,
              productId: productRef.resourceId,
              reason,
            });
            const publishedResult = Match.value(published).pipe(
              Match.tag('published', (result) => result),
              Match.orElse((failure) => assert.fail(JSON.stringify(failure))),
            );
            return yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
              configuration: {
                choices: [{ choiceKey: 'mount', value: 'A' }],
                definition: {
                  resourceRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: definitionId,
                    resourceType: 'commerce.catalog.configuration-definition',
                    tenantId: scope.tenantId,
                  },
                  revision: publishedResult.revision,
                },
                productRef,
                variantRef,
              },
              productRef,
              variantRef,
            });
          }),
        )
        .pipe(Effect.provideContext(fixtureContext));
      assert(selected.configuration !== undefined);
      const { configuration } = selected;
      const observeDefinition = () =>
        fixture
          .prepareOwner((transaction, scope) =>
            productConfigurationPersistenceForScope(transaction, scope).readCurrent({
              at: DateTime.toDateUtc(composition.observedAt),
              definitionId: configuration.definition.resourceRef.resourceId,
              productId: selected.productRef.resourceId,
            }),
          )
          .pipe(Effect.provideContext(fixtureContext), Effect.map(Option.getOrThrow));
      const fullDefinition = yield* observeDefinition();
      expect(fullDefinition.choices).toHaveLength(2);
      expect(fullDefinition.choices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ choiceKey: 'mount', required: true }),
          expect.objectContaining({ choiceKey: 'finish', required: false }),
        ]),
      );
      expect(configuration.choices).toHaveLength(1);
      const adapter = yield* fixture
        .prepareOwner((transaction, scope) =>
          catalogSelectionPackageUnitBasisForScope(transaction, scope).read(
            selected,
            DateTime.toDateUtc(composition.observedAt),
          ),
        )
        .pipe(Effect.provideContext(fixtureContext));
      expect(adapter).toMatchObject({
        configuration: {
          choiceRevisions: expect.arrayContaining([
            expect.objectContaining({ choiceKey: 'mount' }),
            expect.objectContaining({ choiceKey: 'finish' }),
          ]),
        },
        status: 'CURRENT',
      });
      const assessment = yield* fixture
        .prepareOwner((transaction, scope) =>
          catalogSelectionEvidenceForScope(transaction, scope).assess({ purpose: 'PRICING', selection: selected }),
        )
        .pipe(Effect.provideContext(fixtureContext));
      expect(assessment.evidence).toMatchObject({ purpose: 'PRICING', selection: selected, status: 'VALID' });
      expect(assessment.missingRoles).toEqual([]);
      const keyPair = yield* Effect.sync(() => generateKeyPairSync('ed25519'));
      const kid = 'catalog-optional-configuration';
      const tokenIssuer = 'https://disposable-shell.ontos.test';
      const jwks = JSON.stringify({
        keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
      });
      const now = Math.floor(DateTime.toEpochMillis(composition.observedAt) / 1000);
      const authorization = Effect.fn('OptionalConfiguration.authorization')(function* authorization(
        actor = fixture.manager,
      ) {
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(
          JSON.stringify({
            aud: 'catalog',
            compositionRevision: composition.composition.revision,
            exp: now + 300,
            iat: now,
            iss: tokenIssuer,
            jti: yield* nextId,
            principal: actor,
            sub: actor.principalId,
            targetBuildMarker: ultramodernApiMarker.buildMarker,
            ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
          }),
        ).toString('base64url');
        const content = `${header}.${payload}`;
        return `Bearer ${content}.${sign(null, Buffer.from(content), keyPair.privateKey).toString('base64url')}`;
      });
      // Explicit single-use TEST redemption store validates receiving transport, not
      // Catalog's currently unconfigured default production redemption provider.
      const redeemed = new Set<string>();
      const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
        consume: ({ jti }) =>
          Effect.suspend(() => {
            if (redeemed.has(jti)) {
              return Effect.fail(new GatewayAssertionReplayError({ reason: 'Assertion already redeemed' }));
            }
            redeemed.add(jti);
            return Effect.void;
          }),
      });
      const handlers = selectionEvidenceReadApiLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            ActionPrincipalVerifierLive,
            makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
          ).pipe(Layer.provide(ActiveApplicationCompositionSourceLive), Layer.provide(FetchHttpClient.layer)),
        ),
        Layer.provide(redemption),
        Layer.provide(fixture.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ ONTOS_GATEWAY_ISSUER: tokenIssuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks }),
          ),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(HttpApi.make('CatalogApi').add(catalogApi.groups.selectionEvidence)).pipe(
              Layer.provide(handlers),
              Layer.provideMerge(fixture.layer),
              Layer.provide(HttpServer.layerServices),
              Layer.provide(NodeCrypto.layer),
            ),
            { disableLogger: true },
          ),
        ),
        (value) => Effect.promise(value.dispose.bind(value)).pipe(Effect.orDie),
      );
      const emptyContext = Context.makeUnsafe<unknown>(new Map());
      const nativeFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), emptyContext);
      const read = Effect.fn('OptionalConfiguration.publicRead')(function* publicRead(
        selection = selected,
        actor = fixture.manager,
      ) {
        return yield* executeSelectionEvidenceWithAuthorization(
          { purpose: 'PRICING', selection },
          yield* authorization(actor),
          yield* nextId,
          {
            baseUrl: 'https://catalog.ontos.test',
            compositionRevision: composition.composition.revision,
          },
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      });
      const before = yield* fixture.evidence(coreEvidenceExecutor);
      expect(yield* read()).toMatchObject({
        evidence: { purpose: 'PRICING', selection: selected, status: 'VALID' },
        missingRoles: [],
      });
      expect(yield* read()).toMatchObject({ evidence: { selection: selected, status: 'VALID' }, missingRoles: [] });
      const after = yield* fixture.evidence(coreEvidenceExecutor);
      expect(after.accesses.length).toBe(before.accesses.length + 2);
      expect(after.events).toEqual(before.events);
      expect(after.audits).toEqual(before.audits);
      expect(yield* observeDefinition()).toEqual(fullDefinition);
      const unauthenticated = yield* executeSelectionEvidenceWithAuthorization(
        { purpose: 'PRICING', selection: selected },
        'Bearer invalid',
        yield* nextId,
        {
          baseUrl: 'https://catalog.ontos.test',
          compositionRevision: composition.composition.revision,
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch), Effect.flip);
      expect(Schema.is(SelectionEvidenceAuthenticationProblemSchema)(unauthenticated)).toBe(true);
      const forbiddenLegalEntity = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
      expect(
        Schema.is(SelectionEvidenceForbiddenProblemSchema)(
          yield* read(selected, forbiddenLegalEntity).pipe(Effect.flip),
        ),
      ).toBe(true);
      const foreignTenantId = yield* nextId;
      const foreignSelection = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        productRef: { ...selected.productRef, tenantId: foreignTenantId },
        variantRef: { ...selected.variantRef, tenantId: foreignTenantId },
      });
      expect(
        Schema.is(SelectionEvidenceUnavailableProblemSchema)(yield* read(foreignSelection).pipe(Effect.flip)),
      ).toBe(true);
      const denied = yield* read(selected, fixture.denied).pipe(Effect.flip);
      expect(Schema.is(SelectionEvidenceForbiddenProblemSchema)(denied)).toBe(true);
      assert(selected.configuration !== undefined);
      const missingRequired = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        ...selected,
        configuration: { ...selected.configuration, choices: [] },
      });
      expect(yield* read(missingRequired)).toMatchObject({ evidence: { status: 'INVALID' } });
      const unknownOption = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        ...selected,
        configuration: { ...selected.configuration, choices: [{ choiceKey: 'mount', value: 'unknown' }] },
      });
      expect(yield* read(unknownOption)).toMatchObject({ evidence: { status: 'INVALID' } });
      const staleDefinition = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        ...selected,
        configuration: {
          ...selected.configuration,
          definition: {
            ...selected.configuration.definition,
            revision: selected.configuration.definition.revision + 1,
          },
        },
      });
      expect((yield* read(staleDefinition)).evidence).not.toMatchObject({ status: 'VALID' });
      const advanced = yield* fixture
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* advanceDefinition() {
            const population: CartOpenSelectionPopulationPort = {
              read: () =>
                Effect.succeed({
                  complete: true,
                  observedAt: DateTime.formatIso(composition.observedAt),
                  revisionToken: '1263-owned-empty-successor',
                  selections: [],
                  tenantId: scope.tenantId,
                }),
            };
            return yield* productConfigurationPersistenceForScope(
              transaction,
              scope,
              productConfigurationSelectionImpactForScope(transaction, scope, population),
            ).publish({
              actionInvocationId: yield* nextId,
              choices: fullDefinition.choices,
              compatibilityRules: fullDefinition.compatibilityRules,
              definitionId: fullDefinition.definitionId,
              effectiveFrom: new Date(fullDefinition.effectiveFrom.getTime() + 1),
              evidenceRefs: ['fixture:1263:successor-publication'],
              expectedRevision: fullDefinition.revision,
              measuredRules: fullDefinition.measuredRules,
              optionAllowances: fullDefinition.optionAllowances,
              principalId: fixture.manager.principalId,
              productId: fullDefinition.productId,
              reason: 'Confirm successor currentness without changing optional semantics',
            });
          }),
        )
        .pipe(Effect.provideContext(fixtureContext));
      const advancedResult = Match.value(advanced).pipe(
        Match.tag('published', (result) => result),
        Match.orElse((failure) => assert.fail(JSON.stringify(failure))),
      );
      expect(advancedResult.revision).toBe(2);
      expect((yield* read()).evidence).not.toMatchObject({ status: 'VALID' });
      const successorSelection = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        ...selected,
        configuration: {
          ...configuration,
          definition: { ...configuration.definition, revision: advancedResult.revision },
        },
      });
      expect((yield* read(successorSelection)).evidence).toMatchObject({
        selection: successorSelection,
        status: 'VALID',
      });
      expect(yield* observeDefinition()).toEqual({
        ...fullDefinition,
        effectiveTo: new Date(fullDefinition.effectiveFrom.getTime() + 1),
      });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  120_000,
);
