import { describe, expect, it } from 'effect-rstest';
import { getVerticalRuntimeActions } from '@app/core-runtime';

import { pricingApi } from '../../shared/api.ts';
import { manageCommitmentConfirmationAction } from '../../src/actions/manage-commitment-confirmation.action.ts';
import { pricingRegistration } from '../../vertical.registration.ts';

describe('commitment confirmation publication boundary', () => {
  it('registers the Action and publishes its governed HTTP group', () => {
    expect(Object.keys(pricingApi.groups)).toContain('manageCommitmentConfirmationAction');
    expect(getVerticalRuntimeActions(pricingRegistration)).toContain(manageCommitmentConfirmationAction);
  });
});
