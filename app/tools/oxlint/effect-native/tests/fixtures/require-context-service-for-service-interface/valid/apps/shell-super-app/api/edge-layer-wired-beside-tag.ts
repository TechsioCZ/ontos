import { Context, Effect, Layer } from 'effect';

import { PrincipalResolver } from './generic-tag.ts';

/** Its tag lives next door and is wired here — the same escape `layer-wired.ts` relies on. */
export interface PrincipalSessionRepositoryPort {
  readonly resolve: (id: string) => Effect.Effect<string, Error>;
}

export const PrincipalSessionRepositoryLive = Layer.effect(
  PrincipalResolver,
  // B4: explicit contract evidence, not blanket suppression from unrelated Layer construction.
  Effect.succeed({ resolve: (id: string) => Effect.succeed(id) } satisfies PrincipalSessionRepositoryPort),
);

/** …and this module additionally declares a tag of its own for an unrelated contract. */
export interface PrincipalAuditSinkPort {
  readonly record: (event: string) => Effect.Effect<void, Error>;
}

export class PrincipalAuditSink extends Context.Service<PrincipalAuditSink, PrincipalAuditSinkPort>()(
  '@app/shell-super-app/api/PrincipalAuditSink',
) {}
