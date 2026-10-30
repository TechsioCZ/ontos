import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { Effect, Match, Option, Schema } from 'effect';

import { principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import {
  ScopedRoleMembershipRoleSchema,
  ScopedRoleScopeSchema,
} from '../outbox/core-identity-scoped-role-membership-changed-v1.ts';
import { fullyConsistent } from '../permissions/client.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { fromScopedRoleObjectId } from '../permissions/scoped-role.ts';
import { openSpiceDbRpc } from '../permissions/spicedb-transaction-guard.ts';
import type { ReadFinishContext, ReadLoadContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';

/** Presentation only. These names never grant access; the live graph owns the catalog and all permissions. */
const namedRolePresentation = (
  roleKey: string,
): Option.Option<{ readonly description: string; readonly name: string }> =>
  Match.value(roleKey)
    .pipe(
      Match.when('admin', () =>
        Option.some({ description: 'Správa vybrané firmy, jejích lidí a rolí.', name: 'Správce firmy' }),
      ),
      Match.when('superadmin', () =>
        Option.some({ description: 'Správa všech firem a lidí v celém prostředí.', name: 'Správce celé organizace' }),
      ),
      Match.when('auditor', () =>
        Option.some({ description: 'Nahlížení do údajů bez možnosti změn.', name: 'Auditor' }),
      ),
      Match.when('sales-leadership', () =>
        Option.some({
          description: 'Vedení obchodu, obchodních případů a související agendy firmy.',
          name: 'Vedoucí obchodu',
        }),
      ),
      Match.when('sales', () =>
        Option.some({
          description: 'Práce se zákazníky, obchodními případy a vlastními úkoly.',
          name: 'Obchodník',
        }),
      ),
      Match.when('accounting', () =>
        Option.some({ description: 'Účetní agenda a související podklady firmy.', name: 'Účetní' }),
      ),
      Match.when('warehouse', () => Option.some({ description: 'Správa zboží a skladových úkolů.', name: 'Skladník' })),
      Match.when('crm-administration', () =>
        Option.some({
          description: 'Správa zákazníků, obchodního týmu a souvisejících údajů.',
          name: 'Správa obchodu',
        }),
      ),
      Match.when('crm-leadership', () =>
        Option.some({
          description: 'Přehled všech klientů a jejich přidělování obchodníkům.',
          name: 'Vedoucí obchodu',
        }),
      ),
      Match.when('crm-sales', () =>
        Option.some({ description: 'Práce s přidělenými klienty a obchodními úkoly.', name: 'Obchodník' }),
      ),
      Match.when('eshop-administration', () =>
        Option.some({ description: 'Správa zboží a související agendy e-shopu firmy.', name: 'Správa e-shopu' }),
      ),
      Match.when('fulfilment', () =>
        Option.some({ description: 'Práce se zbožím a expedicí objednávek.', name: 'Expedice' }),
      ),
      Match.when('management', () =>
        Option.some({ description: 'Vedení pronájmů, provozu a přidělování klientů.', name: 'Vedení' }),
      ),
      Match.when('operations', () =>
        Option.some({ description: 'Každodenní agenda pronájmů a provozu.', name: 'Provoz' }),
      ),
      Match.when('rental-accounting', () =>
        Option.some({ description: 'Účetní podklady pronájmů a provozu.', name: 'Účetní pronájmů' }),
      ),
    )
    .pipe(
      Match.when('external-business', () =>
        Option.some({
          description: 'Přidělení klienti, obchodní případy a provozní přehled.',
          name: 'Externí obchodník',
        }),
      ),
      Match.when('development-administration', () =>
        Option.some({ description: 'Správa samostatného vývojového prostředí.', name: 'Správa vývoje' }),
      ),
      Match.when('connection-verification', () =>
        Option.some({
          description: 'Ověření dostupnosti úkolů ve zkušebním prostředí.',
          name: 'Ověření připojení',
        }),
      ),
      Match.when('account-administration', () =>
        Option.some({
          description: 'Doplňková správa členství a rolí v přiděleném rozsahu.',
          name: 'Správa účtů',
        }),
      ),
      Match.when('assigned-task-reader', () =>
        Option.some({
          description: 'Přístup k přiděleným úkolům bez přehledu cizích úkolů.',
          name: 'Vlastní úkoly',
        }),
      ),
      Match.when('operational-repair-external', () =>
        Option.some({ description: 'Doplňkový přístup k přidělené provozní agendě.', name: 'Provoz – operativa' }),
      ),
      Match.when('crm-repair-management', () =>
        Option.some({
          description: 'Doplňkový přístup k řízení klientů a obchodních případů.',
          name: 'Obchod – vedení',
        }),
      ),
      Match.when('operations-execution', () =>
        Option.some({
          description: 'Provedení přidělených provozních změn v souvisejících agendách.',
          name: 'Provoz – operativa',
        }),
      ),
      Match.when('rental-sales-execution', () =>
        Option.some({ description: 'Provedení obchodních změn v agendě nájmů.', name: 'Obchodník – nájmy' }),
      ),
      Match.when('crm-repair-external', () =>
        Option.some({
          description: 'Doplňkový přístup k přiděleným klientům a případům.',
          name: 'Obchod – přidělení klienti',
        }),
      ),
      Match.orElse(() => Option.none()),
    );

export const RoleCatalogResultSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      name: Schema.String,
      roleKey: ScopedRoleMembershipRoleSchema.fields.roleKey,
      scope: ScopedRoleScopeSchema,
    }),
  ),
});
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Role catalog is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );
const services = (transaction: ScopedTransactionExecutor) => ({
  load: () =>
    transaction
      .select({ displayName: principals.displayName, kind: principals.kind, principalId: principals.principalId })
      .from(principals)
      .where(and(eq(principals.tenantId, transaction.scope.tenantId), eq(principals.kind, 'agent')))
      .pipe(Effect.mapError(unavailable)),
});

export const roleCatalogRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'core.identity.role-catalog',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.role-catalog.access.v1' },
    inputSchema: Schema.Struct({}),
    legalEntityScope: 'optional',
    owningModuleKey: 'core.identity',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.role-catalog',
    resultSchema: RoleCatalogResultSchema,
    schemaVersion: '1',
  },
  {
    finish: (
      _input,
      context: ReadFinishContext<undefined, Effect.Success<ReturnType<ReturnType<typeof services>['load']>>>,
    ) =>
      Effect.scoped(
        Effect.gen(function* finishRoleCatalog() {
          const config = yield* loadSpiceDbConfig();
          const client = yield* Effect.acquireRelease(
            Effect.try({ catch: unavailable, try: () => openSpiceDbRpc(config, 5000) }),
            (rpc) => Effect.sync(rpc.close),
          );
          // Keep roles discoverable after the last member is removed: enumerate capability usersets,
          // not the people page (which is paginated and is not a role catalog).
          const pages = yield* Effect.forEach(
            ['tenant', 'legal_entity', 'module_access', 'action', 'action_grant', 'context_permission'],
            (resourceType) =>
              client.readRelationships(
                v1.ReadRelationshipsRequest.create({
                  consistency: fullyConsistent,
                  relationshipFilter: { optionalSubjectFilter: { subjectType: 'scoped_role' }, resourceType },
                }),
              ),
            { concurrency: 2 },
          );
          const ids = new Set(
            pages
              .flat()
              .flatMap(({ relationship }) =>
                relationship?.subject?.object?.objectId === undefined ? [] : [relationship.subject.object.objectId],
              ),
          );
          const items = [];
          for (const id of ids) {
            const parsed = fromScopedRoleObjectId(id);
            if (Option.isNone(parsed)) {
              return yield* unavailable('Malformed role identity');
            }
            const role = parsed.value;
            if (role.tenantId !== context.scope.tenantId || role.legalEntityId !== context.scope.legalEntityId) {
              continue;
            }
            const agent = context.loaded.find((row) => role.roleKey === `agent:${row.principalId}`);
            const presentation =
              agent === undefined
                ? namedRolePresentation(role.roleKey)
                : Option.some({
                    description: 'Oprávnění nastavená pro tohoto agenta.',
                    name: `Profil agenta – ${agent.displayName}`,
                  });
            // Technical workloads are not assignable people profiles.
            if (Option.isSome(presentation)) {
              items.push({
                ...presentation.value,
                roleKey: role.roleKey,
                scope:
                  role.legalEntityId === undefined
                    ? { _tag: 'tenant' as const }
                    : { _tag: 'company' as const, legalEntityId: role.legalEntityId },
              });
            }
          }
          items.sort((left, right) => left.name.localeCompare(right.name, 'cs'));
          return { evidence: { resultCount: items.length }, result: { items } };
        }),
      ).pipe(Effect.mapError(unavailable)),
    load: (_input, context: ReadLoadContext<ReturnType<typeof services>>) => context.services.load(),
  },
  (transaction) => Effect.succeed(services(transaction)),
  (_input, scope) =>
    scope.legalEntityId === undefined
      ? { kind: 'tenant', permission: 'read_people' }
      : {
          kind: 'any_of',
          targets: [
            { kind: 'tenant', permission: 'read_people' },
            { kind: 'legal_entity', legalEntityId: scope.legalEntityId, permission: 'read_people' },
          ],
        },
);
