import type { OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TaxCorrectionPreviewRequestSchema,
  TaxCorrectionPreviewResponseSchema,
} from '../../shared/apis/tax-correction-preview.ts';
import { AcceptedTaxTermsContractSchema } from '../../shared/domain/tax-correction-preview-contracts.ts';
import { previewTaxCorrection } from '../../src/api/tax-correction-preview.read.ts';
import {
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
} from '../../src/domain/tax-correction-delta.ts';
import {
  HistoricalReadUsesAcceptedTaxTermsSchema,
  NewEventDeterminationUnsupportedSchema,
  NoNewTaxEventSchema,
} from '../../src/domain/tax-declared-purpose.ts';
import { acceptedTaxTermsInput } from './tax-correction-fixtures.ts';
import { exactDecimal } from './tax-domain-fixtures.ts';

type PreviewRequestInput = typeof TaxCorrectionPreviewRequestSchema.Encoded;

const decodeRequest = Schema.decodeUnknownSync(TaxCorrectionPreviewRequestSchema);
const encodeResponse = Schema.encodeSync(TaxCorrectionPreviewResponseSchema);

const scope = {
  authContextRef: 'tax-correction-preview-test',
  authMethod: 'session',
  correlationId: 'tax-correction-preview-test',
  legalEntityId: 'selling-legal-entity-1',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: 'tenant-1',
} satisfies OperationalScope;

const terms = acceptedTaxTermsInput([{ lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' }]);

const preview = (input: PreviewRequestInput, at: OperationalScope = scope) =>
  previewTaxCorrection(decodeRequest(input), at).pipe(Effect.map(({ result }) => result));

describe('Tax correction preview read', () => {
  it.effect('#948 F13-F15 #946 F16 previews a correction delta from the handed-over Accepted Tax Terms only', () =>
    Effect.gen(function* previewsCorrectionDelta() {
      const result = yield* preview({
        acceptedTaxTerms: terms,
        declaredPurpose: {
          _tag: 'CORRECTION',
          correctionEventRef: 'return-1',
          correctionReason: 'CUSTOMER_RETURN',
          units: [
            {
              change: { _tag: 'QUANTITY', quantityDelta: exactDecimal('-3') },
              expectedPreviousState: { _tag: 'NO_ACCEPTED_CORRECTION' },
              taxableSupplyUnitId: 'taxable-supply-unit:o-1',
            },
          ],
        },
      });

      expect(Schema.is(TaxCorrectionDeltaSchema)(result)).toBe(true);
      expect(encodeResponse(result)).toMatchObject({
        correctionTaxDelta: { amount: '-62.99', currency: 'CZK' },
        units: [{ proposedNext: { remainingPublishedTax: { amount: '146.99', currency: 'CZK' } } }],
      });
    }),
  );

  it.effect('#947 F1-F3 #946 F21 a historical read is answered by the retained terms without any Tax evaluation', () =>
    Effect.gen(function* answersHistoricalRead() {
      const result = yield* preview({ acceptedTaxTerms: terms, declaredPurpose: { _tag: 'HISTORICAL_READ' } });

      expect(Schema.is(HistoricalReadUsesAcceptedTaxTermsSchema)(result)).toBe(true);
      expect(encodeResponse(result)).toMatchObject({ originalTaxDecisionId: 'tax-decision-1' });
    }),
  );

  it.effect('#948 F32-F37 a Fulfillment split is no new Tax event and fabricates no Decision', () =>
    Effect.gen(function* interpretsFulfillmentSplit() {
      const result = yield* preview({
        acceptedTaxTerms: terms,
        declaredPurpose: { _tag: 'NEW_EVENT', eventKind: 'PARTIAL_FULFILLMENT', eventRef: 'shipment-4-of-10' },
      });

      expect(Schema.is(NoNewTaxEventSchema)(result)).toBe(true);
      expect(Object.keys(result).toSorted()).toEqual(['_tag', 'eventRef']);
    }),
  );

  it.effect('#947 F16-F22 an independent later supply fails explicitly, with no live or historical fallback', () =>
    Effect.gen(function* rejectsIndependentSupply() {
      const result = yield* preview({
        acceptedTaxTerms: terms,
        declaredPurpose: { _tag: 'NEW_EVENT', eventKind: 'INDEPENDENT_SUPPLY', eventRef: 'later-supply-1' },
      });

      expect(Schema.is(NewEventDeterminationUnsupportedSchema)(result)).toBe(true);
      expect(Object.keys(result).toSorted()).toEqual(['_tag', 'eventRef']);
    }),
  );

  it.effect('#907 F214-F215 Accepted Tax Terms of another Tenant or Selling Legal Entity are not visible', () =>
    Effect.gen(function* hidesForeignTerms() {
      for (const foreign of [
        { ...scope, legalEntityId: 'selling-legal-entity-2' },
        { ...scope, tenantId: 'tenant-2' },
      ]) {
        const failure = yield* Effect.flip(
          preview({ acceptedTaxTerms: terms, declaredPurpose: { _tag: 'HISTORICAL_READ' } }, foreign),
        );
        expect(failure.code).toBe('read_handler_not_found');
      }
    }),
  );

  it.effect('#947 F13 #948 F7 an incomplete original record is the explicit unresolved outcome, not a rejection', () =>
    Effect.gen(function* answersIncompleteRecord() {
      const { finalTax, ...withoutFinalTax } = terms;
      const withoutQuantity = {
        ...terms,
        finalTax: {
          ...finalTax,
          decision: {
            ...finalTax.decision,
            purchaseBinding: { ...finalTax.decision.purchaseBinding, purchaseDemandOccurrences: [] },
          },
        },
      };
      for (const incomplete of [withoutFinalTax, withoutQuantity, {}]) {
        const result = yield* preview(
          { acceptedTaxTerms: incomplete, declaredPurpose: { _tag: 'HISTORICAL_READ' } },
          { ...scope, tenantId: 'tenant-2' },
        );
        expect(Schema.is(TaxCorrectionHistoricalInputUnresolvedSchema)(result)).toBe(true);
        expect(encodeResponse(result)).toMatchObject({ unresolved: { _tag: 'ORIGINAL_RECORD_INCOMPLETE' } });
      }
    }),
  );

  it('#946 F8-F9 owners hand over Accepted Tax Terms in the published contract shape', () => {
    const encode = Schema.encodeSync(AcceptedTaxTermsContractSchema);
    expect(encode(Schema.decodeUnknownSync(AcceptedTaxTermsContractSchema)(terms))).toEqual(terms);
  });

  it('#948 F11 #907 F193-F194 accepts no Payment refund or Fulfillment status as correction facts', () => {
    expect(() =>
      decodeRequest({
        acceptedTaxTerms: terms,
        declaredPurpose: {
          _tag: 'CORRECTION',
          correctionEventRef: 'refund-1',
          correctionReason: 'PAYMENT_REFUND',
          units: [
            {
              change: { _tag: 'REFUND', refundAmount: exactDecimal('-100') },
              expectedPreviousState: { _tag: 'NO_ACCEPTED_CORRECTION' },
              taxableSupplyUnitId: 'taxable-supply-unit:o-1',
            },
          ],
        },
      }),
    ).toThrow();
  });
});
