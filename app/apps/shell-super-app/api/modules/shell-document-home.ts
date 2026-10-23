import { legalEntityDetailRead, ReadRuntime } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Context, Effect, Match, Option } from 'effect';

import type { ShellComposition, ShellDocumentHome, ShellHomeContribution } from '../../shared/api.ts';
import { presentedShellNavigationItems } from '../../shared/shell-platform-navigation.ts';
import { ShellGovernedReads } from './shell-governed-reads.ts';

interface DocumentHomeInput {
  readonly canManagePeople: boolean;
  readonly composition: Extract<ShellComposition, { readonly state: 'available' }>;
  readonly principal: TrustedPrincipalContext & { readonly legalEntityId: string };
}

export class DocumentHomeCorrelationId extends Context.Service<DocumentHomeCorrelationId, string>()(
  '@app/shell-super-app/api/modules/shell-document-home/DocumentHomeCorrelationId',
) {}

/** Uses the document's captured catalog and permission-decision scope, but retains full governed-read admission. */
export const resolveDocumentHome = Effect.fn('ShellDocument.resolveHome')(function* resolveDocumentHomeEffect({
  canManagePeople,
  composition,
  principal,
}: DocumentHomeInput) {
  const correlationId = yield* DocumentHomeCorrelationId;
  const reads = yield* ShellGovernedReads;
  const visibleModules = new Set(
    presentedShellNavigationItems(composition.navigation, canManagePeople).map(({ moduleId }) => String(moduleId)),
  );
  const candidates = composition.homeComponents.filter(({ requiresModules }) =>
    requiresModules.every((moduleId) => visibleModules.has(moduleId)),
  );
  const tryFrom = (index: number): Effect.Effect<ShellHomeContribution> => {
    const candidate = candidates[index];
    if (candidate === undefined) {
      return Effect.succeed({ state: 'forbidden' });
    }
    return reads
      .moduleTarget({
        compositionRevision: composition.compositionRevision,
        correlationId,
        entrypointKey: candidate.entrypointKey,
        moduleId: candidate.moduleId,
        principal,
      })
      .pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Match.value(error).pipe(
              Match.tags({
                ModuleStateDeniedError: () => true,
                OperationContextDenied: () => true,
                ReadHandlerNotFound: () => true,
                ReadPermissionDenied: () => true,
              }),
              Match.orElse(() => false),
            )
              ? tryFrom(index + 1)
              : Effect.succeed<ShellHomeContribution>({ state: 'unavailable' }),
          onSuccess: (target) => Effect.succeed<ShellHomeContribution>({ state: 'ready', target }),
        }),
      );
  };
  const contribution = yield* tryFrom(0);
  if (contribution.state !== 'forbidden') {
    return { contribution } satisfies ShellDocumentHome;
  }
  // The company's text remains a governed Core read, only for people shown the welcome page.
  const runtime = yield* ReadRuntime;
  const welcome = yield* runtime
    .runRead({
      input: {
        legalEntityRef: {
          moduleId: 'core.identity',
          resourceId: principal.legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId: principal.tenantId,
        },
      },
      principal,
      registration: legalEntityDetailRead,
      transport: { correlationId },
    })
    .pipe(
      Effect.map((response) => Option.fromUndefinedOr(response.welcome)),
      Effect.orElseSucceed(Option.none),
    );
  return Option.match(welcome, {
    onNone: (): ShellDocumentHome => ({ contribution }),
    onSome: (text): ShellDocumentHome => ({ contribution, welcome: text }),
  });
});
