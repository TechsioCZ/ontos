import { Schema } from 'effect';

export {
  GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_ASSERTION_VERSION,
  GatewayAudienceSchema,
  GatewayAudienceInvalidProblemSchema,
  GatewayAuthenticationRequiredProblemSchema,
  GatewayContextApi,
  GatewayContextApiGroup,
  GatewayContextClaimsSchema,
  GatewayContextProtectedHeaderSchema,
  GatewayContextRequestSchema,
  GatewayContextResponseSchema,
  GatewayInternalProblemSchema,
  GatewayTrustedPrincipalContextSchema,
  GatewayUnavailableProblemSchema,
  decodeGatewayContextClaims,
  decodeGatewayContextProtectedHeader,
  issueGatewayContext,
  shellGatewayContextContract,
} from './gateway-context.ts';
export type {
  GatewayAudienceInvalidProblem,
  GatewayAuthenticationRequiredProblem,
  GatewayContextClientEffect,
  GatewayContextClientError,
  GatewayContextClientOptions,
  GatewayContextClaims,
  GatewayContextProblem,
  GatewayContextProtectedHeader,
  GatewayContextRequest,
  GatewayContextResponse,
  GatewayInternalProblem,
  GatewayTrustedPrincipalContext,
  GatewayUnavailableProblem,
} from './gateway-context.ts';
export { makeOperationGateway } from './operation-gateway.ts';
export type {
  OperationGateway,
  OperationGatewayAttempt,
  OperationGatewayIssuer,
} from './operation-gateway.ts';

export const UltramodernPublicSitemapChangeFrequencySchema = Schema.Literals([
  'always',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'never',
]);
export type UltramodernPublicSitemapChangeFrequency =
  typeof UltramodernPublicSitemapChangeFrequencySchema.Type;

export interface UltramodernPublicSitemapEntry {
  changeFrequency?: UltramodernPublicSitemapChangeFrequency;
  draft?: boolean;
  indexable?: boolean;
  lastModified?: string;
  /**
   * Per-locale overrides when translated URLs use translated params.
   */
  localeParams?: Partial<Record<'en' | 'cs', Record<string, string | number | boolean>>>;
  /**
   * Params used to expand every localized route pattern, for example
   * { slug: 'platform-story' } for /talks/:slug.
   */
  params: Record<string, string | number | boolean>;
  priority?: number;
}

export const UltramodernPerformanceReadinessSignalIdSchema = Schema.Literals([
  'bfcache',
  'core-web-vitals-rum',
  'duplicate-prefetch-warmup',
  'cache-policy-sanity',
  'save-data-behavior',
  'cloudflare-ssr-cache-hints',
]);
export type UltramodernPerformanceReadinessSignalId =
  typeof UltramodernPerformanceReadinessSignalIdSchema.Type;

export interface UltramodernPerformanceReadinessDiagnosticsConfig {
  /**
   * Default-on. Set to false only for an explicit local or CI fast path.
   */
  enabled?: boolean;
  /**
   * Diagnostics may fail objective generated/framework invariants, or never
   * fail and only emit the deterministic report.
   */
  failOn?: 'framework-invariant' | 'never';
  reportPath?: string;
  signals?: Partial<
    Record<
      UltramodernPerformanceReadinessSignalId,
      {
        enabled?: boolean;
      }
    >
  >;
}

export const ultramodernWorkspaceContract = {
  ownership: 'topology/ownership.json',
  performanceReadiness: {
    defaultOn: true,
    optOut: 'scripts/ultramodern-performance-readiness.config.mjs#enabled=false',
    report: '.codex/reports/performance-readiness/ultramodern-performance-readiness.json',
    signals: [
      'bfcache',
      'core-web-vitals-rum',
      'duplicate-prefetch-warmup',
      'cache-policy-sanity',
      'save-data-behavior',
      'cloudflare-ssr-cache-hints',
    ],
  },
  preset: 'presetUltramodern',
  topology: 'topology/reference-topology.json',
} as const;

export const UltramodernWorkspaceLocaleSchema = Schema.Literals(['en', 'cs']);
export type UltramodernWorkspaceLocale = typeof UltramodernWorkspaceLocaleSchema.Type;

export const UltramodernPerformanceReadinessSignalStatusSchema = Schema.Literals([
  'pass',
  'warn',
  'fail',
]);
export type UltramodernPerformanceReadinessSignalStatus =
  typeof UltramodernPerformanceReadinessSignalStatusSchema.Type;

export const ultramodernWorkspaceEventNames = {
  navigate: 'ultramodern:navigate',
  performanceSignal: 'ultramodern:performance-signal',
  remoteReady: 'ultramodern:remote-ready',
  routeSettled: 'ultramodern:route-settled',
} as const;

export type UltramodernWorkspaceEventName =
  (typeof ultramodernWorkspaceEventNames)[keyof typeof ultramodernWorkspaceEventNames];

const UltramodernWorkspaceJsonValueSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Finite,
    Schema.Boolean,
    Schema.String,
    Schema.Array(UltramodernWorkspaceJsonValueSchema),
    Schema.Record(Schema.String, UltramodernWorkspaceJsonValueSchema),
  ]),
);

export const UltramodernWorkspaceJsonObjectSchema = Schema.Record(
  Schema.String,
  UltramodernWorkspaceJsonValueSchema,
);
export type UltramodernWorkspaceJsonObject = typeof UltramodernWorkspaceJsonObjectSchema.Type;

const UltramodernWorkspaceNonEmptyStringSchema = Schema.String.check(Schema.isPattern(/\S/u));
const UltramodernWorkspaceNonNegativeNumberSchema = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
);
const UltramodernWorkspaceAppIdSchema = UltramodernWorkspaceNonEmptyStringSchema.pipe(
  Schema.brand('UltramodernWorkspaceAppId'),
);

export const UltramodernNavigatePayloadSchema = Schema.Struct({
  replace: Schema.optional(Schema.Boolean),
  state: Schema.optional(UltramodernWorkspaceJsonObjectSchema),
  to: UltramodernWorkspaceNonEmptyStringSchema,
});
export type UltramodernNavigatePayload = typeof UltramodernNavigatePayloadSchema.Type;

export const UltramodernRouteSettledPayloadSchema = Schema.Struct({
  locale: Schema.optional(UltramodernWorkspaceLocaleSchema),
  pathname: UltramodernWorkspaceNonEmptyStringSchema,
  title: Schema.optional(UltramodernWorkspaceNonEmptyStringSchema),
});
export type UltramodernRouteSettledPayload = typeof UltramodernRouteSettledPayloadSchema.Type;

export const UltramodernRemoteReadyPayloadSchema = Schema.Struct({
  appId: UltramodernWorkspaceAppIdSchema,
  build: Schema.optional(UltramodernWorkspaceNonEmptyStringSchema),
  surface: Schema.optional(UltramodernWorkspaceNonEmptyStringSchema),
  version: Schema.optional(UltramodernWorkspaceNonEmptyStringSchema),
});
export type UltramodernRemoteReadyPayload = typeof UltramodernRemoteReadyPayloadSchema.Type;

export const UltramodernPerformanceSignalPayloadSchema = Schema.Struct({
  detail: Schema.optional(UltramodernWorkspaceJsonObjectSchema),
  durationMs: Schema.optional(UltramodernWorkspaceNonNegativeNumberSchema),
  signalId: UltramodernPerformanceReadinessSignalIdSchema,
  status: UltramodernPerformanceReadinessSignalStatusSchema,
});
export type UltramodernPerformanceSignalPayload =
  typeof UltramodernPerformanceSignalPayloadSchema.Type;

export interface UltramodernWorkspaceEventPayloadMap {
  'ultramodern:navigate': UltramodernNavigatePayload;
  'ultramodern:performance-signal': UltramodernPerformanceSignalPayload;
  'ultramodern:remote-ready': UltramodernRemoteReadyPayload;
  'ultramodern:route-settled': UltramodernRouteSettledPayload;
}

export class UltramodernWorkspaceEventValidationError<Payload = never> {
  readonly message: string;
  readonly name = 'UltramodernWorkspaceEventValidationError';
  readonly eventName: UltramodernWorkspaceEventName;
  readonly payload: Payload;

  constructor(eventName: UltramodernWorkspaceEventName, payload: Payload) {
    this.message = `Invalid payload for UltraModern workspace event "${eventName}"`;
    this.eventName = eventName;
    this.payload = payload;
  }
}

export const isUltramodernNavigatePayload = <Payload>(
  payload: Payload,
): payload is Payload & UltramodernNavigatePayload =>
  Schema.is(UltramodernNavigatePayloadSchema)(payload);

export const isUltramodernRouteSettledPayload = <Payload>(
  payload: Payload,
): payload is Payload & UltramodernRouteSettledPayload =>
  Schema.is(UltramodernRouteSettledPayloadSchema)(payload);

export const isUltramodernRemoteReadyPayload = <Payload>(
  payload: Payload,
): payload is Payload & UltramodernRemoteReadyPayload =>
  Schema.is(UltramodernRemoteReadyPayloadSchema)(payload);

export const isUltramodernPerformanceSignalPayload = <Payload>(
  payload: Payload,
): payload is Payload & UltramodernPerformanceSignalPayload =>
  Schema.is(UltramodernPerformanceSignalPayloadSchema)(payload);

const ultramodernWorkspaceEventPayloadSchemas = {
  [ultramodernWorkspaceEventNames.navigate]: UltramodernNavigatePayloadSchema,
  [ultramodernWorkspaceEventNames.performanceSignal]: UltramodernPerformanceSignalPayloadSchema,
  [ultramodernWorkspaceEventNames.remoteReady]: UltramodernRemoteReadyPayloadSchema,
  [ultramodernWorkspaceEventNames.routeSettled]: UltramodernRouteSettledPayloadSchema,
};

const ultramodernWorkspaceCustomEventSchema = <Name extends UltramodernWorkspaceEventName>(
  eventName: Name,
) =>
  Schema.Opaque<CustomEvent<UltramodernWorkspaceEventPayloadMap[Name]>>()(
    Schema.Struct({
      detail: ultramodernWorkspaceEventPayloadSchemas[eventName],
      initCustomEvent: Schema.instanceOf(Function),
    }),
  );

export const isUltramodernWorkspaceEventPayload = <
  Name extends UltramodernWorkspaceEventName,
  Payload,
>(
  eventName: Name,
  payload: Payload,
): payload is Payload & UltramodernWorkspaceEventPayloadMap[Name] =>
  Schema.is(ultramodernWorkspaceEventPayloadSchemas[eventName])(payload);

export const assertUltramodernWorkspaceEventPayload = <
  Name extends UltramodernWorkspaceEventName,
  Payload,
>(
  eventName: Name,
  payload: Payload,
): Payload & UltramodernWorkspaceEventPayloadMap[Name] => {
  if (!isUltramodernWorkspaceEventPayload(eventName, payload)) {
    throw new UltramodernWorkspaceEventValidationError(eventName, payload);
  }

  return payload;
};

export const createUltramodernWorkspaceEvent = <Name extends UltramodernWorkspaceEventName>(
  eventName: Name,
  payload: UltramodernWorkspaceEventPayloadMap[Name],
): CustomEvent<UltramodernWorkspaceEventPayloadMap[Name]> =>
  new CustomEvent(eventName, {
    bubbles: true,
    composed: true,
    detail: assertUltramodernWorkspaceEventPayload(eventName, payload),
  });

export const dispatchUltramodernWorkspaceEvent = <Name extends UltramodernWorkspaceEventName>(
  target: EventTarget,
  eventName: Name,
  payload: UltramodernWorkspaceEventPayloadMap[Name],
) => target.dispatchEvent(createUltramodernWorkspaceEvent(eventName, payload));

export const onUltramodernWorkspaceEvent = <Name extends UltramodernWorkspaceEventName>(
  target: EventTarget,
  eventName: Name,
  handler: (
    payload: UltramodernWorkspaceEventPayloadMap[Name],
    event: CustomEvent<UltramodernWorkspaceEventPayloadMap[Name]>,
  ) => void,
) => {
  const listener = (event: Event) => {
    if (!('detail' in event)) {
      throw new UltramodernWorkspaceEventValidationError(eventName, undefined);
    }
    const payload = event.detail;
    if (!Schema.is(ultramodernWorkspaceCustomEventSchema(eventName))(event)) {
      throw new UltramodernWorkspaceEventValidationError(eventName, payload);
    }

    handler(event.detail, event);
  };

  target.addEventListener(eventName, listener);

  return () => {
    target.removeEventListener(eventName, listener);
  };
};

export const dispatchUltramodernNavigate = (
  target: EventTarget,
  payload: UltramodernNavigatePayload,
) => dispatchUltramodernWorkspaceEvent(target, ultramodernWorkspaceEventNames.navigate, payload);

export const dispatchUltramodernRouteSettled = (
  target: EventTarget,
  payload: UltramodernRouteSettledPayload,
) =>
  dispatchUltramodernWorkspaceEvent(target, ultramodernWorkspaceEventNames.routeSettled, payload);

export const dispatchUltramodernRemoteReady = (
  target: EventTarget,
  payload: UltramodernRemoteReadyPayload,
) => dispatchUltramodernWorkspaceEvent(target, ultramodernWorkspaceEventNames.remoteReady, payload);

export const dispatchUltramodernPerformanceSignal = (
  target: EventTarget,
  payload: UltramodernPerformanceSignalPayload,
) =>
  dispatchUltramodernWorkspaceEvent(
    target,
    ultramodernWorkspaceEventNames.performanceSignal,
    payload,
  );

export const onUltramodernNavigate = (
  target: EventTarget,
  handler: (
    payload: UltramodernNavigatePayload,
    event: CustomEvent<UltramodernNavigatePayload>,
  ) => void,
) => onUltramodernWorkspaceEvent(target, ultramodernWorkspaceEventNames.navigate, handler);

export const onUltramodernRouteSettled = (
  target: EventTarget,
  handler: (
    payload: UltramodernRouteSettledPayload,
    event: CustomEvent<UltramodernRouteSettledPayload>,
  ) => void,
) => onUltramodernWorkspaceEvent(target, ultramodernWorkspaceEventNames.routeSettled, handler);

export const onUltramodernRemoteReady = (
  target: EventTarget,
  handler: (
    payload: UltramodernRemoteReadyPayload,
    event: CustomEvent<UltramodernRemoteReadyPayload>,
  ) => void,
) => onUltramodernWorkspaceEvent(target, ultramodernWorkspaceEventNames.remoteReady, handler);

export const onUltramodernPerformanceSignal = (
  target: EventTarget,
  handler: (
    payload: UltramodernPerformanceSignalPayload,
    event: CustomEvent<UltramodernPerformanceSignalPayload>,
  ) => void,
) => onUltramodernWorkspaceEvent(target, ultramodernWorkspaceEventNames.performanceSignal, handler);
