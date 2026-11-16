import {
  OrganizationBusinessOnboardTemplateSchema,
  organizationBusinessOnboardTemplateDigest,
  organizationBusinessSourceInputDigest,
} from '@app/party-registry/apis/organization-record-facts';
import type { OrganizationBusinessSourceReferenceSchema } from '@app/party-registry/apis/organization-record-facts';
import {
  ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
  OrganizationProfileSourceCreateTemplateSchema,
  fingerprintOrganizationProfileSourceCreateTemplate,
} from '@app/commerce-customer-context/domain/organization-profile-source';
import { Effect, Match, Option, Schema } from 'effect';
import { SymmyPinnedEffectSchema } from './symmy-job-execution.ts';
import type { SymmyPinnedEffect, SymmyPinnedJobPlan } from './symmy-job-execution.ts';
import { SymmyPartyCommerceIntentSchema } from './symmy-party-commerce-intents.ts';

export interface SymmyOrganizationNamedParent {
  readonly effectKey: string;
  readonly itemKey: string;
}
export interface SymmyAcceptedOrganizationProjection {
  readonly inputDigest: string;
  readonly parents: readonly SymmyOrganizationNamedParent[];
  readonly projectionVersion: string;
  readonly sourceReference: typeof OrganizationBusinessSourceReferenceSchema.Type;
}
const sourceMatches = (
  effect: SymmyPinnedEffect,
  reference: SymmyAcceptedOrganizationProjection['sourceReference'],
) => {
  const { occurrenceId, record } = effect.ref.occurrence;
  return (
    reference.occurrenceId === occurrenceId &&
    reference.recordId === record.sourceRecordId &&
    reference.source.issuer === record.issuerId &&
    reference.source.namespace === record.sourceNamespace &&
    reference.source.recordType === record.entityKind &&
    reference.source.routeRef === record.route.integrationRouteId
  );
};
const namedParent = (plan: SymmyPinnedJobPlan, child: SymmyPinnedEffect, reference: SymmyOrganizationNamedParent) => {
  const parents: SymmyPinnedEffect[] = [];
  for (const item of plan.items) {
    if (item.itemKey === reference.itemKey) {
      for (const effect of item.effects) {
        if (effect.effectKey === reference.effectKey) {
          parents.push(effect);
        }
      }
    }
  }
  const [parent] = parents;
  const declared = (child.dependsOn ?? []).some((dependency) =>
    Schema.is(Schema.String)(dependency)
      ? dependency === reference.effectKey && parent?.itemId === child.itemId
      : dependency.effectKey === reference.effectKey && dependency.itemKey === reference.itemKey,
  );
  return parents.length === 1 &&
    parent !== undefined &&
    declared &&
    parent.ref.occurrence.record.route.tenantId === child.ref.occurrence.record.route.tenantId
    ? Option.some(parent)
    : Option.none<SymmyPinnedEffect>();
};
const partyModule = 'party.registry';
const operationMatches = (effect: SymmyPinnedEffect, moduleId: string, entrypointKey: string) =>
  effect.ref.operation.moduleId === moduleId &&
  effect.ref.operation.entrypointKey === entrypointKey &&
  effect.ref.operation.schemaVersion === '1';
const baseProjection: (effect: SymmyPinnedEffect) => Effect.Effect<Option.Option<SymmyAcceptedOrganizationProjection>> =
  Effect.fn('SymmyOrganizationAccepted.base')(function* baseProjection(effect) {
    const intent = Schema.decodeUnknownOption(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })(
      effect.intent,
    );
    if (Option.isNone(intent)) {
      return Option.none();
    }
    const input = Match.value(intent.value).pipe(
      Match.tag('PartyCreate', (value) =>
        operationMatches(effect, partyModule, 'party.registry.create-party')
          ? Option.some({ operation: 'CREATE' as const, payload: value.payload })
          : Option.none(),
      ),
      Match.tag('PartyMatch', (value) =>
        operationMatches(effect, partyModule, 'party.registry.match-party')
          ? Option.some({ operation: 'MATCH' as const, payload: value.payload })
          : Option.none(),
      ),
      Match.orElse(() => Option.none()),
    );
    if (Option.isNone(input)) {
      return Option.none();
    }
    const projection = yield* organizationBusinessSourceInputDigest(input.value).pipe(Effect.option);
    return Option.isSome(projection) && sourceMatches(effect, projection.value.sourceReference)
      ? Option.some({ ...projection.value, parents: [] })
      : Option.none();
  });
const onboardProjection: (
  plan: SymmyPinnedJobPlan,
  effect: SymmyPinnedEffect,
) => Effect.Effect<Option.Option<SymmyAcceptedOrganizationProjection>> = Effect.fn('SymmyOrganizationAccepted.onboard')(
  function* onboardProjection(plan, effect) {
    if (!operationMatches(effect, partyModule, 'party.registry.counterparty-customer-onboard')) {
      return Option.none();
    }
    const intent = Schema.decodeUnknownOption(OrganizationBusinessOnboardTemplateSchema, { onExcessProperty: 'error' })(
      effect.intent,
    );
    if (Option.isNone(intent)) {
      return Option.none();
    }
    const { value } = intent;
    const parent = namedParent(plan, effect, value.fromPartyEffect);
    if (Option.isNone(parent) || Option.isNone(yield* baseProjection(parent.value))) {
      return Option.none();
    }
    const projection = yield* organizationBusinessOnboardTemplateDigest(value).pipe(Effect.option);
    return Option.isSome(projection) && sourceMatches(effect, projection.value.sourceReference)
      ? Option.some({
          inputDigest: projection.value.semanticInputDigest,
          parents: [value.fromPartyEffect],
          projectionVersion: projection.value.projectionVersion,
          sourceReference: projection.value.sourceReference,
        })
      : Option.none();
  },
);
/** Classification binds the accepted semantic DAG, never a guessed future native identifier. */
export const projectSymmyOrganizationAcceptedEffect: (
  plan: SymmyPinnedJobPlan,
  effect: SymmyPinnedEffect,
) => Effect.Effect<Option.Option<SymmyAcceptedOrganizationProjection>> = Effect.fn('SymmyOrganizationAccepted.project')(
  function* project(plan, effect) {
    const accepted: SymmyPinnedEffect[] = [];
    for (const item of plan.items) {
      for (const candidate of item.effects) {
        if (candidate.ref.effectId === effect.ref.effectId) {
          accepted.push(candidate);
        }
      }
    }
    if (
      accepted.length !== 1 ||
      accepted[0] === undefined ||
      !Schema.toEquivalence(Schema.toType(SymmyPinnedEffectSchema))(accepted[0], effect)
    ) {
      return Option.none();
    }
    const base = yield* baseProjection(effect);
    if (Option.isSome(base)) {
      return base;
    }
    const onboard = yield* onboardProjection(plan, effect);
    if (Option.isSome(onboard)) {
      return onboard;
    }
    if (
      !operationMatches(
        effect,
        'commerce.customer-context',
        'commerce.customer-context.create-counterparty-purchasing-profile',
      )
    ) {
      return Option.none();
    }
    const intent = Schema.decodeUnknownOption(OrganizationProfileSourceCreateTemplateSchema, {
      onExcessProperty: 'error',
    })(effect.intent);
    if (Option.isNone(intent)) {
      return Option.none();
    }
    const { value } = intent;
    const parent = namedParent(plan, effect, value.fromCounterpartyEffect);
    if (Option.isNone(parent)) {
      return Option.none();
    }
    const parentProjection = yield* onboardProjection(plan, parent.value);
    if (Option.isNone(parentProjection)) {
      return Option.none();
    }
    const encoded = yield* Schema.encodeEffect(OrganizationProfileSourceCreateTemplateSchema)(value).pipe(
      Effect.option,
    );
    if (Option.isNone(encoded)) {
      return Option.none();
    }
    const inputDigest = yield* fingerprintOrganizationProfileSourceCreateTemplate(encoded.value).pipe(Effect.option);
    const sourceReference = {
      occurrenceId: value.payload.source.occurrenceId,
      recordId: value.payload.source.recordId,
      source: {
        issuer: value.payload.source.issuer,
        namespace: value.payload.source.namespace,
        recordType: value.payload.source.recordType,
        routeRef: value.payload.source.route.id,
      },
    };
    return Option.isSome(inputDigest) && sourceMatches(effect, sourceReference)
      ? Option.some({
          inputDigest: inputDigest.value,
          parents: [value.fromCounterpartyEffect, ...parentProjection.value.parents],
          projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
          sourceReference,
        })
      : Option.none();
  },
);
