/**
 * Where one connection description spends its time, for the `mcp.request` line: counts and summed milliseconds of
 * the spans the description already emits. Fixed names and numbers only, never an identity. Sums of concurrent
 * spans can exceed the description's wall time.
 */
import { Clock, Effect, Exit, Predicate, Schema, Tracer } from 'effect';

/** The parts a description's time is split into. */
const PartSchema = Schema.Literals(['cells', 'composition', 'configure', 'evidence', 'resolution', 'spicedb']);
type Part = typeof PartSchema.Type;

/** The span names that measure each part of a description. */
const PART_OF = new Map<string, Part>([
  ['TenantIntentLoader.loadAuthorityCellsMany', 'cells'],
  ['TenantIntentLoader.loadAuthorityCells', 'cells'],
  ['ActiveApplicationComposition.configuredActiveApplicationCompositionSnapshot', 'composition'],
  ['Mcp.loadCatalog', 'composition'],
  ['TenantIntentLoader.loadConfigureBases', 'configure'],
  ['AccessDecisionLog.recordAll', 'evidence'],
  ['SubjectInspection.resolve', 'resolution'],
  ['AccessDecision.spicedbCheckBulk', 'spicedb'],
]);

/** The breakdown the request line carries: per part milliseconds, plus the round trips counted. */
export interface DescriptionTiming {
  readonly cellsMs: number;
  readonly compositionMs: number;
  readonly configureMs: number;
  readonly evidenceMs: number;
  readonly resolutionMs: number;
  readonly spicedbCalls: number;
  readonly spicedbMs: number;
  readonly statements: number;
  readonly transactions: number;
}

/** The steps of a request whose own work runs elsewhere or spans many round trips, counted with their milliseconds. */
const STEP_OF = new Map<string, 'actionAuthority' | 'actions' | 'owner' | 'reads'>([
  ['ActionAuthority.checkActionAuthorities', 'actionAuthority'],
  ['ActionRuntime.runAction', 'actions'],
  ['ModuleApi.dispatchApprovedRequest', 'owner'],
  ['ReadRuntime.runRead', 'reads'],
]);

/**
 * What a request waited on beyond its own round trips: module owners (each a request to another process, whose own
 * work no counter here sees, with the phases the slowest one reported itself), Core Reads and Actions, and Action
 * authority checks. Counts and summed milliseconds; nested and concurrent steps each keep their own time.
 */
export interface RequestSteps {
  readonly actionAuthorityChecks: number;
  readonly actionAuthorityMs: number;
  readonly coreActionMs: number;
  readonly coreActions: number;
  readonly coreReadMs: number;
  readonly coreReads: number;
  readonly ownerCalls: number;
  readonly ownerMs: number;
  /** The slowest owner call: its app, its milliseconds and the phases it reported (`phase;dur=ms, …`). */
  readonly slowestOwner: string;
}

/** A tracer that counts the round trips and parts of the spans it sees, and passes every span on to `tracer`. */
const makeRoundTripCounter = (tracer: Tracer.Tracer) => {
  const ms = { cells: 0, composition: 0, configure: 0, evidence: 0, resolution: 0, spicedb: 0 };
  const counts = { spicedbCalls: 0, statements: 0, transactions: 0 };
  const steps = { actionAuthority: [0, 0], actions: [0, 0], owner: [0, 0], reads: [0, 0] };
  let slowestOwner = { app: '', ms: -1, timing: '' };
  const count = (name: string, elapsedMs: number, attributes: ReadonlyMap<string, unknown>) => {
    if (name === 'postgres') {
      counts.statements += 1;
    } else if (name === 'sql.transaction') {
      counts.transactions += 1;
    }
    const part = PART_OF.get(name);
    if (part !== undefined) {
      ms[part] += elapsedMs;
      counts.spicedbCalls += part === 'spicedb' ? 1 : 0;
    }
    const step = STEP_OF.get(name);
    if (step !== undefined) {
      const [calls = 0, total = 0] = steps[step];
      steps[step] = [calls + 1, total + elapsedMs];
    }
    if (step === 'owner' && elapsedMs > slowestOwner.ms) {
      const app = attributes.get('ontos.owner_app');
      const timing = attributes.get('ontos.owner_timing');
      slowestOwner = {
        app: Predicate.isString(app) ? app : '',
        ms: elapsedMs,
        timing: Predicate.isString(timing) ? timing : '',
      };
    }
  };
  const span: Tracer.Tracer['span'] = (options) => {
    const opened = tracer.span(options);
    const end = opened.end.bind(opened);
    const attribute = opened.attribute.bind(opened);
    const attributes = new Map<string, unknown>();
    opened.attribute = (key, value) => {
      attributes.set(key, value);
      attribute(key, value);
    };
    opened.end = (endTime, exit) => {
      end(endTime, exit);
      count(options.name, Number(endTime - options.startTime) / 1e6, attributes);
    };
    return opened;
  };
  // The request's own tracer keeps its context hook (span propagation of an exporter, for example), called on that
  // tracer as its own method, never on the counting one.
  const counting = Tracer.make(
    tracer.context === undefined ? { span } : { context: tracer.context.bind(tracer), span },
  );
  const timing = (): DescriptionTiming => ({
    cellsMs: Math.round(ms.cells),
    compositionMs: Math.round(ms.composition),
    configureMs: Math.round(ms.configure),
    evidenceMs: Math.round(ms.evidence),
    resolutionMs: Math.round(ms.resolution),
    spicedbCalls: counts.spicedbCalls,
    spicedbMs: Math.round(ms.spicedb),
    statements: counts.statements,
    transactions: counts.transactions,
  });
  const requestSteps = (): RequestSteps => ({
    actionAuthorityChecks: steps.actionAuthority[0] ?? 0,
    actionAuthorityMs: Math.round(steps.actionAuthority[1] ?? 0),
    coreActionMs: Math.round(steps.actions[1] ?? 0),
    coreActions: steps.actions[0] ?? 0,
    coreReadMs: Math.round(steps.reads[1] ?? 0),
    coreReads: steps.reads[0] ?? 0,
    ownerCalls: steps.owner[0] ?? 0,
    ownerMs: Math.round(steps.owner[1] ?? 0),
    slowestOwner:
      slowestOwner.ms < 0 ? '' : `${slowestOwner.app} ${Math.round(slowestOwner.ms)} ms: ${slowestOwner.timing}`,
  });
  return { counting, requestSteps, timing };
};

/** Runs `effect` with a tracer that also counts its spans; the spans still reach the request's own tracer. */
export const timedDescription = Effect.fn('Mcp.timedDescription')(function* timedDescription<A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const counter = makeRoundTripCounter(yield* Effect.tracer);
  const value = yield* effect.pipe(Effect.withTracer(counter.counting));
  return [value, counter.timing()] as const;
});

/**
 * Runs one request of `route` and logs its `agent-platform.request` line when it ends, succeeded or failed: its
 * milliseconds, the same round-trip counts and parts the `mcp.request` line carries, and what it waited on beyond
 * them (module owners, Core Reads and Actions, Action authority checks). Fixed names and numbers only.
 */
export const withRoundTripLog = Effect.fn('AgentPlatform.roundTripLog')(function* withRoundTripLog<A, E, R>(
  route: string,
  effect: Effect.Effect<A, E, R>,
) {
  const counter = makeRoundTripCounter(yield* Effect.tracer);
  const startedAt = yield* Clock.currentTimeMillis;
  return yield* effect.pipe(
    Effect.withTracer(counter.counting),
    Effect.onExit((exit) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((finishedAt) =>
          Effect.logInfo('agent-platform.request').pipe(
            Effect.annotateLogs({
              ...counter.timing(),
              ...counter.requestSteps(),
              outcome: Exit.isSuccess(exit) ? 'ok' : 'failed',
              route,
              totalMs: finishedAt - startedAt,
            }),
          ),
        ),
      ),
    ),
  );
});
