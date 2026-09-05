// expect-count: 6
import type { ReactElement } from 'react';

const SOCKET_CODES = new Set(['EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH']);

export function StatusBanner({ failure }: { readonly failure: Record<string, unknown> }): ReactElement {
	const code = 'code' in failure ? String(failure.code) : '';
	const retryable = code.startsWith('08') || SOCKET_CODES.has(code) || code === '57P01';
	return <p>{retryable ? 'retry' : 'failed'}</p>;
}
