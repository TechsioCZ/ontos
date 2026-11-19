import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  SourceProcessingEligibilityRequestSchema,
  SourceProcessingEligibilityResponseSchema,
} from '../../shared/apis/source-processing-eligibility.ts';
import { sourceProcessingEligibilityRead } from '../../src/api/source-processing-eligibility.read.ts';
import { makeSourceProcessingFixture } from '../support/source-processing-fixture.ts';

/**
 * #1396 — the public shape of the owner contract for the Communications consumer. These are contract tests; the
 * three outcomes themselves are proven against real ledgers in
 * `tests/integration/source-processing-communications-postgres.test.ts`.
 */
const fixture = makeSourceProcessingFixture({
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const decodeRequest = Schema.decodeUnknownResult(SourceProcessingEligibilityRequestSchema, {
  onExcessProperty: 'error',
});
const communicationsRequest = { ...fixture.request, consumerModuleId: 'communications.core' };
type Candidate = Parameters<typeof decodeRequest>[0];
const accepted = (input: Candidate) => Result.isSuccess(decodeRequest(input));

describe('#1396 the Communications consumer of the source processing contract', () => {
  it('accepts a qualified source record or a Party target and nothing that names nobody', () => {
    expect(accepted(communicationsRequest)).toBe(true);
    expect(
      accepted({ ...communicationsRequest, source: null, target: { kind: 'PARTY', resourceId: 'party-one' } }),
    ).toBe(true);
    // A native owner operation (no source, no target) identifies nobody: it is not a Communications use.
    expect(accepted({ ...communicationsRequest, source: null, target: null })).toBe(false);
  });

  it('refuses the organization, Symmy and counterparty uses that belong to other consumers', () => {
    expect(accepted({ ...communicationsRequest, organizationBusinessUse: 'COMPANY_ICO' })).toBe(false);
    expect(accepted({ ...communicationsRequest, operation: 'CUSTOMER_SOURCE_INTAKE' })).toBe(false);
    expect(
      accepted({ ...communicationsRequest, target: { kind: 'COUNTERPARTY', resourceId: 'counterparty-one' } }),
    ).toBe(false);
    expect(
      accepted({ ...communicationsRequest, target: { kind: 'PARTY_CONTACT_POINT', resourceId: 'contact-one' } }),
    ).toBe(false);
  });

  it('carries no e-mail address, channel secret or other control field that could select the subject', () => {
    expect(accepted({ ...communicationsRequest, emailAddress: 'someone@example.test' })).toBe(false);
    expect(accepted({ ...communicationsRequest, principalId: '10000000-0000-4000-8000-000000000003' })).toBe(false);
  });

  it('leaves the requests of the original consumers exactly as they were', () => {
    expect(accepted(fixture.request)).toBe(true);
    expect(accepted({ ...fixture.request, source: null, target: null })).toBe(true);
    expect(accepted({ ...fixture.request, consumerModuleId: 'unknown.consumer' })).toBe(false);
  });

  it('keeps the original denial responses valid and adds only an optional, evidenced distinction', () => {
    const plain = { evaluatedAt: fixture.evaluatedAt, outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' };
    expect(Schema.is(SourceProcessingEligibilityResponseSchema)(plain)).toBe(true);
    // An unevidenced claim of a prohibition is not representable: the distinction must carry the owner's evidence.
    expect(
      Schema.is(SourceProcessingEligibilityResponseSchema)({ ...plain, eligibility: { outcome: 'NOT_ALLOWED' } }),
    ).toBe(false);
    expect(
      Schema.is(SourceProcessingEligibilityResponseSchema)({
        ...plain,
        eligibility: { evidence: {}, outcome: 'ALLOWED' },
      }),
    ).toBe(false);
  });

  it('admits the Communications module as a declared caller beside the three original callers', () => {
    expect(sourceProcessingEligibilityRead.descriptor.accessActor?.callers).toEqual([
      'party-registry',
      'commerce-customer-context',
      'symmy-integration',
      'communications',
    ]);
    // The same enrolled workload and the same declaration: no new authority path was invented for Communications.
    expect(sourceProcessingEligibilityRead.descriptor.accessActor?.subjectWorkloads).toEqual([
      'privacy.core.source-processing-check',
    ]);
    expect(sourceProcessingEligibilityRead.descriptor.accessDeclaration?.key).toBe(
      'privacy.core.source-processing-eligibility.read',
    );
  });
});
