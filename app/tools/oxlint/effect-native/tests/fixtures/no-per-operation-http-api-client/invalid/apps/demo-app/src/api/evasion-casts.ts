// expect-count: 3
// `as` / `!` / `satisfies` wrappers around the callee must not hide the constructor.
import * as bff from '@modern-js/plugin-bff/effect-client';
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

type Builder = (api: unknown, options: unknown) => unknown;

export const withAs = (baseUrl: string) =>
  (makeEffectHttpApiClient as Builder)(contactsApi, { baseUrl });

export const withNonNull = (baseUrl: string) => HttpApiClient.make!(contactsApi, { baseUrl });

export const withSatisfies = (baseUrl: string) =>
  (bff.makeEffectHttpApiClient satisfies Builder)(contactsApi, { baseUrl });
