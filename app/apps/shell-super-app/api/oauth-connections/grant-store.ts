/** Shell domain mapping. Core owns grant/binding state; Auth owns credential families. */
import {
  OAuthAuthenticationAuditUnavailable,
  OAuthGrantOwners,
  OAuthGrantRegistry,
  OAuthGrantModulesSchema,
} from '@app/core-runtime';
import type { OAuthGrantRecord } from '@app/core-runtime';
import type {
  ConnectionModulesRequest,
  ConnectionRevokeReason,
  ConnectionWritePolicy,
} from '@app/shared-contracts/oauth-connections';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { OAuthCredentials } from '../auth/db/oauth-credentials.ts';
import { ConnectionUnavailable } from './errors.ts';
import type { GrantListFilter, GrantRow, NewDraftGrant, OAuthRefreshGuardRow } from './types.ts';

const unavailable = (cause: unknown) => new ConnectionUnavailable({ cause });
/** Structural mapping is checked against both native owner and Shell wire types. */
const toGrantRow = (record: OAuthGrantRecord): GrantRow => ({ ...record, modules: record.modules });
const optionalGrant = (record: Option.Option<OAuthGrantRecord>): GrantRow | undefined =>
  Option.getOrUndefined(Option.map(toGrantRow)(record));
const nativeModules = (modules: ConnectionModulesRequest) =>
  Schema.decodeEffect(OAuthGrantModulesSchema)(modules).pipe(Effect.mapError(unavailable));

export interface GrantKey {
  readonly actingPrincipalId: string;
  readonly clientId: string;
  readonly legalEntityId: string;
  readonly userId: string;
}

export const insertDraftGrant = Effect.fn('OAuthGrantStore.insertDraftGrant')(function* insertDraftGrant(
  input: NewDraftGrant,
) {
  return toGrantRow(
    yield* (yield* OAuthGrantRegistry)
      .insertDraftGrant({ ...input, modules: yield* nativeModules(input.modules) })
      .pipe(Effect.mapError(unavailable)),
  );
});
export const findGrant = Effect.fn('OAuthGrantStore.findGrant')(function* findGrant(grantId: string) {
  return optionalGrant(yield* (yield* OAuthGrantRegistry).findGrant(grantId).pipe(Effect.mapError(unavailable)));
});
export const findSessionGrant = Effect.fn('OAuthGrantStore.findSessionGrant')(function* findSessionGrant(input: {
  readonly sessionId: string;
  readonly userId: string;
}) {
  return optionalGrant(yield* (yield* OAuthGrantRegistry).findSessionGrant(input).pipe(Effect.mapError(unavailable)));
});
export const findPreviousProfileId = Effect.fn('OAuthGrantStore.findPreviousProfileId')(function* findPreviousProfileId(
  input: GrantKey,
) {
  return Option.getOrUndefined(
    yield* (yield* OAuthGrantRegistry).findPreviousProfileId(input).pipe(Effect.mapError(unavailable)),
  );
});
export const approveDraftGrant = Effect.fn('OAuthGrantStore.approveDraftGrant')(function* approveDraftGrant(input: {
  readonly actorPrincipalId: string;
  readonly grant: GrantRow;
}) {
  const result = yield* (yield* OAuthGrantRegistry)
    .approveDraftGrant({ ...input, grant: { ...input.grant, modules: yield* nativeModules(input.grant.modules) } })
    .pipe(Effect.mapError(unavailable));
  return Option.getOrUndefined(
    result.pipe(
      Option.map((activation) => ({
        active: toGrantRow(activation.active),
        superseded: activation.superseded.map(toGrantRow),
      })),
    ),
  );
});
export const setGrantStatus = Effect.fn('OAuthGrantStore.setGrantStatus')(function* setGrantStatus(input: {
  readonly grantId: string;
  readonly revokedByPrincipalId: string | null;
  readonly revokeReason: ConnectionRevokeReason | null;
  readonly status: 'denied' | 'revoked' | 'superseded';
}) {
  return optionalGrant(yield* (yield* OAuthGrantRegistry).setGrantStatus(input).pipe(Effect.mapError(unavailable)));
});
export const updateGrantAccess = Effect.fn('OAuthGrantStore.updateGrantAccess')(function* updateGrantAccess(input: {
  readonly grantId: string;
  readonly modules: ConnectionModulesRequest;
  readonly writePolicy: ConnectionWritePolicy;
}) {
  return optionalGrant(
    yield* (yield* OAuthGrantRegistry)
      .updateGrantAccess({ ...input, modules: yield* nativeModules(input.modules) })
      .pipe(Effect.mapError(unavailable)),
  );
});
export const touchGrantLastUsed = Effect.fn('OAuthGrantStore.touchGrantLastUsed')(function* touchGrantLastUsed(
  grantId: string,
) {
  return yield* (yield* OAuthGrantRegistry).touchGrantLastUsed(grantId).pipe(Effect.mapError(unavailable));
});
export const listGrants = Effect.fn('OAuthGrantStore.listGrants')(function* listGrants(filter: GrantListFilter) {
  return (yield* (yield* OAuthGrantRegistry).listGrants(filter).pipe(Effect.mapError(unavailable))).map(toGrantRow);
});
export const setGrantBindingStatus = Effect.fn('OAuthGrantStore.setGrantBindingStatus')(
  function* setGrantBindingStatus(input: {
    readonly authBindingId: string;
    readonly status: 'active' | 'disabled';
    readonly tenantId: string;
  }) {
    yield* (yield* OAuthGrantRegistry).setGrantBindingStatus(input).pipe(Effect.mapError(unavailable));
  },
);
export const loadBindingStatus = Effect.fn('OAuthGrantStore.loadBindingStatus')(function* loadBindingStatus(input: {
  readonly authBindingId: string;
  readonly tenantId: string;
}) {
  return Option.getOrUndefined(
    yield* (yield* OAuthGrantRegistry).loadBindingStatus(input).pipe(Effect.mapError(unavailable)),
  );
});
export const loadUserAccount = Effect.fn('OAuthGrantStore.loadUserAccount')(function* loadUserAccount(userId: string) {
  return Option.getOrUndefined(
    yield* (yield* OAuthCredentials).loadUserAccount(userId).pipe(Effect.mapError(unavailable)),
  );
});
export const loadPrincipals = Effect.fn('OAuthGrantStore.loadPrincipals')(function* loadPrincipals(
  tenantId: string,
  principalIds: readonly string[],
) {
  return yield* (yield* OAuthGrantRegistry).loadPrincipals(tenantId, principalIds).pipe(Effect.mapError(unavailable));
});
export const listAgentPrincipals = Effect.fn('OAuthGrantStore.listAgentPrincipals')(function* listAgentPrincipals(
  tenantId: string,
) {
  return yield* (yield* OAuthGrantRegistry).listAgentPrincipals(tenantId).pipe(Effect.mapError(unavailable));
});

export class OAuthEndpointGuardData extends Context.Service<
  OAuthEndpointGuardData,
  {
    readonly consentApproved: (session: {
      readonly sessionId: string;
      readonly userId: string;
    }) => Effect.Effect<boolean, ConnectionUnavailable>;
    readonly loadRefresh: (
      storageKey: string,
    ) => Effect.Effect<Option.Option<OAuthRefreshGuardRow>, ConnectionUnavailable>;
    readonly revokeFamily: (row: OAuthRefreshGuardRow) => Effect.Effect<void, ConnectionUnavailable>;
  }
>()('@app/shell-super-app/api/oauth-connections/grant-store/OAuthEndpointGuardData') {}

/** Native composition of two real owner producers; no transport can acquire a global database. */
export const OAuthEndpointGuardDataLive = Layer.effect(
  OAuthEndpointGuardData,
  Effect.gen(function* oauthEndpointGuardDataService() {
    const registry = yield* OAuthGrantRegistry;
    const credentials = yield* OAuthCredentials;
    return {
      consentApproved: Effect.fn('OAuthEndpointGuardData.consentApproved')(function* consentApproved(session: {
        readonly sessionId: string;
        readonly userId: string;
      }) {
        return (yield* registry.findSessionGrant(session).pipe(Effect.mapError(unavailable))).pipe(
          Option.exists((grant) => grant.status === 'active'),
        );
      }),
      loadRefresh: Effect.fn('OAuthEndpointGuardData.loadRefresh')(function* loadRefresh(storageKey: string) {
        const token = yield* credentials.loadRefresh(storageKey);
        if (Option.isNone(token)) {
          return Option.none<OAuthRefreshGuardRow>();
        }
        const row = token.value;
        const retained =
          row.referenceId === null ? Option.none<OAuthGrantRecord>() : yield* registry.findGrant(row.referenceId);
        // A malformed cross-client/user reference must not grant authority over that other grant or binding.
        const grant = retained.pipe(
          Option.filter((candidate) => candidate.clientId === row.clientId && candidate.userId === row.userId),
        );
        return Option.some<OAuthRefreshGuardRow>({
          clientId: row.clientId,
          grant: Option.map(toGrantRow)(grant),
          id: row.id,
          referenceId: row.referenceId,
          revoked: row.revoked,
          rotatedAt: row.rotatedAt,
          rotationReplayExpiresAt: row.rotationReplayExpiresAt,
        });
      }, Effect.mapError(unavailable)),
      revokeFamily: Effect.fn('OAuthEndpointGuardData.revokeFamily')(function* revokeFamily(row: OAuthRefreshGuardRow) {
        // Commit authorization disablement FIRST. Auth cleanup is a separate commit and its failures must propagate.
        if (Option.isSome(row.grant)) {
          const grant = row.grant.value;
          if (row.referenceId !== grant.grantId || row.clientId !== grant.clientId) {
            return yield* unavailable('Refresh family does not match retained grant');
          }
          const disabled = yield* registry
            .setGrantStatus({
              grantId: grant.grantId,
              revokedByPrincipalId: null,
              revokeReason: null,
              status: 'revoked',
            })
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(disabled)) {
            return yield* unavailable('Retained grant disappeared before authorization disablement');
          }
        }
        return yield* credentials.revokeFamily(row).pipe(Effect.mapError(unavailable));
      }),
    };
  }),
);

/** Retained owners come from Core's real grant registry; governed note authorization is unchanged. */
export const OAuthGrantOwnersLive = Layer.effect(
  OAuthGrantOwners,
  Effect.gen(function* oauthGrantOwnersService() {
    const registry = yield* OAuthGrantRegistry;
    return {
      owners: (input: Parameters<(typeof OAuthGrantOwners)['Service']['owners']>[0]) =>
        registry.owners(input).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthAuthenticationAuditUnavailable({
                cause,
                reason: 'Unable to verify retained OAuth grant owners',
              }),
          ),
        ),
    };
  }),
);
