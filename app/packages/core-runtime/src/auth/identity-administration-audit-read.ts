import { DateTime, Effect, Option, Schema } from 'effect';

import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { ReadFinishContext, ReadLoadContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import {
  IdentityAdministrationAuditInputSchema,
  IdentityAdministrationAuditResultSchema,
} from './identity-administration-audit-contract.ts';
import { identityAdministrationAuditFromTransaction } from './identity-administration-audit-persistence.ts';
import { identityAdministrationAuditUnavailable } from './identity-administration-audit-unavailable.ts';

type Services = ReturnType<typeof identityAdministrationAuditFromTransaction>;
type Loaded = Effect.Success<ReturnType<Services['load']>>;
const load = (input: typeof IdentityAdministrationAuditInputSchema.Type, context: ReadLoadContext<Services>) =>
  context.services.load(input);
const finish = Effect.fn('IdentityAdministrationAudit.finish')(function* finish(
  _input: typeof IdentityAdministrationAuditInputSchema.Type,
  context: ReadFinishContext<undefined, Loaded>,
) {
  const result = yield* Schema.decodeUnknownEffect(Schema.toType(IdentityAdministrationAuditResultSchema))({
    entries: context.loaded.map((row) => ({
      ...row,
      actorName: Option.fromNullOr(row.actorName),
      occurredAt: DateTime.fromDateUnsafe(row.occurredAt),
    })),
  }).pipe(Effect.mapError(identityAdministrationAuditUnavailable));
  return { evidence: { resultCount: result.entries.length }, result };
});

/** Native admission and live admin permission precede the scoped factory and all audit/member/name SQL. */
export const identityAdministrationAuditRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'core.identity.identity-administration-audit',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.identity-administration-audit.access.v1',
    },
    inputSchema: IdentityAdministrationAuditInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.identity-administration-audit',
    resultSchema: Schema.toType(IdentityAdministrationAuditResultSchema),
    schemaVersion: '1',
  },
  { finish, load },
  (transaction) => Effect.succeed(identityAdministrationAuditFromTransaction(transaction)),
  () => ({
    kind: 'any_of',
    targets: [
      { kind: 'tenant', permission: 'manage_identity' },
      { kind: 'legal_entity', permission: 'manage_people' },
    ],
  }),
);
