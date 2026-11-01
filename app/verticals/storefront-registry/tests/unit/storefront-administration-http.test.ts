import { ActionPermissionDenied, OperationAuthenticationRequired } from '@app/core-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { mapRegisterStorefrontApplicationActionProblem } from '../../api/register-storefront-application-action-problems.ts';
import { mapReviseStorefrontApplicationActionProblem } from '../../api/revise-storefront-application-action-problems.ts';
import { StorefrontApplicationCommandRejected } from '../../shared/action-contracts.ts';
import { RegisterStorefrontApplicationPayloadSchema } from '../../shared/actions/register-storefront-application.ts';
import { RegisterStorefrontApplicationActionApi } from '../../shared/apis/register-storefront-application-action.ts';
import { ReviseStorefrontApplicationActionApi } from '../../shared/apis/revise-storefront-application-action.ts';
import { StorefrontAdministrationPersistenceUnavailable } from '../../src/actions/storefront-administration-persistence-unavailable.ts';

const maps = [mapRegisterStorefrontApplicationActionProblem, mapReviseStorefrontApplicationActionProblem];

describe('Storefront Registry administration Action HTTP transport', () => {
  it('publishes both Actions as owner-scoped POST endpoints', () => {
    const register =
      RegisterStorefrontApplicationActionApi.groups.registerStorefrontApplicationAction.endpoints.execute;
    const revise = ReviseStorefrontApplicationActionApi.groups.reviseStorefrontApplicationAction.endpoints.execute;
    expect([register.method, register.path]).toEqual([
      'POST',
      '/storefront-registry/actions/register-storefront-application',
    ]);
    expect([revise.method, revise.path]).toEqual([
      'POST',
      '/storefront-registry/actions/revise-storefront-application',
    ]);
  });

  it('keeps the public register payload strict about lifecycle and unique channels', () => {
    const decode = Schema.decodeUnknownExit(RegisterStorefrontApplicationPayloadSchema);
    const valid = {
      allowedChannels: ['B2C', 'B2B'],
      effectiveInterval: { effectiveFrom: '2026-10-01T00:00:00.000Z' },
      lifecycle: 'ACTIVE',
      reason: 'Demo storefront registration',
      storefrontAppId: 'akros-storefront',
    };
    expect(decode(valid)._tag).toBe('Success');
    expect(decode({ ...valid, lifecycle: 'SUSPENDED' })._tag).toBe('Failure');
    expect(decode({ ...valid, allowedChannels: ['B2C', 'B2C'] })._tag).toBe('Failure');
  });

  it('maps owner rejections to conflict or not-found and persistence loss to a retryable unavailable problem', () => {
    for (const map of maps) {
      expect(
        map(new StorefrontApplicationCommandRejected({ code: 'revision_conflict', reason: 'Stale revision' })),
      ).toMatchObject({ code: 'revision_conflict', status: 409 });
      expect(
        map(new StorefrontApplicationCommandRejected({ code: 'application_not_found', reason: 'Unknown application' })),
      ).toMatchObject({ code: 'application_not_found', status: 404 });
      expect(
        map(
          new StorefrontAdministrationPersistenceUnavailable({
            code: 'storefront_administration_persistence_unavailable',
            reason: 'Owner store unavailable',
          }),
        ),
      ).toMatchObject({ code: 'storefront_administration_persistence_unavailable', retryable: true, status: 503 });
    }
  });

  it('keeps authentication and authorization failures closed', () => {
    for (const map of maps) {
      expect(
        map(new OperationAuthenticationRequired({ code: 'operation_authentication_required', reason: 'Missing' })),
      ).toMatchObject({ status: 401 });
      expect(
        map(new ActionPermissionDenied({ code: 'action_permission_denied', reason: 'Permission denied' })),
      ).toMatchObject({ code: 'action_permission_denied', status: 403 });
    }
  });
});
