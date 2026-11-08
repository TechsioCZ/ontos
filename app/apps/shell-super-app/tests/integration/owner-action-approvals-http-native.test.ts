import {
  ActiveApplicationCompositionSnapshotSchema,
  GatewayScopeGrantRegistrar,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  TrustedPrincipalContextSchema,
  verifySessionRoleOnFirstUse,
} from '@app/core-runtime';
import {
  OWNER_ACTION_APPROVAL_INSPECTION_PATH,
  OwnerActionApprovalRequestSchema,
} from '@app/core-runtime/access/approvals/owner-api';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  ProposalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  NativeHumanSessionsFactory,
  OperationalScopeResolverLive,
  makeGatewayScopeGrantRegistrar,
  makeNativeActionV2Fixture,
  makeNativeActionV2OwnerRuntime,
  nativeV2Keys,
} from '@app/core-runtime/testing/native-action-v2';
import type { NativeActionV2Fixture } from '@app/core-runtime/testing/native-action-v2';
import { publishTestApplicationCompositionAuthority, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { moduleReleaseFetch } from '@app/core-runtime/unit-service-fetch';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Clock, Context, Crypto, DateTime, Effect, Exit, Layer, Option, Redacted, Result, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair } from 'jose';

import { ApprovalOwnerIdentity, requireApprovalOwnerIdentity } from '../../api/access-admin/approval-owner-identity.ts';
import { approvalOwnerRefused } from '../../api/access-admin/approval-owner-errors.ts';
import { ApprovalRequesterSchema } from '../../api/access-admin/approvals-contract.ts';
import { ApprovalOwnerModuleTransport } from '../../api/access-admin/approval-owner-module-transport.ts';
import { makeApprovalOwnerTransport } from '../../api/access-admin/approval-owner-transport.ts';
import { GatewayIssuer, GatewayIssuerError, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { makeInstalledModuleCatalogLayer } from '../../api/modules/installed-module-catalog.ts';
import { launchNativeApprovalOwner } from '../fixtures/approval-owner-native.ts';
import { sealComposition } from '../fixtures/application-composition.ts';
import { nativeOwnerApprovalRedemptionSetup } from '../support/approval-owner-native-redemption.ts';
import { makeNativeHumanSessionProvider } from '../support/native-human-sessions.ts';

const parentServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      Reactivity.layer,
      Layer.succeed(NativeHumanSessionsFactory, {
        make: (options) => makeNativeHumanSessionProvider(options, new URL('../../drizzle-auth/', import.meta.url)),
      }),
    ),
  ),
);
const date = Schema.Union([Schema.Date, Schema.DateFromString]);
const pendingRecordSchema = Schema.Struct({
  capabilityKey: CapabilityKeySchema,
  commandDigest: CommandDigestSchema,
  createdAt: date,
  expiresAt: date,
  id: ProposalIdSchema,
  requester: ApprovalRequesterSchema,
  scopeId: AccessScopeIdSchema,
  status: Schema.Literal('pending'),
  tenantId: TenantIdSchema,
});
const rowsSchema = Schema.Array(Schema.Struct({ record_key: Schema.String, salary: Schema.Int, version: Schema.Int }));
const statusSchema = Schema.Array(Schema.Struct({ status: Schema.String }));
type OwnerInspectionRequest = typeof OwnerActionApprovalRequestSchema.Encoded;

const pendingRecord = Effect.fn('OwnerApprovalHttpNative.pendingRecord')(function* loadPendingRecord(
  fixture: NativeActionV2Fixture,
  proposalId: string,
) {
  const [row] = yield* fixture.admin.unsafe(
    `select capability_key as "capabilityKey",command_digest as "commandDigest",created_at as "createdAt",
      expires_at as "expiresAt",proposal_id as id,requester_json as requester,scope_id as "scopeId",status,
      tenant_id as "tenantId" from core.access_proposals where tenant_id=$1 and proposal_id=$2`,
    [fixture.tenantId, proposalId],
  );
  return yield* Schema.decodeUnknownEffect(pendingRecordSchema)(row);
});
const businessRows = (fixture: NativeActionV2Fixture) =>
  fixture.admin
    .unsafe('select record_key,salary,version from public.native_action_v2_records order by record_key')
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(rowsSchema)));
const statusOf = (fixture: NativeActionV2Fixture, proposalId: string) =>
  fixture.admin
    .unsafe('select status from core.access_proposals where tenant_id=$1 and proposal_id=$2', [
      fixture.tenantId,
      proposalId,
    ])
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(statusSchema)));

it.layer(parentServices, { excludeTestServices: true, timeout: '120 seconds' })(
  'independent owner Action approval HTTP',
  (suite) => {
    suite.effect(
      'uses real sessions, issuer, approved Node placement and owner authority without executing the command',
      () =>
        Effect.gen(function* independentlyApprovesOriginalCommand() {
          const fixture = yield* makeNativeActionV2Fixture;
          const { caseContext } = fixture;
          const child = yield* launchNativeApprovalOwner();
          yield* Effect.addFinalizer((exit) =>
            Exit.isFailure(exit)
              ? child.diagnostics.pipe(
                  Effect.flatMap((stderr) => Effect.logError('Independent owner diagnostics', stderr)),
                )
              : Effect.void,
          );
          const now = yield* DateTime.now;
          // Only the real loopback placement changes. The contract document and its owner-authored
          // API/declarations remain byte-for-byte those the original factory actually published.
          const snapshot = yield* Schema.decodeUnknownEffect(Schema.toType(ActiveApplicationCompositionSnapshotSchema))(
            {
              composition: sealComposition({
                ...caseContext.compositionSnapshot.composition,
                modules: caseContext.compositionSnapshot.composition.modules.map((module) => ({
                  ...module,
                  backend: { baseUrl: child.listening.baseUrl, transport: 'node-http' },
                })),
              }),
              observedAt: now,
              validUntil: DateTime.add(now, { minutes: 2 }),
            },
          );
          const adminDatabase = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, fixture.admin));
          yield* publishTestApplicationCompositionAuthority(adminDatabase, snapshot);
          for (const statement of nativeOwnerApprovalRedemptionSetup) {
            yield* fixture.admin.unsafe(statement);
          }
          const parentRuntime = yield* makeNativeActionV2OwnerRuntime({
            configuration: Redacted.value(caseContext.configuration),
            database: fixture.database,
            enrollment: caseContext.enrollment,
            owner: {
              applicationComposition: { load: Effect.succeed(snapshot) },
              expectedDeployment: caseContext.expectedDeployment,
              ownerRegistration: fixture.owner.ownerRegistration,
            },
            scopeResolverLayer: OperationalScopeResolverLive,
          });
          const namespace = yield* Layer.build(
            staffAuthenticationNamespaceRegistryLayer([caseContext.expectedDeployment.appId, 'shell-super-app']),
          );
          const tenantIdentity = yield* fixture.approverSession.authenticateTenant();
          const tenantScope = yield* parentRuntime.scopeResolver
            .resolve({
              correlationId: 'independent-owner-approval',
              legalEntityScope: 'optional',
              principal: tenantIdentity.principal,
            })
            .pipe(Effect.provideContext(namespace));
          expect(tenantScope.legalEntityId).toBeUndefined();
          const requesterIdentity = yield* fixture.requesterSession.authenticate();
          const requesterScope = yield* parentRuntime.scopeResolver
            .resolve({
              correlationId: 'independent-owner-proposal',
              legalEntityScope: 'required',
              principal: requesterIdentity.principal,
            })
            .pipe(Effect.provideContext(namespace));
          const park = Effect.fn('OwnerApprovalHttpNative.park')(function* park(key: string) {
            const result = yield* parentRuntime.runtime
              .runAction({
                payload: fixture.payload,
                principal: requesterIdentity.principal,
                registration: fixture.action,
                successContract: 'result-or-proposal',
                transport: { correlationId: key, idempotencyKey: key, intent: 'propose' },
              })
              .pipe(Effect.provideContext(namespace));
            if (!Schema.is(ActionProposalAcceptedSchema)(result)) {
              return yield* Effect.die('Only a genuine parked command may enter the HTTP approval proof');
            }
            const frozen = yield* parentRuntime.frozenCommands.load(requesterScope, {
              proposalId: result.proposalId,
              scopeId: fixture.companyScope,
            });
            if (Option.isNone(frozen)) {
              return yield* Effect.die('The original runtime must persist its frozen command');
            }
            return {
              frozen: frozen.value,
              headers: new Headers(),
              proposal: yield* pendingRecord(fixture, result.proposalId),
            };
          });
          const original = yield* park('native-http-original');
          const denied = yield* park('native-http-denied-read-field');
          const issuer = 'https://shell.owner-http-native.test';
          const keyPair = yield* Effect.promise(() => generateKeyPair('Ed25519', { extractable: true }));
          const privateJwk = {
            ...(yield* Effect.promise(() => exportJWK(keyPair.privateKey))),
            alg: 'EdDSA',
            kid: 'native-owner-approval',
            use: 'sig',
          };
          const publicJwks = JSON.stringify({
            keys: [
              {
                ...(yield* Effect.promise(() => exportJWK(keyPair.publicKey))),
                alg: 'EdDSA',
                kid: privateJwk.kid,
                use: 'sig',
              },
            ],
          });
          const connections = Redacted.value(caseContext.connections);
          const identityEntries = yield* Effect.forEach(
            (identity: (typeof caseContext.enrollment.identities)[number]) => {
              const connection = connections.runtime[identity.id];
              return connection === undefined
                ? Effect.die('The case must contain every original enrolled database identity')
                : Effect.succeed([identity.urlKey, connection.connectionString] as const);
            },
          )(caseContext.enrollment.identities);
          const databaseEnvironment = {
            DATABASE_ADMIN_URL: connections.admin.connectionString,
            ...Object.fromEntries(identityEntries),
          };
          const permissionConfiguration = Redacted.value(caseContext.configuration);
          const permissionEnvironment = {
            SPICEDB_ENDPOINT: permissionConfiguration.endpoint,
            SPICEDB_PRESHARED_KEY: permissionConfiguration.preSharedKey,
            ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'test',
          };
          const spiceDbEnvironment =
            permissionConfiguration.caCertificate === undefined
              ? permissionEnvironment
              : { ...permissionEnvironment, SPICEDB_CA_CERT: permissionConfiguration.caCertificate };
          const ready = yield* child.configure({
            compositionSnapshot: snapshot,
            databaseEnvironment: Redacted.make(databaseEnvironment),
            expectedDeployment: caseContext.expectedDeployment,
            issuer,
            publicJwks,
            spiceDbEnvironment: Redacted.make(spiceDbEnvironment),
          });
          expect(ready.pid).not.toBe(process.pid);
          const issuerConnection = connections.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id];
          if (issuerConnection === undefined) {
            return yield* Effect.die('The actual case issuer connection is required');
          }
          const issuerClient = verifySessionRoleOnFirstUse(
            yield* PgClient.makeClient({ url: Redacted.make(issuerConnection.connectionString) }),
            issuerConnection.expectedRole,
          );
          const crypto = yield* Crypto.Crypto;
          const issuerClock = yield* Clock.Clock;
          const issuerContext = yield* Layer.build(
            makeGatewayIssuerLayer({
              currentTimeSeconds: issuerClock.currentTimeMillis.pipe(
                Effect.map((milliseconds) => Math.floor(milliseconds / 1000)),
              ),
              generateJti: crypto.randomUUIDv4().pipe(
                Effect.mapError(
                  () =>
                    new GatewayIssuerError({
                      code: 'gateway_issuer_unavailable',
                      reason: 'Native signing is unavailable',
                      stage: 'signing',
                    }),
                ),
              ),
              loadAdmission: Effect.succeed({
                audiences: new Map([
                  [caseContext.expectedDeployment.appId, caseContext.expectedDeployment.buildMarker],
                ]),
                revision: snapshot.composition.revision,
              }),
              loadConfig: parseGatewayIssuerConfig({
                ONTOS_GATEWAY_ISSUER: issuer,
                ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify(privateJwk),
              }),
            }).pipe(
              Layer.provide(
                Layer.succeed(
                  GatewayScopeGrantRegistrar,
                  makeGatewayScopeGrantRegistrar(issuerClient, caseContext.enrollment),
                ),
              ),
            ),
          );
          const sent: { readonly module: (typeof snapshot.composition.modules)[number]; readonly request: Request }[] =
            [];
          const transport = yield* makeApprovalOwnerTransport.pipe(
            Effect.provideContext(issuerContext),
            Effect.provide(makeInstalledModuleCatalogLayer(Effect.succeed(snapshot))),
            Effect.provideService(ApprovalOwnerIdentity, {
              resolve: (_headers, admitted, legalEntityId) =>
                fixture.approverSession.authenticate().pipe(
                  Effect.flatMap(({ principal }) => requireApprovalOwnerIdentity(admitted, principal, legalEntityId)),
                  Effect.mapError(approvalOwnerRefused),
                ),
            }),
            Effect.provideService(ApprovalOwnerModuleTransport, {
              send: (request, module) => {
                sent.push({ module, request: request.clone() });
                return moduleReleaseFetch(request, module).pipe(
                  Effect.tap((response) =>
                    Effect.logInfo('Independent owner HTTP response', { status: response.status }),
                  ),
                );
              },
            }),
          );
          const initialRows = yield* businessRows(fixture);
          expect(yield* transport.inspect(tenantScope, original)).toBe(true);
          expect(yield* statusOf(fixture, original.proposal.id)).toEqual([{ status: 'pending' }]);
          const [inspectionRequest] = sent;
          if (inspectionRequest === undefined) {
            return yield* Effect.die('The inspection must cross the real independent HTTP boundary');
          }
          expect(new URL(inspectionRequest.request.url).pathname.endsWith(OWNER_ACTION_APPROVAL_INSPECTION_PATH)).toBe(
            true,
          );
          const replay = yield* moduleReleaseFetch(inspectionRequest.request.clone(), inspectionRequest.module);
          expect(replay.status).toBe(401);
          yield* Effect.promise(() => replay.text());
          const [ownerModule] = snapshot.composition.modules;
          if (ownerModule === undefined) {
            return yield* Effect.die('The original published owner must be present');
          }
          const validRequest = {
            compositionRevision: snapshot.composition.revision,
            expectedCommandDigest: original.frozen.commandDigest,
            expectedOwner: {
              deployment: caseContext.expectedDeployment,
              moduleKey: fixture.owner.ownerRegistration.moduleId,
            },
            expectedStatus: 'pending',
            proposalId: original.frozen.proposalId,
            scopeId: original.frozen.scopeId,
          } satisfies OwnerInspectionRequest;
          const directInspection = Effect.fn('OwnerApprovalHttpNative.direct')(function* direct(
            payload: OwnerInspectionRequest,
            context: 'company' | 'tenant',
          ) {
            const gatewayIssuer = Context.get(issuerContext, GatewayIssuer);
            const identity = yield* context === 'company'
              ? fixture.approverSession.authenticate()
              : fixture.approverSession.authenticateTenant();
            const { principal } = identity;
            const assertion = yield* gatewayIssuer.issue({
              audience: caseContext.expectedDeployment.appId,
              compositionRevision: snapshot.composition.revision,
              principal: yield* Schema.encodeEffect(TrustedPrincipalContextSchema)(principal),
            });
            const decoded = yield* Schema.decodeUnknownEffect(OwnerActionApprovalRequestSchema)(payload);
            return yield* moduleReleaseFetch(
              new Request(
                `https://module.invalid/${caseContext.expectedDeployment.appId}-api${OWNER_ACTION_APPROVAL_INSPECTION_PATH}`,
                {
                  body: yield* Schema.encodeEffect(Schema.fromJsonString(OwnerActionApprovalRequestSchema))(decoded),
                  headers: {
                    authorization: `Bearer ${assertion.token}`,
                    'content-type': 'application/json',
                    'x-correlation-id': 'native-owner-negative',
                  },
                  method: 'POST',
                },
              ),
              ownerModule,
            );
          });
          for (const { payload, status } of [
            {
              payload: {
                ...validRequest,
                expectedOwner: { ...validRequest.expectedOwner, moduleKey: 'foreign.owner' },
              },
              status: 403,
            },
            {
              payload: {
                ...validRequest,
                expectedOwner: {
                  ...validRequest.expectedOwner,
                  deployment: { ...caseContext.expectedDeployment, buildMarker: 'other-release' },
                },
              },
              status: 403,
            },
            // The actual owner API treats a changed frozen digest as a currentness conflict.
            { payload: { ...validRequest, expectedCommandDigest: 'f'.repeat(64) }, status: 409 },
          ]) {
            const response = yield* directInspection(payload, 'company');
            expect(response.status).toBe(status);
            yield* Effect.promise(() => response.text());
          }
          const noCompany = yield* directInspection(validRequest, 'tenant');
          expect(noCompany.status).toBe(403);
          yield* Effect.promise(() => noCompany.text());
          const staleComposition = yield* directInspection(
            {
              ...validRequest,
              compositionRevision: caseContext.compositionSnapshot.composition.revision,
            },
            'company',
          );
          expect(staleComposition.status).toBe(401);
          yield* Effect.promise(() => staleComposition.text());
          const [tenantScopeRow] = yield* fixture.admin.unsafe(
            'select scope_id from core.access_scopes where tenant_id=$1 and legal_entity_id is null',
            [fixture.tenantId],
          );
          const originalTenantScope = yield* Schema.decodeUnknownEffect(Schema.Struct({ scope_id: Schema.String }))(
            tenantScopeRow,
          );
          const wrongScope = yield* directInspection(
            { ...validRequest, scopeId: originalTenantScope.scope_id },
            'company',
          );
          expect(wrongScope.status).toBe(403);
          yield* Effect.promise(() => wrongScope.text());
          const beforeMismatch = sent.length;
          const crossTenant = yield* Effect.result(
            transport.inspect(tenantScope, {
              ...original,
              frozen: { ...original.frozen, tenantId: TenantIdSchema.make('00000000-0000-4000-8000-000000000099') },
            }),
          );
          expect(Result.isFailure(crossTenant)).toBe(true);
          expect(sent).toHaveLength(beforeMismatch);
          yield* transport.approve(tenantScope, original);
          expect(
            fixture.approverRole.grants.filter(
              ({ capabilityKey, mode }) => capabilityKey === nativeV2Keys.action && mode === 'run',
            ),
          ).toHaveLength(0);
          expect(yield* statusOf(fixture, original.proposal.id)).toEqual([{ status: 'approved' }]);
          expect(yield* businessRows(fixture)).toEqual(initialRows);
          expect(fixture.executions.value).toBe(0);
          const replayedApproval = yield* Effect.result(transport.approve(tenantScope, original));
          expect(Result.isFailure(replayedApproval)).toBe(true);
          const readGrant = fixture.approverRole.grants.find(
            ({ capabilityKey }) => capabilityKey === nativeV2Keys.readField,
          );
          if (readGrant === undefined) {
            return yield* Effect.die('The genuine fixture must own its declared read-field grant');
          }
          yield* fixture.admin.unsafe(
            "update core.access_grant_incarnations set status='retired' where grant_incarnation_id=$1",
            [readGrant.grantId],
          );
          yield* fixture.reconcile();
          expect(yield* transport.inspect(tenantScope, denied)).toBe(false);
          expect(Result.isFailure(yield* Effect.result(transport.approve(tenantScope, denied)))).toBe(true);
          expect(yield* statusOf(fixture, denied.proposal.id)).toEqual([{ status: 'pending' }]);
          expect(yield* businessRows(fixture)).toEqual(initialRows);
          yield* child.stop;
          expect(yield* child.isRunning).toBe(false);
          expect(yield* child.diagnostics).toContain('OwnerApprovalNative scoped resources released');
          expect(Result.isFailure(yield* Effect.result(transport.inspect(tenantScope, denied)))).toBe(true);
          yield* fixture.approverSession.signOut();
          const beforeSignedOut = sent.length;
          expect(Result.isFailure(yield* Effect.result(transport.inspect(tenantScope, denied)))).toBe(true);
          expect(sent).toHaveLength(beforeSignedOut);
          return yield* Effect.void;
        }).pipe(Effect.scoped),
    );
  },
);
