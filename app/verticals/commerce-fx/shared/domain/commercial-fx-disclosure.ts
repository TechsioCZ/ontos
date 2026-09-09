import { Context, Effect, Layer, Schema } from 'effect';
import {
  FxConversionRedactedSchema,
  FxConversionResolvedSchema,
  SameCurrencyNoConversionSchema,
} from './commercial-fx-conversion.ts';
import type {
  CommercialFxConversionSuccess,
  FxConversionResolved,
} from './commercial-fx-conversion.ts';

export const CommercialFxDisclosureDecisionSchema = Schema.Literals(['EXACT', 'REDACTED']);
export type CommercialFxDisclosureDecision = typeof CommercialFxDisclosureDecisionSchema.Type;

export interface CommercialFxDisclosureScope {
  readonly authMethod: 'api_key' | 'session' | 'support_impersonation' | 'system';
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly trustedStorefrontId: string;
}

export interface CommercialFxDisclosurePolicyService {
  readonly decide: (input: {
    readonly result: FxConversionResolved;
    readonly scope: CommercialFxDisclosureScope;
  }) => Effect.Effect<CommercialFxDisclosureDecision>;
}

export interface PurchaseLimitFxEvidenceConsumerGrant {
  /** The credential provenance accepted for this exact deployment grant. */
  readonly authMethod: 'api_key' | 'system';
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly trustedStorefrontId: string;
}

/** Trusted deployment policy deciding whether commercially sensitive quote evidence may leave the Read. */
export class CommercialFxDisclosurePolicy extends Context.Service<
  CommercialFxDisclosurePolicy,
  CommercialFxDisclosurePolicyService
>()('@app/commerce-fx/shared/domain/commercial-fx-disclosure/CommercialFxDisclosurePolicy') {}

/** Secure default: conversion remains usable, but rate/source/provider evidence is omitted. */
export const redactCommercialFxEvidence: CommercialFxDisclosurePolicyService = Object.freeze({
  decide: () => Effect.succeed('REDACTED' as const),
});

/**
 * Grants exact evidence only to one deployment-configured server principal for Purchase Limit
 * comparison in its exact verified Tenant, Legal Entity, and Storefront scope. The API-key form
 * is used by the owner-local server credential path; a public/session caller cannot opt into it.
 * Purpose alone is never authority because it is public request data.
 */
export const makePurchaseLimitCommercialFxDisclosurePolicy = (
  grant: PurchaseLimitFxEvidenceConsumerGrant,
): CommercialFxDisclosurePolicyService => ({
  decide: ({ result, scope }) =>
    Effect.succeed(
      result.purpose === 'PURCHASE_LIMIT_COMPARISON' &&
        scope.authMethod === grant.authMethod &&
        scope.principalId === grant.principalId &&
        scope.tenantId === grant.tenantId &&
        scope.legalEntityId === grant.legalEntityId &&
        scope.trustedStorefrontId === grant.trustedStorefrontId
        ? ('EXACT' as const)
        : ('REDACTED' as const),
    ),
});

/** Deployment Layer for one exact trusted Purchase Limit server-consumer scope. */
export const purchaseLimitCommercialFxDisclosurePolicyLive = (
  grant: PurchaseLimitFxEvidenceConsumerGrant,
) =>
  Layer.succeed(CommercialFxDisclosurePolicy, makePurchaseLimitCommercialFxDisclosurePolicy(grant));

const redactResolvedConversion = (result: FxConversionResolved) =>
  FxConversionRedactedSchema.make({
    arithmeticVersion: result.arithmeticVersion,
    contextRevision: result.contextRevision,
    decidedAt: result.decidedAt,
    policyRevision: result.policyRevision,
    purpose: result.purpose,
    resultAmount: result.resultAmount,
    roundingIncrement: result.roundingIncrement,
    roundingMode: result.roundingMode,
    roundingRule: result.roundingRule,
    roundingRuleRevision: result.roundingRuleRevision,
    sourceAmount: result.sourceAmount,
    targetMinorUnits: result.targetMinorUnits,
  });

export const applyCommercialFxDisclosure = (
  result: CommercialFxConversionSuccess,
  decision: CommercialFxDisclosureDecision,
): CommercialFxConversionSuccess =>
  Schema.is(SameCurrencyNoConversionSchema)(result) ||
  decision === 'EXACT' ||
  !Schema.is(FxConversionResolvedSchema)(result)
    ? result
    : redactResolvedConversion(result);
