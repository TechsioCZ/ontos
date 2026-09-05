import { HttpApiClient } from 'effect/unstable/httpapi';
import * as bff from '@modern-js/plugin-bff/effect-client';
import { makeEffectHttpApiClient } from './unrelated.ts';
export const unrelated = () => makeEffectHttpApiClient();
export function shadowed(HttpApiClient: { make(): unknown }) { return HttpApiClient.make(); }
export function shadowedBarrel(bff: { makeEffectHttpApiClient(): unknown }) {
  return bff.makeEffectHttpApiClient();
}
void HttpApiClient; void bff;
