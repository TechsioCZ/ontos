import { Effect, Schema } from 'effect';

import { SymmyRouteContextSchema, SymmyRouteRefSchema } from './identity.ts';
import type { SymmyRouteContext } from './identity.ts';

export const SymmyRouteSelectionSchema = Schema.Struct({
  integrationRouteId: SymmyRouteRefSchema.fields.integrationRouteId,
  mappingVersion: SymmyRouteContextSchema.fields.mappingVersion,
  routeRevision: SymmyRouteContextSchema.fields.routeRevision,
});

export class SymmyRouteRejected extends Schema.TaggedError<SymmyRouteRejected>()('SymmyRouteRejected', {
  reason: Schema.Literals([
    'route_missing',
    'route_ambiguous',
    'scope_mismatch',
    'route_revoked',
    'route_version_mismatch',
  ]),
}) {}

/** Select from current server registrations using verified scope and the server's expected revisions. */
export const selectSymmyRoute = Effect.fn('Symmy.selectRoute')(function* selectRoute(input: {
  readonly registrations: readonly { readonly context: SymmyRouteContext; readonly state: 'active' | 'revoked' }[];
  readonly selection: typeof SymmyRouteSelectionSchema.Type;
  readonly verifiedScope: Pick<SymmyRouteContext, 'principalId' | 'sellingLegalEntityId'> &
    Pick<SymmyRouteContext['route'], 'tenantId'>;
}) {
  const { registrations, selection, verifiedScope } = input;
  const candidates = registrations.filter(
    ({ context }) =>
      context.route.tenantId === verifiedScope.tenantId &&
      context.route.integrationRouteId === selection.integrationRouteId,
  );
  const [candidate] = candidates;
  if (candidate === undefined) {
    return yield* new SymmyRouteRejected({ reason: 'route_missing' });
  }
  if (candidates.length > 1) {
    return yield* new SymmyRouteRejected({ reason: 'route_ambiguous' });
  }

  const { context, state } = candidate;
  if (
    context.principalId !== verifiedScope.principalId ||
    context.sellingLegalEntityId !== verifiedScope.sellingLegalEntityId
  ) {
    return yield* new SymmyRouteRejected({ reason: 'scope_mismatch' });
  }
  if (state !== 'active') {
    return yield* new SymmyRouteRejected({ reason: 'route_revoked' });
  }
  if (context.routeRevision !== selection.routeRevision || context.mappingVersion !== selection.mappingVersion) {
    return yield* new SymmyRouteRejected({ reason: 'route_version_mismatch' });
  }
  const [firstOperation, ...remainingOperations] = context.allowedOwnerOperations;
  const selectedContext: SymmyRouteContext = {
    ...context,
    allowedOwnerOperations: [{ ...firstOperation }, ...remainingOperations.map((operation) => ({ ...operation }))],
    route: { ...context.route },
  };
  return selectedContext;
});
