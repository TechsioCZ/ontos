import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Schema } from 'effect';
import { describe, expect, it, rstest } from 'effect-rstest';

import { priceListSaveResult } from '../../src/market-admin/assortment-section.tsx';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({ useModernI18n: () => ({ language: 'cs', t: String }) }));

const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-14T10:00:00.000Z',
  proposalId: '77777777-7777-4777-8777-777777777777',
});

describe('market writes parked for approval', () => {
  it('keeps a price list parked for approval unsaved, without inventing a market revision', () => {
    expect(priceListSaveResult(proposal)).toBe('failed');
  });

  it('adopts the committed market revision, or reports a plain save when the owner returns none', () => {
    expect(priceListSaveResult({ entityIds: [], marketRevision: 3, revision: 12 })).toBe(3);
    expect(priceListSaveResult({ entityIds: [], revision: 12 })).toBe('saved');
  });
});
