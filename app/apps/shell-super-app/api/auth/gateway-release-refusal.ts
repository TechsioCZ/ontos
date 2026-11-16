/**
 * What the Shell logs when it refuses a gateway context because the caller's document names a release that is no
 * longer admitted (409 "reload required"): enough to find the caller — the page it was sent from (path only), a coarse
 * client kind and the revision it sent against the current one — and nothing that identifies a person or a session.
 */
export interface GatewayReleaseRefusal {
  readonly clientKind: 'browser' | 'headless-browser' | 'server' | 'unknown';
  readonly currentRevision: string;
  readonly endpoint: string;
  readonly refererPath: string | null;
  readonly sentRevision: string | null;
}

const SHORT_REVISION = 12;

const clientKindOf = (userAgent: string | undefined): GatewayReleaseRefusal['clientKind'] => {
  if (userAgent === undefined || userAgent === '') {
    return 'unknown';
  }
  if (/HeadlessChrome|Headless/u.test(userAgent)) {
    return 'headless-browser';
  }
  return userAgent.startsWith('Mozilla/') ? 'browser' : 'server';
};

const pathOf = (referer: string | undefined): string | null => {
  if (referer === undefined || !URL.canParse(referer)) {
    return null;
  }
  return new URL(referer).pathname;
};

/** The only request headers the log reads. */
export interface GatewayReleaseRefusalHeaders {
  readonly referer?: string | undefined;
  readonly 'user-agent'?: string | undefined;
}

export const gatewayReleaseRefusal = (input: {
  readonly currentRevision: string;
  readonly endpoint: string;
  readonly headers: GatewayReleaseRefusalHeaders;
  readonly sentRevision: string | null;
}): GatewayReleaseRefusal => ({
  clientKind: clientKindOf(input.headers['user-agent']),
  currentRevision: input.currentRevision.slice(0, SHORT_REVISION),
  endpoint: input.endpoint,
  refererPath: pathOf(input.headers.referer),
  sentRevision: input.sentRevision === null ? null : input.sentRevision.slice(0, SHORT_REVISION),
});
