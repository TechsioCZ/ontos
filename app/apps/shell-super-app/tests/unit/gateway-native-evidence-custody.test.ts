import {
  buildApplicationCompositionCatalog,
  defineTenantModuleEntrypoint,
  OntosRegisteredWorkloadCallSchema,
} from '@app/core-runtime';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { symmyRouteSourceWorkloads } from '../../api/symmy/native-evidence-policy.ts';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayWorkloadSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { GatewayRegisteredAssertionSubjectSchema } from '@app/shared-contracts';
import { Context, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { GatewayNativeEvidenceLive } from '../../api/auth/gateway-native-evidence.service.ts';
import { GatewayNativeEvidence } from '../../api/auth/gateway-native-evidence.ts';
import { GatewayModuleBindingSchema } from '../../api/auth/gateway-delegation-policy.ts';

type DatabaseFreeOperations = {
  readonly [Method in keyof GatewayNativeEvidence['Service']]: (
    ...input: Parameters<GatewayNativeEvidence['Service'][Method]>
  ) => Effect.Effect<unknown, unknown>;
};

it.effect('captures native custody, rechecks revocation on each call, and exposes no database requirement', () =>
  Effect.gen(function* nativeCustody() {
    const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      authBindingId: '10000000-0000-4000-8000-000000000001',
      authContextRef: 'better-auth-api-key:source-key',
      authenticationNamespaceId: 'source-namespace',
      authMethod: 'api_key',
      principalId: '10000000-0000-4000-8000-000000000002',
      tenantId: '10000000-0000-4000-8000-000000000003',
    });
    let active = true;
    let reads = 0;
    const connection = testSqlConnection((statement, parameters) => {
      if (!statement.includes('from core.principals p')) {
        return Effect.succeed([]);
      }
      reads += 1;
      expect(statement).toContain('a.revoked_at is null');
      expect(statement).toContain("p.kind='integration' and p.status='active'");
      expect(statement).toContain("w.status='active'");
      expect(parameters).toContain(principal.tenantId);
      expect(parameters).toContain(principal.authBindingId);
      expect(parameters).toContain(principal.authenticationNamespaceId);
      expect(parameters).toContain('source-key');
      return Effect.succeed(active ? [{ principal_id: principal.principalId }] : []);
    });
    const database = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
      Layer.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
    );
    // Only the capability escapes construction; the calling context contains no CoreDatabase.
    const services = yield* Layer.build(GatewayNativeEvidenceLive.pipe(Layer.provide(database)));
    const native = Context.get(services, GatewayNativeEvidence);
    const admitted: Effect.Effect<
      typeof TrustedPrincipalContextSchema.Type,
      Effect.Error<ReturnType<typeof native.validateRoutePrincipal>>
    > = (native satisfies DatabaseFreeOperations).validateRoutePrincipal(principal, symmyRouteSourceWorkloads('admit'));
    expect(yield* admitted).toEqual(principal);
    active = false;
    const revoked = yield* native
      .validateRoutePrincipal(principal, symmyRouteSourceWorkloads('admit'))
      .pipe(Effect.flip);
    expect(revoked).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
    expect(reads).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect('rechecks original Payment source authority independently of the receiving system binding', () =>
  Effect.gen(function* originalPaymentAuthority() {
    const principalId = '10000000-0000-4000-8000-000000000001';
    const tenantId = '10000000-0000-4000-8000-000000000002';
    const incarnation = '10000000-0000-4000-8000-000000000003';
    const rule = yield* Schema.decodeUnknownEffect(OntosRegisteredWorkloadCallSchema)({
      audience: 'payment',
      declarationKey: 'payment.core.source-ingress',
      entrypointKey: 'payment.core.submit-source-statement',
      jobKey: 'payment.core.process-provider-notification',
      legalEntityScope: 'required',
      schemaVersion: '1',
      workerKey: 'payment.core.process-provider-notification',
      workloadKey: 'payment.source-ingress',
    });
    const binding = yield* Schema.decodeUnknownEffect(GatewayModuleBindingSchema)({
      compositionRevision: 'a'.repeat(64),
      providerKeyId: 'payment-test-key',
      sourceAppId: 'payment',
      sourceBuildMarker: 'payment-build',
    });
    const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      authContextRef: `job:${rule.jobKey}:run:${principalId}`,
      authMethod: 'system',
      principalId,
      tenantId,
    });
    const subject = yield* Schema.decodeUnknownEffect(GatewayRegisteredAssertionSubjectSchema)({
      _tag: 'RegisteredAssertion',
      declarationKey: rule.declarationKey,
      sourceAssertion: 'signed-source-assertion',
    });
    const workload = yield* Schema.decodeUnknownEffect(RegisteredGatewayWorkloadSchema)({
      ...rule,
      admissionInvocationId: principalId,
      bindingIncarnation: incarnation,
      legalEntityId: tenantId,
      originalOwnerBindingIncarnation: incarnation,
      originalPrincipalId: tenantId,
      originalWorkloadBindingIncarnation: incarnation,
      originalWorkloadKey: 'payment.provider-notification-ingress',
      runReference: principalId,
      sourceAppId: 'payment',
      sourceBuildMarker: 'payment-build',
      sourceMode: 'admission',
    });
    const payment = makeModuleContractFixture({ appId: 'payment', moduleId: 'payment.core' });
    const operation = {
      apiKey: 'payment.core.api.source',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: rule.entrypointKey,
        moduleKey: 'payment.core',
        role: 'api',
      }),
      operationKey: 'source.submit',
      schemaVersion: rule.schemaVersion,
      workloadCarrier: { declarationKey: rule.declarationKey, workloads: [rule.workloadKey] },
    };
    const installed = yield* makeCompositionSnapshot([
      {
        ...payment,
        manifest: {
          ...payment.manifest,
          publicSurface: {
            ...payment.manifest.publicSurface,
            api: [{ key: operation.apiKey, operationKeys: [operation.operationKey] }],
            operationContracts: [operation],
          },
        },
      },
    ]);
    const catalog = yield* buildApplicationCompositionCatalog(installed.composition);
    const [contract] = catalog.contracts;
    if (contract === undefined) {
      yield* Effect.die('Expected a Payment release in the installed catalog');
      return;
    }
    const statements: string[] = [];
    let systemActive = false;
    const connection = testSqlConnection((statement, parameters) => {
      if (statement.includes('from core.access_workload_bindings receiver')) {
        statements.push(statement);
        expect(statement).toMatch(/\$\d+ not in \(\$\d+, \$\d+\) or exists/u);
        expect(statement).toContain('original_payment_source.tenant_id=original.tenant_id');
        expect(statement).toContain('original_payment_source.principal_id=original.principal_id');
        expect(statement).toMatch(/original_payment_source.workload_key=\$\d+/u);
        expect(statement).toContain("original_payment_source.status='active'");
        expect(parameters.slice(7, 11)).toEqual([
          workload.originalWorkloadKey,
          'payment.provider-notification-ingress',
          'payment.provider-reconciliation',
          'payment.source-ingress',
        ]);
        expect(parameters).toContain(workload.originalPrincipalId);
        return Effect.succeed(
          systemActive ? [{ bindingIncarnation: incarnation, ownerBindingIncarnation: incarnation, principalId }] : [],
        );
      }
      return Effect.succeed([]);
    });
    const database = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
      Layer.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
    );
    const services = yield* Layer.build(GatewayNativeEvidenceLive.pipe(Layer.provide(database)));
    const native = Context.get(services, GatewayNativeEvidence);
    yield* Effect.forEach(
      [0, 1],
      () =>
        native
          .admitAssertion({
            binding,
            destination: contract,
            rule,
            source: contract,
            sourceAccess: 'write',
            sourcePrincipal: principal,
            subject,
            workload,
          })
          .pipe(
            Effect.flip,
            Effect.tap((error) =>
              Effect.sync(() => {
                expect(error).toMatchObject({ code: 'forbidden', reason: 'workload_binding_not_active' });
              }),
            ),
          ),
      { concurrency: 1 },
    );
    expect(statements).toHaveLength(2);

    systemActive = true;
    const input = {
      binding,
      destination: contract,
      rule,
      source: contract,
      sourceAccess: 'write' as const,
      sourcePrincipal: principal,
      subject,
      workload,
    };
    const installedOperation = contract.manifest.publicSurface.operationContracts?.[0];
    if (installedOperation === undefined) {
      yield* Effect.die('Expected the installed Payment operation');
      return;
    }
    const ambiguous = {
      ...contract,
      manifest: {
        ...contract.manifest,
        publicSurface: {
          ...contract.manifest.publicSurface,
          operationContracts: [installedOperation, installedOperation],
        },
      },
    };
    for (const invalid of [
      { ...input, rule: { ...rule, schemaVersion: '2' } },
      { ...input, destination: ambiguous },
      { ...input, workload: { ...workload, schemaVersion: '2' } },
      { ...input, source: ambiguous },
    ]) {
      const refusal = yield* Effect.flip(native.admitAssertion(invalid));
      expect(refusal).toMatchObject({ code: 'forbidden', reason: 'registered_operation_refused' });
    }
    expect(statements).toHaveLength(2);
  }).pipe(Effect.scoped),
);
