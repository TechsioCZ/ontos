import { Effect, Schema } from 'effect';
import { RecordKeySchema } from '../../src/access/ids.ts';
import { defineAction, defineActionAccessTargets } from '../../src/actions/definition.ts';
import { defineActionGoverningRead } from '../../src/actions/governing-read.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineRead } from '../../src/reads/definition.ts';

export const ownerKey = 'demo.governing-read';
export const readFor = (owner = ownerKey, recordScoped = true) =>
  defineRead(
    {
      accessDeclaration: {
        key: `${owner}.record.read`,
        kind: 'read',
        modes: ['run'],
        placement: { group: 'records', level: 'basic' },
        risk: 'sensitive',
        selectors: recordScoped ? ['all'] : [],
      },
      accessFieldGroups: [
        {
          fieldClass: 'salaries',
          fields: ['salary'],
          key: `${owner}.record.read-salary`,
          kind: 'field_read',
          modes: ['run'],
          placement: { group: 'records', level: 'extended' },
          risk: 'sensitive',
          selectors: [],
        },
      ],
      accessKind: 'list',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'protected' },
        entrypointKey: `${owner}.api.records`,
        moduleKey: owner,
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: `${owner}.records.evidence.v1` },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'required',
      owningModuleKey: owner,
      policies: [],
      readKey: `${owner}.api.records`,
      resultSchema: Schema.Struct({ salary: Schema.optionalKey(Schema.Number) }),
      schemaVersion: '1',
    },
    () => Effect.die('An Action governing Read reference must never execute the Read'),
    () => Effect.succeed(Object.freeze({})),
  );
const payloadSchema = Schema.Struct({ ids: Schema.Array(RecordKeySchema), salary: Schema.optionalKey(Schema.Number) });
export const actionFor = (read = readFor()) =>
  defineAction(
    {
      accessDeclaration: {
        key: `${ownerKey}.record.change`,
        kind: 'action',
        modes: ['run', 'propose', 'approve'],
        placement: { group: 'records', level: 'basic' },
        risk: 'sensitive',
        selectors: ['all'],
      },
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${ownerKey}.change.evidence.v1` },
      accessFieldGroups: [
        {
          fieldClass: 'salaries',
          fields: ['salary'],
          key: `${ownerKey}.record.write-salary`,
          kind: 'field_write',
          modes: ['run', 'propose', 'approve'],
          placement: { group: 'records', level: 'extended' },
          risk: 'sensitive',
          selectors: [],
        },
      ],
      accessGoverningRead: defineActionGoverningRead(read),
      accessTargets: defineActionAccessTargets<typeof payloadSchema.Type>((payload) =>
        payload.ids.map((recordKey) => ({ moduleKey: ownerKey, recordKey })),
      ),
      actionKey: `${ownerKey}.change`,
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: `${ownerKey}.change`,
        moduleKey: ownerKey,
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: ownerKey,
      payloadSchema,
      policies: [],
      resultSchema: Schema.Number,
      schemaVersion: '1',
    },
    (payload) => Effect.succeed(payload.ids.length),
  );
export const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:governing-read',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
