import { Predicate } from 'effect';
import type { Schema } from 'effect';

export {
  GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_ASSERTION_VERSION,
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

export type UltramodernPublicSitemapChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

export interface UltramodernPublicSitemapEntry {
  /**
   * Params used to expand every localized route pattern, for example
   * { slug: 'platform-story' } for /talks/:slug.
   */
  params: Record<string, string | number | boolean>;
  /**
   * Per-locale overrides when translated URLs use translated params.
   */
  localeParams?: Partial<Record<'en' | 'cs', Record<string, string | number | boolean>>>;
  draft?: boolean;
  indexable?: boolean;
  lastModified?: string;
  changeFrequency?: UltramodernPublicSitemapChangeFrequency;
  priority?: number;
}

export type UltramodernPerformanceReadinessSignalId =
  | 'bfcache'
  | 'core-web-vitals-rum'
  | 'duplicate-prefetch-warmup'
  | 'cache-policy-sanity'
  | 'save-data-behavior'
  | 'cloudflare-ssr-cache-hints';

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

export type UltramodernWorkspaceLocale = 'en' | 'cs';

export type UltramodernPerformanceReadinessSignalStatus = 'pass' | 'warn' | 'fail';

export const ultramodernWorkspaceEventNames = {
  navigate: 'ultramodern:navigate',
  performanceSignal: 'ultramodern:performance-signal',
  remoteReady: 'ultramodern:remote-ready',
  routeSettled: 'ultramodern:route-settled',
} as const;

export type UltramodernWorkspaceEventName =
  (typeof ultramodernWorkspaceEventNames)[keyof typeof ultramodernWorkspaceEventNames];

export type UltramodernWorkspaceJsonObject = Readonly<
  Record<string, Schema.Schema.Type<typeof Schema.Json>>
>;

export interface UltramodernNavigatePayload {
  to: string;
  replace?: boolean;
  state?: UltramodernWorkspaceJsonObject;
}

export interface UltramodernRouteSettledPayload {
  pathname: string;
  locale?: UltramodernWorkspaceLocale;
  title?: string;
}

export interface UltramodernRemoteReadyPayload {
  appId: string;
  build?: string;
  surface?: string;
  version?: string;
}

export interface UltramodernPerformanceSignalPayload {
  signalId: UltramodernPerformanceReadinessSignalId;
  status: UltramodernPerformanceReadinessSignalStatus;
  durationMs?: number;
  detail?: UltramodernWorkspaceJsonObject;
}

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

const isRecord = <Value>(value: Value): value is Value & object =>
  Predicate.isObjectKeyword(value) && value !== null && !Array.isArray(value);

const isNonEmptyString = <Value>(value: Value): value is Value & string =>
  Predicate.isString(value) && value.trim().length > 0;

const isNonNegativeNumber = <Value>(value: Value): value is Value & number =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0;

const isUltramodernWorkspaceLocale = <Value>(
  value: Value,
): value is Value & UltramodernWorkspaceLocale => value === 'en' || value === 'cs';

const isPerformanceReadinessSignalId = <Value>(
  value: Value,
): value is Value & UltramodernPerformanceReadinessSignalId =>
  value === 'bfcache' ||
  value === 'core-web-vitals-rum' ||
  value === 'duplicate-prefetch-warmup' ||
  value === 'cache-policy-sanity' ||
  value === 'save-data-behavior' ||
  value === 'cloudflare-ssr-cache-hints';

const isPerformanceReadinessSignalStatus = <Value>(
  value: Value,
): value is Value & UltramodernPerformanceReadinessSignalStatus =>
  value === 'pass' || value === 'warn' || value === 'fail';

const optionalProperty = <Value extends object, Key extends string>(
  value: Value,
  key: Key,
): { readonly present: false } | { readonly present: true; readonly value: unknown } => {
  const entry = Object.entries(value).find(([entryKey]) => entryKey === key);
  return entry === undefined ? { present: false } : { present: true, value: entry[1] };
};

const hasOptionalString = <Value extends object, Key extends string>(value: Value, key: Key) => {
  const property = optionalProperty(value, key);
  return !property.present || property.value === undefined || isNonEmptyString(property.value);
};

const hasOptionalBoolean = <Value extends object, Key extends string>(value: Value, key: Key) => {
  const property = optionalProperty(value, key);
  return !property.present || property.value === undefined || Predicate.isBoolean(property.value);
};

const hasOptionalRecord = <Value extends object, Key extends string>(value: Value, key: Key) => {
  const property = optionalProperty(value, key);
  return !property.present || property.value === undefined || isRecord(property.value);
};

const hasOptionalNonNegativeNumber = <Value extends object, Key extends string>(
  value: Value,
  key: Key,
) => {
  const property = optionalProperty(value, key);
  return !property.present || property.value === undefined || isNonNegativeNumber(property.value);
};

const hasOptionalLocale = <Value extends object, Key extends string>(value: Value, key: Key) => {
  const property = optionalProperty(value, key);
  return (
    !property.present ||
    property.value === undefined ||
    isUltramodernWorkspaceLocale(property.value)
  );
};

export const isUltramodernNavigatePayload = <Payload>(
  payload: Payload,
): payload is Payload & UltramodernNavigatePayload =>
  isRecord(payload) &&
  'to' in payload &&
  isNonEmptyString(payload.to) &&
  hasOptionalBoolean(payload, 'replace') &&
  hasOptionalRecord(payload, 'state');

export const isUltramodernRouteSettledPayload = <Payload>(
  payload: Payload,
): payload is Payload & UltramodernRouteSettledPayload =>
  isRecord(payload) &&
  'pathname' in payload &&
  isNonEmptyString(payload.pathname) &&
  hasOptionalLocale(payload, 'locale') &&
  hasOptionalString(payload, 'title');

export const isUltramodernRemoteReadyPayload = <Payload>(
  payload: Payload,
): payload is Payload & UltramodernRemoteReadyPayload =>
  isRecord(payload) &&
  'appId' in payload &&
  isNonEmptyString(payload.appId) &&
  hasOptionalString(payload, 'build') &&
  hasOptionalString(payload, 'surface') &&
  hasOptionalString(payload, 'version');

export const isUltramodernPerformanceSignalPayload = <Payload>(
  payload: Payload,
): payload is Payload & UltramodernPerformanceSignalPayload =>
  isRecord(payload) &&
  'signalId' in payload &&
  isPerformanceReadinessSignalId(payload.signalId) &&
  'status' in payload &&
  isPerformanceReadinessSignalStatus(payload.status) &&
  hasOptionalNonNegativeNumber(payload, 'durationMs') &&
  hasOptionalRecord(payload, 'detail');

const ultramodernWorkspaceEventValidators = {
  [ultramodernWorkspaceEventNames.navigate]: isUltramodernNavigatePayload,
  [ultramodernWorkspaceEventNames.performanceSignal]: isUltramodernPerformanceSignalPayload,
  [ultramodernWorkspaceEventNames.remoteReady]: isUltramodernRemoteReadyPayload,
  [ultramodernWorkspaceEventNames.routeSettled]: isUltramodernRouteSettledPayload,
} satisfies {
  [Name in UltramodernWorkspaceEventName]: <Payload>(
    payload: Payload,
  ) => payload is Payload & UltramodernWorkspaceEventPayloadMap[Name];
};

export const isUltramodernWorkspaceEventPayload = <
  Name extends UltramodernWorkspaceEventName,
  Payload,
>(
  eventName: Name,
  payload: Payload,
): payload is Payload & UltramodernWorkspaceEventPayloadMap[Name] =>
  ultramodernWorkspaceEventValidators[eventName](payload);

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

const isUltramodernWorkspaceCustomEvent = <Name extends UltramodernWorkspaceEventName>(
  eventName: Name,
  event: Event,
): event is CustomEvent<UltramodernWorkspaceEventPayloadMap[Name]> =>
  'detail' in event &&
  'initCustomEvent' in event &&
  Predicate.isFunction(event.initCustomEvent) &&
  isUltramodernWorkspaceEventPayload(eventName, event.detail);

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
    if (!isUltramodernWorkspaceCustomEvent(eventName, event)) {
      throw new UltramodernWorkspaceEventValidationError(eventName, event.detail);
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
