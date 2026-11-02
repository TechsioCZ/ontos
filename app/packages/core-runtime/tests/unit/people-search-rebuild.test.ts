import { coreActionCatalog, coreActionMcpCatalog } from '../../src/modules/actions/catalog.ts';
import { Effect, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { createActionCollector } from '../../src/actions/collector.ts';
import { getActionHandler } from '../../src/actions/definition.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { expect, it } from 'effect-rstest';
import { requestPeopleSearchRebuildAction } from '../../src/modules/actions/request-people-search-rebuild.action.ts';
import { OutboxPayloadSchema } from '../../src/outbox/core-identity-people-search-rebuild-requested-v1.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

it('rebuild is an explicit audited tenant-only Action, not a direct search or SQL mutation endpoint', () => {
  const { descriptor } = requestPeopleSearchRebuildAction;
  expect(descriptor.entrypoint).toMatchObject({
    authorization: { kind: 'action_execution', provisioning: 'explicit' },
    moduleKey: 'core.identity',
    scope: 'system',
  });
  expect(descriptor.legalEntityScope).toBe('forbidden');
  expect(descriptor.idempotency).toBe('required');
  expect(descriptor.tenantPermission?.({ reason: 'Repair projection' })).toBe('manage_identity');
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
it('people row access inherits the same tenant OR company directory permission without reader/accessor grants', () => {
  expect(ONTOS_SPICEDB_SCHEMA).toContain('relation people_company: legal_entity');
  expect(ONTOS_SPICEDB_SCHEMA).toContain('relation people_tenant: tenant');
  expect(ONTOS_SPICEDB_SCHEMA).toContain(
    '((people_company->read_people + people_tenant->read_people) & people_company->access)',
  );
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
