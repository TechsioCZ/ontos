import { Option } from 'effect';

/**
 * Commerce never mints a trusted-device cookie. The published payloads still carry the field so a
 * caller can send an explicit `false`, and `true` is refused at the transport with the owner's
 * `trust_device_not_allowed` problem rather than a generic decoding failure.
 */
export const narrowCommercePortalAuthMfaTrustDevice = (payload: {
  readonly trustDevice?: boolean;
}): Option.Option<{ readonly trustDevice?: false }> =>
  payload.trustDevice === true
    ? Option.none()
    : Option.some(payload.trustDevice === undefined ? {} : { trustDevice: false });
