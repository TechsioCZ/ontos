import { expect, it } from 'effect-rstest';

import { connectionAllowsWrite } from '../../src/api/records.read.ts';

it('only a direct MCP connection with leasing write may change occupancies', () => {
  expect(connectionAllowsWrite({ authMethod: 'session' }, 'property.leasing')).toBe(true);
  expect(connectionAllowsWrite({ authMethod: 'oauth_connection' }, 'property.leasing')).toBe(false);
});
