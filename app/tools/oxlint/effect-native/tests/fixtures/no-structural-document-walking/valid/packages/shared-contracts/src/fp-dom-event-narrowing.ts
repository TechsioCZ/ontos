import { Predicate } from 'effect';

/**
 * False positive reproduction — `packages/shared-contracts/src/index.ts:340`.
 *
 * Narrowing a live DOM `Event` to a `CustomEvent` by its own method. `event` is a host object, not a
 * decoded document: there is no Schema that can own `initCustomEvent`, and
 * `Schema.decodeUnknownEffect(..., { onExcessProperty: 'error' })` is not a possible remedy. Note the
 * sibling probe `'detail' in event` is already silent only because `detail` happens to sit in the
 * driver-failure `allowInKeys` vocabulary — proof the `in` detector never looks at the receiver.
 */
export const isWorkspaceCustomEvent = (event: Event): event is CustomEvent<unknown> =>
	'detail' in event && 'initCustomEvent' in event && Predicate.isFunction(event.initCustomEvent);
