import {
  AddSavedAddressActionAuthenticationProblemSchema,
  AddSavedAddressActionForbiddenProblemSchema,
  AddSavedAddressPayloadSchema,
} from '@app/commerce-customer-context/api/add-saved-address-action';
import { executeAddSavedAddressWithAuthorization } from '@app/commerce-customer-context/api/add-saved-address-action/client';
import type { UpdateSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/update-saved-address-action';
import type { RemoveSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/remove-saved-address-action';
import {
  SavedAddressSourceReceiptRequestSchema,
  SavedAddressSourceReceiptResponseSchema,
} from '@app/commerce-customer-context/api/saved-address-source-receipt';
import { executeSavedAddressSourceReceiptWithAuthorization } from '@app/commerce-customer-context/api/saved-address-source-receipt/client';
import type { SavedAddressRefSchema } from '@app/commerce-customer-context/resources/saved-address';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { writeTestTenantScopes } from '@app/core-runtime/testing/tenant-access';
import { PgClient } from '@effect/sql-pg';
import { SourceProcessingContextSchema } from '@app/privacy/api';
import { ProcessingPurposeRefSchema } from '@app/privacy/resources/processing-purpose';
import { seedCommittedProfileSourceProcessingNativeFixture } from '@app/privacy/testing/source-processing-native';
import { retireSourceProcessingNativePurpose } from '@app/privacy/testing/source-processing-governance-native';
import { SymmyEffectIdSchema } from '@app/shared-contracts/symmy';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { expect, it } from 'effect-rstest';
import { Effect, Redacted, Schema } from 'effect';
import { savedAddressWorkerRules, savedAddressRecoveryRules } from './support/symmy-c14-saved-address-rules.mts';
import {
  SavedAddressNativeInvocationSchema,
  issueSavedAddressFixtureRecovery,
} from './support/symmy-c14-saved-address-recovery.mts';
import {
  customerFixtureServices as services,
  makeSymmyC14CustomerFixture,
  observeCustomerFixtureUntil as observeUntil,
} from './support/symmy-c14-customer-assignment-fixture.mts';
import { customerFixtureUuid as uuid } from './support/symmy-c14-customer-native-authority.mts';
import { internalCustomerSource } from './support/symmy-c14-customer-plan.mts';
import { customerWorkerKey } from './support/symmy-c14-customer-rules.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  startProductOwner,
  startProductWorker,
} from './support/symmy-c14-product-runtime.mts';

const nativeInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('NativeActionInvocationId'),
  Schema.decodeTo(Schema.String),
);
const effectSchema = Schema.Struct({
  effect_id: Schema.toEncoded(SymmyEffectIdSchema),
  effect_key: Schema.String,
  owner_invocation_id: Schema.OptionFromNullOr(nativeInvocationIdSchema),
  owner_receipt: Schema.Unknown,
  state: Schema.String,
});
const addressOperation = {
  AddSavedAddress: { effectKey: 'address-add', entrypointKey: 'commerce.customer-context.add-saved-address' },
  RemoveSavedAddress: { effectKey: 'address-remove', entrypointKey: 'commerce.customer-context.remove-saved-address' },
  UpdateSavedAddress: { effectKey: 'address-update', entrypointKey: 'commerce.customer-context.update-saved-address' },
} as const;
const commerceModuleId = 'commerce.customer-context';
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });
it.live(
  'INTERNAL_C14 native SavedAddress Add, Update, Remove and read-only recovery obey current Privacy',
  () =>
    Effect.scoped(
      Effect.gen(function* actualSavedAddressConformance() {
        const {
          admin,
          environment,
          flatSource,
          governancePrincipalId,
          isolated,
          legalEntityId,
          moduleKey,
          ownerDiagnostics,
          ownerRuntimes,
          privacy,
          profileReceipt,
          proofTransport,
          recordId,
          shell,
          snapshot,
          sourceIdentity,
          sourceRouteId,
          submitFor,
          symmy,
          systemId,
          tenantId,
          workerArtifact,
        } = yield* makeSymmyC14CustomerFixture({
          allowedOwnerOperations: Object.values(addressOperation).map(({ entrypointKey }) => ({
            entrypointKey,
            moduleId: commerceModuleId,
            schemaVersion: '1',
          })),
          initializeScopes: ({
            admin: scopeAdmin,
            legalEntityId: scopeLegalEntityId,
            principalId,
            tenantId: scopeTenantId,
          }) =>
            testCoreDatabase.pipe(
              Effect.provideService(PgClient.PgClient, scopeAdmin),
              Effect.flatMap((core) =>
                writeTestTenantScopes(core, {
                  legalEntityIds: [scopeLegalEntityId],
                  principalId,
                  tenantId: scopeTenantId,
                }),
              ),
            ),
          workerRules: [...savedAddressWorkerRules, ...savedAddressRecoveryRules],
        });
        const runPrefix = `job:${customerWorkerKey}:run:`;
        // The profile is the actual owner-issued result from the preceding native job.
        // This separate import therefore needs neither a guessed profile ID nor a guessed address ID.
        const profile = { kind: 'RETAIL' as const, profileRef: profileReceipt.profileRef };
        const occurrences = [yield* uuid, yield* uuid, yield* uuid, yield* uuid];
        const sourceFor = (index: number, nativeAddressId: string | null) => {
          const source = {
            effectId: 'INTERNAL_C14_ASSIGNED_AT_ADMISSION',
            identity: { ...flatSource, occurrenceId: occurrences[index] },
            mappingRevision: internalCustomerSource.mappingVersion,
            order: index + 1,
            purposes: ['BILLING'] as const,
            revision: `INTERNAL_C14_ADDRESS_REVISION_${index + 1}`,
            routeRevision: internalCustomerSource.routeRevision,
          };
          return nativeAddressId === null ? source : { ...source, nativeAddressId };
        };
        yield* admin`insert into commerce_customer_context.saved_address_source_routes
          (tenant_id,legal_entity_id,route_ref,route_revision,principal_id,issuer,namespace,record_type,mapping_revision,active)
          values(${tenantId},${legalEntityId},${sourceRouteId},${internalCustomerSource.routeRevision},${systemId},
          ${sourceIdentity.issuer},${sourceIdentity.namespace},${sourceIdentity.recordType},${internalCustomerSource.mappingVersion},true)`;
        const dataPrivacy = yield* seedCommittedProfileSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: occurrences.flatMap((addressOccurrenceId, index) =>
            [
              [
                'saved-address-source.add',
                'saved-address-source.update',
                'saved-address-source.remove',
                'saved-address-source.update',
              ][index],
              'saved-address-source.receipt',
            ].map((operation) => ({
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: commerceModuleId,
                operation,
                source: { ...flatSource, occurrenceId: addressOccurrenceId },
                target: { kind: 'RETAIL_CUSTOMER_PROFILE' as const, resourceId: profile.profileRef.resourceId },
              },
            })),
          ),
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_SAVED_ADDRESS_LIFECYCLE',
          controllerRef: 'internal:customer-conformance',
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId,
          legalEntityId,
          meaning:
            'Independent current fixture policy allows only qualified SavedAddress native effects and minimal receipt recovery',
          profileReceipt: proofTransport,
          tenantId,
        });
        const privacyRuntime = ownerRuntimes.get('privacy');
        if (privacyRuntime === undefined) {
          return yield* unavailable('The actual Privacy receiver is required for SavedAddress DATA processing');
        }
        yield* privacyRuntime.receiver.child.kill();
        yield* privacyRuntime.receiver.child.exitCode;
        const restartedPrivacy = yield* startProductOwner({
          artifacts: privacyRuntime.artifacts,
          contract: privacyRuntime.contract,
          environment: {
            ...environment,
            ONTOS_GATEWAY_MODULE_API_KEY: privacyRuntime.moduleKey,
            ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
            )([...privacy.contexts, ...dataPrivacy.contexts]),
          },
          port: privacyRuntime.port,
          prefix: '/privacy-api',
        });
        ownerDiagnostics.set('privacy', restartedPrivacy.diagnostic);
        const addressWorker = yield* startProductWorker(workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_SAVED_ADDRESS_NATIVE_WORKER',
          ONTOS_GATEWAY_MODULE_API_KEY: moduleKey,
        });
        const addressPlan = (
          tag: 'AddSavedAddress' | 'UpdateSavedAddress' | 'RemoveSavedAddress',
          payload:
            | typeof AddSavedAddressPayloadSchema.Encoded
            | typeof UpdateSavedAddressPayloadSchema.Encoded
            | typeof RemoveSavedAddressPayloadSchema.Encoded,
          index: number,
          target?: typeof SavedAddressRefSchema.Encoded,
        ) => {
          const effect = {
            effectKey: addressOperation[tag].effectKey,
            intent: { _tag: tag, payload },
            operation: {
              entrypointKey: addressOperation[tag].entrypointKey,
              moduleId: commerceModuleId,
              schemaVersion: '1',
            },
          };
          if (target !== undefined) {
            Object.assign(effect, { originalTarget: target });
          }
          return Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
            items: [
              {
                effects: [effect],
                itemKey: 'customer',
                source: {
                  entityKind: sourceIdentity.recordType,
                  issuerId: sourceIdentity.issuer,
                  sourceNamespace: sourceIdentity.namespace,
                  sourceRecordId: recordId,
                },
                sourceOccurrenceId: occurrences[index],
              },
            ],
          });
        };
        const effectRows = (jobId: string) =>
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          );
        const diagnostics = Effect.all([
          addressWorker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
          shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
          ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
            diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
          ),
          admin`select action_key,status,count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} group by action_key,status`.pipe(
            Effect.flatMap(Effect.logError),
          ),
        ]);
        const settle = (jobId: string) =>
          observeUntil(
            effectRows(jobId),
            (rows) => rows.length === 1 && rows.every(({ state }) => state === 'settled'),
          ).pipe(Effect.tapError(() => diagnostics));
        const submitAddress = (key: string, addressInput: typeof SymmyInternalExecutionPlanSchema.Type) =>
          submitFor(key, addressInput).pipe(
            Effect.tapError(() => diagnostics),
            Effect.tapError(() => Effect.logError({ addressAdmissionKey: key })),
          );
        const addPayload = yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema)({
          label: 'INTERNAL_C14 native billing address',
          origin: {
            kind: 'COMMERCE_ONLY',
            postalAddress: {
              addressLine1: '17 Internal Street',
              city: 'Prague',
              countryCode: 'CZ',
              postalCode: '11000',
            },
          },
          profile,
          purposes: ['BILLING'],
          reason: 'Qualified internal source explicitly imports its billing postal address',
          source: sourceFor(0, null),
        });
        const addPlan = yield* addressPlan(
          'AddSavedAddress',
          yield* Schema.encodeEffect(AddSavedAddressPayloadSchema)(addPayload),
          0,
        );
        const addJob = yield* submitAddress('INTERNAL_C14_SAVED_ADDRESS_ADD', addPlan);
        const [addEffect] = yield* settle(addJob.jobId).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.toType(effectSchema)]))),
        );
        const receipts = admin`select action_invocation_id as "actionInvocationId",action_key as "actionKey",recorded_auth_context_ref as "authContextRef",effect_id as "idempotencyKey",actor_principal_id as "principalId",request_hash as "requestHash",result,source from commerce_customer_context.saved_address_source_receipts where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} order by recorded_at`;
        const addedRows = yield* receipts;
        if (addedRows.length !== 1) {
          yield* diagnostics;
          yield* admin`select effect_key,state,outcome from symmy_integration.job_effects where job_id=${addJob.jobId}`.pipe(
            Effect.flatMap(Effect.logError),
          );
        }
        expect(addedRows).toHaveLength(1);
        const [addedRow] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([
            Schema.Struct({
              ...SavedAddressNativeInvocationSchema.fields,
              result: Schema.Unknown,
              source: Schema.Unknown,
            }),
          ]),
        )(addedRows);
        const nativeAdd = yield* Schema.decodeUnknownEffect(SavedAddressNativeInvocationSchema)(addedRow);
        const addReceiptResponse = yield* Schema.decodeUnknownEffect(
          SavedAddressSourceReceiptResponseSchema.members[3],
        )({ _tag: 'RECEIPT', receipt: addedRow.result });
        const { receipt: added } = addReceiptResponse;
        expect(added).toMatchObject({ operation: 'ADD', outcome: 'ADDED', profile, revision: 1 });
        expect(addedRow.result).toEqual(added);
        expect(addedRow.idempotencyKey).toBe(addEffect.effect_id);
        expect(JSON.stringify(addedRow.result)).not.toContain('Internal Street');
        expect(JSON.stringify(addedRow.result)).not.toContain('native billing address');
        const { savedAddressRef } = added;
        const updatePlan = yield* addressPlan(
          'UpdateSavedAddress',
          {
            expectedRevision: 1,
            label: 'INTERNAL_C14 revised native billing address',
            origin: {
              kind: 'COMMERCE_ONLY',
              postalAddress: {
                addressLine1: '18 Internal Street',
                city: 'Prague',
                countryCode: 'CZ',
                postalCode: '11000',
              },
            },
            profile,
            reason: 'Apply the next qualified source revision to the original native address',
            savedAddressRef,
            source: sourceFor(1, savedAddressRef.resourceId),
          },
          1,
          savedAddressRef,
        );
        const updateJob = yield* submitAddress('INTERNAL_C14_SAVED_ADDRESS_UPDATE', updatePlan);
        yield* settle(updateJob.jobId);
        const removePlan = yield* addressPlan(
          'RemoveSavedAddress',
          {
            expectedRevision: 2,
            profile,
            reason: 'Qualified source explicitly removes its original billing address',
            savedAddressRef,
            source: sourceFor(2, savedAddressRef.resourceId),
          },
          2,
          savedAddressRef,
        );
        const removeJob = yield* submitAddress('INTERNAL_C14_SAVED_ADDRESS_REMOVE', removePlan);
        yield* settle(removeJob.jobId);
        const lifecycleRows = yield* receipts;
        expect(lifecycleRows).toHaveLength(3);
        const lifecycleReceipts = yield* Schema.decodeUnknownEffect(
          Schema.Array(SavedAddressSourceReceiptResponseSchema.members[3]),
        )(lifecycleRows.map((row) => ({ _tag: 'RECEIPT', receipt: row.result })));
        expect(
          lifecycleReceipts.map((result) => [
            result.receipt.operation,
            result.receipt.outcome,
            result.receipt.revision,
            result.receipt.savedAddressRef.resourceId,
          ]),
        ).toEqual([
          ['ADD', 'ADDED', 1, savedAddressRef.resourceId],
          ['UPDATE', 'UPDATED', 2, savedAddressRef.resourceId],
          ['REMOVE', 'REMOVED', 3, savedAddressRef.resourceId],
        ]);
        expect(lifecycleRows.map(({ result }) => result)).toEqual(lifecycleReceipts.map(({ receipt }) => receipt));
        expect(lifecycleRows.at(0)).toEqual(addedRow);
        for (const [jobKey, replayPlan, original] of [
          ['INTERNAL_C14_SAVED_ADDRESS_ADD', addPlan, addJob],
          ['INTERNAL_C14_SAVED_ADDRESS_UPDATE', updatePlan, updateJob],
          ['INTERNAL_C14_SAVED_ADDRESS_REMOVE', removePlan, removeJob],
        ] as const) {
          expect(yield* submitAddress(jobKey, replayPlan)).toEqual(original);
        }
        expect(yield* receipts).toEqual(lifecycleRows);
        const [storedAddress] =
          yield* admin`select saved_address_id,revision,lifecycle,address_line_1 as street from commerce_customer_context.saved_addresses where tenant_id=${tenantId}`;
        expect(storedAddress).toEqual({
          lifecycle: 'REMOVED',
          revision: 3,
          saved_address_id: savedAddressRef.resourceId,
          street: '18 Internal Street',
        });
        const [nativeCounts] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and status='succeeded' and action_key in ('commerce.customer-context.add-saved-address','commerce.customer-context.update-saved-address','commerce.customer-context.remove-saved-address')`;
        expect(nativeCounts).toEqual({ count: 3 });
        const addDeliveryId = nativeAdd.authContextRef.slice(runPrefix.length);
        yield* observeUntil(
          admin<{
            status: string;
          }>`select status from core.outbox_deliveries where outbox_delivery_id=${addDeliveryId}`,
          (rows) => rows.some(({ status }) => status === 'done'),
        );
        const [addressRecoveryRequirement] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ key: Schema.String })]),
        )(
          (symmy.manifest.requirements?.operations ?? []).filter(
            (requirement) =>
              requirement.entrypointKey === customerWorkerKey &&
              requirement.provider.entrypointKey === 'commerce.customer-context.api.saved-address-source-receipt',
          ),
        );
        const originalSource = yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema.fields.source)(
          addedRow.source,
        );
        const receiptRequest = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
          actionInvocationId: nativeAdd.actionInvocationId,
          actionKey: nativeAdd.actionKey,
          mode: 'RECEIPT',
          profile,
          requestHash: nativeAdd.requestHash,
          source: originalSource,
        });
        const receiptTransport = yield* issueSavedAddressFixtureRecovery({
          compositionRevision: snapshot.composition.revision,
          deliveryId: addDeliveryId,
          expectedReadPrincipalId: systemId,
          legalEntityId,
          moduleApiKey: Redacted.make(moduleKey),
          nativeAction: nativeAdd,
          operationRequirementKey: addressRecoveryRequirement.key,
          request: receiptRequest,
          shellGatewayBaseUrl: environment.ONTOS_SHELL_GATEWAY_BASE_URL,
          tenantId,
        });
        const recovered = yield* executeSavedAddressSourceReceiptWithAuthorization(
          receiptRequest,
          Redacted.value(receiptTransport.authorization),
          receiptTransport.requestCorrelation,
          { baseUrl: receiptTransport.baseUrl, compositionRevision: receiptTransport.compositionRevision },
        );
        expect(recovered).toEqual(addReceiptResponse);
        const unknownRequest = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
          ...receiptRequest,
          source: { ...originalSource, effectId: yield* uuid },
        });
        const unknownTransport = yield* issueSavedAddressFixtureRecovery({
          compositionRevision: snapshot.composition.revision,
          deliveryId: addDeliveryId,
          expectedReadPrincipalId: systemId,
          legalEntityId,
          moduleApiKey: Redacted.make(moduleKey),
          nativeAction: nativeAdd,
          operationRequirementKey: addressRecoveryRequirement.key,
          request: unknownRequest,
          shellGatewayBaseUrl: environment.ONTOS_SHELL_GATEWAY_BASE_URL,
          tenantId,
        });
        const unknownResult = yield* executeSavedAddressSourceReceiptWithAuthorization(
          unknownRequest,
          Redacted.value(unknownTransport.authorization),
          unknownTransport.requestCorrelation,
          { baseUrl: unknownTransport.baseUrl, compositionRevision: unknownTransport.compositionRevision },
        );
        expect(Schema.is(SavedAddressSourceReceiptResponseSchema.members[1])(unknownResult)).toBe(true);
        expect(yield* receipts).toEqual(lifecycleRows);
        const readOnlyWriteTransport = yield* issueSavedAddressFixtureRecovery({
          compositionRevision: snapshot.composition.revision,
          deliveryId: addDeliveryId,
          expectedReadPrincipalId: systemId,
          legalEntityId,
          moduleApiKey: Redacted.make(moduleKey),
          nativeAction: nativeAdd,
          operationRequirementKey: addressRecoveryRequirement.key,
          request: receiptRequest,
          shellGatewayBaseUrl: environment.ONTOS_SHELL_GATEWAY_BASE_URL,
          tenantId,
        });
        const forbiddenWriteKey = 'INTERNAL_C14_ADDRESS_RECOVERY_IS_READ_ONLY';
        const forbiddenWrite = yield* executeAddSavedAddressWithAuthorization(
          addPayload,
          Redacted.value(readOnlyWriteTransport.authorization),
          yield* uuid,
          {
            baseUrl: readOnlyWriteTransport.baseUrl,
            compositionRevision: readOnlyWriteTransport.compositionRevision,
            idempotencyKey: forbiddenWriteKey,
          },
        ).pipe(Effect.flip);
        expect(
          Schema.is(
            Schema.Union([
              AddSavedAddressActionAuthenticationProblemSchema,
              AddSavedAddressActionForbiddenProblemSchema,
            ]),
          )(forbiddenWrite),
        ).toBe(true);
        const [forbiddenInvocation] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and idempotency_key=${forbiddenWriteKey}`;
        expect(forbiddenInvocation).toEqual({ count: 0 });
        const retired = yield* retireSourceProcessingNativePurpose({
          connections: isolated.connections,
          governancePrincipalId,
          legalEntityId,
          ownedDatabase: isolated,
          purpose: 'implementation-1096-registered-workload-gateway',
          purposeRef: yield* Schema.decodeUnknownEffect(ProcessingPurposeRefSchema)(dataPrivacy.purposeRef),
          tenantId,
        });
        expect(retired).toMatchObject({ changed: true, lifecycle: 'RETIRED' });
        const deniedTransport = yield* issueSavedAddressFixtureRecovery({
          compositionRevision: snapshot.composition.revision,
          deliveryId: addDeliveryId,
          expectedReadPrincipalId: systemId,
          legalEntityId,
          moduleApiKey: Redacted.make(moduleKey),
          nativeAction: nativeAdd,
          operationRequirementKey: addressRecoveryRequirement.key,
          request: receiptRequest,
          shellGatewayBaseUrl: environment.ONTOS_SHELL_GATEWAY_BASE_URL,
          tenantId,
        });
        const deniedReceipt = yield* executeSavedAddressSourceReceiptWithAuthorization(
          receiptRequest,
          Redacted.value(deniedTransport.authorization),
          deniedTransport.requestCorrelation,
          { baseUrl: deniedTransport.baseUrl, compositionRevision: deniedTransport.compositionRevision },
        ).pipe(Effect.flip);
        expect(deniedReceipt).toMatchObject({ status: 503 });
        expect(yield* receipts).toEqual(lifecycleRows);
        const deniedPlan = yield* addressPlan(
          'UpdateSavedAddress',
          {
            expectedRevision: 3,
            label: 'INTERNAL_C14 prohibited resurrection',
            profile,
            reason: 'Current retired processing Purpose must deny this new source revision',
            savedAddressRef,
            source: sourceFor(3, savedAddressRef.resourceId),
          },
          3,
          savedAddressRef,
        );
        const deniedJob = yield* submitAddress('INTERNAL_C14_ADDRESS_RETIRED_PURPOSE_UPDATE', deniedPlan);
        const deniedRows = yield* observeUntil(
          admin`select a.status from core.action_invocations a join symmy_integration.job_effects e on e.effect_id::text=a.idempotency_key
          where e.job_id=${deniedJob.jobId} and a.tenant_id=${tenantId} and a.action_key='commerce.customer-context.update-saved-address'`,
          (rows) => rows.some(({ status }) => status === 'received'),
        ).pipe(Effect.tapError(() => diagnostics));
        expect(deniedRows).toEqual([{ status: 'received' }]);
        const commerceDiagnostic = ownerDiagnostics.get('commerce-customer-context');
        if (commerceDiagnostic === undefined) {
          return yield* unavailable('The actual Commerce source rejection evidence is required');
        }
        yield* observeUntil(commerceDiagnostic, (message) => message.includes('saved_address_source_privacy_denied'));
        expect(yield* receipts).toEqual(lifecycleRows);
        const [preservedAddress] =
          yield* admin`select saved_address_id,revision,lifecycle,address_line_1 as street from commerce_customer_context.saved_addresses where tenant_id=${tenantId}`;
        expect(preservedAddress).toEqual(storedAddress);
        const [afterDeniedWrites] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and status='succeeded' and action_key in ('commerce.customer-context.add-saved-address','commerce.customer-context.update-saved-address','commerce.customer-context.remove-saved-address')`;
        expect(afterDeniedWrites).toEqual({ count: 3 });
        const [siblings] = yield* admin`select
          (select count(*)::integer from party.parties where tenant_id=${tenantId}) as parties,
          (select count(*)::integer from commerce_customer_context.customer_profiles where tenant_id=${tenantId}) as profiles`;
        expect(siblings).toEqual({ parties: 1, profiles: 1 });
        yield* addressWorker.child.kill();
        yield* addressWorker.child.exitCode;
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(services)),
  240_000,
);
