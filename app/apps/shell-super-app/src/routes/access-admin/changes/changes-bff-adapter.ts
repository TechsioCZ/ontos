import { Effect, Match, Schema } from 'effect';
import type { HttpClientError } from 'effect/http';

import {
  DecideAccessChangesPayloadSchema,
  PreviewAccessChangesPayloadSchema,
} from '../../../../shared/access-admin-api.ts';
import type { AccessAdminProblem, ListAccessChangesResponse } from '../../../../shared/access-admin-api.ts';
import { decideAccessChanges, listAccessChanges, previewAccessChanges } from '../../../api/auth-client.ts';
import { ChangesClientFailure } from './changes-client.ts';
import type { ChangesClient } from './changes-client.ts';
import type { ChangeItemView, ChangePreviewView } from './changes-model.ts';

type ClientFailure = AccessAdminProblem | HttpClientError.HttpClientError | Schema.SchemaError;

export const changesClientFailure = (error: ClientFailure): ChangesClientFailure =>
  new ChangesClientFailure({
    cause: error,
    reason: Match.value(error).pipe(
      Match.tag('AccessAdminAuthenticationRequired', () => 'unauthenticated' as const),
      Match.tag('AccessAdminForbidden', () => 'forbidden' as const),
      Match.tag('AccessAdminConflict', () => 'stalePreview' as const),
      Match.tag('AccessAdminInvalidRequest', 'AccessAdminUnprocessable', () => 'failed' as const),
      Match.tag(
        'AccessAdminUnavailable',
        'AccessAdminInternal',
        'HttpClientError',
        'SchemaError',
        () => 'unavailable' as const,
      ),
      Match.exhaustive,
    ),
  });

export const changeItemView = (
  item: ListAccessChangesResponse['items'][number],
  roles: readonly { readonly id: string; readonly name: string }[],
): ChangeItemView => ({
  addedCells: item.addedCells,
  affectedHolders: item.holders.flatMap(({ holder }) =>
    Match.value(holder).pipe(
      Match.tag('human', (human) => [human.principalId]),
      Match.tag('agent', () => []),
      Match.exhaustive,
    ),
  ),
  batchEligible: item.batchEligible,
  capabilityKey: item.capabilityKey,
  catalogSnapshotId: item.catalogSnapshotId,
  id: item.id,
  kind: item.kind,
  lineage: item.lineageFrom,
  provenance: null,
  removedCells: item.removedCells,
  risk: item.risk,
  roleNames: Object.fromEntries(roles.map((role) => [role.id, role.name])),
  status: item.status,
  suggestedRoles: item.suggestedRoleIds.map((id) => roles.find((role) => role.id === id)?.name ?? id),
  widening: item.widens,
});

/** The BFF owns write availability; every list refresh observes the current release gate. */
export const liveChangesClient: ChangesClient = {
  decide: (preview, idempotencyKey) => {
    // Until the independent company picker exists, this surface can confirm tenant targets only.
    if (preview.legalEntityId !== null) {
      return Effect.fail(new ChangesClientFailure({ reason: 'stalePreview' }));
    }
    const base = {
      catalogSnapshotId: preview.catalogSnapshotId,
      decision: preview.decision,
      itemIds: preview.items.map((item) => item.id),
      legalEntityId: null,
    };
    const confirmed = { ...base, previewToken: preview.token };
    const [effect] = preview.effects;
    const withEffect = effect === undefined ? confirmed : { ...confirmed, namedEffect: effect.description };
    const payload = preview.decision === 'decline' ? base : withEffect;
    return Schema.decodeUnknownEffect(DecideAccessChangesPayloadSchema)(payload).pipe(
      Effect.flatMap((command) => decideAccessChanges(command, { idempotencyKey })),
      Effect.map((receipt) => ({ legalEntityId: receipt.legalEntityId, skipped: receipt.skipped })),
      Effect.mapError(changesClientFailure),
    );
  },
  list: (cursor, options = {}) =>
    listAccessChanges(cursor === undefined ? { limit: 25 } : { cursor, limit: 25 }, options).pipe(
      Effect.map((response) => ({
        items: response.items.map((item) => changeItemView(item, response.roles)),
        nextCursor: response.nextCursor,
        writeAvailability: response.writeAvailability,
      })),
      Effect.mapError(changesClientFailure),
    ),
  preview: (items, decision) => {
    const roleNames = Object.fromEntries(items.flatMap((item) => Object.entries(item.roleNames)));
    const roleLabels = Object.entries<string>(roleNames).map(([id, name]) => ({ id, name }));
    if (decision === 'decline') {
      // Decline has no server preview token and grants no authority; retain a separate confirmation.
      return Effect.succeed({
        affectedHumanCount: null,
        catalogSnapshotId: items[0]?.catalogSnapshotId ?? '',
        decision,
        effects: [],
        items,
        legalEntityId: null,
        requiresNamedEffect: false,
        roleChanges: null,
        token: 'decline-confirmation',
        undoSkips: null,
      });
    }
    return Schema.decodeUnknownEffect(PreviewAccessChangesPayloadSchema)({
      catalogSnapshotId: items[0]?.catalogSnapshotId,
      decision,
      itemIds: items.map((item) => item.id),
      legalEntityId: null,
    }).pipe(
      Effect.flatMap((payload) => previewAccessChanges(payload)),
      Effect.map((response): ChangePreviewView => ({
        affectedHumanCount: response.affectedHumanCount,
        catalogSnapshotId: items[0]?.catalogSnapshotId ?? '',
        decision,
        effects: response.items.flatMap((item) =>
          item.namedEffect === undefined ? [] : [{ description: item.namedEffect, itemId: item.id }],
        ),
        items: response.items.map((item) => changeItemView(item, roleLabels)),
        legalEntityId: response.legalEntityId,
        requiresNamedEffect: response.requiresNamedEffect || response.individualItemIds.length > 0,
        roleChanges: response.roleChanges.map((change) => ({
          ...change,
          roleName: roleLabels.find((role) => role.id === change.roleId)?.name ?? change.roleId,
        })),
        token: response.previewToken,
        undoSkips: response.skipped,
      })),
      Effect.mapError(changesClientFailure),
    );
  },
};
