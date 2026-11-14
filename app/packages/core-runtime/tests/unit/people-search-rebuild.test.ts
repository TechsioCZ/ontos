import { coreActionCatalog, coreActionMcpCatalog } from '../../src/modules/actions/catalog.ts';
import { Effect, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { createActionCollector } from '../../src/actions/collector.ts';
import { getActionHandler } from '../../src/actions/definition.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { expect, it } from 'effect-rstest';
import { requestPeopleSearchRebuildAction } from '../../src/modules/actions/request-people-search-rebuild.action.ts';
import { peopleSearchRead } from '../../src/people/people-search.ts';
import { OutboxPayloadSchema } from '../../src/outbox/core-identity-people-search-rebuild-requested-v1.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

it('rebuild is an explicit audited tenant-only Action, not a direct search or SQL mutation endpoint', () => {
  const { descriptor } = requestPeopleSearchRebuildAction;
  expect(descriptor.entrypoint).toMatchObject({
    authorization: { kind: 'protected' },
    moduleKey: 'core.identity',
    scope: 'system',
  });
  // The v2 carrier is the Action's own declaration (O43): administration of the projection is a
  // human-only, run-only capability, and the gate decides it instead of a legacy provisioning mode.
  expect(descriptor.accessDeclaration).toMatchObject({
    key: 'core.identity.people-search.rebuild',
    kind: 'admin',
    modes: ['run'],
    risk: 'sensitive',
  });
  // O7, O67-Q3: `forbidden` legal-entity scope means the gate decides this Action in the tenant
  // context, so only the tenant's own identity administration may request a rebuild. The per-Action
  // legacy `tenantPermission` override is gone with the v1 engine, not shadowed by a second one.
  expect(descriptor.legalEntityScope).toBe('forbidden');
  expect(descriptor.idempotency).toBe('required');
  expect('tenantPermission' in descriptor).toBe(false);
  expect(Object.keys(descriptor.domainEvents)).toEqual(['core.identity.people-search-rebuild-requested.v1']);
  const decode = Schema.decodeUnknownSync(descriptor.payloadSchema, { onExcessProperty: 'error' });
  expect(decode({ reason: 'Repair projection' })).toEqual({ reason: 'Repair projection' });
  for (const payload of [
    {},
    { reason: ' ' },
    { reason: 'Repair', tenantId: 'foreign' },
    { legalEntityId: 'foreign', reason: 'Repair' },
  ]) {
    expect(() => decode(payload)).toThrow();
  }
  expect(
    Schema.decodeUnknownSync(OutboxPayloadSchema, { onExcessProperty: 'error' })({ data: { operation: 'rebuild' } }),
  ).toEqual({ data: { operation: 'rebuild' } });
  expect(() =>
    Schema.decodeUnknownSync(OutboxPayloadSchema, { onExcessProperty: 'error' })({ data: { tenantId: 'foreign' } }),
  ).toThrow();
});
it('people row access is decided by the v2 gate in the exact company scope, never by a broad grant', () => {
  // The v1 containment relations (`people_company`/`people_tenant` over `read_all`) are retired with
  // the legacy schema, so no broad allow role survives; the read's own declaration and the gate's
  // list predicate decide rows in the named company (O25, O28).
  expect(ONTOS_SPICEDB_SCHEMA).not.toContain('read_all');
  expect(ONTOS_SPICEDB_SCHEMA).not.toContain('write_all');
  expect(peopleSearchRead.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(peopleSearchRead.descriptor.legalEntityScope).toBe('required');
  expect(peopleSearchRead.descriptor.accessDeclaration).toMatchObject({
    key: 'core.identity.people-search.query',
    kind: 'read',
    modes: ['run'],
  });
});

it('the native Core Action catalog classifies rebuild as hidden, with no business MCP endpoint', () => {
  const key = requestPeopleSearchRebuildAction.descriptor.actionKey;
  expect(coreActionCatalog.some(({ actionKey }) => actionKey === key)).toBe(true);
  expect(coreActionMcpCatalog.find(({ actionKey }) => actionKey === key)).toMatchObject({ exposure: 'hidden' });
  expect(coreActionMcpCatalog.map(({ actionKey }) => actionKey)).toEqual(
    coreActionCatalog.map(({ actionKey }) => actionKey),
  );
});

it.layer(NodeCrypto.layer)('people rebuild collector', (suite) => {
  suite.effect('collects exactly one audited outbox wake-up atomically with the governed Action', () =>
    Effect.gen(function* requested() {
      const { descriptor } = requestPeopleSearchRebuildAction;
      const collector = createActionCollector(
        descriptor.domainEvents,
        descriptor.owningModuleKey,
        descriptor.accessEvidencePolicy,
        descriptor.auditEvidenceSchema,
        'a'.repeat(64),
      );
      const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:rebuild',
        authMethod: 'session',
        principalId: '30000000-0000-4000-8000-000000000001',
        tenantId: '10000000-0000-4000-8000-000000000001',
      });
      const result = yield* getActionHandler(requestPeopleSearchRebuildAction)(
        { reason: 'Repair projection' },
        {
          ...collector,
          actionInvocationId: '50000000-0000-4000-8000-000000000001',
          compositionRevision: 'a'.repeat(64),
          scope: { ...principal, correlationId: 'rebuild-test' },
          services: {},
        },
      );
      expect(result).toEqual({ status: 'requested' });
      const snapshot = collector.snapshot();
      expect(snapshot.auditEvidence).toEqual({ reason: 'Repair projection' });
      expect(snapshot.domainEvents).toHaveLength(1);
      expect(snapshot.outboxMessages).toHaveLength(1);
      expect(snapshot.domainEvents[0]).toMatchObject({
        eventType: 'core.identity.people-search-rebuild-requested.v1',
        producerModuleKey: 'core.identity',
        subjectResourceId: principal.tenantId,
      });
      expect(snapshot.outboxMessages[0]?.message).toMatchObject({
        payloadJson: { data: { operation: 'rebuild' } },
        producerModuleKey: 'core.identity',
        topic: 'core.identity.people-search-rebuild-requested.v1',
      });
    }),
  );
});
