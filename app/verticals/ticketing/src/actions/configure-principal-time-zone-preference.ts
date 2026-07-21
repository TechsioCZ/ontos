import { configurePrincipalTimeZonePreferenceActionHandler } from '@app/core-runtime/principal-time-zone-preferences';
import type { ActionRegistration } from '@app/core-runtime';
import {
  configurePrincipalTimeZonePreferenceActionKey,
  configurePrincipalTimeZonePreferenceActionPayloadSchema,
  configurePrincipalTimeZonePreferenceActionResponseSchema,
} from '../../shared/actions/configure-principal-time-zone-preference.ts';
import type {
  ConfigurePrincipalTimeZonePreferenceActionPayload,
  ConfigurePrincipalTimeZonePreferenceActionResponse,
} from '../../shared/actions/configure-principal-time-zone-preference.ts';

export const configurePrincipalTimeZonePreferenceActionRegistration: ActionRegistration<
  ConfigurePrincipalTimeZonePreferenceActionPayload,
  ConfigurePrincipalTimeZonePreferenceActionResponse
> = {
  descriptor: {
    actionKey: configurePrincipalTimeZonePreferenceActionKey,
    auditProfile: 'standard',
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    transportRequestSchema: configurePrincipalTimeZonePreferenceActionPayloadSchema,
    transportResponseSchema: configurePrincipalTimeZonePreferenceActionResponseSchema,
  },
  handler: configurePrincipalTimeZonePreferenceActionHandler,
};
