import { DateTime, Effect, Option, Schema } from 'effect';

import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { ReadFinishContext, ReadLoadContext, ReadPrepareContext } from '../reads/context.ts';
import { requireAgentAdministration } from './agent-administration.ts';
import { defineRead } from '../reads/definition.ts';
import {
  IdentityAdministrationAuditInputSchema,
  IdentityAdministrationAuditResultSchema,
} from './identity-administration-audit-contract.ts';
import { identityAdministrationAuditFromTransaction } from './identity-administration-audit-persistence.ts';
import { identityAdministrationAuditUnavailable } from './identity-administration-audit-unavailable.ts';

/** The agent administration audit is read by exactly the company's agent administrators (O81). */
const prepare = Effect.fn('IdentityAdministrationAudit.prepare')(function* prepare(
  _input: typeof IdentityAdministrationAuditInputSchema.Type,
  context: ReadPrepareContext,
) {
  yield* requireAgentAdministration(context.scope);
});

type Services = ReturnType<typeof identityAdministrationAuditFromTransaction>;
type Loaded = Effect.Success<ReturnType<Services['load']>>;
const load = (input: typeof IdentityAdministrationAuditInputSchema.Type, context: ReadLoadContext<Services, void>) =>
  context.services.load(input);
const finish = Effect.fn('IdentityAdministrationAudit.finish')(function* finish(
  _input: typeof IdentityAdministrationAuditInputSchema.Type,
  context: ReadFinishContext<void, Loaded>,
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
    permissionTarget: 'legal_entity',
    policies: [],
    readKey: 'core.identity.identity-administration-audit',
    resultSchema: Schema.toType(IdentityAdministrationAuditResultSchema),
    schemaVersion: '1',
  },
  { finish, load, prepare },
  (transaction) => Effect.succeed(identityAdministrationAuditFromTransaction(transaction)),
  // Admitted by authentication in the gate-decided company scope; `prepare` asks the read's own v2 question. No legacy
  // relation is asked: `manage_identity` / `manage_people` are not v2 intent, and the v2 schema defines no
  // `legal_entity#manage_people`, so asking it was unavailable (503) on every v2 tenant.
  () => ({ kind: 'legal_entity' }),
);
