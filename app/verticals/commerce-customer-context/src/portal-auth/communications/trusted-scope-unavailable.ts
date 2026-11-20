import { Schema } from 'effect';

/** Expected failure: the deployment names no trusted Tenant for Portal Auth communications. Fail closed: no request is made. */
export class PortalAuthTrustedScopeUnavailable extends Schema.TaggedError<PortalAuthTrustedScopeUnavailable>()(
  'PortalAuthTrustedScopeUnavailable',
  { reason: Schema.Literal('NOT_CONFIGURED') },
) {}
