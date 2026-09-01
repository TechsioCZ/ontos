import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';

export interface CustomerAresLoaderCopy {
  readonly formLabel: string;
  readonly icoInvalid: string;
  readonly icoLabel: string;
  readonly lookup: string;
  readonly lookingUp: string;
}

export interface CustomerAresLoaderStatus {
  readonly message: string;
  readonly status: 'default' | 'error' | 'success' | 'warning';
}

export interface CustomerAresLoaderProps {
  readonly copy: CustomerAresLoaderCopy;
  readonly disabled?: boolean;
  readonly onLookup: (ico: string) => Promise<void> | void;
  readonly pending?: boolean;
  readonly status?: CustomerAresLoaderStatus;
}

const icoPattern = /^[0-9]{8}$/u;

export const CustomerAresLoader = ({
  copy,
  disabled = false,
  onLookup,
  pending = false,
  status,
}: CustomerAresLoaderProps) => {
  const [ico, setIco] = useState('');
  const [icoError, setIcoError] = useState<string>();
  const icoInputRef = useRef<HTMLInputElement>(null);
  const lookupInFlightRef = useRef(false);
  const controlsDisabled = disabled || pending;
  const icoErrorId = 'customer-ares-ico-error';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (controlsDisabled || lookupInFlightRef.current) {
      return;
    }

    const normalizedIco = ico.trim();
    if (!icoPattern.test(normalizedIco)) {
      setIcoError(copy.icoInvalid);
      icoInputRef.current?.focus();
      return;
    }

    setIcoError(undefined);
    lookupInFlightRef.current = true;
    let lookup: Promise<void> | void;
    try {
      lookup = onLookup(normalizedIco);
    } catch (error) {
      lookupInFlightRef.current = false;
      throw error;
    }
    const releaseLookup = () => {
      lookupInFlightRef.current = false;
    };
    // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- React form callbacks stay synchronous, and both outcomes release the interaction guard.
    void Promise.resolve(lookup).then(releaseLookup, releaseLookup);
  };

  return (
    <form
      aria-label={copy.formLabel}
      className="contacts:grid contacts:min-w-0 contacts:gap-4"
      noValidate
      onSubmit={submit}
    >
      <FormInput
        aria-describedby={icoError === undefined ? undefined : icoErrorId}
        aria-errormessage={icoError === undefined ? undefined : icoErrorId}
        aria-invalid={icoError === undefined ? undefined : true}
        disabled={controlsDisabled}
        helpText={icoError === undefined ? undefined : <span id={icoErrorId}>{icoError}</span>}
        id="customer-ares-ico"
        inputMode="numeric"
        label={copy.icoLabel}
        name="ico"
        onChange={(event) => {
          setIco(event.currentTarget.value);
          setIcoError(undefined);
        }}
        ref={icoInputRef}
        required
        type="text"
        validateStatus={icoError === undefined ? 'default' : 'error'}
        value={ico}
      />

      <Button
        disabled={controlsDisabled}
        isLoading={pending}
        loadingText={copy.lookingUp}
        type="submit"
        variant="primary"
      >
        {copy.lookup}
      </Button>

      {status === undefined ? null : (
        <output aria-live="polite">
          <StatusText showIcon status={status.status}>
            {status.message}
          </StatusText>
        </output>
      )}
    </form>
  );
};
