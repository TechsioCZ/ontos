import type { useParams } from '@modern-js/plugin-tanstack/runtime';

export type Loader = (params: URLSearchParams, body: FormData) => URL;
export type Hook = typeof useParams;

declare const ambientForm: FormData;

export const fieldCount = (): number => Object.keys(ambientForm).length;
