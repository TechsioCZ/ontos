// expect-count: 2
// Both shapes exist verbatim in production route modules that currently report nothing:
// `apps/shell-super-app/src/routes/[lang]/search/page.data.ts` (Effect.catch) and
// `apps/shell-super-app/src/routes/[lang]/login/page.tsx` (Promise `.catch` after the adapter).
import { Effect } from 'effect';

type ShellError = { readonly _tag: 'ShellSelectionRequiredProblem' | 'ShellTargetForbiddenProblem' };
type PageModel = { readonly state: string };

declare const search: Effect.Effect<PageModel, ShellError>;
declare const runEffectRequest: <A>(effect: Effect.Effect<A, never>) => Promise<A>;
declare const signIn: () => Promise<void>;

export const loader = () =>
  runEffectRequest(
    search.pipe(
      Effect.catch((error) =>
        Effect.succeed<PageModel>({
          state:
            error._tag === 'ShellSelectionRequiredProblem' ? 'selection_required' : 'unavailable',
        }),
      ),
    ),
  );

export const submit = () =>
  signIn().catch((error: ShellError) =>
    error._tag === 'ShellTargetForbiddenProblem' ? 'forbidden' : 'unavailable',
  );
