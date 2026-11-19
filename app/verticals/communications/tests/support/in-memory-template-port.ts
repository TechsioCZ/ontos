import { Array as EffectArray, Crypto, DateTime, Effect, Option } from 'effect';
import { templateScopeKey } from '../../shared/template-revision.ts';
import type { TemplateIdentity } from '../../shared/template-revision.ts';
import { TemplateStoreUnavailable } from '../../shared/template-revision-errors.ts';
import type {
  TemplateActivationEnding,
  TemplateActivationRecord,
  TemplateInvalidationRecord,
  TemplateRevisionPortContract,
  TemplateRevisionRecord,
  TemplateTypeRecord,
} from '../../src/services/template-revision-port.service.ts';

const sameIdentity = (left: TemplateIdentity, right: TemplateIdentity) =>
  left.messageType === right.messageType &&
  left.channel === right.channel &&
  left.language === right.language &&
  templateScopeKey(left.scope) === templateScopeKey(right.scope);
const isOpen = (activation: TemplateActivationRecord) => Option.isNone(activation.ending);
const instantsOf = (activation: TemplateActivationRecord) => [
  activation.activatedAt,
  ...Option.match(activation.ending, { onNone: () => [], onSome: (ending) => [ending.endedAt] }),
];
const unavailable = () =>
  new TemplateStoreUnavailable({ code: 'template_store_unavailable', reason: 'Template storage is unavailable' });
const newId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(Effect.orDie);

interface InMemoryState {
  activations: TemplateActivationRecord[];
  clock: DateTime.Utc;
  invalidations: TemplateInvalidationRecord[];
  revisions: TemplateRevisionRecord[];
  types: TemplateTypeRecord[];
}

/** Same port contract as the PostgreSQL form, in memory: lets the rule tests run without a database. */
export const makeInMemoryTemplatePort = (startAt = '2026-11-19T10:00:00Z') => {
  const state: InMemoryState = {
    activations: [],
    clock: DateTime.makeUnsafe(startAt),
    invalidations: [],
    revisions: [],
    types: [],
  };
  const port: TemplateRevisionPortContract = {
    activationsAt: (templateTypeId, at) =>
      Effect.succeed(
        state.activations.filter(
          (activation) =>
            activation.templateTypeId === templateTypeId &&
            DateTime.isLessThanOrEqualTo(activation.activatedAt, at) &&
            Option.match(activation.ending, {
              onNone: () => true,
              onSome: (ending) => DateTime.isGreaterThan(ending.endedAt, at),
            }),
        ),
      ),
    activationsOfRevision: (revisionId) =>
      Effect.succeed(state.activations.filter((activation) => activation.revisionId === revisionId)),
    appendActivation: (input) =>
      Effect.gen(function* append() {
        // The PostgreSQL form enforces this with a partial unique index; the fake keeps the same promise.
        if (state.activations.some((found) => found.templateTypeId === input.templateTypeId && isOpen(found))) {
          return yield* unavailable();
        }
        const record: TemplateActivationRecord = {
          activatedAt: input.activatedAt,
          activatedByPrincipalId: input.activatedByPrincipalId,
          activationId: yield* newId,
          activationReason: input.activationReason,
          ending: Option.none(),
          revisionId: input.revisionId,
          scopeKey: input.scopeKey,
          templateTypeId: input.templateTypeId,
        };
        state.activations.push(record);
        return record;
      }),
    appendInvalidation: (input) =>
      Effect.sync(() => {
        state.invalidations.push(input);
      }),
    appendRevision: (input) =>
      Effect.gen(function* append() {
        const record: TemplateRevisionRecord = {
          body: input.body,
          contentDigest: input.contentDigest,
          createdAt: input.at,
          createdByPrincipalId: input.principalId,
          optionalPlaceholders: input.optionalPlaceholders,
          placeholdersUsed: input.placeholdersUsed,
          reason: input.reason,
          requiredPlaceholders: input.requiredPlaceholders,
          revisionId: yield* newId,
          revisionNumber:
            state.revisions.filter((revision) => revision.templateTypeId === input.templateTypeId).length + 1,
          subject: input.subject,
          templateTypeId: input.templateTypeId,
        };
        state.revisions.push(record);
        return record;
      }),
    // The PostgreSQL form refuses to close a closed row (guard and trigger) and a period that ends before it started.
    clockNow: Effect.sync(() => state.clock),
    closeActivation: (activationId, ending: TemplateActivationEnding & { readonly actionInvocationId: string }) =>
      Effect.gen(function* close() {
        const index = state.activations.findIndex((activation) => activation.activationId === activationId);
        const found = state.activations[index];
        if (found === undefined || !isOpen(found) || DateTime.isLessThan(ending.endedAt, found.activatedAt)) {
          yield* unavailable();
        } else {
          state.activations[index] = { ...found, ending: Option.some(ending) };
        }
      }),
    ensureType: (input) =>
      Effect.gen(function* ensure() {
        const existing = state.types.find((type) => sameIdentity(type.identity, input.identity));
        if (existing !== undefined) {
          return existing;
        }
        const record: TemplateTypeRecord = {
          createdAt: input.at,
          createdByPrincipalId: input.principalId,
          identity: input.identity,
          templateTypeId: yield* newId,
        };
        state.types.push(record);
        return record;
      }),
    findInvalidation: (revisionId) =>
      Effect.succeed(Option.fromNullishOr(state.invalidations.find((found) => found.revisionId === revisionId))),
    findType: (identity) =>
      Effect.succeed(Option.fromNullishOr(state.types.find((type) => sameIdentity(type.identity, identity)))),
    latestActivityAt: (templateTypeId) =>
      Effect.sync(() => {
        const instants = state.activations.flatMap((activation) =>
          activation.templateTypeId === templateTypeId ? instantsOf(activation) : [],
        );
        return EffectArray.isArrayNonEmpty(instants)
          ? Option.some(EffectArray.max(instants, DateTime.Order))
          : Option.none();
      }),
    loadRevision: (revisionId) =>
      Effect.succeed(Option.fromNullishOr(state.revisions.find((revision) => revision.revisionId === revisionId))),
    loadType: (templateTypeId) =>
      Effect.succeed(Option.fromNullishOr(state.types.find((type) => type.templateTypeId === templateTypeId))),
    lockType: (templateTypeId) =>
      Effect.succeed(Option.fromNullishOr(state.types.find((type) => type.templateTypeId === templateTypeId))),
    lockTypeShared: () => Effect.void,
    openActivations: (templateTypeId) =>
      Effect.succeed(
        state.activations.filter((activation) => activation.templateTypeId === templateTypeId && isOpen(activation)),
      ),
  };
  return {
    advance: (minutes: number) => {
      state.clock = DateTime.add(state.clock, { minutes });
    },
    /** Sets the clock outright, e.g. to a value that lags an activation another writer already committed. */
    port,
    setClock: (at: string) => {
      state.clock = DateTime.makeUnsafe(at);
    },
    state,
  };
};
