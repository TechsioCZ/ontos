import { expect, rs } from '@rstest/core';

declare const app: { handler(request: Request): Promise<Response> };

const fetch: typeof globalThis.fetch = (input, init) => app.handler(new Request(input, init));
const fetchSpy = rs.spyOn(globalThis, 'fetch');
document.body.innerHTML = '<main></main>';
window.dispatchEvent(new Event('resize'));
expect(fetchSpy).not.toHaveBeenCalled();
export { fetch };
