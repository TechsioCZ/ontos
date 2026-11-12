// The VAT settings page talks to Tax itself, as the signed-in person: every read and change is judged by Tax against
// that person's own Tax rights, so an accountant manages VAT and anyone else sees Tax's refusal.
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';
import {
  executeApplicableTaxRuleSet,
  executeCreateTaxRule,
  executeCreateTaxRuleRevision,
  executeDeclareSellerVatRegime,
  executeEndTaxRuleRevision,
  executeSellerVatRegimeAtInstant,
  executeSellerVatRegimeHistory,
  executeTaxRuleHistory,
} from '@app/tax/api/client';
import type { TaxRuleRevisionRef } from '@app/tax/resources/tax-rule-revision';
import type { TaxRuleRef } from '@app/tax/resources/tax-rule';
import { Effect, Match } from 'effect';
import type { DateTime } from 'effect';
import type { VatChangeOutcome } from './vat-settings-model.ts';

// Tax's own clients acquire a single-use assertion for the signed-in person on every call.
const REQUEST_CORRELATION = 'finance-billing.vat-settings';
/** Where a change was made, as Tax records it next to the person and the reason. */
const PROVENANCE = 'ontos:finance-billing:vat-settings';
const ACTION_APPROVAL_REQUIRED = 'action_approval_required';

/** The company's applicable rule set of one classification at an instant. */
export const readApplicableRule = (code: CzVatClassificationCode, instant: DateTime.Utc) =>
  executeApplicableTaxRuleSet(
    { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode: code, taxRelevantTime: instant },
    REQUEST_CORRELATION,
  );

/** Every revision of one rule, with the basis a change must name. */
export const readRuleHistory = (taxRuleRef: TaxRuleRef) => executeTaxRuleHistory({ taxRuleRef }, REQUEST_CORRELATION);

/** The company's declared VAT regime at an instant, with the revision a new declaration must name. */
export const readRegimeAt = (instant: DateTime.Utc) =>
  executeSellerVatRegimeAtInstant({ instant }, REQUEST_CORRELATION);

/** Every declared regime revision of the company, and which VAT changes Tax lets this person make. */
export const readRegimeHistory = () => executeSellerVatRegimeHistory({}, REQUEST_CORRELATION);
/** The VAT changes Tax says the signed-in person may make in the company. */
export type VatChangeRights = Effect.Success<ReturnType<typeof readRegimeHistory>>['changeRights'];

/** A refusal of a Tax Action: approval needed (the person may only propose) or no right at all. */
const refused = (problem: { readonly code: string }): VatChangeOutcome =>
  problem.code === ACTION_APPROVAL_REQUIRED ? 'approvalRequired' : 'forbidden';

type RevisionContent = Parameters<typeof executeCreateTaxRuleRevision>[0]['content'];
type MutableRevisionContent = { -readonly [Key in keyof RevisionContent]: RevisionContent[Key] };

/** Content of one rate revision for `[effectiveFrom, effectiveTo)`; open-ended without an end. */
const revisionContent = (
  code: CzVatClassificationCode,
  ratePercent: number,
  effectiveFrom: DateTime.Utc,
  effectiveTo?: DateTime.Utc,
): RevisionContent => {
  const content: MutableRevisionContent = {
    compositionKind: 'EXCLUSIVE',
    effectiveFrom,
    jurisdiction: 'CZ_DOMESTIC',
    ratePercent: String(ratePercent),
    taxClassificationCode: code,
    treatmentCategory: 'TAXABLE',
  };
  if (effectiveTo !== undefined) {
    content.effectiveTo = effectiveTo;
  }
  return content;
};

/** The first rate of a classification the company has no rule for yet. */
export const createClassificationRule = (
  input: {
    readonly code: CzVatClassificationCode;
    readonly effectiveFrom: DateTime.Utc;
    readonly ratePercent: number;
    readonly reason: string;
  },
  idempotencyKey: string,
): Effect.Effect<VatChangeOutcome> =>
  executeCreateTaxRule(
    {
      initialRevision: revisionContent(input.code, input.ratePercent, input.effectiveFrom),
      meaningKind: 'VAT_RATE',
      provenanceRef: PROVENANCE,
      reason: input.reason,
      stableCode: input.code,
    },
    REQUEST_CORRELATION,
    { idempotencyKey },
  ).pipe(
    Effect.as<VatChangeOutcome>('done'),
    Effect.catchTags({
      CreateTaxRuleActionConflictProblem: () => Effect.succeed<VatChangeOutcome>('conflict'),
      CreateTaxRuleActionForbiddenProblem: (problem) => Effect.succeed(refused(problem)),
      CreateTaxRuleActionIneligibleProblem: () => Effect.succeed<VatChangeOutcome>('invalid'),
      CreateTaxRuleActionInvalidProblem: () => Effect.succeed<VatChangeOutcome>('invalid'),
    }),
    Effect.orElseSucceed((): VatChangeOutcome => 'unavailable'),
  );

/** A new revision of a classification's rate for `[effectiveFrom, effectiveTo)`. */
export const createRateRevision = (
  input: {
    readonly code: CzVatClassificationCode;
    readonly effectiveFrom: DateTime.Utc;
    readonly effectiveTo: DateTime.Utc | undefined;
    readonly expectedBasisFingerprint: string;
    readonly ratePercent: number;
    readonly reason: string;
    /** The revision this one takes over from, or null for none. */
    readonly replacesRevisionRef: TaxRuleRevisionRef | null;
    readonly taxRuleRef: TaxRuleRef;
  },
  idempotencyKey: string,
): Effect.Effect<VatChangeOutcome> => {
  const payload = {
    content: revisionContent(input.code, input.ratePercent, input.effectiveFrom, input.effectiveTo),
    expectedBasisFingerprint: input.expectedBasisFingerprint,
    provenanceRef: PROVENANCE,
    reason: input.reason,
    taxRuleRef: input.taxRuleRef,
  };
  return executeCreateTaxRuleRevision(
    input.replacesRevisionRef === null ? payload : { ...payload, replacesRevisionRef: input.replacesRevisionRef },
    REQUEST_CORRELATION,
    { idempotencyKey },
  ).pipe(
    Effect.as<VatChangeOutcome>('done'),
    Effect.catchTags({
      CreateTaxRuleRevisionActionConflictProblem: () => Effect.succeed<VatChangeOutcome>('conflict'),
      CreateTaxRuleRevisionActionForbiddenProblem: (problem) => Effect.succeed(refused(problem)),
      CreateTaxRuleRevisionActionIneligibleProblem: () => Effect.succeed<VatChangeOutcome>('invalid'),
      CreateTaxRuleRevisionActionInvalidProblem: () => Effect.succeed<VatChangeOutcome>('invalid'),
    }),
    Effect.orElseSucceed((): VatChangeOutcome => 'unavailable'),
  );
};

/** Ends a revision at `endedEffectiveTo`; ending a scheduled revision at its own start withdraws it. */
export const endRateRevision = (
  input: {
    readonly endedEffectiveTo: DateTime.Utc;
    readonly expectedBasisFingerprint: string;
    readonly reason: string;
    readonly taxRuleRevisionRef: TaxRuleRevisionRef;
  },
  idempotencyKey: string,
): Effect.Effect<VatChangeOutcome> =>
  executeEndTaxRuleRevision(
    {
      endedEffectiveTo: input.endedEffectiveTo,
      expectedBasisFingerprint: input.expectedBasisFingerprint,
      provenanceRef: PROVENANCE,
      reason: input.reason,
      taxRuleRevisionRef: input.taxRuleRevisionRef,
    },
    REQUEST_CORRELATION,
    { idempotencyKey },
  ).pipe(
    Effect.as<VatChangeOutcome>('done'),
    Effect.catchTags({
      EndTaxRuleRevisionActionConflictProblem: () => Effect.succeed<VatChangeOutcome>('conflict'),
      EndTaxRuleRevisionActionForbiddenProblem: (problem) => Effect.succeed(refused(problem)),
      EndTaxRuleRevisionActionIneligibleProblem: () => Effect.succeed<VatChangeOutcome>('invalid'),
      EndTaxRuleRevisionActionInvalidProblem: () => Effect.succeed<VatChangeOutcome>('invalid'),
    }),
    Effect.orElseSucceed((): VatChangeOutcome => 'unavailable'),
  );

/**
 * Declares the company a VAT payer or not from a day, against the regime revision the page showed. Tax answers a
 * missing reason (a past day) or an unconfirmed replacement of a planned declaration without storing anything.
 */
export const declareRegime = (
  input: {
    readonly confirmReplacesScheduled: boolean;
    readonly effectiveFrom: DateTime.Utc;
    readonly expectedCurrentRevision: number;
    readonly reason: string;
    readonly regime: 'NON_PAYER' | 'VAT_PAYER';
  },
  idempotencyKey: string,
): Effect.Effect<VatChangeOutcome> => {
  const reason = input.reason.trim();
  const base = {
    effectiveFrom: input.effectiveFrom,
    expectedCurrentRevision: input.expectedCurrentRevision,
    regime: input.regime,
  };
  const withReason = reason === '' ? base : { ...base, reason };
  return executeDeclareSellerVatRegime(
    input.confirmReplacesScheduled ? { ...withReason, confirmReplacesScheduled: true } : withReason,
    REQUEST_CORRELATION,
    { idempotencyKey },
  ).pipe(
    Effect.map((result) =>
      Match.value(result).pipe(
        Match.tag('DECLARED', (): VatChangeOutcome => 'done'),
        Match.tag('DECLARATION_REJECTED', ({ reason: rejection }): VatChangeOutcome =>
          rejection === 'REASON_REQUIRED_FOR_BACKDATED_EFFECT' ? 'reasonRequired' : 'confirmReplace',
        ),
        Match.exhaustive,
      ),
    ),
    Effect.catchTags({
      DeclareSellerVatRegimeActionConflictProblem: () => Effect.succeed<VatChangeOutcome>('conflict'),
      DeclareSellerVatRegimeActionForbiddenProblem: (problem) => Effect.succeed(refused(problem)),
      DeclareSellerVatRegimeActionIneligibleProblem: () => Effect.succeed<VatChangeOutcome>('invalid'),
      DeclareSellerVatRegimeActionInvalidProblem: () => Effect.succeed<VatChangeOutcome>('invalid'),
    }),
    Effect.orElseSucceed((): VatChangeOutcome => 'unavailable'),
  );
};
