import type { OperationalScope } from '@app/core-runtime';
import { czVatClassificationCodes } from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import {
  executeApplicableTaxRuleSetWithAuthorization,
  executeSellerVatRegimeAtInstantWithAuthorization,
} from '@app/tax/api/client';
import { Context, Crypto, Effect, Layer, Match, Schema } from 'effect';
import { GATEWAY_MODULE_NOT_INSTALLED_TYPE } from '@app/shared-contracts';
import { FinanceReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import type { VatChoices, VatClassificationRate } from '../../shared/apis/vat-choices.ts';
import { pragueDayStart } from '../../shared/domain/line-vat.ts';

const TAX_AUDIENCE = 'tax';

const NotInstalledSchema = Schema.TaggedStruct('GatewayForbiddenProblem', {
  type: Schema.Literal(GATEWAY_MODULE_NOT_INSTALLED_TYPE),
});
/** The reason when the Shell answered that Tax is not installed for the Tenant: an answer, not an outage. */
export const TAX_NOT_INSTALLED_REASON = 'Tax is not installed for the Tenant, so the company has no VAT rates yet';

/**
 * Why Tax gave no answer, from the call's own failure: "not installed" only for the Shell's 403 that says so (Tax has
 * no state for the tenant); a Tax installed but not readable now (suspended, quarantined, inactive, archived) is a plain
 * refusal, an outage like any other.
 */
export const taxUnavailableReasonOf = (cause: unknown): string =>
  Schema.is(NotInstalledSchema)(cause) ? TAX_NOT_INSTALLED_REASON : 'The VAT rates of the company are unavailable';

/**
 * One stable refusal for every way Tax cannot answer: not installed, unreachable, or refusing this call. Only "not
 * installed" says so in its reason, decided here from the call's own failure.
 */
const taxUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new FinanceReferenceUnavailable({ code: 'finance_reference_unavailable', reason: taxUnavailableReasonOf(cause) }),
    'cause',
    { value: cause },
  );

/**
 * Whether Tax's unavailability was the Shell's answer that Tax is not installed for the Tenant (an answer: the company
 * is not set up yet), not an outage, a missing credential or a refusal of this call.
 */
export const taxNotInstalled = (failure: FinanceReferenceUnavailable): boolean =>
  failure.reason === TAX_NOT_INSTALLED_REASON;

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
  /**
   * The same for asynchronous work: Finance asks Tax for the person or workload of the invocation the work runs for
   * (`Originator`), in the company the work belongs to.
   */
  readonly choicesFor: (call: TaxCall, on: string) => Effect.Effect<VatChoices, FinanceReferenceUnavailable>;
}

/** Whom one Tax call is for, and the correlation it carries. */
export interface TaxCall {
  /** The request correlation the Shell records for the module call. */
  readonly requestCorrelation: string;
  readonly subject: GatewayDelegationSubject;
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
    /** A fresh single-use module-call assertion naming Finance as the caller and the call's subject. */
    const taxCredential = (call: TaxCall) =>
      acquireDelegatedGatewayContext(
        {
          audience: TAX_AUDIENCE,
          callingAppId: 'finance-billing',
          legalEntityScope: 'subject',
          requestCorrelation: call.requestCorrelation,
          subject: call.subject,
        },
        crypto,
      );
    const rateOf = Effect.fn('FinanceTaxRates.rate')(function* rateOf(
      call: TaxCall,
      code: CzVatClassificationCode,
      instant: NonNullable<ReturnType<typeof pragueDayStart>>,
    ) {
      const credential = yield* taxCredential(call);
      const response = yield* executeApplicableTaxRuleSetWithAuthorization(
        { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode: code, taxRelevantTime: instant },
        credential.authorization,
        call.requestCorrelation,
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
      call: TaxCall,
      instant: NonNullable<ReturnType<typeof pragueDayStart>>,
    ) {
      const credential = yield* taxCredential(call);
      const response = yield* executeSellerVatRegimeAtInstantWithAuthorization(
        { instant },
        credential.authorization,
        call.requestCorrelation,
        { baseUrl: credential.apiBaseUrl, compositionRevision: credential.compositionRevision },
      );
      return Match.value(response.selection).pipe(
        Match.tag('DECLARED', ({ regime }) => regime),
        Match.orElse(() => 'NOT_DECLARED' as const),
      );
    });
    const choicesFor = Effect.fn('FinanceTaxRates.choices')(function* choices(call: TaxCall, on: string) {
      const instant = pragueDayStart(on);
      if (instant === undefined) {
        return yield* taxUnavailable();
      }
      const [regime, rates] = yield* Effect.all(
        [
          regimeOf(call, instant),
          Effect.forEach(czVatClassificationCodes, (code) => rateOf(call, code, instant), { concurrency: 2 }),
        ],
        { concurrency: 2 },
      );
      return { on, rates: rates.flat(), regime } satisfies VatChoices;
    }, Effect.mapError(taxUnavailable));
    return {
      choices: (scope: OperationalScope, on: string) =>
        choicesFor({ requestCorrelation: scope.correlationId, subject: { _tag: 'Assertion', scope } }, on),
      choicesFor,
    } satisfies FinanceTaxRatesService;
  }),
);
