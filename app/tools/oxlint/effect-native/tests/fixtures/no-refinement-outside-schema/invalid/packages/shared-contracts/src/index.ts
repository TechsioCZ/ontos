// expect-count: 6
import { Predicate } from 'effect';

export type WorkspaceLocale = 'cs' | 'en';
export interface WorkspaceEventPayloadMap {
  readonly navigate: { readonly href: string };
}

// A2 evidence: packages/shared-contracts/src/index.ts:178-209 — six hand-written refinements that
// duplicate, in TypeScript control flow, the validation the workspace-event Schemas already own.
const isRecord = <Value>(value: Value): value is Value & object =>
  Predicate.isObjectKeyword(value) && value !== null && !Array.isArray(value);

const isNonEmptyString = <Value>(value: Value): value is Value & string =>
  Predicate.isString(value) && value.trim().length > 0;

const isNonNegativeNumber = <Value>(value: Value): value is Value & number =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0;

const isWorkspaceLocale = <Value>(value: Value): value is Value & WorkspaceLocale =>
  value === 'en' || value === 'cs';

const isNavigatePayload = <Name extends keyof WorkspaceEventPayloadMap>(
  name: Name,
  payload: unknown,
): payload is WorkspaceEventPayloadMap[Name] =>
  isRecord(payload) && 'href' in payload && isNonEmptyString(payload.href) && name === 'navigate';

const isWorkspaceCustomEvent = <Name extends keyof WorkspaceEventPayloadMap>(
  name: Name,
  event: Event,
): event is CustomEvent<WorkspaceEventPayloadMap[Name]> =>
  'detail' in event && 'initCustomEvent' in event && isNavigatePayload(name, event.detail);

export const guards = {
  isNonNegativeNumber,
  isRecord,
  isWorkspaceCustomEvent,
  isWorkspaceLocale,
};
