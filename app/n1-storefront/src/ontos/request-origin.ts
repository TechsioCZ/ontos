import { Effect, Schema } from "effect";

export class RequestOriginInvalid extends Schema.TaggedError<RequestOriginInvalid>()(
  "RequestOriginInvalid",
  {},
) {}

/** Next may normalize Request.url's hostname. HTTP Host remains the incoming public authority.
 * Retain the framework's protocol and path; never accept forwarded headers or an Origin fallback. */
export const normalizePublicRequest = (request: Request) =>
  Effect.gen(function* normalizePublicRequestProgram() {
    const frameworkUrl = URL.parse(request.url);
    const authority = request.headers.get("host");
    if (
      frameworkUrl === null ||
      (frameworkUrl.protocol !== "http:" && frameworkUrl.protocol !== "https:") ||
      authority === null ||
      authority.length === 0 ||
      /[\s/@?#\\,]/u.test(authority)
    ) {
      return yield* new RequestOriginInvalid({});
    }
    const publicUrl = URL.parse(`${frameworkUrl.protocol}//${authority}`);
    if (
      publicUrl === null ||
      publicUrl.username !== "" ||
      publicUrl.password !== "" ||
      publicUrl.pathname !== "/" ||
      publicUrl.search !== "" ||
      publicUrl.hash !== ""
    ) {
      return yield* new RequestOriginInvalid({});
    }
    publicUrl.pathname = frameworkUrl.pathname;
    publicUrl.search = frameworkUrl.search;
    publicUrl.hash = frameworkUrl.hash;
    return yield* Effect.try({
      catch: () => new RequestOriginInvalid({}),
      try: () => new Request(publicUrl, request),
    });
  });
