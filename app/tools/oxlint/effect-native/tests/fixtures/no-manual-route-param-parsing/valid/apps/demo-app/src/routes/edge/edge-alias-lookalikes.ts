import { URL as NodeUrl, URLSearchParams as NodeSearchParams } from 'node:url';
import { useParams } from '@modern-js/plugin-tanstack/runtime';

// Imported (non-global) constructors, typed hook options held in a binding and plain objects that
// merely own a `searchParams` field must all stay clean, even with alias resolution enabled.
const typedOptions = { from: '/$lang/contacts/customers/$id' } as const;
const parsedNode = new NodeUrl('https://example.test/x?q=1');
const descriptor = { searchParams: 'plain' };
const mirror = descriptor;

export const nodeQuery = (): string | null => new NodeSearchParams('q=1').get('q');
export const nodeHref = (): string => parsedNode.toString();
export const typedParams = () => useParams(typedOptions);
export const label = (): string => mirror.searchParams;
export const canParse = (raw: string): boolean => URL.canParse(raw);
