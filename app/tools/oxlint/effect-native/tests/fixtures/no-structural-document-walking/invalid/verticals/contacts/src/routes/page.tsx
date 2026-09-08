// expect-count: 3
import { Predicate } from 'effect';

export const lifecycleOf = (decoded: Record<string, unknown>): string => {
  if ('ontosLifecycle' in decoded && decoded['ontosLifecycle'] === 'binding_pending_v1') {
    return 'pending';
  }
  if (!Predicate.isObjectKeyword(decoded['profile'])) {
    return 'unknown';
  }
  return decoded.hasOwnProperty('displayName') ? 'named' : 'anonymous';
};

export const LifecyclePanel = (): JSX.Element => <div>{lifecycleOf({})}</div>;
