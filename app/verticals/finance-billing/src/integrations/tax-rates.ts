import type { OperationalScope } from '@app/core-runtime';
import { czVatClassificationCodes } from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import {
  executeApplicableTaxRuleSetWithAuthorization,
  executeSellerVatRegimeAtInstantWithAuthorization,
} from '@app/tax/api/client';
import { Context, Crypto, Effect, Layer, Match } from 'effect';
import { FinanceReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import type { VatChoices, VatClassificationRate } from '../../shared/apis/vat-choices.ts';
import { pragueDayStart } from '../../shared/domain/line-vat.ts';

const TAX_AUDIENCE = 'tax';

/** One stable refusal for every way Tax cannot answer: not installed, unreachable, or refusing this call. */
const taxUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new FinanceReferenceUnavailable({
      code: 'finance_reference_unavailable',
      reason: 'The VAT rates of the company are unavailable',
    }),
    'cause',
    { value: cause },
  );

/** A Tax rate Finance can store: one whole percent between 1 and 100. */
const wholePercent = (ratePercent: string): number | undefined => {
  const value = Number(ratePercent);
  return Number.isInteger(value) && value > 0 && value <= 100 ? value : undefined;
};

export interface FinanceTaxRatesService {
  /**
   * What the company's invoice lines may use on `on` (YYYY-MM-DD): its declared VAT regime and each classification
   * Tax publishes exactly one whole-percent rate for at the start of that Prague day.
   */
  readonly choices: (scope: OperationalScope, on: string) => Effect.Effect<VatChoices, FinanceReferenceUnavailable>;
}

/**
 * Finance reads Tax as a calling module for the person it already admitted: the Shell signs a module-call assertion
 * naming Finance as the actor and the requester as the subject, and Tax admits it only because its reads list
 * `finance-billing` as a caller. The requester therefore needs no Tax right of their own to fill in an invoice line.
 * Every Tax read gets its own single-use assertion.
 */
export class FinanceTaxRates extends Context.Service<FinanceTaxRates, FinanceTaxRatesService>()(
  '@app/finance-billing/integrations/tax-rates/FinanceTaxRates',
) {}

export const FinanceTaxRatesLive = Layer.effect(
  FinanceTaxRates,
  Effect.gen(function* financeTaxRatesLayer() {
    const crypto = yield* Crypto.Crypto;
    /** A fresh single-use module-call assertion naming Finance as the caller and the requester as the subject. */
    const taxCredential = (scope: OperationalScope) =>
      acquireDelegatedGatewayContext(
        {
          audience: TAX_AUDIENCE,
          legalEntityScope: 'subject',
          requestCorrelation: scope.correlationId,
          subject: { _tag: 'Assertion', scope },
        },
        crypto,
      );
    const rateOf = Effect.fn('FinanceTaxRates.rate')(function* rateOf(
      scope: OperationalScope,
      code: CzVatClassificationCode,
      instant: NonNullable<ReturnType<typeof pragueDayStart>>,
    ) {
      const credential = yield* taxCredential(scope);
      const response = yield* executeApplicableTaxRuleSetWithAuthorization(
        { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode: code, taxRelevantTime: instant },
        credential.authorization,
        scope.correlationId,
        { baseUrl: credential.apiBaseUrl, compositionRevision: credential.compositionRevision },
      );
      const [revision, ...others] = response.applicable;
      const ratePercent = revision === undefined ? undefined : wholePercent(revision.ratePercent);
      // An overlap, conflict or missing rule leaves the classification out: Finance never guesses a rate.
      if (response.outcome !== 'SELECTED' || revision === undefined || others.length > 0 || ratePercent === undefined) {
        return [];
      }
      const rate: VatClassificationRate = {
        code,
        effectiveFrom: revision.effectiveFrom,
        ratePercent,
        taxRuleRevisionRef: revision.taxRuleRevisionRef,
      };
      return [rate];
    });
    const regimeOf = Effect.fn('FinanceTaxRates.regime')(function* regimeOf(
      scope: OperationalScope,
      instant: NonNullable<ReturnType<typeof pragueDayStart>>,
    ) {
      const credential = yield* taxCredential(scope);
      const response = yield* executeSellerVatRegimeAtInstantWithAuthorization(
        { instant },
        credential.authorization,
        scope.correlationId,
        { baseUrl: credential.apiBaseUrl, compositionRevision: credential.compositionRevision },
      );
      return Match.value(response.selection).pipe(
        Match.tag('DECLARED', ({ regime }) => regime),
        Match.orElse(() => 'NOT_DECLARED' as const),
      );
    });
    return {
      choices: Effect.fn('FinanceTaxRates.choices')(function* choices(scope: OperationalScope, on: string) {
        const instant = pragueDayStart(on);
        if (instant === undefined) {
          return yield* taxUnavailable();
        }
        const [regime, rates] = yield* Effect.all(
          [
            regimeOf(scope, instant),
            Effect.forEach(czVatClassificationCodes, (code) => rateOf(scope, code, instant), { concurrency: 2 }),
          ],
          { concurrency: 2 },
        );
        return { on, rates: rates.flat(), regime } satisfies VatChoices;
      }, Effect.mapError(taxUnavailable)),
    } satisfies FinanceTaxRatesService;
  }),
);
