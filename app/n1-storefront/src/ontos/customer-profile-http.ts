import { constUndefined } from "effect/Function";
import type { OperationError } from "@ontos/storefront-runtime";
import { storefrontHttpClientLayer, ownerHttp } from "./owner-operation";
import "server-only";
import { ByteSize, Context, Effect, Layer, ManagedRuntime, Match } from "effect";
import {
  Cookies,
  FetchHttpClient,
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import {
  CustomerProfileApi,
  CustomerProfileAuthenticationProblem,
  CustomerProfileConflictProblem,
  CustomerProfileForbiddenProblem,
  CustomerProfileInvalidProblem,
  CustomerProfileReadSchema,
  CustomerProfileSchemaErrorMiddleware,
  CustomerProfileUnavailableProblem,
  CustomerProfileUnconfirmedProblem,
} from "./customer-profile";
import type { CustomerProfileRead } from "./customer-profile";
import { readCustomerProfile, updateCustomerProfile } from "./customer-profile-server";
import type { CustomerProfileFailure } from "./customer-profile-server";
import { portalRequestContext } from "./portal-server";
import type { PortalRequestContext } from "./portal-server";
import { isPortalOrigin } from "./portal-model";
import { normalizePublicRequest } from "./request-origin";
import { changeCustomerAddress, readCustomerAddresses } from "./customer-addresses-server";
import { CustomerAddressesReadSchema, CustomerAddressSavedSchema } from "./customer-addresses";

const ProfileChannelRequest = Context.Reference<PortalRequestContext | undefined>(
  "n1/ProfileChannelRequest",
  {
    defaultValue: constUndefined,
  },
);

const maxBodyBytes = 16_384;
const problemContentType = "application/problem+json";
const noStore = HttpServerResponse.setHeaders({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});
const details = {
  detail: "Customer profile request could not be completed.",
  title: "Customer profile",
  type: "urn:n1:customer-profile",
};
const invalidProblem = () =>
  CustomerProfileInvalidProblem.make({ ...details, state: "invalid", status: 400 });
const operationFailureState = (
  error: OperationError,
  request: HttpServerRequest.HttpServerRequest,
) => (error.kind === "overloaded" || request.method === "GET" ? "unavailable" : "unconfirmed");
const responseForFailure = (state: CustomerProfileFailure["state"]) =>
  Match.value(state).pipe(
    Match.when("invalid", () =>
      HttpServerResponse.schemaJson(CustomerProfileInvalidProblem)(invalidProblem(), {
        contentType: problemContentType,
        status: 400,
      }),
    ),
    Match.when("anonymous", () =>
      HttpServerResponse.schemaJson(CustomerProfileAuthenticationProblem)(
        CustomerProfileAuthenticationProblem.make({ ...details, state: "anonymous", status: 401 }),
        { contentType: problemContentType, status: 401 },
      ),
    ),
    Match.when("forbidden", () =>
      HttpServerResponse.schemaJson(CustomerProfileForbiddenProblem)(
        CustomerProfileForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
        { contentType: problemContentType, status: 403 },
      ),
    ),
    Match.when("conflict", () =>
      HttpServerResponse.schemaJson(CustomerProfileConflictProblem)(
        CustomerProfileConflictProblem.make({ ...details, state: "conflict", status: 409 }),
        { contentType: problemContentType, status: 409 },
      ),
    ),
    Match.when("unavailable", () =>
      HttpServerResponse.schemaJson(CustomerProfileUnavailableProblem)(
        CustomerProfileUnavailableProblem.make({ ...details, state: "unavailable", status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
    Match.when("unconfirmed", () =>
      HttpServerResponse.schemaJson(CustomerProfileUnconfirmedProblem)(
        CustomerProfileUnconfirmedProblem.make({ ...details, state: "unconfirmed", status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
    Match.exhaustive,
    Effect.orDie,
    Effect.map(noStore),
  );
const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(
  CustomerProfileSchemaErrorMiddleware,
  () => Effect.fail(invalidProblem()),
);
type ProfileService<F> = F extends (...args: infer Args) => Effect.Effect<infer A, infer E, infer R>
  ? (...args: Args) => Effect.Effect<A, E | OperationError, R>
  : never;
type ProfileProgram =
  | ReturnType<typeof readCustomerProfile>
  | ReturnType<typeof readCustomerAddresses>
  | ReturnType<typeof changeCustomerAddress>
  | ReturnType<typeof updateCustomerProfile>;
const channel = (
  request: HttpServerRequest.HttpServerRequest,
  program: (
    context: PortalRequestContext,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    CustomerProfileFailure | OperationError,
    Effect.Services<ProfileProgram>
  >,
) =>
  Effect.gen(function* customerProfileChannel() {
    const context = yield* ProfileChannelRequest;
    if (context === undefined) {
      return yield* Effect.die(new Error("Missing Profile request boundary"));
    }
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(
        response.pipe(
          noStore,
          HttpServerResponse.replaceCookies(Cookies.fromSetCookie(context.setCookies)),
        ),
      ),
    );
    return yield* program(context).pipe(
      Effect.catch((error) =>
        responseForFailure(
          Match.value(error).pipe(
            Match.tag("OperationError", (failure) => operationFailureState(failure, request)),
            Match.tag("CustomerProfileFailure", (failure) => failure.state),
            Match.exhaustive,
          ),
        ),
      ),
    );
  });

const profileChannel = (
  request: HttpServerRequest.HttpServerRequest,
  program: (
    context: PortalRequestContext,
  ) => Effect.Effect<
    CustomerProfileRead,
    CustomerProfileFailure | OperationError,
    Effect.Services<ProfileProgram>
  >,
) =>
  channel(request, (context) =>
    program(context).pipe(
      Effect.flatMap((value) =>
        HttpServerResponse.schemaJson(CustomerProfileReadSchema)(value).pipe(Effect.orDie),
      ),
    ),
  );
const addressResponse = (value: typeof CustomerAddressesReadSchema.Type) =>
  HttpServerResponse.schemaJson(CustomerAddressesReadSchema)(value).pipe(Effect.orDie);
const savedAddressResponse = (value: typeof CustomerAddressSavedSchema.Type) =>
  HttpServerResponse.schemaJson(CustomerAddressSavedSchema)(value).pipe(Effect.orDie);
const makeHandlers = (
  readAddresses: ProfileService<typeof readCustomerAddresses>,
  readProfile: ProfileService<typeof readCustomerProfile>,
  updateProfile: ProfileService<typeof updateCustomerProfile>,
  changeAddress: ProfileService<typeof changeCustomerAddress>,
) =>
  HttpApiBuilder.group(CustomerProfileApi, "customerProfile", (group) =>
    group
      .handle("read", ({ request }) => profileChannel(request, readProfile))
      .handle("readAddresses", ({ request }) =>
        channel(request, (context) => readAddresses(context).pipe(Effect.flatMap(addressResponse))),
      )
      .handle("changeAddress", ({ payload, request }) =>
        channel(request, (context) =>
          changeAddress(payload, context).pipe(Effect.flatMap(savedAddressResponse)),
        ),
      )
      .handle("update", ({ payload, request }) =>
        profileChannel(request, (context) => updateProfile(payload, context)),
      ),
  ).pipe(Layer.provide(schemaErrors));
const responsePolicy = HttpRouter.middleware(
  (effect) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        HttpServerError.isHttpServerError(defect)
          ? Match.value(defect.reason).pipe(
              Match.tag("RequestParseError", () => responseForFailure("invalid")),
              Match.orElse(() => Effect.die(defect)),
            )
          : Effect.die(defect),
      ),
      Effect.flatMap((response) =>
        response.status === 413 ? responseForFailure("invalid") : Effect.succeed(response),
      ),
      // Deadline responses pass through native sending, so request-owned Portal cookie hooks survive interruption.
      Effect.timeoutOrElse({
        duration: "55 seconds",
        orElse: () =>
          HttpServerRequest.HttpServerRequest.pipe(
            Effect.flatMap((request) =>
              responseForFailure(request.method === "GET" ? "unavailable" : "unconfirmed"),
            ),
          ),
      }),
      Effect.map(noStore),
    ),
  { global: true },
);
export const makeCustomerProfileWeb = ({
  changeAddress = changeCustomerAddress,
  readAddresses = readCustomerAddresses,
  readProfile = readCustomerProfile,
  updateProfile = updateCustomerProfile,
}: {
  changeAddress?: ProfileService<typeof changeCustomerAddress>;
  readAddresses?: ProfileService<typeof readCustomerAddresses>;
  readProfile?: ProfileService<typeof readCustomerProfile>;
  updateProfile?: ProfileService<typeof updateCustomerProfile>;
} = {}) => {
  const application = Layer.merge(HttpApiBuilder.layer(CustomerProfileApi), responsePolicy).pipe(
    Layer.provide(makeHandlers(readAddresses, readProfile, updateProfile, changeAddress)),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(storefrontHttpClientLayer),
    Layer.provideMerge(
      Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
    ),
    Layer.provideMerge(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(maxBodyBytes))),
  );
  return HttpRouter.toWebHandler(application, {
    disableLogger: true,
    middleware: (effect) =>
      Effect.gen(function* profileRequestBoundary() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const context = portalRequestContext(
          new URL(request.originalUrl).origin,
          request.headers.cookie,
        );
        return yield* ownerHttp(
          Effect.gen(function* guardCustomerProfileRequest() {
            if (
              (request.method !== "GET" || request.headers.origin !== undefined) &&
              !isPortalOrigin(request.headers.origin, request.originalUrl)
            ) {
              return yield* responseForFailure("forbidden");
            }
            const url = new URL(request.originalUrl);
            const length = request.headers["content-length"];
            if (
              url.search !== "" ||
              (request.method !== "GET" &&
                (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "") ||
                  (length !== undefined &&
                    (!/^\d+$/u.test(length) || Number(length) > maxBodyBytes))))
            ) {
              return yield* responseForFailure("invalid");
            }
            return yield* effect;
          }).pipe(Effect.map(noStore)),
          (error, failedRequest) =>
            responseForFailure(operationFailureState(error, failedRequest)).pipe(
              Effect.map(
                HttpServerResponse.replaceCookies(Cookies.fromSetCookie(context.setCookies)),
              ),
            ),
        ).pipe(Effect.updateService(ProfileChannelRequest, () => context));
      }),
  });
};
export const customerProfileWeb = makeCustomerProfileWeb();
const edgeRuntime = ManagedRuntime.make(Layer.empty);
export const customerProfileHandler = async (request: Request) =>
  await edgeRuntime.runPromise(
    normalizePublicRequest(request).pipe(
      Effect.matchEffect({
        onFailure: () => responseForFailure("invalid").pipe(Effect.map(HttpServerResponse.toWeb)),
        onSuccess: (normalized) =>
          Effect.promise(async () => await customerProfileWeb.handler(normalized)),
      }),
    ),
  );
