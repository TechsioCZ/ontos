import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AccessScopeIdSchema, RoleIdSchema, RoleRevisionIdSchema } from '../../src/access/ids.ts';
import { makeTenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { capability, person, principalHolder, tenant } from './access-decision-support.ts';

/*
 * A full-access preset holds a cell for every capability of the catalogue. A cell read asks about a few of them, so
 * it must read only those: the revision rows come back with just the asked capabilities' cells, and the read costs
 * the same however many rights the preset holds.
 */

const scope: OperationalScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:asked-cells',
    authMethod: 'session',
    principalId: person,
    tenantId: tenant,
  }),
  correlationId: 'asked-cells',
});
const scopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000003');
const roleId = RoleIdSchema.make('00000000-0000-4000-8000-000000000007');
const roleRevisionId = RoleRevisionIdSchema.make('00000000-0000-4000-8000-000000000008');

/** One active assignment of the person; the revision statement is kept, every other statement answers no rows. */
const scripted =
  (revisionReads: { readonly params: readonly unknown[]; readonly statement: string }[]) =>
  (statement: string, params: readonly unknown[]): Effect.Effect<readonly object[]> => {
    if (statement.includes('current_user')) {
      return Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenant }]);
    }
    if (statement.includes('"access_role_revisions"')) {
      revisionReads.push({ params, statement });
      return Effect.succeed([]);
    }
    if (statement.includes('"access_assignments"')) {
      // The columns in the loader's select order.
      return Effect.succeed([
        {
          agentId: null,
          assignedBy: person,
          delegatedBy: null,
          delegationEnvelopeJson: null,
          incarnationId: '00000000-0000-4000-8000-000000000009',
          principalId: person,
          roleId,
          roleRevisionId,
          scopeId,
          status: 'active',
          tenantId: tenant,
          validFrom: '2026-01-01T00:00:00.000Z',
          validUntil: null,
        },
      ]);
    }
    return Effect.succeed([]);
  };

it.effect("reads only the asked capabilities' cells of a held revision, never the whole preset", () =>
  Effect.gen(function* askedCellsOnly() {
    const revisionReads: { readonly params: readonly unknown[]; readonly statement: string }[] = [];
    const executor = yield* makeTestDatabase(scripted(revisionReads));
    const loader = makeTenantIntentLoader({ enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor });
    const asked = capability('finance.invoice.void');
    yield* loader.loadAuthorityCellsMany(scope, [
      { capabilityKey: asked, holder: principalHolder(), mode: 'run', scopeId, tenantId: tenant },
    ]);
    expect(revisionReads).toHaveLength(1);
    const [read] = revisionReads;
    // The cells are narrowed in the statement itself, by the asked capability and mode.
    expect(read?.statement).toMatch(/jsonb_array_elements\("cells_json"\)/u);
    expect(read?.params).toContain(asked);
    expect(read?.params).toContain('run');
  }),
);
