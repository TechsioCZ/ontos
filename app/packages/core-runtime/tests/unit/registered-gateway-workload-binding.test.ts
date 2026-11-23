import { PgDialect } from 'drizzle-orm/pg-core';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  registeredGatewayExecutorEligibility,
  registeredGatewayOriginalAdmission,
} from '../../src/access/workloads/bindings.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import { WorkloadKeySchema } from '../../src/authorization/access-declaration.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { internalWorkloadPrincipalId } from '../../src/auth/module-credentials.ts';
import {
  RegisteredGatewayRouteScopeSchema,
  RegisteredGatewayWorkloadSchema,
  isTrustedSystemPrincipalContext,
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayRouteScope,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';

const tenantId = TenantIdSchema.make('10000000-0000-4000-8000-000000000001');
const legalEntityId = '10000000-0000-4000-8000-000000000002';
const workloadKey = 'party.registry.source-read';
const principalId = PrincipalIdSchema.make(internalWorkloadPrincipalId({ tenantId, legalEntityId, workloadKey }));
const originalPrincipalId = '20000000-0000-4000-8000-000000000001';
const bindingIncarnation = '30000000-0000-4000-8000-000000000001';
const originalWorkloadBindingIncarnation = '30000000-0000-4000-8000-000000000002';
const workload = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)({
  admissionInvocationId: '40000000-0000-4000-8000-000000000001',
  bindingIncarnation,
  declarationKey: 'party.registry.source-read',
  entrypointKey: 'party.registry.api.source-read',
  jobKey: 'customer-source',
  legalEntityId,
  legalEntityScope: 'required',
  originalOwnerBindingIncarnation: bindingIncarnation,
  originalPrincipalId,
  originalWorkloadBindingIncarnation,
  originalWorkloadKey: 'integration.symmy-admit',
  runReference: '40000000-0000-4000-8000-000000000001',
  schemaVersion: '1',
  sourceAppId: 'symmy-integration',
  sourceBuildMarker: 'source-build',
  sourceMode: 'admission',
  workloadKey,
});
const dialect = new PgDialect();

it('keeps the original integration admission live without requiring an external receiver alias', () => {
  const query = dialect.sqlToQuery(registeredGatewayOriginalAdmission({ tenantId, principalId }, workload));
  expect(query.sql).toContain("p.status='active' and p.kind='integration'");
  expect(query.sql).toContain("b.status='active'");
  expect(query.sql).toContain('"core"."access_workload_bindings"."incarnation"=');
  expect(query.sql).not.toContain('ob.principal_id');
  expect(query.params).toContain(originalPrincipalId);
  expect(query.params).toContain('integration.symmy-admit');
  expect(query.params).toContain(originalWorkloadBindingIncarnation);
  expect(query.params).toContain(bindingIncarnation);
  expect(query.params).not.toContain(workloadKey);
});

it('admits native SYSTEM and exact company-canonical SERVICE receivers, never an integration or arbitrary service', () => {
  const query = dialect.sqlToQuery(registeredGatewayExecutorEligibility({ tenantId, principalId }, workload));
  expect(query.sql).toContain("s.kind = 'system'");
  expect(query.sql).toContain("s.kind = 'service' and s.platform_role = 'internal_workload'");
  expect(query.sql).toContain("s.status = 'active'");
  expect(query.sql).toContain("cb.status='active'");
  expect(query.sql).toContain("le.status='active'");
  expect(query.sql).toContain('cb.workload_binding_id="core"."access_workload_bindings"."binding_id"');
  expect(query.params.filter((value) => value === principalId)).toHaveLength(2);
  expect(query.params).toContain(legalEntityId);
  expect(query.params).not.toContain(originalPrincipalId);
});

it('keeps a projected tenant-only receiver fenced to platform identity and its active native company registration', () => {
  const { legalEntityId: _company, ...rest } = workload;
  const tenantOnly = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)({
    ...rest,
    legalEntityScope: 'forbidden',
  });
  const query = dialect.sqlToQuery(registeredGatewayExecutorEligibility({ tenantId, principalId }, tenantOnly));
  expect(query.sql).toContain("s.platform_role = 'internal_workload'");
  expect(query.sql).toContain('cb.workload_binding_id="core"."access_workload_bindings"."binding_id"');
  expect(query.sql).toContain("cb.status='active'");
  expect(query.sql).toContain("le.status='active'");
  expect(query.params).not.toContain(legalEntityId);
});

it.effect('admits only the exact synchronous native Read and cannot reuse its proof for an Action or another workload', () =>
  Effect.gen(function* nativeSourceRead() {
    const route = Schema.decodeUnknownSync(RegisteredGatewayRouteScopeSchema)({
      legalEntityId,
      nativeReadReceiver: {
        bindingIncarnation,
        enrollmentLegalEntityId: legalEntityId,
        originalPrincipalId,
        originalWorkloadBindingIncarnation,
        originalWorkloadKey: 'integration.symmy-poll',
        workloadKey,
      },
      operations: [{ entrypointKey: workload.entrypointKey, schemaVersion: '1' }],
      principalId,
      routeId: workload.runReference,
      routeKey: 'adminCustomers',
      routeRevision: '1',
      sourceRouteId: workload.runReference,
      sourceRouteRevision: '1',
      tenantId,
    });
    const principal = trustVerifiedGatewayPrincipalContext(
      Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authContextRef: `job:integration.symmy.source-read:run:${workload.runReference}`,
        authMethod: 'system',
        principalId,
        tenantId,
      }),
      'a'.repeat(64),
      undefined,
      undefined,
      undefined,
      route,
    );
    const scope = preserveSystemPrincipalContextTrust(principal, {
      ...principal,
      legalEntityId: LegalEntityIdSchema.make(legalEntityId),
      correlationId: 'native-source-read',
    });
    expect(isTrustedSystemPrincipalContext(scope)).toBe(true);
    expect(readVerifiedGatewayRouteScope(scope)?.nativeReadReceiver?.bindingIncarnation).toBe(bindingIncarnation);
    const makeGate = () => makeAccessDecisionService({
      authorityFor: () => ({
        readCells: () => Effect.succeed([]),
        readCompanyOwnership: () => Effect.succeed(true),
        readConnection: () => Effect.succeed(Option.none()),
        readScope: () => Effect.succeed(Option.none()),
        readTeamIds: () => Effect.succeed([]),
      }),
      check: { checkBulk: () => Effect.succeed([]) },
      decisionLog: { record: () => Effect.void },
      legalEntities: { listCandidateIds: () => Effect.succeed([]) },
      principalKinds: { readKind: () => Effect.succeed(Option.some('service')) },
      workloadBindings: {
        readWorkloadAuthority: () => Effect.succeed({
          activeCompanyIds: new Set([LegalEntityIdSchema.make(legalEntityId)]),
          workloadKeys: new Set([workloadKey]),
        }),
      },
    });
    const gate = makeGate();
    const carrier = {
      accessDeclaration: {
        key: 'party.registry.source-read',
        kind: 'read',
        modes: ['run'],
        risk: 'sensitive',
        selectors: [],
      },
      accessWorkload: { reason: 'Exact native source Read', workloads: [WorkloadKeySchema.make(workloadKey)] },
      entrypoint: { entrypointKey: workload.entrypointKey },
      schemaVersion: '1',
    } satisfies Parameters<typeof gate.decide>[0]['carrier'];
    const input = { carrier, legalEntityScope: 'required', now: new Date(), scope } satisfies Parameters<typeof gate.decide>[0];
    expect((yield* gate.decide(input)).outcome).toBe('ALLOWED');
    expect((yield* makeGate().decide({
      ...input,
      carrier: { ...carrier, accessDeclaration: { ...carrier.accessDeclaration, kind: 'action' } },
    })).outcome).toBe('DENIED');
    expect((yield* makeGate().decide({
      ...input,
      carrier: { ...carrier, accessWorkload: { ...carrier.accessWorkload, workloads: [WorkloadKeySchema.make('party.registry.source-write')] } },
    })).outcome).toBe('DENIED');
    expect((yield* makeGate().decide({
      ...input,
      carrier: { ...carrier, entrypoint: { entrypointKey: 'party.registry.api.other-read' } },
    })).outcome).toBe('DENIED');
  }),
);
