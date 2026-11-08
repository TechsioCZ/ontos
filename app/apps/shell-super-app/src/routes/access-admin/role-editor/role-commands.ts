import { Effect, Match, Schema } from 'effect';
import type { Config, PlatformError } from 'effect';

import { AccessRoleEditPayloadSchema } from '../../../../shared/access-admin-api.ts';
import type { PreviewAccessRoleEditResponse } from '../../../../shared/access-admin-api.ts';
import {
  createAccessAdministrationIdempotencyKey,
  previewAccessRoleEdit,
  saveAccessRoleEdit,
} from '../../../api/auth-client.ts';
import type { AccessAdministrationClientError } from '../../../api/auth-client.ts';
import type { RolePreviewView } from './model.ts';

export const roleErrorStatus = (
  error: AccessAdministrationClientError | Config.ConfigError | PlatformError.PlatformError,
) =>
  Match.value(error).pipe(
    Match.tag('AccessAdminAuthenticationRequired', () => 'unauthenticated' as const),
    Match.tag('AccessAdminForbidden', () => 'forbidden' as const),
    Match.tag('AccessAdminConflict', () => 'conflict' as const),
    Match.tag('AccessAdminInvalidRequest', 'AccessAdminUnprocessable', () => 'invalid' as const),
    Match.tag(
      'AccessAdminUnavailable',
      'AccessAdminInternal',
      'HttpClientError',
      'SchemaError',
      'PlatformError',
      'ConfigError',
      () => 'unavailable' as const,
    ),
    Match.exhaustive,
  );

export const roleFormErrorStatus = (error: AccessAdministrationClientError | PlatformError.PlatformError) =>
  Match.value(error).pipe(
    Match.tag('SchemaError', () => 'invalid' as const),
    Match.orElse(roleErrorStatus),
  );

export const prepareRolePreview = (payload: typeof AccessRoleEditPayloadSchema.Encoded, locale: string) =>
  Schema.decodeEffect(AccessRoleEditPayloadSchema)(payload).pipe(
    Effect.flatMap((decoded) => previewAccessRoleEdit(decoded, { locale })),
    Effect.flatMap((result) => createAccessAdministrationIdempotencyKey().pipe(Effect.map((key) => ({ key, result })))),
  );

export const commitRolePreview = (
  payload: typeof AccessRoleEditPayloadSchema.Encoded,
  preview: RolePreviewView,
  idempotencyKey: string,
  locale: string,
) =>
  Schema.decodeEffect(AccessRoleEditPayloadSchema)(payload).pipe(
    Effect.flatMap((decoded) =>
      saveAccessRoleEdit(
        {
          ...decoded,
          confirmedEffects: preview.dangerousEffects.map((effect) => ({ effect: effect.value, slot: effect.id })),
          previewToken: preview.previewToken,
        },
        { idempotencyKey, locale },
      ),
    ),
  );

export const toRolePreviewView = (
  preview: PreviewAccessRoleEditResponse,
  describe: (effect: PreviewAccessRoleEditResponse['dangerous'][number]) => string,
): RolePreviewView => ({
  added: preview.added,
  affectedHumanCount: preview.affectedHumanCount,
  affectedPeople: [
    ...new Set(
      preview.affectedHolders.flatMap(({ holder }) =>
        Match.value(holder).pipe(
          Match.tag('Principal', ({ principalId }) => [principalId]),
          Match.tag('Agent', () => []),
          Match.exhaustive,
        ),
      ),
    ),
  ],
  dangerousEffects: preview.dangerous.map((effect) => ({
    description: describe(effect),
    id: effect.slot,
    value: effect.effect,
  })),
  previewToken: preview.previewToken,
  removed: preview.removed,
  requiresNamedEffect: preview.requiresNamedEffect,
});
