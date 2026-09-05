import { Predicate } from "effect";
import { isFunction as callable } from "effect/Predicate";
interface Service { readonly resolve: () => void }
interface OptionalCapability { readonly verify: () => void }
export const supportsVerify = (service: Service): service is Service & OptionalCapability =>
  "verify" in service && Predicate.isFunction(service.verify);
export const computed = (service: Service): service is Service & OptionalCapability =>
  "verify" in service && callable(service["verify"]);
