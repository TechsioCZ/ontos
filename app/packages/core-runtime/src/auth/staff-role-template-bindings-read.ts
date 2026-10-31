import { and, eq, inArray } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { principalAuthBindings, principalCompanyMemberships, principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { PrincipalRefSchema } from '../permissions/principal-ref.ts';
import type { ReadLoadContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import {
  StaffRoleTemplateAccountProvider,
  StaffRoleTemplateAccountsSchema,
  StaffRoleTemplateEmailSchema,
  StaffRoleTemplateEmailsSchema,
} from './staff-role-template-account-provider.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from './staff-authentication-namespace.ts';
import { staffRoleTemplateUnavailable } from './staff-role-template-unavailable.ts';

export const StaffRoleTemplateBindingsInputSchema = Schema.Struct({ emails: StaffRoleTemplateEmailsSchema });
export const StaffRoleTemplateBindingsResultSchema = Schema.Struct({
  bindings: Schema.Array(
    Schema.Struct({ email: StaffRoleTemplateEmailSchema, principalId: PrincipalRefSchema.fields.principalId }),
  ).check(Schema.isMaxLength(6)),
});

/** Runs only after native admission/authorization, before Core opens its scoped transaction. */
const prepare = Effect.fn('StaffRoleTemplateBindings.prepare')(function* prepare(
  input: typeof StaffRoleTemplateBindingsInputSchema.Type,
) {
  const requestedEmails = new Set(input.emails);
  const emails = [...requestedEmails];
  const accounts = yield* (yield* StaffRoleTemplateAccountProvider)
    .lookup(emails)
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StaffRoleTemplateAccountsSchema)),
      Effect.mapError(staffRoleTemplateUnavailable),
    );
  if (
    accounts.some((account) => !requestedEmails.has(account.email)) ||
    new Set(accounts.map((account) => account.email)).size !== accounts.length ||
    new Set(accounts.map((account) => account.providerSubjectId)).size !== accounts.length
  ) {
    return yield* staffRoleTemplateUnavailable('The staff account directory returned inconsistent identities');
  }
  return accounts;
});

type Prepared = Effect.Success<ReturnType<typeof prepare>>;

/** Core owns all binding/principal SQL, scoped to the exact selected company's active native membership. */
const bindingsFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  load: Effect.fn('StaffRoleTemplateBindings.load')(function* load(accounts: Prepared) {
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined) {
      return yield* staffRoleTemplateUnavailable('An exact company context is required');
    }
    if (accounts.length === 0) {
      return { bindings: [] };
    }
    const rows = yield* transaction
      .select({ principalId: principals.principalId, providerSubjectId: principalAuthBindings.providerSubjectId })
      .from(principalAuthBindings)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, principalAuthBindings.tenantId),
          eq(principals.principalId, principalAuthBindings.principalId),
          eq(principals.kind, 'human'),
          eq(principals.status, 'active'),
        ),
      )
      .innerJoin(
        principalCompanyMemberships,
        and(
          eq(principalCompanyMemberships.tenantId, principals.tenantId),
          eq(principalCompanyMemberships.principalId, principals.principalId),
          eq(principalCompanyMemberships.legalEntityId, legalEntityId),
          eq(principalCompanyMemberships.status, 'active'),
        ),
      )
      .where(
        and(
          eq(principalAuthBindings.tenantId, tenantId),
          eq(principalAuthBindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
          eq(principalAuthBindings.provider, 'better-auth'),
          eq(principalAuthBindings.subjectType, 'user'),
          eq(principalAuthBindings.status, 'active'),
          inArray(
            principalAuthBindings.providerSubjectId,
            accounts.map((account) => account.providerSubjectId),
          ),
        ),
      )
      .pipe(Effect.mapError(staffRoleTemplateUnavailable));
    const bySubject = new Map(rows.map((row) => [row.providerSubjectId, row.principalId]));
    if (bySubject.size !== rows.length) {
      return yield* staffRoleTemplateUnavailable('A staff account has ambiguous principal bindings');
    }
    return {
      bindings: accounts.flatMap(({ email, providerSubjectId }) => {
        const principalId = bySubject.get(providerSubjectId);
        return principalId === undefined ? [] : [{ email, principalId }];
      }),
    };
  }),
});
type Services = ReturnType<typeof bindingsFromTransaction>;
const load = (_input: typeof StaffRoleTemplateBindingsInputSchema.Type, context: ReadLoadContext<Services, Prepared>) =>
  context.services
    .load(context.prepared)
    .pipe(Effect.map((result) => ({ evidence: { resultCount: result.bindings.length }, result })));

export const staffRoleTemplateBindingsRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'core.identity.staff-role-template-bindings',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.staff-role-template-bindings.access.v1' },
    inputSchema: StaffRoleTemplateBindingsInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.staff-role-template-bindings',
    resultSchema: StaffRoleTemplateBindingsResultSchema,
    schemaVersion: '1',
  },
  { load, prepare },
  (transaction) => Effect.succeed(bindingsFromTransaction(transaction)),
  () => ({
    kind: 'any_of',
    targets: [
      { kind: 'tenant', permission: 'manage_identity' },
      { kind: 'legal_entity', permission: 'manage_people' },
    ],
  }),
);
