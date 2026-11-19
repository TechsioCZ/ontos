import type { AntiResurrectionProtection } from '@app/privacy/domain/anti-resurrection';
import { Context, Effect, Layer } from 'effect';

import { ProtectionLookupUnavailable } from './protection-lookup-unavailable.ts';

export interface AntiResurrectionProtections {
  /** The protections of one tenant and subject. The production default is the explicit unavailable form. */
  readonly forSubject: (
    tenantId: string,
    subjectRef: string,
  ) => Effect.Effect<readonly AntiResurrectionProtection[], ProtectionLookupUnavailable>;
}

export class CommunicationsAntiResurrectionProtections extends Context.Service<
  CommunicationsAntiResurrectionProtections,
  AntiResurrectionProtections
>()('@app/communications/domain/retention/anti-resurrection-protections/CommunicationsAntiResurrectionProtections') {}

export const unavailableAntiResurrectionProtections: AntiResurrectionProtections = Object.freeze({
  forSubject: () => Effect.fail(new ProtectionLookupUnavailable({ reason: 'PROTECTION_STORE_NOT_AVAILABLE' })),
});

export const unavailableAntiResurrectionProtectionsLayer = Layer.succeed(
  CommunicationsAntiResurrectionProtections,
  unavailableAntiResurrectionProtections,
);
