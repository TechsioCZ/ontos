import { Crypto, Effect, Layer } from 'effect';

import { unavailableDocumentLinkOwnerLayer } from '../domain/documents/document-owner.ts';
import { unavailableMessageHandoffLayer } from '../domain/handoff/message-handoff.ts';
import { productionCatalogLayer } from '../domain/intake/message-type-catalog.ts';
import { notEstablishedRecipientLanguageLayer } from '../domain/intake/recipient-language.ts';
import { undeclaredProcessingScopeLayer } from '../domain/intake/scope-declaration.ts';
import { portalAuthOwnerPortsOver, portalAuthOwnerTransportLive } from '../integrations/portal-auth-owner.ts';
import type { PortalAuthOwnerTransport } from '../integrations/portal-auth-owner.ts';
import {
  privacyOwnerTransportLive,
  privacyProcessingEligibilityGateOver,
} from '../integrations/privacy-eligibility-gate.ts';
import type { PrivacyOwnerTransport } from '../integrations/privacy-eligibility-gate.ts';

/**
 * Owner-decided deadline of one Current-gate check. The domain has no default on purpose: a check that cannot be
 * bounded cannot be wired, and a check past this deadline fails closed as an unavailable owner.
 */
const GATE_CHECK_TIMEOUT = '10 seconds';

/** How each owner is reached; the only thing a composition replaces, never what is asked or how an answer is read. */
export interface CommunicationsOwnerTransports {
  readonly portalAuth: PortalAuthOwnerTransport;
  readonly privacy: PrivacyOwnerTransport;
}

/**
 * Every owner port of the decision, over given transports to the owners. The ports are real: the catalog approves the three
 * Portal Auth types, each ask of Auth and Privacy is made again with fresh authority (never remembered), and every port no owner
 * has published yet stays the EXPLICIT fail-closed form, so nothing is ever decided or allowed by default or by a missing adapter:
 * - no owner publishes a trusted recipient language, so none is established and the default `cs` applies;
 * - Portal Auth, the sole source owner of the approved types, states the current occurrence and recipient endpoint through its
 *   published Read; a source with no adapter is an unavailable owner;
 * - no producer declares a Privacy scope (#1396 J: the source producer declares it, and no approved contract field carries it yet),
 *   so a recipient has no scope and is stopped as an unresolved Privacy context;
 * - Core Media V1 and the document owners publish no Read yet (#1443, #1446), so every document question is unavailable.
 */
export const communicationsOwnerPortsOver = (transports: CommunicationsOwnerTransports) =>
  Layer.mergeAll(
    productionCatalogLayer,
    notEstablishedRecipientLanguageLayer,
    portalAuthOwnerPortsOver({ checkTimeout: GATE_CHECK_TIMEOUT }, transports.portalAuth),
    undeclaredProcessingScopeLayer,
    privacyProcessingEligibilityGateOver({ checkTimeout: GATE_CHECK_TIMEOUT }, transports.privacy),
    unavailableDocumentLinkOwnerLayer,
  );

/** The production composition: both owners are reached through their published Reads with a fresh delegated assertion per ask. */
export const communicationsProductionOwnerPortsLive = Layer.unwrap(
  Effect.gen(function* productionOwnerPorts() {
    const crypto = yield* Crypto.Crypto;
    return communicationsOwnerPortsOver({
      portalAuth: portalAuthOwnerTransportLive(crypto),
      privacy: privacyOwnerTransportLive(crypto),
    });
  }),
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
