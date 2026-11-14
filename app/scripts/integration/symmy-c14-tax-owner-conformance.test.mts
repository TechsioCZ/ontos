import { randomUUID } from 'node:crypto';

import { SYMMY_FIXTURE_ROUTES, SymmyRouteContextSchema } from '@app/shared-contracts/symmy';
import {
  decodeSymmySellerVatDeclarationSource,
  mapSymmySellerVatDeclaration,
} from '@app/symmy-integration/symmy-internal-contracts';
import { ImportSellerVatRegimeDeclarationsPayloadSchema } from '@app/tax/actions/import-seller-vat-regime-declarations';
import { expect, it } from 'effect-rstest';
import { Duration, Effect, FileSystem, Option, Queue, Schema } from 'effect';

import {
  encodePolicyFixtureJson as encodeJson,
  initializePolicyFixtureScopes,
  makeSymmyC14PolicyClient,
  makeSymmyC14PolicyFixture,
  observePolicyFixtureUntil,
  policyFixtureServices,
} from './support/symmy-c14-policy-fixture.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  buildProductOwner,
  buildProductWorker,
  startProductOwner,
  startProductWorker,
} from './support/symmy-c14-product-runtime.mts';

const routeKey = 'sellerVatDeclarationsFixtureBatch';
const mappingVersion = 'INTERNAL_C14_SELLER_VAT_DECLARATION_V1';
const fixtureId = 'INTERNAL_C14_SELLER_VAT';
const acceptedIdempotencyKey = 'internal-seller-vat-accepted';
const lifecyclePolicy = { policyId: 'INTERNAL_C14_SELLER_VAT_RETENTION', revision: 'v1' };
const operation = {
  entrypointKey: 'commerce.tax.import-seller-vat-regime-declarations',
  moduleId: 'commerce.tax',
  schemaVersion: '1',
};
const entityKind = 'SELLER_VAT_REGIME_DECLARATION';
const issuerId = 'INTERNAL_C14_SELLER_VAT_ISSUER';
const sourceNamespace = 'INTERNAL_C14_SELLER_VAT_DECLARATIONS';
const routeRevision = 'INTERNAL_C14_SELLER_VAT_ROUTE_V1';
const migrationStartedAt = '2026-11-01T00:00:00.000Z';
const committedLoss = Schema.fromJsonString(
  Schema.Struct({ path: Schema.String, type: Schema.Literal('committed-response-lost') }),
);

const declaration = (sellerId: string) => ({
  contractVersion: mappingVersion,
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  reason: 'Explicit C14 fixture seller VAT regime',
  regime: 'VAT_PAYER',
  sellingLegalEntityId: sellerId,
  sourceRecordId: 'seller-vat-source-1',
});

const routePlan = (source: ReturnType<typeof declaration>) =>
  encodeJson({
    items: [
      {
        effects: [
          {
            effectKey: 'seller-vat-declaration',
            intent: { _tag: 'SellerVatDeclarationFixture', migrationStartedAt, source },
            operation,
          },
        ],
        itemKey: 'seller-vat-declaration',
        source: { entityKind, issuerId, sourceNamespace, sourceRecordId: source.sourceRecordId },
        sourceOccurrenceId: randomUUID(),
      },
    ],
  });

it.live(
  'recovers one dated seller VAT declaration through Shell and C14 after response loss and authority revocation',
  () =>
    Effect.scoped(
      Effect.gen(function* taxConformance() {
        const runtime = yield* makeSymmyC14PolicyFixture({
          initializeScopes: initializePolicyFixtureScopes,
          lifecyclePolicy,
          owner: 'tax',
          workloadKey: 'commerce.tax.symmy-seller-vat-fixture-import',
        });
        const {
          admin,
          environment,
          integration,
          ownerContract,
          ownerPort,
          routeId,
          sellerId,
          shell,
          symmy,
          symmyModuleKey,
          symmyPort,
          system,
          tenantId,
        } = runtime;
        const source = declaration(sellerId);
        const mappingRoute = yield* Schema.decodeUnknownEffect(SymmyRouteContextSchema)({
          allowedOwnerOperations: [operation],
          factFamily: entityKind,
          issuerId,
          mappingVersion,
          principalId: integration.principalId,
          route: { integrationRouteId: routeId, tenantId },
          routeRevision,
          sellingLegalEntityId: sellerId,
          sourceNamespace,
        });
        const mapped = yield* mapSymmySellerVatDeclaration(
          mappingRoute,
          yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(migrationStartedAt),
          yield* decodeSymmySellerVatDeclarationSource(source),
        );
        const command = yield* Schema.encodeEffect(ImportSellerVatRegimeDeclarationsPayloadSchema)(mapped.payload);
        yield* admin`insert into symmy_integration.job_routes
          (route_id,tenant_id,principal_id,legal_entity_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
          values(${routeId},${tenantId},${integration.principalId},${sellerId},true,array[${fixtureId}],${yield* routePlan(source)}::jsonb,
            ${mappingVersion},${routeKey},${routeRevision},${yield* encodeJson(lifecyclePolicy)}::jsonb)`;

        const fs = yield* FileSystem.FileSystem;
        const faultDirectory = yield* fs.makeTempDirectoryScoped({ prefix: 'INTERNAL_C14_SELLER_VAT_' });
        const faultMarker = `${faultDirectory}/drop-owner-response`;
        yield* fs.writeFileString(faultMarker, 'INTERNAL_C14 transport fault after native owner commit');
        const permits = yield* Schema.decodeUnknownEffect(Schema.Json)([
          { command, legalEntityId: sellerId, principalId: system.principalId, tenantId },
        ]);
        const taxReceiver = yield* startProductOwner({
          artifacts: yield* buildProductOwner(ownerContract),
          contract: ownerContract,
          environment: {
            ...environment,
            ONTOS_C14_RESPONSE_LOSS_MARKER: faultMarker,
            ONTOS_C14_RESPONSE_LOSS_OPERATION: 'tax-import',
            ONTOS_TAX_SYMMY_SELLER_VAT_FIXTURES: yield* encodeJson(permits),
          },
          port: ownerPort,
          prefix: '/tax-api',
        });
        const symmyReceiver = yield* startProductOwner({
          artifacts: yield* buildProductOwner(symmy),
          contract: symmy,
          environment,
          moduleKey: symmyModuleKey,
          port: symmyPort,
          prefix: '/symmy-integration-api',
        });
        const { poll, post, submit } = yield* makeSymmyC14PolicyClient(
          runtime,
          SYMMY_FIXTURE_ROUTES[routeKey].path,
          fixtureId,
          symmyReceiver.diagnostic,
        );
        expect((yield* post('product-vat-hint', { fixtureId, vatRate: 21 })).status).toBe(400);
        const accepted = yield* submit(acceptedIdempotencyKey);
        expect(yield* submit(acceptedIdempotencyKey)).toEqual(accepted);

        const workerArtifact = yield* buildProductWorker(symmy);
        const worker = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_SELLER_VAT_PROCESS',
          },
          symmyModuleKey,
        );
        const failure = (reason: string, workerDiagnostic: Effect.Effect<string>) =>
          Effect.all([
            taxReceiver.diagnostic,
            symmyReceiver.diagnostic,
            workerDiagnostic,
            shell.issuerDiagnostics().pipe(
              Effect.flatMap(encodeJson),
              Effect.orElseSucceed(() => 'Issuer diagnostics unavailable'),
            ),
          ]).pipe(
            Effect.flatMap((diagnostics) =>
              Effect.fail(
                new SymmyC14ProductFixtureUnavailable({
                  message: `${reason}; native diagnostics: ${diagnostics.join('\n')}`,
                }),
              ),
            ),
          );
        const lost = yield* Effect.gen(function* waitForLostResponse() {
          for (;;) {
            const event = Schema.decodeUnknownOption(committedLoss)(yield* Queue.take(taxReceiver.output));
            if (Option.isSome(event)) {
              return event.value;
            }
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(35),
            orElse: () => failure('The real Tax owner did not commit and lose its response', worker.diagnostic),
          }),
        );
        expect(lost.path).toBe('/tax-api/tax/actions/import-seller-vat-regime-declarations');

        const readDeclarations = admin`select effective_from_origin,legal_entity_id,migration_run_ref,provenance,
          regime,revision,source_record_ref,
          to_char(effective_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_from
          from tax.tax_seller_vat_regime_declarations where tenant_id=${tenantId}`;
        const expected = {
          effective_from: source.effectiveFrom,
          effective_from_origin: 'SOURCE',
          legal_entity_id: sellerId,
          migration_run_ref: command.migrationRunRef,
          provenance: 'MIGRATED',
          regime: source.regime,
          revision: 1,
          source_record_ref: command.declarations[0].sourceRecordRef,
        };
        const originalInvocations = admin<{
          action_invocation_id: string;
          principal_id: string;
        }>`select action_invocation_id,principal_id
          from core.action_invocations where tenant_id=${tenantId} and action_key=${operation.entrypointKey} and status='succeeded'`;
        const [original] = yield* originalInvocations;
        expect(original?.principal_id).toBe(system.principalId);
        expect(yield* readDeclarations).toEqual([expected]);
        yield* worker.child.kill();
        yield* worker.child.exitCode;
        yield* admin`update core.access_workload_bindings set status='revoked',revoked_at=clock_timestamp()
          where tenant_id=${tenantId} and principal_id=${integration.principalId} and workload_key='integration.symmy-admit'`;
        yield* fs.remove(faultMarker);
        const restarted = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_SELLER_VAT_RESTARTED_PROCESS',
          },
          symmyModuleKey,
        );
        const final = yield* observePolicyFixtureUntil(
          poll(accepted.jobId),
          ({ status }) => status === 'completed_all',
          failure('The C14 worker did not settle the original Tax effect after revocation', restarted.diagnostic),
        );
        expect(final.items).toMatchObject([{ outcome: 'accepted' }]);
        const [ledger] = yield* admin`select owner_invocation_id,state from symmy_integration.job_effects
          where tenant_id=${tenantId} and job_id=${accepted.jobId}`;
        expect(ledger).toEqual({ owner_invocation_id: original?.action_invocation_id, state: 'settled' });

        yield* admin`update core.access_workload_bindings set status='active',revoked_at=null
          where tenant_id=${tenantId} and principal_id=${integration.principalId} and workload_key='integration.symmy-admit'`;
        const foreignSeller = declaration(randomUUID());
        yield* admin`update symmy_integration.job_routes set fixture_plan=${yield* routePlan(foreignSeller)}::jsonb,
          route_revision='INTERNAL_C14_SELLER_VAT_ROUTE_V2' where tenant_id=${tenantId} and route_id=${routeId}`;
        expect((yield* post('foreign-seller', { fixtureId })).status).toBe(403);

        yield* admin`update symmy_integration.job_routes set fixture_plan=${yield* routePlan({ ...source, regime: 'NON_PAYER' })}::jsonb,
          route_revision='INTERNAL_C14_SELLER_VAT_ROUTE_V3' where tenant_id=${tenantId} and route_id=${routeId}`;
        const unapproved = yield* submit('unapproved-tax-declaration');
        const denied = yield* observePolicyFixtureUntil(
          poll(unapproved.jobId),
          ({ status }) => status === 'completed_none',
          failure('The unapproved Tax command did not settle as denied', restarted.diagnostic),
        );
        expect(denied.items).toMatchObject([{ outcome: 'not_accepted' }]);
        const [deniedEffect] = yield* admin`select outcome->>'status' as status
          from symmy_integration.job_effects where tenant_id=${tenantId} and job_id=${unapproved.jobId}`;
        expect(deniedEffect).toEqual({ status: 'denied' });
        expect(yield* readDeclarations).toEqual([expected]);
        expect(yield* originalInvocations).toEqual([original]);
      }),
    ).pipe(Effect.provide(policyFixtureServices)),
  120_000,
);
