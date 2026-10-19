import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, request, useApi } from '../api.ts';
import { useCart } from '../cart.tsx';
import { EmptyState, ErrorState, Icon, Spinner } from '../components/ui.tsx';
import { rememberOrder } from '../orders.ts';
import { Link, navigate, useDocumentTitle } from '../router.tsx';
import type { OrderIssue, PlacedOrder, ShippingMethodId, ShippingOption } from '../shared/types.ts';
import { DEMO_DISCLAIMER } from '../shared/types.ts';
import { formatCzk } from '../shared/text.ts';
import { useCartValidation } from '../useCartValidation.ts';

interface FormState {
  name: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  postalCode: string;
  shippingMethod: ShippingMethodId | '';
  note: string;
}

const EMPTY: FormState = { city: '', email: '', name: '', note: '', phone: '', postalCode: '', shippingMethod: '', street: '' };
const SAMPLE: FormState = {
  city: 'Brno',
  email: 'jana.novakova@example.cz',
  name: 'Jana Nováková',
  note: 'Ukázková objednávka pro prezentaci.',
  phone: '+420 600 000 000',
  postalCode: '602 00',
  shippingMethod: 'ZASILKOVNA',
  street: 'Ukázková 12',
};
const FORM_KEY = 'kavarna-doma.checkout.form';
const SUBMISSION_KEY = 'kavarna-doma.checkout.submission';

const readForm = (): FormState => {
  try {
    return { ...EMPTY, ...(JSON.parse(window.sessionStorage.getItem(FORM_KEY) ?? '{}') as Partial<FormState>) };
  } catch {
    return EMPTY;
  }
};

/** One submission id per checkout: reused verbatim for every retry and double-click until an order is stored. */
const submissionId = (): string => {
  const existing = window.sessionStorage.getItem(SUBMISSION_KEY);
  if (existing !== null) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(SUBMISSION_KEY, created);
  return created;
};

const validate = (form: FormState): Record<string, string> => {
  const errors: Record<string, string> = {};
  if (form.name.trim().length < 3) errors.name = 'Vyplňte jméno a příjmení (stačí fiktivní).';
  if (form.email.trim() === '') errors.email = 'Vyplňte e-mail (stačí fiktivní).';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(form.email.trim())) errors.email = 'E-mail nemá platný tvar, například jana.novakova@example.cz.';
  if (form.street.trim() === '') errors.street = 'Vyplňte ulici a číslo popisné.';
  if (form.city.trim() === '') errors.city = 'Vyplňte město.';
  if (form.postalCode.trim() === '') errors.postalCode = 'Vyplňte PSČ.';
  else if (!/^\d{3}\s?\d{2}$/u.test(form.postalCode.trim())) errors.postalCode = 'PSČ má tvar 602 00.';
  if (form.shippingMethod === '') errors.shippingMethod = 'Vyberte způsob dopravy.';
  return errors;
};

const Field = ({ id, label, error, children, hint }: { readonly id: string; readonly label: string; readonly error?: string; readonly children: ReactNode; readonly hint?: string }) => (
  <div className={`field${error === undefined ? '' : ' field--error'}`}>
    <label htmlFor={id}>{label}</label>
    {children}
    {error === undefined ? hint === undefined ? null : <small className="field__hint">{hint}</small> : <small className="field__error" id={`${id}-error`}>{error}</small>}
  </div>
);

export const CheckoutPage = () => {
  useDocumentTitle('Dokončení DEMO objednávky');
  const cart = useCart();
  const check = useCartValidation(cart.items);
  const shipping = useApi<{ options: ShippingOption[] }>('/api/shipping');
  const [form, setForm] = useState<FormState>(readForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ApiError | undefined>();
  const [issues, setIssues] = useState<readonly OrderIssue[]>([]);
  const lock = useRef(false);
  const errorSummary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.sessionStorage.setItem(FORM_KEY, JSON.stringify(form));
  }, [form]);

  if (cart.items.length === 0 && !submitting) {
    return (
      <div className="container page-pad">
        <EmptyState action={<Link className="button button--primary" to="/produkty">Vybrat kávu</Link>} title="Košík je prázdný">
          <p>Pro dokončení DEMO objednávky nejdřív vložte zboží do košíku.</p>
        </EmptyState>
      </div>
    );
  }

  const set = (key: keyof FormState) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (errors[key] !== undefined) setErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => field !== key)));
  };
  const selected = shipping.data?.options.find((option) => option.id === form.shippingMethod);
  const subtotal = check.validation?.subtotalMinor ?? null;
  const blocked = check.current && check.validation?.canCheckout !== true;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current) return; // double-click guard; the server also de-duplicates by submission id
    const found = validate(form);
    setErrors(found);
    setFailure(undefined);
    setIssues([]);
    if (Object.keys(found).length > 0) {
      window.setTimeout(() => errorSummary.current?.focus(), 0);
      return;
    }
    if (!check.current || check.validation?.canCheckout !== true) {
      check.revalidate();
      return;
    }
    lock.current = true;
    setSubmitting(true);
    const id = submissionId();
    try {
      const order = await request<PlacedOrder>('/api/orders', {
        body: JSON.stringify({
          address: { city: form.city, postalCode: form.postalCode, street: form.street },
          contact: { email: form.email, name: form.name, ...(form.phone.trim() === '' ? {} : { phone: form.phone }) },
          expectedShippingPriceMinor: selected?.priceMinor,
          lines: cart.items.map(({ priceMinor, productId, quantity, variantId }) => ({ priceMinor, productId, quantity, variantId })),
          note: form.note.trim() === '' ? undefined : form.note,
          shippingMethod: form.shippingMethod,
          submissionId: id,
        }),
        method: 'POST',
      });
      rememberOrder(order);
      window.sessionStorage.removeItem(SUBMISSION_KEY);
      window.sessionStorage.removeItem(FORM_KEY);
      navigate(`/objednavka/${id}`, { replace: true });
      cart.clear();
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(0, { code: 'unknown', message: String(error) });
      if (apiError.problem.fieldErrors !== undefined) setErrors(apiError.problem.fieldErrors);
      if (apiError.problem.issues !== undefined) {
        setIssues(apiError.problem.issues);
        check.revalidate();
      }
      setFailure(apiError);
      window.setTimeout(() => errorSummary.current?.focus(), 0);
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  };

  const errorList = Object.entries(errors);

  return (
    <div className="container page-pad checkout">
      <ol className="steps" aria-label="Postup objednávky">
        <li className="is-done">
          <Link to="/kosik">Košík</Link>
        </li>
        <li className="is-current" aria-current="step">
          Údaje a doprava
        </li>
        <li>Potvrzení</li>
      </ol>
      <h1 className="page-title">Dokončení DEMO objednávky</h1>
      <div className="notice notice--demo">
        <span className="demo-ribbon__pill">DEMO</span>
        <span>Používejte výhradně fiktivní údaje. Formulář nepřijímá platby ani čísla karet a nikomu nic neodesílá.</span>
      </div>

      <form className="checkout__grid" noValidate onSubmit={submit}>
        <div className="checkout__form">
          <div aria-live="assertive" className="checkout__alerts" ref={errorSummary} tabIndex={-1}>
            {errorList.length > 0 ? (
              <div className="notice notice--danger" role="alert">
                <Icon name="warning" size={18} />
                <div>
                  <strong>Formulář obsahuje chyby, objednávka nebyla uložena.</strong>
                  <ul>
                    {errorList.map(([field, message]) => (
                      <li key={field}>{message}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
            {failure !== undefined && errorList.length === 0 ? (
              <div className="notice notice--danger" role="alert">
                <Icon name="warning" size={18} />
                <div>
                  <strong>Objednávka nebyla uložena.</strong>
                  <span>{failure.problem.message}</span>
                  {issues.length > 0 ? (
                    <ul>
                      {issues.map((issue, index) => (
                        <li key={index}>
                          {issue.message}
                          {issue.currentUnitPriceMinor === undefined ? '' : ` Aktuální cena: ${formatCzk(issue.currentUnitPriceMinor)}.`}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {issues.length > 0 ? (
                    <Link className="button button--secondary button--sm" to="/kosik">
                      Zkontrolovat košík a potvrdit nové ceny
                    </Link>
                  ) : (
                    <span className="muted">Můžete bezpečně zkusit odeslat znovu – objednávka nevznikne dvakrát.</span>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <section className="form-card">
            <div className="form-card__head">
              <h2>
                <span className="step-number">1</span> Kontakt
              </h2>
              <button className="text-link" onClick={() => {
                  setForm(SAMPLE);
                  setErrors({});
                  setFailure(undefined);
                }} type="button">
                Vyplnit ukázkové údaje
              </button>
            </div>
            <div className="form-grid">
              <Field error={errors.name} id="name" label="Jméno a příjmení *">
                <input aria-describedby={errors.name === undefined ? undefined : 'name-error'} aria-invalid={errors.name !== undefined} autoComplete="name" id="name" onChange={(event) => set('name')(event.target.value)} value={form.name} />
              </Field>
              <Field error={errors.email} hint="Fiktivní e-mail, nic vám nepošleme." id="email" label="E-mail *">
                <input aria-describedby={errors.email === undefined ? undefined : 'email-error'} aria-invalid={errors.email !== undefined} autoComplete="email" id="email" inputMode="email" onChange={(event) => set('email')(event.target.value)} type="email" value={form.email} />
              </Field>
              <Field id="phone" label="Telefon (nepovinné)">
                <input autoComplete="tel" id="phone" inputMode="tel" onChange={(event) => set('phone')(event.target.value)} value={form.phone} />
              </Field>
            </div>
          </section>

          <section className="form-card">
            <h2>
              <span className="step-number">2</span> Doručovací adresa
            </h2>
            <div className="form-grid">
              <Field error={errors.street} id="street" label="Ulice a číslo *">
                <input aria-invalid={errors.street !== undefined} autoComplete="street-address" id="street" onChange={(event) => set('street')(event.target.value)} value={form.street} />
              </Field>
              <Field error={errors.city} id="city" label="Město *">
                <input aria-invalid={errors.city !== undefined} autoComplete="address-level2" id="city" onChange={(event) => set('city')(event.target.value)} value={form.city} />
              </Field>
              <Field error={errors.postalCode} id="postalCode" label="PSČ *">
                <input aria-invalid={errors.postalCode !== undefined} autoComplete="postal-code" id="postalCode" inputMode="numeric" onChange={(event) => set('postalCode')(event.target.value)} value={form.postalCode} />
              </Field>
              <Field id="country" label="Země">
                <input disabled id="country" value="Česká republika" />
              </Field>
            </div>
          </section>

          <section className="form-card">
            <h2>
              <span className="step-number">3</span> Doprava <span className="badge badge--sim">Simulace</span>
            </h2>
            {shipping.error !== undefined ? (
              <ErrorState error={shipping.error} onRetry={shipping.reload} />
            ) : shipping.data === undefined ? (
              <Spinner />
            ) : (
              <div className={`radio-cards${errors.shippingMethod === undefined ? '' : ' radio-cards--error'}`} role="radiogroup" aria-label="Způsob dopravy">
                {shipping.data.options.map((option) => (
                  <label className={`radio-card${form.shippingMethod === option.id ? ' is-checked' : ''}`} key={option.id}>
                    <input checked={form.shippingMethod === option.id} name="shipping" onChange={() => set('shippingMethod')(option.id)} type="radio" value={option.id} />
                    <span className="radio-card__body">
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    <span className="radio-card__price">{option.priceMinor === 0 ? 'Zdarma' : formatCzk(option.priceMinor)}</span>
                  </label>
                ))}
                {errors.shippingMethod === undefined ? null : <small className="field__error">{errors.shippingMethod}</small>}
              </div>
            )}
          </section>

          <section className="form-card">
            <h2>
              <span className="step-number">4</span> Platba
            </h2>
            <label className="radio-card is-checked is-disabled">
              <input checked disabled readOnly type="radio" />
              <span className="radio-card__body">
                <strong>Platba: neplatíte nic</strong>
                <small>Jediná ukázková metoda. Žádná platební brána, žádné inkaso, žádné číslo karty.</small>
              </span>
              <span className="radio-card__price">0 Kč</span>
            </label>
            <Field id="note" label="Poznámka k objednávce (nepovinné)">
              <textarea id="note" maxLength={1000} onChange={(event) => set('note')(event.target.value)} rows={3} value={form.note} />
            </Field>
          </section>
        </div>

        <aside className="summary checkout__summary">
          <h2>Vaše objednávka</h2>
          <ul className="summary__lines">
            {cart.items.map((item) => {
              const line = check.validation?.lines.find((entry) => entry.productId === item.productId && entry.variantId === item.variantId);
              const unit = line?.currentPriceMinor ?? item.priceMinor;
              return (
                <li key={`${item.productId}:${item.variantId}`}>
                  <img alt="" height={64} src={item.image} width={64} />
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      {item.variantLabel === null ? '' : `${item.variantLabel} · `}
                      {item.quantity} ks
                    </small>
                  </div>
                  <span>{unit === null ? '–' : formatCzk(unit * item.quantity)}</span>
                </li>
              );
            })}
          </ul>
          <dl className="summary__rows">
            <div>
              <dt>Zboží</dt>
              <dd>{subtotal === null ? '–' : formatCzk(subtotal)}</dd>
            </div>
            <div>
              <dt>Doprava (simulace)</dt>
              <dd>{selected === undefined ? 'vyberte' : selected.priceMinor === 0 ? 'Zdarma' : formatCzk(selected.priceMinor)}</dd>
            </div>
            <div>
              <dt>Platba</dt>
              <dd>0 Kč</dd>
            </div>
          </dl>
          <div className="summary__total">
            <span>Celkem s DPH (informativně)</span>
            <strong>{subtotal === null ? '–' : formatCzk(subtotal + (selected?.priceMinor ?? 0))}</strong>
          </div>
          {blocked ? (
            <div className="notice notice--danger" role="alert">
              <Icon name="warning" size={18} />
              <div>
                <strong>Košík se změnil</strong>
                <span>Ceny nebo dostupnost se změnily. Zkontrolujte košík a potvrďte nové ceny.</span>
                <Link className="button button--secondary button--sm" to="/kosik">
                  Zpět do košíku
                </Link>
              </div>
            </div>
          ) : null}
          <p className="disclaimer" role="note">
            <Icon name="info" size={18} />
            <span>{DEMO_DISCLAIMER}</span>
          </p>
          <button aria-busy={submitting} className="button button--primary button--lg button--block" disabled={submitting || blocked || check.error !== undefined} type="submit">
            {submitting ? (
              <>
                <span className="dot dot--pulse dot--light" /> Ukládám objednávku…
              </>
            ) : (
              <>
                <Icon name="check" size={18} /> Potvrdit DEMO objednávku
              </>
            )}
          </button>
          <p className="summary__fine">
            {check.checking ? 'Ověřuji aktuální ceny a dostupnost…' : 'Před uložením server znovu ověří ceny a dostupnost v OntOS.'}
          </p>
        </aside>
      </form>
    </div>
  );
};
