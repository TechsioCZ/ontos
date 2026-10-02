import { describe, expect, it } from 'effect-rstest';
import { getVerticalRuntimeActions } from '@app/core-runtime';

import { pricingApi } from '../../shared/api.ts';
import { manageCommitmentConfirmationAction } from '../../src/actions/manage-commitment-confirmation.action.ts';
import { pricingRegistration } from '../../vertical.registration.ts';

describe('commitment confirmation publication boundary', () => {
  it('keeps the Action registered without publishing its dormant HTTP group', () => {
    expect(Object.keys(pricingApi.groups)).not.toContain('manageCommitmentConfirmationAction');
    expect(getVerticalRuntimeActions(pricingRegistration)).toContain(manageCommitmentConfirmationAction);
  });
});
