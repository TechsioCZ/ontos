import { ImportSymmyRulePayloadSchema } from '@app/assortment/actions/import-symmy-rule';
import { executeImportSymmyRuleWithAuthorization } from '@app/assortment/api/import-symmy-rule-action-client';
import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { executeImportSellerVatRegimeDeclarationsWithAuthorization } from '@app/tax/api/import-seller-vat-regime-declarations-action-client';
import { ImportSellerVatRegimeDeclarationsPayloadSchema } from '@app/tax/actions/import-seller-vat-regime-declarations';
import { Context, Crypto, Effect, Layer, Match, Option, Result, Schema } from 'effect';

import { symmyAssortmentRuleOperation } from '../../shared/domain/symmy-assortment-rule-mapping.ts';
import { symmySellerVatDeclarationOperation } from '../../shared/domain/symmy-seller-vat-declaration-mapping.ts';
import type { SymmyExecutionOutcome } from '../../shared/domain/symmy-job-execution.ts';
import {
  mapSymmyPolicyFixtureIntent,
  SymmyPolicyFixtureIntentSchema,
} from '../../shared/domain/symmy-policy-fixture-intents.ts';
import { symmyOwnerOperationRequirementKey } from '../../shared/domain/symmy-owner-operation-requirements.ts';
import type {
  SymmyEffectAdapter,
  SymmyEffectAdapterInput,
  SymmyOriginalEffectRecovery,
} from './symmy-effect-adapters.service.ts';
import { symmyJobWorkerInvalid, symmyJobWorkerUnavailable } from './symmy-job-worker-error.ts';
import { readOriginalOwnerAttempt } from './symmy-owner-request-recovery.ts';

const problemStatus = Schema.Struct({ status: Schema.Int });

const outcomeFor = (
  input: SymmyEffectAdapterInput,
  status: 'accepted_change' | 'conflict' | 'denied',
): SymmyExecutionOutcome => ({
  effectId: input.effect.ref.effectId,
  owner: input.effect.ref.operation.moduleId,
  status,
});

const policyFixtureOwners = [
  {
    audience: 'assortment',
    declarationKey: 'commerce.assortment.symmy-fixture-rule.import',
    operation: symmyAssortmentRuleOperation,
  },
  {
    audience: 'tax',
    declarationKey: 'commerce.tax.seller-vat-regime-declaration.import',
    operation: symmySellerVatDeclarationOperation,
  },
] as const;

const makePolicyFixtureAdapter = (
  contract: (typeof policyFixtureOwners)[number],
  crypto: Crypto.Crypto,
): SymmyEffectAdapter => {
  const { audience, declarationKey, operation } = contract;
  const requireCommittedInvocation = Effect.fn('SymmyPolicyFixture.requireCommittedInvocation')(
    function* requireCommitted(
      input: SymmyEffectAdapterInput,
      originalPrincipalId: string,
      requestHash: string,
      reportedInvocationId: string | null,
    ) {
      const invocation = yield* input.readOriginalActionInvocation({
        actionKey: operation.entrypointKey,
        idempotencyKey: input.effect.ref.effectId,
        originalPrincipalId,
        requestHash,
      });
      if (
        Option.isNone(invocation) ||
        invocation.value.status !== 'succeeded' ||
        (reportedInvocationId !== null && reportedInvocationId !== invocation.value.actionInvocationId)
      ) {
        return yield* symmyJobWorkerUnavailable();
      }
      return yield* input.recordInvocationId(invocation.value.actionInvocationId);
    },
  );

  const invoke = Effect.fn('SymmyPolicyFixture.invoke')(function* invoke(input: SymmyEffectAdapterInput) {
    const { context, effect, legalEntityId } = input;
    if (
      context === undefined ||
      !input.canExecuteNewEffects ||
      legalEntityId === undefined ||
      !Schema.is(SymmyPolicyFixtureIntentSchema)(effect.intent)
    ) {
      return yield* symmyJobWorkerInvalid();
    }

    const command = yield* mapSymmyPolicyFixtureIntent(effect.ref, effect.intent, input.routeKey, legalEntityId).pipe(
      Effect.mapError(symmyJobWorkerInvalid),
    );
    const normalizedPayload = yield* Match.value(command).pipe(
      Match.tags({
        AssortmentRuleFixture: ({ payload }) => Schema.encodeEffect(ImportSymmyRulePayloadSchema)(payload),
        SellerVatDeclarationFixture: ({ payload }) =>
          Schema.encodeEffect(ImportSellerVatRegimeDeclarationsPayloadSchema)(payload),
      }),
      Match.exhaustive,
      Effect.mapError(symmyJobWorkerInvalid),
    );
    const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(symmyJobWorkerUnavailable));
    const baseSubject = {
      _tag: 'RegisteredWorkload',
      context,
      declarationKey,
      legalEntityId,
      operationRequirementKey: symmyOwnerOperationRequirementKey('worker', operation.entrypointKey),
    } satisfies GatewayDelegationSubject;
    const subject =
      input.originalExecutorPrincipalId === undefined
        ? baseSubject
        : { ...baseSubject, expectedPrincipalId: input.originalExecutorPrincipalId };
    const gateway = yield* acquireDelegatedGatewayContext(
      { audience, legalEntityScope: 'subject', requestCorrelation, subject },
      crypto,
    ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    const machine = 'machineContext' in gateway ? gateway.machineContext : undefined;
    if (machine === undefined) {
      return yield* symmyJobWorkerUnavailable();
    }
    const requestHash = computeActionRequestHash({
      actionKey: operation.entrypointKey,
      normalizedPayload,
      owningModuleKey: operation.moduleId,
      principal: {
        legalEntityId,
        principalId: machine.principalId,
        tenantId: effect.ref.occurrence.record.route.tenantId,
      },
      schemaVersion: operation.schemaVersion,
      target: {},
    });
    if (
      (input.originalExecutorPrincipalId !== undefined && input.originalExecutorPrincipalId !== machine.principalId) ||
      (input.originalRequestHash !== undefined && input.originalRequestHash !== requestHash) ||
      (input.originalAuthContextRef !== undefined && input.originalAuthContextRef !== machine.authContextRef)
    ) {
      return yield* symmyJobWorkerInvalid();
    }
    yield* input.recordOwnerRequest({
      authContextRef: machine.authContextRef,
      executorPrincipalId: machine.principalId,
      requestHash,
    });
    const options = {
      baseUrl: gateway.apiBaseUrl,
      compositionRevision: gateway.compositionRevision,
      idempotencyKey: effect.ref.effectId,
    };
    const reportedInvocationId = yield* Match.value(command).pipe(
      Match.tags({
        AssortmentRuleFixture: ({ payload }) =>
          executeImportSymmyRuleWithAuthorization(payload, gateway.authorization, requestCorrelation, options).pipe(
            Effect.as(null),
            Effect.catchTags({
              ImportSymmyRuleActionAlreadyCommittedProblem: ({ invocationId }) => Effect.succeed(invocationId),
              ImportSymmyRuleActionCommitIndeterminateProblem: ({ invocationId }) => Effect.succeed(invocationId),
            }),
          ),
        SellerVatDeclarationFixture: ({ payload }) =>
          executeImportSellerVatRegimeDeclarationsWithAuthorization(
            payload,
            gateway.authorization,
            requestCorrelation,
            options,
          ).pipe(
            Effect.as(null),
            Effect.catchTags({
              ImportSellerVatRegimeDeclarationsActionAlreadyCommittedProblem: ({ invocationId }) =>
                Effect.succeed(invocationId),
              ImportSellerVatRegimeDeclarationsActionCommitIndeterminateProblem: ({ invocationId }) =>
                Effect.succeed(invocationId),
            }),
          ),
      }),
      Match.exhaustive,
    );
    yield* requireCommittedInvocation(input, machine.principalId, requestHash, reportedInvocationId);
    return outcomeFor(input, 'accepted_change');
  });

  return {
    execute: Effect.fn('SymmyPolicyFixture.execute')(function* execute(input) {
      const attempted = yield* Effect.result(invoke(input));
      if (Result.isSuccess(attempted)) {
        return attempted.success;
      }
      const error = attempted.failure;
      if (Schema.is(problemStatus)(error)) {
        if (error.status === 401 || error.status === 403) {
          return outcomeFor(input, 'denied');
        }
        if (error.status === 409) {
          return outcomeFor(input, 'conflict');
        }
      }
      return yield* symmyJobWorkerUnavailable(error);
    }),
    operation,
    recover: Effect.fn('SymmyPolicyFixture.recover')(function* recover(input): Effect.fn.Return<
      SymmyOriginalEffectRecovery,
      ReturnType<typeof symmyJobWorkerUnavailable>
    > {
      const original = yield* readOriginalOwnerAttempt(input);
      if (original.status !== 'committed') {
        return original;
      }
      // Both owner Actions succeed for a fixture only after committing its write. The exact
      // historical invocation proves that outcome without a new assertion or owner request.
      yield* input.recordInvocationId(original.invocationId);
      return { outcome: outcomeFor(input, 'accepted_change'), status: 'settled' };
    }),
  };
};

const makeSymmyPolicyFixtureAdapters = Effect.gen(function* makeFixtureAdapters() {
  const crypto = yield* Crypto.Crypto;
  return { adapters: policyFixtureOwners.map((contract) => makePolicyFixtureAdapter(contract, crypto)) };
});

export class SymmyPolicyFixtureAdapters extends Context.Service<
  SymmyPolicyFixtureAdapters,
  { readonly adapters: readonly SymmyEffectAdapter[] }
>()('@app/symmy-integration/services/symmy-policy-fixture-adapters/SymmyPolicyFixtureAdapters') {}

export const SymmyPolicyFixtureAdaptersLive = Layer.effect(SymmyPolicyFixtureAdapters, makeSymmyPolicyFixtureAdapters);
