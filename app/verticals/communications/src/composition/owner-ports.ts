import { Layer } from 'effect';

import { unavailableMessageHandoffLayer } from '../domain/handoff/message-handoff.ts';
import { productionCatalogLayer } from '../domain/intake/message-type-catalog.ts';
import { notEstablishedRecipientLanguageLayer } from '../domain/intake/recipient-language.ts';
import { undeclaredProcessingScopeLayer } from '../domain/intake/scope-declaration.ts';
import { unavailableSourceOccurrenceAuthorityLayer } from '../domain/intake/source-authority.ts';
import { unavailableRecipientCurrentGateLayer } from '../domain/recipient/current-gate.ts';
import { privacyProcessingEligibilityGateLive } from '../integrations/privacy-eligibility-gate.ts';

/**
 * Owner-decided deadline of one Current-gate check. The domain has no default on purpose: a check that cannot be
 * bounded cannot be wired, and a check past this deadline fails closed as an unavailable owner.
 */
const GATE_CHECK_TIMEOUT = '10 seconds';

/**
 * Every owner port of the production composition. Each one that no owner has published yet is the EXPLICIT fail-closed
 * form, so nothing is ever decided or allowed by default or by a missing adapter:
 * - the approved catalog approves no type, so every purpose is an unknown purpose;
 * - no owner publishes a trusted recipient language, so none is established and the default `cs` applies;
 * - no source owner publishes its current occurrence facts, so no request is decided on a guess;
 * - no producer declares a Privacy scope, so a recipient has no scope and is stopped as an unresolved Privacy context;
 * - no owner publishes a recipient authority, so every Current recipient check is an unavailable source owner;
 * - Privacy is the real public Read, asked again with fresh delegated authority on every check.
 */
export const communicationsProductionOwnerPortsLive = Layer.mergeAll(
  productionCatalogLayer,
  notEstablishedRecipientLanguageLayer,
  unavailableSourceOccurrenceAuthorityLayer,
  undeclaredProcessingScopeLayer,
  unavailableRecipientCurrentGateLayer({ checkTimeout: GATE_CHECK_TIMEOUT }),
  privacyProcessingEligibilityGateLive({ checkTimeout: GATE_CHECK_TIMEOUT }),
);

/**
 * The ports of the pre-handoff worker: the same decision ports (each asked again, never remembered) plus the handoff
 * port. Until step 22 provides the Messaging Adapter the handoff is the explicit unavailable form, which answers that
 * nothing was submitted; no provider adapter and no `EmailDeliveryService` is wired here.
 */
export const communicationsWorkerOwnerPortsLive = Layer.mergeAll(
  communicationsProductionOwnerPortsLive,
  unavailableMessageHandoffLayer,
);

/**
 * The owner port of the public history Reads. No source owner publishes a history visibility Read yet, so the production
 * port is the explicit unavailable form: a history of a source-owned scope (a profile, a Counterparty, a Storefront) is
 * refused as unavailable instead of being shown on a guess, and a Tenant or Legal Entity history needs no source owner.
 */
export { unavailableSourceScopeVisibilityLayer as communicationsHistoryReadPortsLive } from '../domain/access/source-visibility.ts';
