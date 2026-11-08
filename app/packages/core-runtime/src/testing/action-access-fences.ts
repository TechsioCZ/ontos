import { Effect, Option, Schema } from 'effect';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { AccessScopeIdSchema, LegalEntityIdSchema, TenantIdSchema } from '../access/ids.ts';

/** Explicit test database rows, not a gate verdict or a prepared-authority token. */
const FenceRowSchema = Schema.Struct({
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  scopeId: AccessScopeIdSchema,
  state: Schema.Literals(['Changing', 'Ready']),
  tenantId: TenantIdSchema,
});
export type ActionTestAccessFenceRow = typeof FenceRowSchema.Encoded;
const RowsSchema = Schema.Array(FenceRowSchema);
const tenantCondition = '("core"."access_scopes"."tenant_id" = $1)';
const tenantScope = '("core"."access_scopes"."legal_entity_id" is null)';
const companyScope = '("core"."access_scopes"."legal_entity_id" = $2)';
const scopeSelect = 'select "scope_id" from "core"."access_scopes" where ';
const revisionSelect =
  'select "core"."access_scope_fences"."revision", "core"."access_scopes"."scope_id", "core"."access_scope_fences"."state" from "core"."access_scopes" inner join "core"."access_scope_fences" on (("core"."access_scope_fences"."tenant_id" = "core"."access_scopes"."tenant_id") and ("core"."access_scope_fences"."scope_id" = "core"."access_scopes"."scope_id")) where ';
const readScopeTenant = `${scopeSelect}(${tenantCondition} and (${tenantScope}))`;
const readScopeCompany = `${scopeSelect}(${tenantCondition} and ${companyScope})`;
const readRevisionTenant = `${revisionSelect}(${tenantCondition} and ((${tenantScope})))`;
const readRevisionCompany = `${revisionSelect}(${tenantCondition} and (((${tenantScope}) or ${companyScope})))`;
const lockFence = 'select trust.lock_access_scope_fence($1::uuid, $2::uuid) as state';
const supported = new Set([readScopeTenant, readScopeCompany, readRevisionTenant, readRevisionCompany, lockFence]);
const strings = Schema.Array(Schema.String);
const unavailable = (cause: unknown) => new SqlError({ reason: new ConnectionError({ cause }) });

export interface ActionTestAccessFenceQuery {
  readonly params: readonly unknown[];
  readonly scope: { readonly legalEntityId: string; readonly tenantId: string };
  readonly sql: string;
}

/**
 * A shared scripted database table for canonical gate fixtures and the Action driver's joined
 * recheck. It recognizes only the shipped fence statements. It cannot script owner SQL.
 */
export class ActionTestAccessFences {
  readonly #rows: readonly (typeof FenceRowSchema.Type)[];

  private constructor(rows: readonly (typeof FenceRowSchema.Type)[]) {
    this.#rows = rows;
    Object.freeze(this);
  }

  static make(rows: readonly ActionTestAccessFenceRow[]) {
    return Schema.decodeEffect(RowsSchema)(rows).pipe(
      Effect.map((decoded) => new ActionTestAccessFences(decoded.map((row) => Object.freeze({ ...row })))),
    );
  }

  read(query: ActionTestAccessFenceQuery): Option.Option<Effect.Effect<readonly object[], SqlError>> {
    const statement = query.sql.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
    if (!supported.has(statement)) {
      return Option.none();
    }
    return Option.some(
      Schema.decodeUnknownEffect(strings)(query.params).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((params) => this.#readStatement({ ...query, params, sql: statement })),
      ),
    );
  }

  #readStatement(
    query: ActionTestAccessFenceQuery & { readonly params: readonly string[] },
  ): Effect.Effect<readonly object[], SqlError> {
    const [tenantId, selected] = query.params;
    if (
      tenantId !== query.scope.tenantId ||
      (query.params.length !== 1 && query.params.length !== 2) ||
      (query.sql !== lockFence && selected !== undefined && selected !== query.scope.legalEntityId)
    ) {
      return Effect.fail(unavailable('The fixture fence query does not match the installed native scope'));
    }
    const rows = this.#rows.filter((row) => row.tenantId === tenantId);
    if (query.sql === lockFence) {
      const row = rows.find(
        (candidate) =>
          candidate.scopeId === selected &&
          (candidate.legalEntityId === undefined || candidate.legalEntityId === query.scope.legalEntityId),
      );
      return Effect.succeed(row === undefined ? [] : [{ state: row.state }]);
    }
    if (query.sql === readRevisionTenant || query.sql === readRevisionCompany) {
      return Effect.succeed(
        rows
          .filter((row) => row.legalEntityId === undefined || row.legalEntityId === selected)
          .map((row) => ({ revision: row.revision, scopeId: row.scopeId, state: row.state })),
      );
    }
    return Effect.succeed(
      rows.filter((row) => row.legalEntityId === selected).map((row) => ({ scopeId: row.scopeId })),
    );
  }
}

export const makeActionTestAccessFences = (rows: readonly ActionTestAccessFenceRow[]) =>
  ActionTestAccessFences.make(rows);
