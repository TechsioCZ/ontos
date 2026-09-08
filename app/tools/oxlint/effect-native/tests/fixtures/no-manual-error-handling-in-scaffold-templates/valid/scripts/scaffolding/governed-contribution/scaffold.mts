import { Effect as E, Layer, Match, Schema } from "effect";
import * as Cause from "effect/Cause";

/**
 * The A8 target shape: the generated program discriminates failures through the contract-owned
 * TaggedError vocabulary with an exhaustive `Match`, and through `E.catchTags`.
 */
export const renderGovernedContribution = (problemStem: string): string => `
import { Effect, Match, Schema } from 'effect';

export class ${problemStem}InvalidProblem extends Schema.TaggedError<${problemStem}InvalidProblem>()(
  '${problemStem}InvalidProblem',
  { detail: Schema.String },
) {}

const readProblem = Match.type<ReadCoreError>().pipe(
  Match.tag('ReadInputValidationError', () => invalidProblem()),
  Match.tag('OperationAuthenticationRequired', () => authenticationProblem()),
  Match.tag('ReadPermissionDenied', () => forbiddenProblem()),
  Match.exhaustive,
);

const program = verifyOperationPrincipal(request.headers.authorization).pipe(
  Effect.catchTags({
    ActionPrincipalConfigurationError: () => Effect.fail(unavailableProblem()),
    ActionPrincipalUnavailableError: () => Effect.fail(unavailableProblem()),
  }),
  Effect.catchTag('ActionPrincipalInvalidError', () => Effect.fail(authenticationProblem())),
  Effect.catchCause((cause) => Effect.fail(internalProblem(Cause.pretty(cause)))),
);

const runtimeLayer = Layer.orDie(ApplicationLive);
const body = JSON.stringify({ ok: true });
const rows = items.map((item) => item.id).filter((id) => id.length > 0);
`;

/** Aliased and submodule namespace imports are irrelevant to this rule and must not confuse it. */
export const renderMatchOnly = (): string => `
  const decide = Match.type<Failure>().pipe(Match.tag('Missing', () => 0), Match.exhaustive);
  const guarded = E.catchTag('Missing', () => E.succeed(0));
  const described = Cause.pretty(cause);
`;

export const layerForTests = Layer.succeed(Schema.Void, undefined);
export const matched = Match.value(1);
export const effectValue = E.succeed(1);
