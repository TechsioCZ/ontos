import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { auditEvents } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { ContextAccess } from '../permissions/context-access.ts';
import type { ReadLoadContext, ReadPrepareContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';
import {
  OAuthGrantOwners,
  OAuthGrantOwnerSchema,
  ownedOAuthRevocationGrantIds,
  retainedOAuthRevocationGrantOwners,
} from './oauth-grant-owners.ts';

export const OAuthConnectionRevocationNotesInputSchema = Schema.Struct({
  grantIds: Schema.Array(OAuthGrantOwnerSchema.fields.grantId).check(Schema.isMaxLength(500)),
});
export const OAuthConnectionRevocationNotesResultSchema = Schema.Struct({
  notes: Schema.Array(Schema.Struct({ grantId: OAuthGrantOwnerSchema.fields.grantId, note: Schema.String })),
});
const noteEvidence = Schema.Struct({ note: Schema.String });
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'OAuth revocation notes are temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

/** Input must be newest-first. Keep the newest nonblank note, including historical evidence without user identity. */
export const latestOAuthRevocationNotes = (
  rows: readonly { readonly evidence: unknown; readonly grantId: string }[],
) => {
  const notes = new Map<string, string>();
  for (const row of rows) {
    const evidence = Schema.decodeUnknownOption(noteEvidence)(row.evidence);
    if (Option.isSome(evidence) && !notes.has(row.grantId) && evidence.value.note.trim() !== '') {
      notes.set(row.grantId, evidence.value.note.trim());
    }
  }
  return [...notes].map(([grantId, note]) => ({ grantId, note }));
};

const prepare = Effect.fn('OAuthConnectionRevocationNotes.prepare')(function* prepare(
  input: typeof OAuthConnectionRevocationNotesInputSchema.Type,
  context: ReadPrepareContext,
) {
  const { legalEntityId, principalId, tenantId } = context.scope;
  if (legalEntityId === undefined) {
    return yield* unavailable('An exact company is required');
  }
  if (input.grantIds.length === 0) {
    return [];
  }
  // Auth's own producer runs here, before Core opens its audit SQL transaction.
  const owners = yield* (yield* OAuthGrantOwners)
    .owners({ ...input, legalEntityId, tenantId })
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.Array(OAuthGrantOwnerSchema))), Effect.mapError(unavailable));
  const query = { ...input, legalEntityId, principalId, tenantId };
  const ownIds = ownedOAuthRevocationGrantIds(query, owners);
  const candidateIds = retainedOAuthRevocationGrantOwners(query, owners).map((owner) => owner.grantId);
  if (ownIds.length === candidateIds.length) {
    return ownIds;
  }
  // Same live administrator semantics as connection management; membership alone is insufficient.
  const access = yield* ContextAccess;
  const [tenant, company] = yield* Effect.all(
    [
      access.tenants({ permission: 'manage_identity', principalId, tenantIds: [tenantId] }),
      access.legalEntities({ legalEntityIds: [legalEntityId], permission: 'manage_people', principalId, tenantId }),
    ],
    { concurrency: 2 },
  );
  const decisions = [...tenant, ...company];
  if (decisions.some((decision) => decision.decision === 'allowed')) {
    return candidateIds;
  }
  if (decisions.some((decision) => decision.decision === 'unavailable')) {
    return yield* unavailable('Administrator authorization is unavailable');
  }
  return ownIds;
});

const notesFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  load: Effect.fn('OAuthConnectionRevocationNotes.loadRows')(function* load(grantIds: readonly string[]) {
    if (grantIds.length === 0) {
      return [];
    }
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined) {
      return yield* unavailable('An exact company is required');
    }
    const grantId = sql<string>`${auditEvents.evidenceJson} ->> 'grantId'`;
    const rows = yield* transaction
      .select({ evidence: auditEvents.evidenceJson, grantId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.legalEntityId, legalEntityId),
          eq(auditEvents.eventType, 'oauth.connection.revoked'),
          inArray(grantId, [...grantIds]),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.auditEventId))
      .pipe(Effect.mapError(unavailable));
    return latestOAuthRevocationNotes(rows);
  }),
});
type Services = ReturnType<typeof notesFromTransaction>;
const load = Effect.fn('OAuthConnectionRevocationNotes.load')(function* load(
  _input: typeof OAuthConnectionRevocationNotesInputSchema.Type,
  context: ReadLoadContext<Services, readonly string[]>,
) {
  const notes = yield* context.services.load(context.prepared);
  return { evidence: { resultCount: notes.length }, result: { notes } };
});

/** Core revalidates the original caller and selected company; prepare then narrows by real ownership or admin rights. */
export const oauthConnectionRevocationNotesRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'core.identity.oauth-connection-revocation-notes',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.oauth-connection-revocation-notes.access.v1',
    },
    inputSchema: OAuthConnectionRevocationNotesInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    permissionTarget: 'legal_entity',
    policies: [],
    readKey: 'core.identity.oauth-connection-revocation-notes',
    resultSchema: OAuthConnectionRevocationNotesResultSchema,
    schemaVersion: '1',
  },
  { load, prepare },
  (transaction) => Effect.succeed(notesFromTransaction(transaction)),
  () => ({ kind: 'legal_entity' }),
);
