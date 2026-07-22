import { describe, expect, it } from '@rstest/core';

import { ticketingOperationContexts } from '../shared/api';
import { getSelectOptionDeletionImpact } from '../src/api/ticketing-client';

describe('Select option deletion API', () => {
  it('exposes the preview through the typed Ticketing client', () => {
    expect(typeof getSelectOptionDeletionImpact).toBe('function');
    expect(ticketingOperationContexts.getSelectOptionDeletionImpact).toEqual({
      method: 'GET',
      operationId: 'TicketingApi:ticketing:getSelectOptionDeletionImpact',
      routePath:
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/options/:optionId/deletion-impact',
      source: 'generated-client',
    });
  });
});
