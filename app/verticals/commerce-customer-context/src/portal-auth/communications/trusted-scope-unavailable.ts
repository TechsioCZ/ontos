import { Schema } from 'effect';

/**
 * Expected failure: the deployment names no usable trusted Tenant for Portal Auth communications. Fail closed: no request is
 * made. NOT_CONFIGURED: the reviewed deployment value is unset or blank; INVALID: it is set but does not name a Tenant. It
 * carries the reason only, never the configured value.
 */
export class PortalAuthTrustedScopeUnavailable extends Schema.TaggedError<PortalAuthTrustedScopeUnavailable>()(
  'PortalAuthTrustedScopeUnavailable',
  { reason: Schema.Literals(['INVALID', 'NOT_CONFIGURED']) },
) {}
