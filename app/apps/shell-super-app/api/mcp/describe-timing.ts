/**
 * Where one connection description spends its time, for the `mcp.request` line: counts and summed milliseconds of
 * the spans the description already emits. Fixed names and numbers only, never an identity. Sums of concurrent
 * spans can exceed the description's wall time.
 */
import { Effect, Schema, Tracer } from 'effect';

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

/** Runs `effect` with a tracer that also counts its spans; the spans still reach the request's own tracer. */
export const timedDescription = Effect.fn('Mcp.timedDescription')(function* timedDescription<A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const tracer = yield* Effect.tracer;
  const ms = { cells: 0, composition: 0, configure: 0, evidence: 0, resolution: 0, spicedb: 0 };
  const counts = { spicedbCalls: 0, statements: 0, transactions: 0 };
  const count = (name: string, elapsedMs: number) => {
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
  };
  const span: Tracer.Tracer['span'] = (options) => {
    const opened = tracer.span(options);
    const end = opened.end.bind(opened);
    opened.end = (endTime, exit) => {
      end(endTime, exit);
      count(options.name, Number(endTime - options.startTime) / 1e6);
    };
    return opened;
  };
  // The request's own tracer keeps its context hook (span propagation of an exporter, for example), called on that
  // tracer as its own method, never on the counting one.
  const counting = Tracer.make(
    tracer.context === undefined ? { span } : { context: tracer.context.bind(tracer), span },
  );
  const value = yield* effect.pipe(Effect.withTracer(counting));
  const timing: DescriptionTiming = {
    cellsMs: Math.round(ms.cells),
    compositionMs: Math.round(ms.composition),
    configureMs: Math.round(ms.configure),
    evidenceMs: Math.round(ms.evidence),
    resolutionMs: Math.round(ms.resolution),
    spicedbCalls: counts.spicedbCalls,
    spicedbMs: Math.round(ms.spicedb),
    statements: counts.statements,
    transactions: counts.transactions,
  };
  return [value, timing] as const;
});
