/**
 * Connector partners: external integration platforms that push and read a Tenant's business data through their own
 * ingress (accounting, invoicing and ERP systems, migrations from another system), authenticated by a tenant-managed
 * API key of one `integration` Principal. Symmy is the first. Adding a partner is one declaration here plus its owner
 * module's enrollment Action; the Shell's key management, the Principal and its key binding are the same for every
 * partner.
 *
 * The kind is persisted on the integration Principal (`core.principals.integration_kind`), so every list of the
 * Tenant's integrations names the partner it belongs to. Core stores the identifier; this declaration is what a valid
 * identifier means.
 */
import { Schema } from 'effect';

import { SYMMY_REST_PREFIX, SYMMY_ROUTES } from '../symmy/routes.ts';
import type { SymmyRouteKey } from '../symmy/routes.ts';

/** What one connector partner is: its ingress, how it authenticates and which route families it serves. */
export interface ConnectorPartnerDeclaration<RouteFamily extends string = string> {
  /** The HTTP header the partner presents its API key in. */
  readonly apiKeyHeader: 'x-api-key';
  /** The partner's reference documentation on the deployment it sends to. */
  readonly docsPath: `/${string}`;
  /** The ingress every route family of the partner is mounted under. */
  readonly ingressPrefix: `/${string}`;
  /** Shown wherever the Tenant's integrations are listed. */
  readonly label: string;
  /** The route families the partner's ingress serves. */
  readonly routeFamilies: readonly RouteFamily[];
}

const symmyRouteFamilies = Object.keys(SYMMY_ROUTES).filter((key): key is SymmyRouteKey =>
  Object.hasOwn(SYMMY_ROUTES, key),
);

export const CONNECTOR_PARTNERS = {
  symmy: {
    apiKeyHeader: 'x-api-key',
    docsPath: `${SYMMY_REST_PREFIX}/docs`,
    ingressPrefix: SYMMY_REST_PREFIX,
    label: 'Symmy',
    routeFamilies: symmyRouteFamilies,
  },
} as const satisfies Readonly<Record<string, ConnectorPartnerDeclaration>>;

export type ConnectorPartnerKind = keyof typeof CONNECTOR_PARTNERS;

export const connectorPartnerKinds: readonly ConnectorPartnerKind[] = Object.keys(CONNECTOR_PARTNERS).filter(
  (key): key is ConnectorPartnerKind => Object.hasOwn(CONNECTOR_PARTNERS, key),
);
export const ConnectorPartnerKindSchema = Schema.Literals(connectorPartnerKinds);

export const connectorPartner = (kind: ConnectorPartnerKind): (typeof CONNECTOR_PARTNERS)[ConnectorPartnerKind] =>
  CONNECTOR_PARTNERS[kind];

/**
 * An existing API key value an administrator registers instead of generating one, because the partner already holds
 * it. Better Auth hashes it exactly like a key it generated; the value is never stored or logged.
 */
export const SuppliedApiKeyValueSchema = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9_.~-]+$/u),
);
export const SuppliedApiKeySecretSchema = Schema.Redacted(SuppliedApiKeyValueSchema);
