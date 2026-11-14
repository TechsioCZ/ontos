import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { CounterpartyPurchasingProfileRefSchema } from '@app/commerce-customer-context/resources/counterparty-purchasing-profile';
import { FenceLegacyIcoAuthorityResultSchema } from '@app/party-registry/actions/fence-legacy-ico-authority';
import { GatewayContextV2ClaimsSchema } from '@app/shared-contracts';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import {
  ORGANIZATION_PROFILE_ICO_FIELD_CONTRACT_VERSION,
  ChangeOrganizationCustomerProfileIcoPayloadSchema,
  ChangeOrganizationCustomerProfileIcoResultSchema,
  OrganizationCustomerProfileIcoResponseSchema,
} from '@app/commerce-customer-context/domain/organization-profile-ico';
import { executeOrganizationProfileIcoApplicabilityWithAuthorization } from '@app/privacy/api/organization-profile-ico-applicability/client';
import { executeOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/organization-customer-profile-ico/client';
import { executeChangeOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/change-organization-customer-profile-ico-action/client';
import { executeOrganizationCustomerProfileIcoMigrationWithAuthorization } from '@app/commerce-customer-context/api/organization-customer-profile-ico-migration/client';
import { executeMigrateOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/migrate-organization-customer-profile-ico-action/client';
import { MigrateOrganizationCustomerProfileIcoResultSchema } from '@app/commerce-customer-context/domain/organization-profile-ico-migration';
import { executeFenceLegacyIcoAuthorityWithAuthorization } from '@app/party-registry/actions/fence-legacy-ico-authority/client';
import { executeLegacyIcoInventoryWithAuthorization } from '@app/party-registry/apis/legacy-ico-inventory/client';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { Context, DateTime, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';
import { SymmyC14ProductFixtureUnavailable } from './support/symmy-c14-product-runtime.mts';
import { makeOrganizationProfileIcoOwnerFixture } from './support/organization-profile-ico-owner-fixture.mts';
import { logFixtureDiagnostics } from './support/fixture-diagnostics.mts';

import type { CompanyGovernorInitialization } from './support/organization-profile-ico-owner-fixture.mts';

const commerceApp = 'commerce-customer-context';
const partyApp = 'party-registry';
class CompanyFixtureJwks extends Context.Service<CompanyFixtureJwks, ReturnType<typeof createLocalJWKSet>>()(
  'Test/CompanyFixtureJwks',
) {}
const publicJwksSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      alg: Schema.Literal('EdDSA'),
      crv: Schema.Literal('Ed25519'),
      kid: Schema.String,
      kty: Schema.Literal('OKP'),
      use: Schema.Literal('sig'),
      x: Schema.String,
    }),
  ),
});
const [MigrationRequiredSchema, PresentSchema] = OrganizationCustomerProfileIcoResponseSchema.members;
const isPresent = Schema.is(PresentSchema);
const isMigrationRequired = Schema.is(MigrationRequiredSchema);
const encodePublicResponse = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const failureSummarySchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Number),
});
const encodeFailureSummary = Schema.encodeSync(Schema.fromJsonString(failureSummarySchema));
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const initializeGovernor = (input: CompanyGovernorInitialization) =>
  Effect.gen(function* initializeCompanyGovernor() {
    const jwks = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(publicJwksSchema))(input.publicJwks);
    const keysLive = Layer.effect(
      CompanyFixtureJwks,
      Effect.sync(() => createLocalJWKSet({ keys: [...jwks.keys] })),
    );
    return yield* Effect.gen(function* verifyHuman() {
      const keys = yield* CompanyFixtureJwks;
      const verified = yield* Effect.tryPromise({
        catch: () => new SymmyC14ProductFixtureUnavailable({ message: 'Actual human assertion verification failed' }),
        try: async () =>
          await jwtVerify(input.token, keys, { algorithms: ['EdDSA'], audience: 'privacy', issuer: input.issuer }),
      });
      const claims = yield* Schema.decodeUnknownEffect(GatewayContextV2ClaimsSchema)(verified.payload);
      return yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(claims.principal);
    }).pipe(Effect.provide(keysLive));
  }).pipe(
    Effect.mapError(
      () => new SymmyC14ProductFixtureUnavailable({ message: 'Actual selected-company human verification failed' }),
    ),
  );
type PreparedGovernance = Effect.Success<
  ReturnType<typeof makeOrganizationProfileIcoOwnerFixture>
>['governance'][number];
const assertStoredClassification = (
  prepared: PreparedGovernance,
  observed: Effect.Success<ReturnType<PreparedGovernance['observe']>>,
) => {
  expect(Option.isSome(observed.decision)).toBe(true);
  if (Option.isSome(observed.decision)) {
    expect(observed.decision.value.outcome).toBe('APPLICABLE');
    expect(Option.isSome(observed.decision.value.authorityReceiptRef)).toBe(true);
    expect(observed.decision.value.evidenceRefs.length).toBeGreaterThan(0);
    expect(observed.decision.value.authorityEvidenceRefs.length).toBeGreaterThan(0);
    expect(observed.decision.value.policyIdentities.map((identity) => identity.policyKey)).toEqual([
      prepared.policyRef,
    ]);
    const marker = observed.decision.value.nonPersonalApplicability;
    expect(Option.isSome(marker) && marker.value.kind === 'ORGANIZATION_ICO_ONLY').toBe(true);
    if (Option.isSome(marker) && marker.value.kind === 'ORGANIZATION_ICO_ONLY') {
      expect(marker.value.kind).toBe('ORGANIZATION_ICO_ONLY');
      expect(marker.value.holdBehavior).toBe('NO_ACTIVE_SCOPE_HOLD');
      const profileContext = prepared.profileContexts.at(0);
      const expectedFields = profileContext?.request.fields ?? prepared.organizationContexts.at(0)?.request.fields;
      expect(marker.value.allowedFields).toEqual(expectedFields);
      expect(marker.value.fieldContractVersion).toBe(
        profileContext === undefined
          ? 'party.registry.organization-ico-business-fields.v1'
          : ORGANIZATION_PROFILE_ICO_FIELD_CONTRACT_VERSION,
      );
    }
  }
};
it.live(
  'INTERNAL native company ICO uses actual organization facts, current Privacy decisions and complete Party fence before Commerce cutover',
  () =>
    Effect.scoped(
      Effect.gen(function* companyIcoHttp() {
        const fixture = yield* makeOrganizationProfileIcoOwnerFixture(initializeGovernor);
        let phase = 'governance';
        return yield* Effect.gen(function* protocol() {
          const [profileRef, secondProfile] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([CounterpartyPurchasingProfileRefSchema, CounterpartyPurchasingProfileRefSchema]),
          )(fixture.profiles);
          const read = () =>
            Effect.gen(function* readCompanyIco() {
              return yield* executeOrganizationCustomerProfileIcoWithAuthorization(
                { profileRef },
                yield* fixture.authorize(commerceApp),
                randomUUID(),
                fixture.options(commerceApp),
              );
            });
          // Governance setup deliberately contains no decision; the genuine public Action must derive it.
          for (const prepared of fixture.governance) {
            expect(Option.isNone((yield* prepared.observe()).decision)).toBe(true);
          }
          const recorded = yield* fixture.recordGovernance();
          for (const decision of recorded) {
            expect(decision.outcome).toBe('APPLICABLE');
            expect(decision.nonPersonalApplicability?.kind).toBe('ORGANIZATION_ICO_ONLY');
            expect(decision.authorityReceiptRef).toBeDefined();
            expect(decision.authorityEvidenceRefs?.length).toBeGreaterThan(0);
          }
          for (const prepared of fixture.governance) {
            const profileContext = prepared.profileContexts.at(0);
            if (profileContext !== undefined) {
              const applicability = yield* executeOrganizationProfileIcoApplicabilityWithAuthorization(
                profileContext.request,
                yield* fixture.authorize('privacy'),
                randomUUID(),
                fixture.options('privacy'),
              );
              expect(applicability.outcome).toBe('NOT_APPLICABLE');
              if (applicability.outcome === 'NOT_APPLICABLE') {
                expect(applicability.applicabilityDecisionRef).toBe(prepared.decisionRef);
                expect(applicability.allowedFields).toEqual(profileContext.request.fields);
              }
            }
          }
          phase = 'read-after-governance';
          expect(isMigrationRequired(yield* read())).toBe(true);
          const reportInput = {
            asOf: DateTime.formatIso(yield* DateTime.now),
            planId: randomUUID(),
            sourceContext: null,
          };
          phase = 'report';
          const report = yield* executeOrganizationCustomerProfileIcoMigrationWithAuthorization(
            reportInput,
            yield* fixture.authorize(commerceApp),
            randomUUID(),
            fixture.options(commerceApp),
          );
          expect(report.records).toHaveLength(2);
          expect(report.records.every((record) => record.classification === 'MATCHED')).toBe(true);
          expect(report.records.map((record) => record.legacy.normalizedValue)).toEqual(['00000019', '00000019']);
          expect(
            new Set(report.records.flatMap((record) => record.targets.map((target) => target.profileRef.resourceId)))
              .size,
          ).toBe(2);
          const base = {
            ...reportInput,
            expectedPartySnapshotVersion: report.partySnapshotVersion,
            expectedTargetInventoryVersion: report.targetInventoryVersion,
          };
          phase = 'stage';
          const stage = yield* executeMigrateOrganizationCustomerProfileIcoWithAuthorization(
            { ...base, operation: 'STAGE' },
            yield* fixture.authorize(commerceApp),
            randomUUID(),
            fixture.options(commerceApp, randomUUID()),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MigrateOrganizationCustomerProfileIcoResultSchema)));
          expect(stage.phase).toBe('STAGING');
          expect(isMigrationRequired(yield* read())).toBe(true);
          phase = 'inventory';
          const inventory = yield* executeLegacyIcoInventoryWithAuthorization(
            { projection: 'ORGANIZATION_ICO_FIELDS_V1' },
            yield* fixture.authorize(partyApp),
            randomUUID(),
            fixture.options(partyApp),
          );
          expect(inventory.snapshotVersion).toBe(report.partySnapshotVersion);
          expect(inventory.assertions.every((row) => Object.keys(row.provenance).join(',') === 'ownerReceiptRef')).toBe(
            true,
          );
          phase = 'fence';
          const fence = yield* executeFenceLegacyIcoAuthorityWithAuthorization(
            {
              expectedSnapshotVersion: report.partySnapshotVersion,
              migrationPlanRef: report.planId,
              projection: 'ORGANIZATION_ICO_FIELDS_V1',
            },
            yield* fixture.authorize(partyApp),
            randomUUID(),
            fixture.options(partyApp, randomUUID()),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(FenceLegacyIcoAuthorityResultSchema)));
          expect(fence.snapshotVersion).toBe(report.partySnapshotVersion);
          phase = 'cutover';
          const cutover = yield* executeMigrateOrganizationCustomerProfileIcoWithAuthorization(
            { ...base, operation: 'CUTOVER' },
            yield* fixture.authorize(commerceApp),
            randomUUID(),
            fixture.options(commerceApp, randomUUID()),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MigrateOrganizationCustomerProfileIcoResultSchema)));
          expect(cutover.phase).toBe('COMMERCE');
          phase = 'read-after-cutover';
          const initial = yield* read();
          expect(isPresent(initial)).toBe(true);
          if (!isPresent(initial)) {
            throw new Error('Current imported company ICO was not projected');
          }
          expect(initial.current.normalizedValue).toBe('00000019');
          const second = yield* executeOrganizationCustomerProfileIcoWithAuthorization(
            { profileRef: secondProfile },
            yield* fixture.authorize(commerceApp),
            randomUUID(),
            fixture.options(commerceApp),
          );
          expect(isPresent(second)).toBe(true);
          const forms = [initial, second].flatMap((value) =>
            isPresent(value) ? [value.current.originalInput.kind] : [],
          );
          expect(new Set(forms)).toEqual(new Set(['KNOWN', 'UNKNOWN']));
          for (const value of [initial, second, report, cutover]) {
            const encoded = yield* encodePublicResponse(value);
            expect(encoded).not.toContain('actorPrincipalId');
            expect(encoded).not.toContain('acceptedByPrincipalId');
            expect(encoded).not.toContain('"reason"');
            expect(encoded).not.toContain('"source"');
          }
          const readGovernance = fixture.governance.find((value) =>
            value.profileContexts.some(
              (context) =>
                context.request.operation === 'customer-profile-ico.read' &&
                context.request.profileRef.resourceId === profileRef.resourceId,
            ),
          );
          assert.isOk(readGovernance);
          if (readGovernance === undefined) {
            throw new Error('Expected explicit current read governance');
          }
          phase = 'hold';
          yield* readGovernance.setHold(true);
          expect(Exit.isFailure(yield* Effect.exit(read()))).toBe(true);
          yield* readGovernance.setHold(false);
          expect(isPresent(yield* read())).toBe(true);
          phase = 'correction';
          const command = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
            countryCode: 'CZ',
            effectId: randomUUID(),
            effectiveAt: DateTime.formatIso(yield* DateTime.now),
            expectedRevision: 1,
            identifier: { identifierType: 'ICO', value: '27' },
            operation: 'CORRECT',
            originalInput: '27',
            profileRef,
          });
          const corrected = yield* executeChangeOrganizationCustomerProfileIcoWithAuthorization(
            command,
            yield* fixture.authorize(commerceApp),
            randomUUID(),
            fixture.options(commerceApp, randomUUID()),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoResultSchema)));
          expect(corrected.assertion.normalizedValue).toBe('00000027');
          expect(corrected.assertion.revision).toBe(2);
          const after = yield* read();
          expect(isPresent(after)).toBe(true);
          if (isPresent(after)) {
            expect(after.history).toHaveLength(2);
          }
          phase = 'independent-profile-after-correction';
          const secondAfterCorrection = yield* executeOrganizationCustomerProfileIcoWithAuthorization(
            { profileRef: secondProfile },
            yield* fixture.authorize(commerceApp),
            randomUUID(),
            fixture.options(commerceApp),
          );
          expect(isPresent(secondAfterCorrection)).toBe(true);
          if (isPresent(second) && isPresent(secondAfterCorrection)) {
            expect(secondAfterCorrection.current).toEqual(second.current);
            expect(secondAfterCorrection.history).toEqual(second.history);
            expect(secondAfterCorrection.revision).toBe(second.revision);
          }
          for (const prepared of fixture.governance) {
            assertStoredClassification(prepared, yield* prepared.observe());
          }
        }).pipe(
          Effect.tapError(() => logFixtureDiagnostics(fixture.diagnostics)),
          Effect.mapError((cause) => {
            const problem = Schema.decodeUnknownOption(failureSummarySchema)(cause);
            const classification = Option.isSome(problem) ? encodeFailureSummary(problem.value) : 'typed-failure';
            return new SymmyC14ProductFixtureUnavailable({
              cause: Redacted.make(cause),
              message: `Company ICO HTTP phase ${phase}: ${classification}`,
            });
          }),
        );
      }),
    ).pipe(Effect.provide(services)),
  { timeout: 240_000 },
);
