import { Effect } from 'effect';

class Unavailable {
	readonly _tag = 'Unavailable';
	readonly status = 503;
}

class ActionPrincipalError {
	readonly _tag = 'ActionPrincipalConfigurationError';
}

/**
 * False positive reproduction — `verticals/contacts/api/read-server-support.ts:67`.
 *
 * Discriminating a *typed Effect error union* inside `Effect.catch`. Nothing here was decoded: both
 * arms are constructed in-process. This span is audit A4 ("`_tag ===` inside `Effect.catch`", cited at
 * exactly this line) and belongs to `no-manual-tag-comparison` / `Effect.catchTag`, not to A7's
 * document Schemas — the rule already exempts `_tag` for that reason, and `status` is the same ladder.
 */
export const handleSupport = (
	program: Effect.Effect<string, ActionPrincipalError | Unavailable>,
): Effect.Effect<string, ActionPrincipalError | Unavailable> =>
	program.pipe(
		Effect.catch((error: ActionPrincipalError | Unavailable) =>
			'status' in error ? Effect.fail(error) : Effect.succeed('recovered'),
		),
	);
