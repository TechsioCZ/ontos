import { ReadPermissionDenied } from '@app/core-runtime';
import { CounterpartyIdentitiesForbiddenProblemSchema } from '@app/party-registry/apis/counterparty-identities';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FinanceForbidden, FinanceReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import { FinanceForbiddenProblemSchema, mapFinanceForbiddenProblem } from '../../shared/finance-action-problems.ts';
import { knownReasonText } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import {
  EXPORT_ISSUER_IDENTITY_FORBIDDEN,
  EXPORT_PARTNER_IDENTITY_FORBIDDEN,
  issuerNameFailure,
  issuerReadFailure,
  partnerReadFailure,
} from '../../src/services/reference-validation.ts';

describe('accounting export reference refusals', () => {
  it('a caller without the right to read the company identity gets a permission problem, not unavailable', () => {
    const refused = issuerReadFailure(
      new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'core.identity.legal-entity.read' }),
    );
    expect(refused).toBeInstanceOf(FinanceForbidden);
    expect(refused.reason).toBe(EXPORT_ISSUER_IDENTITY_FORBIDDEN);
    // The name withheld by the field right is the same refusal.
    const withheld = issuerNameFailure();
    expect([Schema.is(FinanceForbidden)(withheld), withheld.reason]).toEqual([true, EXPORT_ISSUER_IDENTITY_FORBIDDEN]);
    const problem = mapFinanceForbiddenProblem(
      new FinanceForbidden({ code: 'finance_forbidden', reason: withheld.reason }),
    );
    expect([problem.status, problem.code, problem.detail]).toEqual([
      403,
      'finance_forbidden',
      EXPORT_ISSUER_IDENTITY_FORBIDDEN,
    ]);
    expect(FinanceForbiddenProblemSchema.fields.status.literal).toBe(403);
    expect(knownReasonText(problem.detail)).toContain('nemá právo číst identifikaci firmy');
  });

  it('a Party Registry refusal of the partner read is a permission problem with its own reason', () => {
    const refused = partnerReadFailure(
      CounterpartyIdentitiesForbiddenProblemSchema.make({
        detail: 'Forbidden',
        status: 403,
        title: 'Forbidden',
        type: 'https://ontos.dev/problems/read-forbidden',
      }),
    );
    expect([Schema.is(FinanceForbidden)(refused), refused.reason]).toEqual([true, EXPORT_PARTNER_IDENTITY_FORBIDDEN]);
    expect(knownReasonText(EXPORT_PARTNER_IDENTITY_FORBIDDEN)).toContain('identifikaci obchodních partnerů');
  });

  it('an unreachable or failing owner stays unavailable (503)', () => {
    expect(issuerReadFailure({ _tag: 'ReadHandlerUnavailable', code: 'read_handler_unavailable' })).toBeInstanceOf(
      FinanceReferenceUnavailable,
    );
    // A blank stored name is not the caller's rights.
    expect(issuerNameFailure('  ')).toBeInstanceOf(FinanceReferenceUnavailable);
    expect(partnerReadFailure({ _tag: 'CounterpartyIdentitiesUnavailableProblem', status: 503 })).toBeInstanceOf(
      FinanceReferenceUnavailable,
    );
    expect(partnerReadFailure({ _tag: 'HttpClientError' })).toBeInstanceOf(FinanceReferenceUnavailable);
  });
});
