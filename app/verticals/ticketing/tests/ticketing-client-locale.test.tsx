import { afterEach, expect, rs, test } from '@rstest/core';
import {
  Effect,
  getTaskPropertyWorkspace,
  runConfigureSelectOptionOrderAction,
} from '../src/api/ticketing-client';

afterEach(() => {
  rs.unstubAllGlobals();
});

const requestText = (request: RequestInfo | URL, init?: RequestInit): Promise<string> => {
  if (request instanceof Request) {
    return request.clone().text();
  }
  if (init?.body instanceof Uint8Array) {
    return Promise.resolve(new TextDecoder().decode(init.body));
  }
  return Promise.resolve(String(init?.body ?? ''));
};

test('catalog reads and order transitions use the browser preferred locale by default', async () => {
  const requestBodies: unknown[] = [];
  const requestUrls: string[] = [];
  rs.stubGlobal('navigator', { language: 'en-US', languages: ['sv-SE', 'en-US'] });
  rs.stubGlobal(
    'fetch',
    rs.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      requestUrls.push(request instanceof Request ? request.url : request.toString());
      const body = await requestText(request, init);
      if (body.length > 0) {
        requestBodies.push(JSON.parse(body));
      }
      return new Response('{}', {
        headers: { 'content-type': 'application/json' },
        status: 500,
      });
    }),
  );

  await Effect.runPromiseExit(
    getTaskPropertyWorkspace('collection-1', { baseUrl: 'https://ticketing.example.test' }),
  );
  await Effect.runPromiseExit(
    runConfigureSelectOptionOrderAction(
      {
        collectionId: 'collection-1',
        expectedRevision: 2,
        optionOrderMode: 'manual',
        propertyDefinitionId: 'property-1',
        viewerLocale: 'forged-XX',
      },
      { baseUrl: 'https://ticketing.example.test' },
    ),
  );

  expect(requestUrls).toHaveLength(2);
  expect(new URL(requestUrls[0], 'https://ticketing.example.test').searchParams.get('locale')).toBe(
    'sv-SE',
  );
  expect(requestBodies).toContainEqual(expect.objectContaining({ viewerLocale: 'sv-SE' }));
});
