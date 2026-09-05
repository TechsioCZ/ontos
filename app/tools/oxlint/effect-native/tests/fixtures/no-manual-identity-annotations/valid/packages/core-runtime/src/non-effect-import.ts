// An `Effect` binding that does not come from `effect` or a blessed re-export barrel.
import { Effect } from './fake-effect.ts';

export const notEffect = Effect.annotateLogs({ correlationId: 'c-1', tenantId: 't-1' });
export const notEffectSpan = Effect.withSpan('fake', { attributes: { actionKey: 'a' } });
