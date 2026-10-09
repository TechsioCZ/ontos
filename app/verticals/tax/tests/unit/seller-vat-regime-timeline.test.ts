import { DateTime, Match } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  evaluateSellerVatRegimeDeclaration,
  liveLaterRevisions,
  sellerVatRegimeAt,
  sellerVatRegimeHead,
} from '../../src/domain/seller-vat-regime-timeline.ts';
import type {
  SellerVatRegimeDeclarationEvaluation,
  SellerVatRegimeDeclarationRevision,
  SellerVatRegimeSelection,
} from '../../src/domain/seller-vat-regime-timeline.ts';

const at = (iso: string) => DateTime.makeUnsafe(iso);

const revision = (
  revisionNumber: number,
  effectiveFromIso: string,
  regime: 'VAT_PAYER' | 'NON_PAYER' = 'VAT_PAYER',
): SellerVatRegimeDeclarationRevision => ({
  effectiveFrom: at(effectiveFromIso),
  provenance: 'MERCHANT_DECLARED',
  regime,
  revision: revisionNumber,
});

/** Narrows via `Match.tag`, the audited replacement for manual `_tag ===` comparison. */
const narrowDeclared = (selection: SellerVatRegimeSelection) =>
  Match.value(selection).pipe(
    Match.tag('DECLARED', (declared) => declared),
    Match.orElse(() => {
      throw new Error('expected a DECLARED Seller VAT Regime selection');
    }),
  );

const expectNotDeclared = (selection: SellerVatRegimeSelection): void => {
  Match.value(selection).pipe(
    Match.tag('NOT_DECLARED', () => null),
    Match.orElse(() => {
      throw new Error('expected a NOT_DECLARED Seller VAT Regime selection');
    }),
  );
};

const expectEvaluationTag = (
  evaluation: SellerVatRegimeDeclarationEvaluation,
  tag: 'STALE_BASIS' | 'REASON_REQUIRED_FOR_BACKDATED_EFFECT',
): void => {
  Match.value(evaluation).pipe(
    Match.tag(tag, () => null),
    Match.orElse(() => {
      throw new Error(`expected evaluation tag "${tag}"`);
    }),
  );
};

const narrowAccepted = (evaluation: SellerVatRegimeDeclarationEvaluation) =>
  Match.value(evaluation).pipe(
    Match.tag('ACCEPTED', (accepted) => accepted),
    Match.orElse(() => {
      throw new Error('expected an ACCEPTED evaluation');
    }),
  );

const narrowScheduledConfirmationRequired = (evaluation: SellerVatRegimeDeclarationEvaluation) =>
  Match.value(evaluation).pipe(
    Match.tag('SCHEDULED_REVISION_CONFIRMATION_REQUIRED', (scheduled) => scheduled),
    Match.orElse(() => {
      throw new Error('expected a SCHEDULED_REVISION_CONFIRMATION_REQUIRED evaluation');
    }),
  );

describe('Seller VAT Regime timeline (Unit 10 A1)', () => {
  describe('sellerVatRegimeAt', () => {
    it('includes a revision exactly at its own effectiveFrom', () => {
      const revisions = [revision(1, '2026-01-01T00:00:00.000Z')];
      const declared = narrowDeclared(sellerVatRegimeAt(revisions, at('2026-01-01T00:00:00.000Z')));

      expect(declared.regime).toBe('VAT_PAYER');
      expect(declared.declarationRevisionRef).toEqual({ revision: 1 });
    });

    it('is NOT_DECLARED before the first revision', () => {
      const revisions = [revision(1, '2026-01-01T00:00:00.000Z')];

      expectNotDeclared(sellerVatRegimeAt(revisions, at('2025-12-31T23:59:59.999Z')));
    });

    it('a later revision replaces the timeline from its own effectiveFrom, not before', () => {
      const revisions = [
        revision(1, '2026-01-01T00:00:00.000Z', 'VAT_PAYER'),
        revision(2, '2026-06-01T00:00:00.000Z', 'NON_PAYER'),
      ];

      const beforeSecond = narrowDeclared(sellerVatRegimeAt(revisions, at('2026-03-01T00:00:00.000Z')));
      expect(beforeSecond.regime).toBe('VAT_PAYER');
      expect(beforeSecond.declarationRevisionRef).toEqual({ revision: 1 });

      const atSecond = narrowDeclared(sellerVatRegimeAt(revisions, at('2026-06-01T00:00:00.000Z')));
      expect(atSecond.regime).toBe('NON_PAYER');
      expect(atSecond.declarationRevisionRef).toEqual({ revision: 2 });
    });

    it('is order-independent over the input array (shuffle determinism)', () => {
      const revisions = [
        revision(1, '2026-01-01T00:00:00.000Z'),
        revision(2, '2026-02-01T00:00:00.000Z'),
        revision(3, '2026-03-01T00:00:00.000Z'),
      ];
      const shuffled = [revisions[2], revisions[0], revisions[1]].filter(
        (value): value is SellerVatRegimeDeclarationRevision => value !== undefined,
      );

      const fromOriginal = narrowDeclared(sellerVatRegimeAt(revisions, at('2026-02-15T00:00:00.000Z')));
      const fromShuffled = narrowDeclared(sellerVatRegimeAt(shuffled, at('2026-02-15T00:00:00.000Z')));
      expect(fromShuffled.declarationRevisionRef).toEqual(fromOriginal.declarationRevisionRef);
      expect(fromShuffled.regime).toBe(fromOriginal.regime);
    });
  });

  describe('sellerVatRegimeHead', () => {
    it('is 0 when nothing is declared', () => {
      expect(sellerVatRegimeHead([])).toBe(0);
    });

    it('is the highest revision number, regardless of array order', () => {
      const revisions = [revision(3, '2026-03-01T00:00:00.000Z'), revision(1, '2026-01-01T00:00:00.000Z')];

      expect(sellerVatRegimeHead(revisions)).toBe(3);
    });
  });

  describe('liveLaterRevisions', () => {
    it('ignores a later revision already superseded by an earlier-effective later-numbered one', () => {
      const revisions = [
        revision(1, '2026-01-01T00:00:00.000Z'),
        revision(2, '2026-06-01T00:00:00.000Z'),
        revision(3, '2026-03-01T00:00:00.000Z'),
      ];

      expect(liveLaterRevisions(revisions, at('2026-01-01T00:00:00.000Z')).map(({ revision: r }) => r)).toEqual([3]);
    });
  });

  describe('evaluateSellerVatRegimeDeclaration (declaration evaluation table)', () => {
    const baseRequest = {
      confirmReplacesScheduled: false,
      effectiveFrom: at('2026-06-01T00:00:00.000Z'),
      expectedCurrentRevision: 0,
      regime: 'VAT_PAYER' as const,
    };
    const operationTime = at('2026-06-01T00:00:00.000Z');

    it('CAS stale: expectedCurrentRevision does not match the head', () => {
      const result = evaluateSellerVatRegimeDeclaration({
        operationTime,
        request: { ...baseRequest, expectedCurrentRevision: 5 },
        revisions: [],
      });

      expectEvaluationTag(result, 'STALE_BASIS');
    });

    it('backdated without reason is rejected', () => {
      const result = evaluateSellerVatRegimeDeclaration({
        operationTime: at('2026-06-10T00:00:00.000Z'),
        request: { ...baseRequest, effectiveFrom: at('2026-06-01T00:00:00.000Z') },
        revisions: [],
      });

      expectEvaluationTag(result, 'REASON_REQUIRED_FOR_BACKDATED_EFFECT');
    });

    it('backdated with a non-empty reason is accepted', () => {
      const result = evaluateSellerVatRegimeDeclaration({
        operationTime: at('2026-06-10T00:00:00.000Z'),
        request: { ...baseRequest, effectiveFrom: at('2026-06-01T00:00:00.000Z'), reason: 'Backfilled' },
        revisions: [],
      });
      const accepted = narrowAccepted(result);

      expect(accepted.revision).toBe(1);
      expect(accepted.replacesScheduled).toEqual([]);
    });

    it('future with no scheduled revision is accepted', () => {
      const result = evaluateSellerVatRegimeDeclaration({
        operationTime,
        request: { ...baseRequest, effectiveFrom: at('2027-01-01T00:00:00.000Z') },
        revisions: [],
      });
      const accepted = narrowAccepted(result);

      expect(accepted.revision).toBe(1);
      expect(accepted.replacesScheduled).toEqual([]);
    });

    it('scheduled without confirmation lists the scheduled revisions', () => {
      const revisions = [revision(1, '2026-01-01T00:00:00.000Z'), revision(2, '2027-01-01T00:00:00.000Z')];
      const result = evaluateSellerVatRegimeDeclaration({
        operationTime,
        request: { ...baseRequest, effectiveFrom: at('2026-06-01T00:00:00.000Z'), expectedCurrentRevision: 2 },
        revisions,
      });
      const scheduled = narrowScheduledConfirmationRequired(result);

      expect(scheduled.scheduled).toEqual([{ revision: 2 }]);
    });

    it('scheduled with confirmation is accepted and names the replaced revisions', () => {
      const revisions = [revision(1, '2026-01-01T00:00:00.000Z'), revision(2, '2027-01-01T00:00:00.000Z')];
      const result = evaluateSellerVatRegimeDeclaration({
        operationTime,
        request: {
          ...baseRequest,
          confirmReplacesScheduled: true,
          effectiveFrom: at('2026-06-01T00:00:00.000Z'),
          expectedCurrentRevision: 2,
        },
        revisions,
      });
      const accepted = narrowAccepted(result);

      expect(accepted.revision).toBe(3);
      expect(accepted.replacesScheduled).toEqual([{ revision: 2 }]);
    });

    it('equal effectiveFrom needs no confirmation', () => {
      const revisions = [revision(1, '2026-06-01T00:00:00.000Z')];
      const result = evaluateSellerVatRegimeDeclaration({
        operationTime,
        request: { ...baseRequest, effectiveFrom: at('2026-06-01T00:00:00.000Z'), expectedCurrentRevision: 1 },
        revisions,
      });
      const accepted = narrowAccepted(result);

      expect(accepted.revision).toBe(2);
      expect(accepted.replacesScheduled).toEqual([]);
    });

    it('head 0 with expectedCurrentRevision 0 is accepted when nothing is declared', () => {
      const result = evaluateSellerVatRegimeDeclaration({ operationTime, request: baseRequest, revisions: [] });
      const accepted = narrowAccepted(result);

      expect(accepted.revision).toBe(1);
      expect(accepted.replacesScheduled).toEqual([]);
    });
  });
});
