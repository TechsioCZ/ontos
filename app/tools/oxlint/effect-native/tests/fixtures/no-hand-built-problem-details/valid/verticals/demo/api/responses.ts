import { HttpServerResponse } from 'effect/unstable/http';

declare const body: string;
declare const error: { readonly message: string };

// D tier: Promise/framework adapters and transport status codes are not Problem Details.
export const noContent = HttpServerResponse.empty({ status: 204 });

export const ok = new Response(body, {
  headers: { 'content-type': 'application/json' },
  status: 200,
});

export const redirect = { location: '/login', status: 302 };

export const fixture = { body, contentType: 'application/json', status: 200 };

// Not a Problem Details payload: no title, no type, no `…Problem` tag.
export const logged = { message: error.message, operation: 'contacts.read' };

// A status carried by a non-problem envelope stays quiet.
export const envelope = { data: body, status: 200 };
