import { OntosMcpHidden } from '@app/core-runtime/modules/mcp-contribution';
import { expect, it } from 'effect-rstest';

import { privacyMcpContribution } from '../../shared/mcp/contribution.ts';
import { privacyManifest } from '../../vertical.manifest.ts';

it('the deployed catalog hides exactly the two tools whose consent authorities are not installed', () => {
  expect(privacyMcpContribution.actions['consent-self-service']).not.toBe(OntosMcpHidden);
  expect(privacyMcpContribution.actions['record-notice-provision']).not.toBe(OntosMcpHidden);
  expect(privacyManifest.publicSurface.mcp).toEqual({
    ...privacyMcpContribution,
    actions: {
      ...privacyMcpContribution.actions,
      'consent-self-service': OntosMcpHidden,
      'record-notice-provision': OntosMcpHidden,
    },
  });
});
