// The VAT settings page's data and changes, each one a real Tax read or Action for the signed-in person.
import { GATEWAY_MODULE_NOT_INSTALLED_TYPE } from '@app/shared-contracts';
import { czVatClassificationCodes } from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';
import { definePageData } from '@app/shared-contracts/page-data';
import type { TaxRuleRef } from '@app/tax/resources/tax-rule';
import { DateTime, Effect, Match, Result } from 'effect';
import { pragueDayStart } from '../../../../../shared/domain/line-vat.ts';
import { browserCrypto } from '../../../../api/browser-crypto.ts';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';
import {
  createClassificationRule,
  createRateRevision,
  declareRegime,
  endRateRevision,
  readApplicableRule,
  readRegimeAt,
  readRegimeHistory,
  readRuleHistory,
} from './tax-access.ts';
import type { VatChangeRights } from './tax-access.ts';
import { classificationView, planRateChange, planWithdraw, regimeTimeline } from './vat-settings-model.ts';
import type { ClassificationView, RateRevision, RegimePeriod, VatChangeOutcome } from './vat-settings-model.ts';

type ReadyClassification = Extract<ClassificationView, { readonly state: 'ready' }>;

export interface VatRegimeView {
  readonly current: 'NON_PAYER' | 'NOT_DECLARED' | 'VAT_PAYER';
  /** The regime revision a new declaration must name (0 when nothing is declared yet). */
  readonly headRevision: number;
  /** Undefined when the person may see the current regime but not its full history. */
  readonly timeline: readonly RegimePeriod[] | undefined;
}

/** Nothing offered: a person Tax shows no history to is offered no change either. */
const NO_CHANGES: VatChangeRights = {
  createRevision: false,
  createRule: false,
  declareRegime: false,
  endRevision: false,
};

/** The whole page, or why it cannot be shown. A failed Tax read is part of the value, never a thrown error. */
export type VatSettings =
  | { readonly state: 'forbidden' }
  /** The Shell answered that Tax is not installed for the tenant (absent, switched off or retired). */
  | { readonly state: 'notInstalled' }
  | { readonly state: 'unavailable' }
  | {
      readonly classifications: readonly ClassificationView[];
      readonly now: DateTime.Utc;
      readonly regime: VatRegimeView;
      /** The changes Tax says this person may make; the page offers only those (Tax decides again on each). */
      readonly rights: VatChangeRights;
      readonly state: 'ready';
    };

const loadClassification = Effect.fn('VatSettings.classification')(function* loadClassification(
  code: CzVatClassificationCode,
  now: DateTime.Utc,
) {
  const applicable = yield* readApplicableRule(code, now);
  const [first] = applicable.applicable;
  if (first === undefined) {
    return { code, state: 'missing' } satisfies ClassificationView;
  }
  const history = yield* readRuleHistory(first.taxRuleRef);
  return classificationView(code, history, now, applicable.outcome !== 'SELECTED');
});

const loadRegime = Effect.fn('VatSettings.regime')(function* loadRegime(now: DateTime.Utc) {
  const [atNow, history] = yield* Effect.all([readRegimeAt(now), readRegimeHistory().pipe(Effect.result)], {
    concurrency: 2,
  });
  const current = Match.value(atNow.selection).pipe(
    Match.tag('DECLARED', ({ regime }) => regime),
    Match.orElse(() => 'NOT_DECLARED' as const),
  );
  return {
    regime: {
      current,
      headRevision: atNow.headRevision,
      timeline: Result.isSuccess(history) ? regimeTimeline(history.success.revisions, now) : undefined,
    } satisfies VatRegimeView,
    rights: Result.isSuccess(history) ? history.success.changeRights : NO_CHANGES,
  };
});

const forbidden = (): Effect.Effect<VatSettings> => Effect.succeed({ state: 'forbidden' });

/**
 * The Shell's refusal of the call to Tax: "not installed" only when it says exactly that (its problem type), any other
 * refusal is the person's own lack of rights. This is the page's one source for whether Tax runs for the company.
 */
export const gatewayRefusalState = (problem: { readonly type: string }): VatSettings =>
  problem.type === GATEWAY_MODULE_NOT_INSTALLED_TYPE ? { state: 'notInstalled' } : { state: 'forbidden' };

/** Which of the page's states the loaded settings are: not installed, no regime declared yet, or declared. */
export const vatPageState = (settings: VatSettings) => {
  if (settings.state !== 'ready') {
    return settings.state;
  }
  return settings.regime.current === 'NOT_DECLARED' ? 'notDeclared' : 'declared';
};

const loadVatSettings = Effect.fn('VatSettings.load')(function* loadVatSettings() {
  const now = yield* DateTime.now;
  return yield* Effect.all(
    [
      loadRegime(now),
      Effect.forEach(czVatClassificationCodes, (code) => loadClassification(code, now), { concurrency: 2 }),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.map(([{ regime, rights }, classifications]): VatSettings => ({
      classifications,
      now,
      regime,
      rights,
      state: 'ready',
    })),
    // Tax (or the Shell, for a company where Tax is not open to the person) refuses: the page says so plainly.
    Effect.catchTags({
      ApplicableTaxRuleSetForbiddenProblem: forbidden,
      GatewayForbiddenProblem: (problem) => Effect.succeed(gatewayRefusalState(problem)),
      SellerVatRegimeAtInstantForbiddenProblem: forbidden,
      TaxRuleHistoryForbiddenProblem: forbidden,
    }),
    Effect.orElseSucceed((): VatSettings => ({ state: 'unavailable' })),
  );
});

/** The page's data per verified Shell scope; live changes from Tax reload it, so nobody refreshes by hand. */
export const vatSettingsData = definePageData({
  changesFrom: ['tax'],
  key: (scope: string) => scope,
  load: (_scope: string) => loadVatSettings(),
  runtime: financeBrowserRuntime,
});

/** Every change ends by reading Tax again, so the page shows what Tax now holds, accepted or not. */
const settle = (change: Effect.Effect<VatChangeOutcome>): Effect.Effect<VatChangeOutcome> =>
  change.pipe(Effect.ensuring(Effect.sync(() => vatSettingsData.invalidate())));

/** A fresh idempotency key for one Tax Action of one change. */
const newKey = browserCrypto.randomUUIDv4().pipe(Effect.orDie);

/** The rule's basis after an earlier step changed it. */
const freshBasis = (taxRuleRef: TaxRuleRef) =>
  readRuleHistory(taxRuleRef).pipe(
    Effect.map((history) => history.basisFingerprint),
    Effect.result,
  );

export interface RateChangeInput {
  /** First day of the new rate (YYYY-MM-DD, Prague). */
  readonly from: string;
  readonly ratePercent: number;
  readonly reason: string;
}

/**
 * Plans a new rate of a classification from a future day: the rate covering that day ends there and the new rate
 * starts, each step against the basis Tax last published, so a concurrent change is refused instead of overwritten.
 */
export const planNewRate = (view: ReadyClassification, input: RateChangeInput, now: DateTime.Utc) =>
  settle(
    Effect.gen(function* planNewRateProgram() {
      const from = pragueDayStart(input.from);
      if (from === undefined) {
        return 'invalid';
      }
      const plan = planRateChange(view, from, now);
      if (plan === 'notInFuture' || plan === 'alreadyPlanned') {
        return plan;
      }
      let basis = view.basisFingerprint;
      if (plan.end !== undefined) {
        const ended = yield* endRateRevision(
          {
            endedEffectiveTo: from,
            expectedBasisFingerprint: basis,
            reason: input.reason,
            taxRuleRevisionRef: plan.end.revisionRef,
          },
          yield* newKey,
        );
        if (ended !== 'done') {
          return ended;
        }
        const fresh = yield* freshBasis(view.taxRuleRef);
        if (Result.isFailure(fresh)) {
          return 'unavailable';
        }
        basis = fresh.success;
      }
      return yield* createRateRevision(
        {
          code: view.code,
          effectiveFrom: plan.create.effectiveFrom,
          effectiveTo: plan.create.effectiveTo,
          expectedBasisFingerprint: basis,
          ratePercent: input.ratePercent,
          reason: input.reason,
          replacesRevisionRef: plan.end?.revisionRef ?? null,
          taxRuleRef: view.taxRuleRef,
        },
        yield* newKey,
      );
    }),
  );

/** Withdraws a planned rate; the rate before it carries on over the withdrawn period. */
export const withdrawPlannedRate = (view: ReadyClassification, planned: RateRevision, reason: string) =>
  settle(
    Effect.gen(function* withdrawPlannedRateProgram() {
      const plan = planWithdraw(view, planned);
      const withdrawn = yield* endRateRevision(
        {
          endedEffectiveTo: planned.from,
          expectedBasisFingerprint: view.basisFingerprint,
          reason,
          taxRuleRevisionRef: plan.withdraw.revisionRef,
        },
        yield* newKey,
      );
      if (withdrawn !== 'done' || plan.continueWith === undefined) {
        return withdrawn;
      }
      const fresh = yield* freshBasis(view.taxRuleRef);
      if (Result.isFailure(fresh)) {
        return 'unavailable';
      }
      return yield* createRateRevision(
        {
          code: view.code,
          effectiveFrom: planned.from,
          effectiveTo: plan.continueWith.effectiveTo,
          expectedBasisFingerprint: fresh.success,
          ratePercent: Number(plan.continueWith.ratePercent),
          reason,
          replacesRevisionRef: null,
          taxRuleRef: view.taxRuleRef,
        },
        yield* newKey,
      );
    }),
  );

/** The first rate of a classification the company has no rule for yet. */
export const setFirstRate = (code: CzVatClassificationCode, input: RateChangeInput) =>
  settle(
    Effect.gen(function* setFirstRateProgram() {
      const from = pragueDayStart(input.from);
      if (from === undefined) {
        return 'invalid';
      }
      return yield* createClassificationRule(
        { code, effectiveFrom: from, ratePercent: input.ratePercent, reason: input.reason },
        yield* newKey,
      );
    }),
  );

export interface RegimeChangeInput {
  readonly confirmReplacesScheduled: boolean;
  /** First day of the regime (YYYY-MM-DD, Prague). */
  readonly from: string;
  readonly reason: string;
  readonly regime: 'NON_PAYER' | 'VAT_PAYER';
}

/**
 * Declares the company a VAT payer or not from a day, against the regime revision the page showed. Tax asks for a
 * reason when the day lies in the past and for a confirmation when a later planned declaration would be replaced.
 */
export const changeRegime = (regime: VatRegimeView, input: RegimeChangeInput) =>
  settle(
    Effect.gen(function* changeRegimeProgram() {
      const from = pragueDayStart(input.from);
      if (from === undefined) {
        return 'invalid';
      }
      return yield* declareRegime(
        {
          confirmReplacesScheduled: input.confirmReplacesScheduled,
          effectiveFrom: from,
          expectedCurrentRevision: regime.headRevision,
          reason: input.reason,
          regime: input.regime,
        },
        yield* newKey,
      );
    }),
  );
