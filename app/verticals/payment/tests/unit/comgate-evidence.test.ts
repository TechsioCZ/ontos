import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Match, Option, Result, Schema } from 'effect';

import { toComgatePrice, fromComgatePrice } from '../../src/integrations/comgate/comgate-money.ts';
import {
  classifyComgateCancelResponse,
  comgateBindingOf,
  comgateTransIdOfLookup,
  comgateVerifiedOrderReference,
  mapComgateCreateResponse,
  mapComgateRefundResponse,
  mapComgateStatus,
} from '../../src/integrations/comgate/comgate-evidence.ts';
import type { ComgateBindingIdentity, ComgateCancelAnswer } from '../../src/integrations/comgate/comgate-evidence.ts';
import { ComgateTransIdSchema, decodeComgateStatusBody } from '../../src/integrations/comgate/comgate-wire.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayExecutionTargetSchema } from '../../src/integrations/psp/psp-request.ts';
import type { GatewayExpectedEffect } from '../../src/integrations/psp/psp-request.ts';
import type { ProviderDispatchResponse, ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';

/** Fixture shapes from https://apidoc.comgate.cz/en/api/rest/ (see tests/fixtures/comgate/README.md). */
const fixtureDir = new URL('../fixtures/comgate/', import.meta.url);
const fixtureText = (name: string) => readFileSync(new URL(name, fixtureDir), 'utf-8');
type JsonObject = Readonly<Record<string, typeof Schema.Json.Type>>;
const fixtureJson = (name: string): JsonObject =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(fixtureText(name));

const collectOperationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const cancelOperationId = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const refundOperationId = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const { orderReference } = deriveProviderCorrelation(collectOperationId);
const transId = Schema.decodeUnknownSync(ComgateTransIdSchema)('AB12-CD34-EF56');
const observedAt = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');
const binding: ComgateBindingIdentity = { merchantId: '123456', test: false };
const amount = { amountMinor: 10_000, currency: 'CZK' as const };

const collect: GatewayExpectedEffect = { _tag: 'COLLECT', amount, operationId: collectOperationId };
const cancel: GatewayExpectedEffect = {
  _tag: 'CANCEL_OR_VOID',
  operationId: cancelOperationId,
  target: { amount, operationId: collectOperationId },
};
const refund: GatewayExpectedEffect = { _tag: 'REFUND', amount, operationId: refundOperationId };

const statusBody = (overrides: JsonObject = {}) =>
  JSON.stringify({ ...fixtureJson('status-paid.json'), refId: orderReference, ...overrides });

const lookup = (expected: GatewayExpectedEffect, bodyText: string) =>
  mapComgateStatus({ answer: decodeComgateStatusBody(bodyText), binding, expected, observedAt, transId });

const findingFor = (findings: readonly ProviderFindingResult[], operationId: string) =>
  findings.find((finding) => finding.target.operationId === operationId);

const factKindOf = (finding: ProviderFindingResult | undefined) =>
  Option.fromUndefinedOr(finding).pipe(
    Option.flatMap((value) => value.evidence),
    Option.map((evidence) => evidence.factKind),
  );

const dispatchKind = (response: ProviderDispatchResponse) =>
  Match.value(response).pipe(
    Match.tag('ACKNOWLEDGED', () => 'ACKNOWLEDGED' as const),
    Match.tag('REJECTED_BEFORE_EFFECT', () => 'REJECTED_BEFORE_EFFECT' as const),
    Match.exhaustive,
  );

const cancelLabel = (answer: ComgateCancelAnswer) =>
  Match.value(answer).pipe(
    Match.tag('ACCEPTED', () => 'ACCEPTED'),
    Match.tag('NOT_CHANGEABLE', () => 'NOT_CHANGEABLE'),
    Match.tag('PROVIDER_ERROR', ({ code }) => `PROVIDER_ERROR:${code}`),
    Match.tag('UNREADABLE', () => 'UNREADABLE'),
    Match.exhaustive,
  );

const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result)
        ? { ok: true as const, value: result.success }
        : { error: result.failure, ok: false as const },
    ),
  );

describe('#1156 Comgate evidence mapping', () => {
  it.effect('#1158 Unknown non-zero code is never success', () =>
    Effect.gen(function* unknownCodes() {
      const create = yield* mapComgateCreateResponse({
        bodyText: fixtureText('create-error.json'),
        expected: { amount, operationId: collectOperationId },
        observedAt,
      });
      expect(dispatchKind(create)).toBe('REJECTED_BEFORE_EFFECT');
      expect(create.finding.finding).toBe('NOT_EFFECTED');
      expect(factKindOf(create.finding)).toEqual(Option.some('COLLECTION_NOT_EFFECTED'));

      const undocumentedCreate = yield* mapComgateCreateResponse({
        bodyText: JSON.stringify({ code: 1999, message: 'Undocumented' }),
        expected: { amount, operationId: collectOperationId },
        observedAt,
      });
      expect(undocumentedCreate.finding.finding).not.toBe('CUSTOMER_ACTION_REQUIRED');

      for (const code of [1100, 1200, 1500, 1999, -1]) {
        const refundResult = yield* outcome(
          mapComgateRefundResponse({
            bodyText: JSON.stringify({ code, message: 'error' }),
            expected: { amount, operationId: refundOperationId },
            observedAt,
            transId,
          }),
        );
        expect(refundResult.ok).toBe(false);
        expect(refundResult).toMatchObject({ error: { _tag: 'GatewayProviderOutcomeUnknown' }, ok: false });

        const status = yield* lookup(collect, JSON.stringify({ code, message: 'error' }));
        expect(status.map((finding) => finding.finding)).toEqual(['INDETERMINATE']);
        expect(status[0]?.evidence).toEqual(Option.none());
      }

      expect(cancelLabel(classifyComgateCancelResponse(JSON.stringify({ code: 1999, message: 'x' })))).toBe(
        'PROVIDER_ERROR:1999',
      );
      expect(cancelLabel(classifyComgateCancelResponse(fixtureText('result-1400.json')))).toBe('NOT_CHANGEABLE');
      expect(cancelLabel(classifyComgateCancelResponse(fixtureText('result-ok.json')))).toBe('ACCEPTED');
      expect(cancelLabel(classifyComgateCancelResponse('<html>'))).toBe('UNREADABLE');
    }),
  );

  it.effect('#1158 Lookup miss is never NOT_EFFECTED', () =>
    Effect.gen(function* lookupMiss() {
      for (const expected of [collect, cancel, refund]) {
        const findings = yield* lookup(expected, fixtureText('status-error.json'));
        expect(findings).toHaveLength(1);
        expect(findings[0]?.target.operationId).toBe(expected.operationId);
        expect(findings[0]?.finding).toBe('INDETERMINATE');
        expect(findings[0]?.evidence).toEqual(Option.none());
      }
      const invalid = yield* outcome(lookup(collect, 'not json'));
      expect(invalid).toMatchObject({ error: { _tag: 'GatewayProviderResponseInvalid' }, ok: false });
      const incompleteSuccess = yield* outcome(lookup(collect, JSON.stringify({ code: 0, message: 'OK' })));
      expect(incompleteSuccess).toMatchObject({ error: { _tag: 'GatewayProviderResponseInvalid' }, ok: false });
    }),
  );

  it.effect('#1156 Refund code 0 is pending only', () =>
    Effect.gen(function* refundPending() {
      const response = yield* mapComgateRefundResponse({
        bodyText: fixtureText('result-ok.json'),
        expected: { amount, operationId: refundOperationId },
        observedAt,
        transId,
      });
      expect(dispatchKind(response)).toBe('ACKNOWLEDGED');
      expect(response.finding.finding).toBe('ACCEPTED_PENDING');
      const evidence = Option.getOrUndefined(response.finding.evidence);
      expect(evidence?.factKind).toBe('REFUND_PENDING');
      expect(evidence?.factFamily).toBe('REFUND_EXECUTION');
      expect(evidence?.economicEffectKey).toEqual(Option.some(`comgate-refund:AB12-CD34-EF56:${refundOperationId}`));
      expect(evidence?.sourceOccurrenceId).toBe(
        `comgate:response:AB12-CD34-EF56:${refundOperationId}:REFUND_PENDING:10000`,
      );

      // A later status lookup never confirms the refund (no refund state is documented, N10).
      const findings = yield* lookup(refund, statusBody());
      expect(findings.map((finding) => finding.finding)).toEqual(['INDETERMINATE']);
      expect(findings[0]?.evidence).toEqual(Option.none());

      for (const code of [1400, 1401, 1402]) {
        const refused = yield* mapComgateRefundResponse({
          bodyText: JSON.stringify({ code, message: 'refused' }),
          expected: { amount, operationId: refundOperationId },
          observedAt,
          transId,
        });
        expect(dispatchKind(refused)).toBe('REJECTED_BEFORE_EFFECT');
        expect(factKindOf(refused.finding)).toEqual(Option.some('REFUND_NOT_EFFECTED'));
      }
    }),
  );

  it.effect('#1154 Create code 0 with transId and redirect requires customer action', () =>
    Effect.gen(function* createAck() {
      const response = yield* mapComgateCreateResponse({
        bodyText: fixtureText('create-success.json'),
        expected: { amount, operationId: collectOperationId },
        observedAt,
      });
      expect(dispatchKind(response)).toBe('ACKNOWLEDGED');
      expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
      expect(response.finding.customerAction).toEqual(
        Option.some({ redirectUrl: 'https://payments.comgate.cz/client/instructions/index?id=AB12-CD34-EF56' }),
      );
      expect(response.finding.providerRefs).toEqual([{ _tag: 'COMGATE_TRANSACTION', transId: 'AB12-CD34-EF56' }]);

      const incomplete = yield* outcome(
        mapComgateCreateResponse({
          bodyText: JSON.stringify({ code: 0, message: 'OK' }),
          expected: { amount, operationId: collectOperationId },
          observedAt,
        }),
      );
      expect(incomplete).toMatchObject({ error: { _tag: 'GatewayProviderOutcomeUnknown' }, ok: false });
    }),
  );

  it.effect('#1156 Status table maps PAID, PENDING, CANCELLED, AUTHORIZED and undocumented states', () =>
    Effect.gen(function* statusTable() {
      const paid = yield* lookup(collect, statusBody());
      expect(paid[0]?.finding).toBe('EFFECT_CONFIRMED');
      expect(factKindOf(paid[0])).toEqual(Option.some('COLLECTION_CONFIRMED'));
      expect(paid[0]?.orderReference).toEqual(Option.some(orderReference));
      expect(
        (paid[0]?.evidence ?? Option.none()).pipe(Option.flatMap((evidence) => evidence.economicEffectKey)),
      ).toEqual(Option.some('AB12-CD34-EF56'));

      const pending = yield* lookup(collect, statusBody({ status: 'PENDING' }));
      expect(pending[0]?.finding).toBe('ACCEPTED_PENDING');
      const cancelled = yield* lookup(collect, statusBody({ status: 'CANCELLED' }));
      expect(cancelled[0]?.finding).toBe('NOT_EFFECTED');
      expect(factKindOf(cancelled[0])).toEqual(Option.some('COLLECTION_NOT_EFFECTED'));
      const authorized = yield* lookup(collect, statusBody({ status: 'AUTHORIZED' }));
      expect(authorized[0]?.finding).toBe('VERIFICATION_CONFLICT');
      const undocumented = yield* lookup(collect, statusBody({ status: 'REFUNDED' }));
      expect(undocumented[0]?.finding).toBe('INDETERMINATE');
    }),
  );

  it.effect('#1156 PAID with a different amount or currency is a discrepancy', () =>
    Effect.gen(function* discrepancy() {
      const findings = yield* lookup(collect, statusBody({ curr: 'EUR', price: '9999' }));
      expect(findings[0]?.finding).toBe('VERIFICATION_CONFLICT');
      const evidence = Option.getOrUndefined(findings[0]?.evidence ?? Option.none());
      expect(evidence?.observedAmount).toEqual(Option.some({ amountMinor: 9999, currency: 'EUR' }));
      expect(evidence?.discrepancy).toEqual(
        Option.some({ expected: amount, observed: { amountMinor: 9999, currency: 'EUR' } }),
      );

      const inexact = yield* outcome(lookup(collect, statusBody({ price: '100.00' })));
      expect(inexact).toMatchObject({ error: { _tag: 'GatewayProviderResponseInvalid' }, ok: false });
    }),
  );

  it.effect('#1156 Another environment, merchant, transaction or refId is a verification conflict', () =>
    Effect.gen(function* conflicts() {
      const conflicting: readonly JsonObject[] = [
        { test: 'true' },
        { test: true },
        { merchant: '654321' },
        { transId: 'ZZ99-ZZ99-ZZ99' },
        { refId: '2010102600' },
      ];
      for (const overrides of conflicting) {
        const findings = yield* lookup(collect, statusBody(overrides));
        expect(findings.map((finding) => finding.finding)).toEqual(['VERIFICATION_CONFLICT']);
        expect(findings[0]?.evidence).toEqual(Option.none());
      }
      expect(
        comgateVerifiedOrderReference({
          answer: decodeComgateStatusBody(statusBody({ merchant: '654321' })),
          binding,
          transId,
        }),
      ).toEqual(Option.none());
      expect(
        comgateVerifiedOrderReference({ answer: decodeComgateStatusBody(statusBody()), binding, transId }),
      ).toEqual(Option.some(orderReference));
    }),
  );

  it.effect('#1156 Lookup of a paid cancel target gives CANCEL_NOT_EFFECTED plus collection evidence', () =>
    Effect.gen(function* cancelPaid() {
      const findings = yield* lookup(cancel, statusBody());
      expect(findings).toHaveLength(2);
      expect(findingFor(findings, cancelOperationId)?.finding).toBe('NOT_EFFECTED');
      expect(factKindOf(findingFor(findings, cancelOperationId))).toEqual(Option.some('CANCEL_NOT_EFFECTED'));
      expect(findingFor(findings, collectOperationId)?.finding).toBe('EFFECT_CONFIRMED');
      expect(factKindOf(findingFor(findings, collectOperationId))).toEqual(Option.some('COLLECTION_CONFIRMED'));

      const cancelled = yield* lookup(cancel, statusBody({ status: 'CANCELLED' }));
      expect(factKindOf(findingFor(cancelled, cancelOperationId))).toEqual(Option.some('CANCEL_CONFIRMED'));
      expect(factKindOf(findingFor(cancelled, collectOperationId))).toEqual(Option.some('COLLECTION_NOT_EFFECTED'));

      const pending = yield* lookup(cancel, statusBody({ status: 'PENDING' }));
      expect(findingFor(pending, cancelOperationId)?.finding).toBe('INDETERMINATE');
    }),
  );

  it.effect('#1154 Comgate binding, lookup target and money boundaries', () =>
    Effect.gen(function* boundaries() {
      const target = Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
        binding: {
          _tag: 'GATEWAY_ACCOUNT',
          environment: 'SANDBOX',
          providerAccountRef: `pab_${'1'.repeat(32)}`,
          providerFamily: 'COMGATE',
        },
        bindingId: '7d3e9a10-55b2-4f6c-8a1d-2b3c4d5e6f70',
        credentialRevision: 1,
        credentialSecretRef: 'comgate.sandbox',
        legalEntityId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
        merchantIdentity: { _tag: 'COMGATE', merchantId: '123456' },
        notificationUrl: 'https://example.test/notify',
        returnUrl: Option.none(),
        tenantId: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
      });
      expect(yield* comgateBindingOf(target)).toEqual({ merchantId: '123456', test: true });
      const foreign = yield* outcome(
        comgateBindingOf({ ...target, merchantIdentity: { _tag: 'GOPAY', goid: '8123456789' } }),
      );
      expect(foreign).toMatchObject({ error: { _tag: 'GatewayProviderUnavailable' }, ok: false });

      const byReference = yield* outcome(comgateTransIdOfLookup({ _tag: 'ORDER_REFERENCE', orderReference }));
      expect(byReference).toMatchObject({ error: { _tag: 'GatewayProviderUnsupported' }, ok: false });

      expect(toComgatePrice({ amountMinor: 99, currency: 'CZK' })).toEqual(Option.none());
      expect(toComgatePrice({ amountMinor: 100, currency: 'CZK' })).toEqual(Option.some(100));
      expect(toComgatePrice({ amountMinor: 100_000_000, currency: 'CZK' })).toEqual(Option.some(100_000_000));
      expect(toComgatePrice({ amountMinor: 100_000_001, currency: 'CZK' })).toEqual(Option.none());
      expect(fromComgatePrice({ curr: 'CZK', price: '159950' })).toEqual(
        Option.some({ amountMinor: 159_950, currency: 'CZK' }),
      );
      expect(fromComgatePrice({ curr: 'CZK', price: '1599.50' })).toEqual(Option.none());
    }),
  );
});
