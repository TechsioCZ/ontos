import { Effect } from 'effect';

/**
 * `Effect` appears only in a *parameter* of the returned function — the contract itself returns
 * nothing effectful, the same shape `data-shapes.ts` already blesses one level up.
 */
export interface TelemetryAttachGateway {
  readonly forSpan: (name: string) => (effect: Effect.Effect<void>) => void;
}

export const attach = (gateway: TelemetryAttachGateway): void =>
  gateway.forSpan('span')(Effect.void);
