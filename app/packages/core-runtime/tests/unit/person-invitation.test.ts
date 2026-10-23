import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { createActionCollector } from '../../src/actions/collector.ts';
import {
  InvitePersonAuditEvidenceSchema,
  InvitePersonPayloadSchema,
  InvitePersonResultSchema,
} from '../../src/auth/person-invitation.ts';
import { personInvitations } from '../../src/db/schema.ts';
import { coreActionCatalog } from '../../src/modules/actions/catalog.ts';
import { invitePersonAction } from '../../src/modules/actions/invite-person.action.ts';
import { principalLifecycleDomainEvents } from '../../src/modules/actions/principal-lifecycle-event.ts';

const invitationId = '74000000-0000-4000-8000-000000000001';
const tenantId = '71000000-0000-4000-8000-000000000001';
const legalEntityId = '72000000-0000-4000-8000-000000000001';
const principalRef = { principalId: '73000000-0000-4000-8000-000000000001', tenantId };
const payload = { affiliation: 'external', displayName: 'Invited person', email: 'person@example.org' };

it.effect(
  'requires an explicit e-mail, display name and human affiliation, with no client scope, credentials or roles',
  () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(InvitePersonPayloadSchema, { onExcessProperty: 'error' });
      expect(decode(payload)).toEqual(payload);
      for (const invalid of [
        { ...payload, affiliation: null },
        { ...payload, affiliation: 'agent' },
        { ...payload, displayName: '  ' },
        { ...payload, email: 'not-an-email' },
        { ...payload, email: 'x'.repeat(255) },
        { ...payload, legalEntityId },
        { ...payload, tenantId },
        { ...payload, principalRef },
        { ...payload, password: 'not-an-invitation' },
        { ...payload, roles: ['superadmin'] },
      ]) {
        expect(() => decode(invalid)).toThrow();
      }
    }),
);

it.effect('returns only durable pending invitation identity and the explicit invited company membership', () =>
  Effect.sync(() => {
    const wire = {
      delivery: 'pending',
      invitationId,
      membership: { affiliation: 'external', legalEntityId, principalRef, revision: 1, status: 'invited' },
      principalRef,
    };
    const decoded = Schema.decodeUnknownSync(InvitePersonResultSchema)(wire);
    expect(decoded.membership.affiliation).toEqual(Option.some('external'));
    expect(Schema.encodeSync(InvitePersonResultSchema)(decoded)).toEqual(wire);
    expect(Object.keys(wire).toSorted()).toEqual(['delivery', 'invitationId', 'membership', 'principalRef']);
  }),
);

it.effect(
  'declares a sensitive exact company Action with required idempotency and no blanket tenant-member provisioning',
  () =>
    Effect.sync(() => {
      const { descriptor } = invitePersonAction;
      expect(descriptor.actionKey).toBe('core.identity.invite-person');
      expect(descriptor.legalEntityScope).toBe('required');
      expect(descriptor.auditProfile).toBe('sensitive');
      expect(descriptor.idempotency).toBe('required');
      expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
      expect(coreActionCatalog.filter((entry) => entry.actionKey === descriptor.actionKey)).toHaveLength(1);
    }),
);

it.effect('collects declared invitation audit evidence as JSON without any credential or token', () =>
  Effect.gen(function* auditInvitation() {
    const collector = createActionCollector(
      principalLifecycleDomainEvents,
      'core.identity',
      {
        captureMode: 'metadata_only',
        policyKey: 'invitation-contract-test',
      },
      InvitePersonAuditEvidenceSchema,
    );
    const evidence = {
      ...payload,
      invitationId,
      legalEntityId,
      membershipRevision: 1,
      membershipStatus: 'invited',
      principalRef,
    };
    yield* collector.recordAuditEvidence(evidence);
    expect(collector.snapshot().auditEvidence).toEqual(evidence);
    expect(Schema.is(Schema.Json)(collector.snapshot().auditEvidence)).toBe(true);
  }),
);

it.effect('keeps invitation intent immutable and RLS-bound to its exact selected company membership', () =>
  Effect.sync(() => {
    const config = getTableConfig(personInvitations);
    expect(config.enableRLS).toBe(true);
    expect(
      config.policies.map((policy) => policy.for).toSorted((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(['insert', 'select']);
    expect(config.columns.some((column) => /password|token|secret/iu.test(column.name))).toBe(false);
    const membership = config.foreignKeys.find((key) => key.getName() === 'core_person_invitations_membership_fk');
    expect(membership?.onDelete).toBe('restrict');
    expect(membership?.reference().columns.map((column) => column.name)).toEqual([
      'tenant_id',
      'legal_entity_id',
      'principal_id',
    ]);
    const dialect = new PgDialect();
    for (const policy of config.policies) {
      const predicate = policy.using ?? policy.withCheck;
      expect(predicate).toBeDefined();
      if (predicate === undefined) {
        expect.unreachable('Invitation policy requires its exact scope predicate');
      }
      const text = dialect.sqlToQuery(predicate).sql;
      expect(text).toContain('ontos.tenant_id');
      expect(text).toContain('ontos.legal_entity_id');
    }
  }),
);
