/** What the stage warm-up gate has read of its declared set, and the failure for having read less than all of it. */
import { Option, Schema } from 'effect';

/** One persona: the menu it declared once logged in, the destinations it read, and the phase that stopped it. */
export interface PersonaCoverage {
  readonly declared: Option.Option<readonly string[]>;
  readonly failed: Option.Option<string>;
  readonly visited: readonly string[];
}

/** Every persona the sweep has heard from, by email. A persona that never logged in is absent. */
export type WarmupCoverage = ReadonlyMap<string, PersonaCoverage>;

const NOTHING: PersonaCoverage = { declared: Option.none(), failed: Option.none(), visited: [] };

const updatePersona = (coverage: WarmupCoverage, email: string, update: (held: PersonaCoverage) => PersonaCoverage) =>
  new Map(coverage).set(email, update(coverage.get(email) ?? NOTHING));

/** The persona logged in and was served this menu: its declared destinations. */
export const declareMenu = (coverage: WarmupCoverage, email: string, declared: readonly string[]): WarmupCoverage =>
  updatePersona(coverage, email, (held) => ({ ...held, declared: Option.some(declared) }));

/** The persona read this destination and its visible text passed. */
export const recordVisit = (coverage: WarmupCoverage, email: string, destination: string): WarmupCoverage =>
  updatePersona(coverage, email, (held) => ({ ...held, visited: [...held.visited, destination] }));

/** The persona stopped at this phase (`login:<email>`, `destination:<path>`, ...). */
export const recordFailure = (coverage: WarmupCoverage, email: string, phase: string): WarmupCoverage =>
  updatePersona(coverage, email, (held) => ({ ...held, failed: Option.some(phase) }));

const stoppedAt = (persona: PersonaCoverage) =>
  Option.match(persona.failed, { onNone: () => '', onSome: (phase) => ` (stopped at ${phase})` });

/**
 * What the sweep left unverified, one line per persona: a persona that never declared its menu, declared an empty one,
 * or left a declared destination unread. Empty only when every persona declared a menu and read all of it, however
 * the sweep ended: a fast failure and an expired budget leave the same gap.
 */
export const warmupGaps = (personas: readonly string[], coverage: WarmupCoverage): readonly string[] =>
  personas.flatMap((email) => {
    const persona = coverage.get(email) ?? NOTHING;
    return Option.match(persona.declared, {
      onNone: () => [`${email} did not log in and declare its menu${stoppedAt(persona)}`],
      onSome: (declared) => {
        if (declared.length === 0) {
          return [`${email} declared no destination`];
        }
        const unread = declared.filter((destination) => !persona.visited.includes(destination));
        return unread.length === 0
          ? []
          : [
              `${email} left ${unread.length}/${declared.length} destinations unread${stoppedAt(persona)}: ${unread.join(', ')}`,
            ];
      },
    });
  });

/** The declared and read destination counts of the sweep, for its report. */
export const destinationCounts = (coverage: WarmupCoverage) => {
  const personas = [...coverage.values()];
  return {
    declaredDestinations: personas.flatMap(({ declared }) => Option.getOrElse(declared, () => [])).length,
    visitedDestinations: personas.flatMap(({ visited }) => visited).length,
  };
};

/**
 * The sweep ended with a declared persona or destination unread, so the only stage-side gate against a visible UUID,
 * internal key or digest did not run over its declared set. That fails the verification on every exit, not only when
 * the budget expired.
 */
export class StageWarmupIncompleteError extends Schema.TaggedError<StageWarmupIncompleteError>()(
  'StageWarmupIncompleteError',
  {
    declaredDestinations: Schema.Number,
    declaredPersonas: Schema.Number,
    durationMs: Schema.Number,
    gaps: Schema.Array(Schema.String),
    visitedDestinations: Schema.Number,
  },
) {}
