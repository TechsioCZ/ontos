// expect-count: 3
import { rs } from '@rstest/core';

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [] } });
rs.stubGlobal('fetch', async () => new Response('{}'));
rs.spyOn(globalThis, 'navigator', 'get').mockReturnValue({} as Navigator);
if (previousDocument !== undefined) Object.defineProperty(globalThis, 'document', previousDocument);
