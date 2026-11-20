import { SystemWorkloadRegistrationInvalidError } from './system-workload-registration-invalid-error.ts';

const registrationProvenance = Symbol('SystemWorkloadRegistration');

/**
 * One system workload a module's own code runs as: the key under which Core resolves the Tenant's enrolled system
 * Principal for that module's work. A module publishes each registration it creates in its manifest's
 * `systemWorkloads`, so Core and an operator can check which system workloads it has.
 */
export interface SystemWorkloadRegistration {
  readonly allowServicePrincipal: boolean;
  readonly jobKey: string;
  readonly [registrationProvenance]?: true;
}

export const systemWorkloadPart = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u;

const rejectInvalidSystemWorkloadRegistration = (): never => {
  const failure = new SystemWorkloadRegistrationInvalidError({
    code: 'system_workload_registration_invalid',
    message: 'System workload job key is invalid',
  });
  Object.setPrototypeOf(failure, TypeError.prototype);
  throw failure;
};

export const registerSystemWorkload = (input: {
  readonly allowServicePrincipal?: boolean;
  readonly jobKey: string;
}): SystemWorkloadRegistration => {
  if (!systemWorkloadPart.test(input.jobKey)) {
    return rejectInvalidSystemWorkloadRegistration();
  }
  const registration: SystemWorkloadRegistration = {
    allowServicePrincipal: input.allowServicePrincipal === true,
    jobKey: input.jobKey,
  };
  Object.defineProperty(registration, registrationProvenance, { value: true });
  return Object.freeze(registration);
};

/** Whether `registerSystemWorkload` created this registration, never a look-alike object of the same shape. */
export const isRegisteredSystemWorkload = (registration: SystemWorkloadRegistration): boolean =>
  registration[registrationProvenance] === true;
