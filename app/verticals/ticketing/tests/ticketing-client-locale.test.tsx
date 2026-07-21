import { afterEach, expect, rs, test } from '@rstest/core';
import {
  Effect,
  getTaskPropertyWorkspace,
  queryIntrinsicTaskProperties,
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

test('catalog reads and order transitions cannot override the browser preferred locale', async () => {
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
    getTaskPropertyWorkspace('collection-1', {
      baseUrl: 'https://ticketing.example.test',
      locale: 'forged-XX',
    }),
  );
  await Effect.runPromiseExit(
    queryIntrinsicTaskProperties(
      {
        collectionId: 'collection-1',
        operation: { _tag: 'CreatedTimeSearch', value: '29 Mar 2026' },
        propertyDefinitionId: 'property-1',
      },
      { baseUrl: 'https://ticketing.example.test', locale: 'forged-XX' },
    ),
  );
  await Effect.runPromiseExit(
    runConfigureSelectOptionOrderAction(
      {
        collectionId: 'collection-1',
        expectedRevision: 2,
        optionOrderMode: 'manual',
        propertyDefinitionId: 'property-1',
      },
      { baseUrl: 'https://ticketing.example.test', locale: 'forged-XX' },
    ),
  );

  expect(requestUrls).toHaveLength(3);
  expect(new URL(requestUrls[0], 'https://ticketing.example.test').searchParams.get('locale')).toBe(
    'sv-SE',
  );
  expect(requestBodies).toHaveLength(2);
  expect(requestBodies).toEqual([
    expect.objectContaining({ viewerLocale: 'sv-SE' }),
    expect.objectContaining({ viewerLocale: 'sv-SE' }),
  ]);
});
