// Cart re-validation and the DEMO order submission (merchandise PlaceStorefrontOrder through apply-command).
// Exactly-once: the browser's submissionId is the owner's `clientRequestId`. Concurrent duplicates share one
// in-flight promise, and a repeated id is answered by the owner (outcome REPLAYED) or found by a read.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type {
  ApiProblem,
  CartLineCheck,
  CartLineInput,
  CartValidation,
  OrderIssue,
  OrderRequest,
  PlacedOrder,
  ShippingOption,
} from '../src/shared/types.ts';
import { invalidateRecords, loadRecords, loadStoredOrder, projectCatalog, useFixture } from './catalog.ts';
import type { ProjectedCatalog } from './catalog.ts';
import { callAction, OntosError } from './ontos.ts';
import { placeFixtureOrder } from './dev-fixture.ts';

type Raw = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Simulated carriers; mirror of the merchandise owner's `shippingMethods` (it re-checks the price on submit). */
export const SHIPPING_OPTIONS: readonly ShippingOption[] = [
  { description: 'Vyzvednutí na výdejním místě do 2 pracovních dnů. Jen simulace, nic se neodesílá.', id: 'ZASILKOVNA', label: 'Zásilkovna – výdejní místo (simulace)', priceMinor: 7_900 },
  { description: 'Doručení kurýrem na adresu. Jen simulace, žádný dopravce nedostane požadavek.', id: 'PPL', label: 'PPL – doručení na adresu (simulace)', priceMinor: 12_900 },
  { description: 'Balík Do ruky. Jen simulace, nic se neodesílá.', id: 'CESKA_POSTA', label: 'Česká pošta – Balík Do ruky (simulace)', priceMinor: 11_900 },
  { description: 'Vyzvednutí v kavárně na Údolní 12, Brno. Jen simulace.', id: 'OSOBNI_ODBER', label: 'Osobní odběr – Kavárna Doma, Brno (simulace)', priceMinor: 0 },
];

export class HttpProblem extends Error {
  readonly status: number;
  readonly problem: ApiProblem;
  constructor(status: number, problem: ApiProblem) {
    super(problem.message);
    this.status = status;
    this.problem = problem;
  }
}

const formatMinor = (minor: number): string =>
  new Intl.NumberFormat('cs-CZ', { currency: 'CZK', maximumFractionDigits: 2, style: 'currency' }).format(minor / 100);

export const validateCart = (catalog: ProjectedCatalog, lines: readonly CartLineInput[]): CartValidation => {
  const checks: CartLineCheck[] = lines.map((line) => {
    const product = catalog.products.find((item) => item.id === line.productId);
    const variant = product?.variants.find((item) => item.id === line.variantId);
    const base = {
      acceptedPriceMinor: line.priceMinor,
      productId: line.productId,
      quantity: line.quantity,
      variantId: line.variantId,
    };
    if (product === undefined || variant === undefined) {
      return { ...base, availability: null, availableQuantity: null, currentPriceMinor: null, image: null, message: 'Produkt už není v nabídce e-shopu.', name: null, sku: null, slug: null, status: 'NOT_FOUND', variantLabel: null };
    }
    const known = {
      ...base,
      availability: variant.availability,
      availableQuantity: variant.availableQuantity,
      currentPriceMinor: variant.priceMinor,
      image: product.image,
      name: product.name,
      sku: variant.sku,
      slug: product.slug,
      variantLabel: product.variants.length > 1 || variant.id !== product.id ? variant.label : null,
    };
    if (variant.priceMinor === null) return { ...known, message: 'Cena není dostupná, položku nelze objednat.', status: 'NO_PRICE' };
    if (variant.availability === 'OUT_OF_STOCK') return { ...known, message: 'Není skladem.', status: 'OUT_OF_STOCK' };
    if (variant.availability === 'UNKNOWN') return { ...known, message: 'Dostupnost nyní nelze ověřit, proto položku nelze objednat.', status: 'UNKNOWN_AVAILABILITY' };
    if (variant.availableQuantity !== null && line.quantity > variant.availableQuantity) {
      return { ...known, message: `Skladem je jen ${variant.availableQuantity} ks.`, status: 'INSUFFICIENT_STOCK' };
    }
    if (line.priceMinor !== variant.priceMinor) {
      return {
        ...known,
        message: line.priceMinor === null ? null : `Cena se změnila z ${formatMinor(line.priceMinor)} na ${formatMinor(variant.priceMinor)}.`,
        status: 'PRICE_CHANGED',
      };
    }
    return { ...known, message: null, status: 'OK' };
  });
  const priced = checks.every((check) => check.currentPriceMinor !== null);
  return {
    canCheckout: checks.length > 0 && checks.every((check) => check.status === 'OK'),
    checkedAt: catalog.snapshot.fetchedAt,
    lines: checks,
    subtotalMinor: priced ? checks.reduce((sum, check) => sum + (check.currentPriceMinor ?? 0) * check.quantity, 0) : null,
  };
};

// ---------------------------------------------------------------- request validation

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const UUIDISH = /^[A-Za-z0-9][A-Za-z0-9-]{7,119}$/u;

export const parseCartLines = (value: unknown): CartLineInput[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new HttpProblem(400, { code: 'cart_invalid', message: 'Košík je prázdný nebo neplatný.' });
  }
  return value.map((item: Raw) => {
    const quantity = num(item?.quantity);
    const productId = str(item?.productId);
    const variantId = str(item?.variantId);
    if (productId === undefined || variantId === undefined || quantity === undefined || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new HttpProblem(400, { code: 'cart_invalid', message: 'Položka košíku je neplatná.' });
    }
    const priceMinor = item.priceMinor === null ? null : num(item.priceMinor) ?? null;
    return { priceMinor, productId, quantity, variantId };
  });
};

export const parseOrderRequest = (body: Raw): OrderRequest => {
  const submissionId = str(body.submissionId);
  if (submissionId === undefined || !UUIDISH.test(submissionId)) {
    throw new HttpProblem(400, { code: 'submission_invalid', message: 'Chybí identifikátor odeslání.' });
  }
  const contact = (body.contact ?? {}) as Raw;
  const address = (body.address ?? {}) as Raw;
  const fieldErrors: Record<string, string> = {};
  const name = str(contact.name);
  const email = str(contact.email);
  const street = str(address.street);
  const city = str(address.city);
  const postalCode = str(address.postalCode);
  if (name === undefined || name.length < 3) fieldErrors.name = 'Vyplňte jméno a příjmení (stačí fiktivní).';
  if (email === undefined) fieldErrors.email = 'Vyplňte e-mail (stačí fiktivní).';
  else if (!EMAIL.test(email)) fieldErrors.email = 'E-mail nemá platný tvar, například jana.novakova@example.cz.';
  if (street === undefined) fieldErrors.street = 'Vyplňte ulici a číslo popisné.';
  if (city === undefined) fieldErrors.city = 'Vyplňte město.';
  if (postalCode === undefined) fieldErrors.postalCode = 'Vyplňte PSČ.';
  else if (!/^\d{3}\s?\d{2}$/u.test(postalCode)) fieldErrors.postalCode = 'PSČ má tvar 602 00.';
  const shipping = SHIPPING_OPTIONS.find((option) => option.id === body.shippingMethod);
  if (shipping === undefined) fieldErrors.shippingMethod = 'Vyberte způsob dopravy.';
  if (Object.keys(fieldErrors).length > 0) {
    throw new HttpProblem(400, { code: 'validation_failed', fieldErrors, message: 'Formulář obsahuje chyby. Opravte zvýrazněná pole.' });
  }
  const phone = str(contact.phone);
  const note = str(body.note);
  return {
    address: { city: city as string, country: 'Česká republika', postalCode: postalCode as string, street: street as string },
    contact: { email: email as string, name: name as string, ...(phone === undefined ? {} : { phone }) },
    expectedShippingPriceMinor: num(body.expectedShippingPriceMinor) ?? (shipping as ShippingOption).priceMinor,
    lines: parseCartLines(body.lines),
    shippingMethod: (shipping as ShippingOption).id,
    submissionId,
    ...(note === undefined ? {} : { note: note.slice(0, 1000) }),
  };
};

// ---------------------------------------------------------------- persistence of BFF answers (cache only)

const DATA_DIR = new URL('../.data/', import.meta.url);
const DATA_FILE = new URL('placed-orders.json', DATA_DIR);
const placed = new Map<string, PlacedOrder>();
try {
  if (existsSync(DATA_FILE)) {
    for (const order of JSON.parse(readFileSync(DATA_FILE, 'utf-8')) as PlacedOrder[]) placed.set(order.submissionId, order);
  }
} catch {
  // a corrupt cache is ignored: the owner read is the source of truth
}
const remember = (order: PlacedOrder): PlacedOrder => {
  placed.set(order.submissionId, order);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify([...placed.values()].slice(-500)));
  } catch {
    // cache only
  }
  return order;
};

const shippingLabel = (method: unknown): string =>
  SHIPPING_OPTIONS.find((option) => option.id === method)?.label ?? String(method ?? '');

/** Customer-safe projection of a stored owner order (found by clientRequestId). */
const fromStoredOrder = (submissionId: string, order: Raw, replayed: boolean): PlacedOrder => {
  const lines = (Array.isArray(order.lines) ? order.lines : []) as Raw[];
  const shipping = (order.shipping ?? undefined) as Raw | undefined;
  const contact = (order.contact ?? undefined) as Raw | undefined;
  return {
    contactName: str(contact?.name) ?? null,
    createdAt: str(order.createdAt) ?? null,
    lines: lines.map((line) => {
      const quantity = num(line.quantity) ?? 1;
      const unit = num(line.unitPriceMinor) ?? 0;
      return { lineTotalMinor: unit * quantity, name: str(line.productName) ?? str(line.name) ?? 'Položka', quantity, sku: str(line.sku) ?? '', unitPriceMinor: unit, variantLabel: str(line.variantName) ?? null };
    }),
    orderNumber: str(order.number) ?? '',
    replayed,
    shipping: shipping === undefined ? null : { label: str(shipping.label) ?? shippingLabel(shipping.method), priceMinor: num(shipping.priceMinor) ?? 0 },
    status: str(order.status) ?? 'NEW',
    submissionId,
    totalMinor: num(order.totalMinor) ?? null,
    totalVatMinor: num(order.totalVatMinor) ?? null,
  };
};

export const lookupOrder = async (submissionId: string): Promise<PlacedOrder | undefined> => {
  const stored = await loadStoredOrder(submissionId);
  if (stored !== undefined) return remember(fromStoredOrder(submissionId, stored, true));
  return placed.get(submissionId);
};

// ---------------------------------------------------------------- submission

const inflight = new Map<string, Promise<PlacedOrder>>();

const issuesOf = (value: unknown): OrderIssue[] =>
  (Array.isArray(value) ? (value as Raw[]) : []).map((issue) => ({
    code: str(issue.code) ?? 'UNKNOWN',
    message: str(issue.message) ?? 'Položku nelze objednat.',
    ...(str(issue.productId) === undefined ? {} : { productId: str(issue.productId) }),
    ...(str(issue.variantId) === undefined ? {} : { variantId: str(issue.variantId) }),
    ...(num(issue.currentUnitPriceMinor) === undefined ? {} : { currentUnitPriceMinor: num(issue.currentUnitPriceMinor) }),
    ...(num(issue.expectedUnitPriceMinor) === undefined ? {} : { expectedUnitPriceMinor: num(issue.expectedUnitPriceMinor) }),
  }));

const commandOf = (request: OrderRequest): Raw => ({
  _tag: 'PlaceStorefrontOrder',
  clientRequestId: request.submissionId,
  contact: request.contact,
  deliveryAddress: request.address,
  expectedShippingPriceMinor: request.expectedShippingPriceMinor,
  lines: request.lines.map((line) => ({
    expectedUnitPriceMinor: line.priceMinor ?? 0,
    productId: line.productId,
    quantity: line.quantity,
    ...(line.variantId === line.productId ? {} : { variantId: line.variantId }),
  })),
  shippingMethod: request.shippingMethod,
  ...(request.note === undefined ? {} : { note: request.note }),
});

const fromResult = (request: OrderRequest, result: Raw, createdAt: string | null): PlacedOrder => {
  const lines = (Array.isArray(result.lines) ? result.lines : []) as Raw[];
  const shippingPriceMinor = num(result.shippingPriceMinor);
  return {
    contactName: request.contact.name,
    createdAt,
    lines: lines.map((line) => ({
      lineTotalMinor: num(line.lineTotalMinor) ?? 0,
      name: str(line.name) ?? 'Položka',
      quantity: num(line.quantity) ?? 1,
      sku: str(line.sku) ?? '',
      unitPriceMinor: num(line.unitPriceMinor) ?? 0,
      variantLabel: str(line.variantName) ?? null,
    })),
    orderNumber: str(result.orderNumber) ?? '',
    replayed: result.outcome === 'REPLAYED',
    shipping: shippingPriceMinor === undefined ? null : { label: shippingLabel(request.shippingMethod), priceMinor: shippingPriceMinor },
    status: str(result.status) ?? 'NEW',
    submissionId: request.submissionId,
    totalMinor: num(result.totalMinor) ?? null,
    totalVatMinor: num(result.totalVatMinor) ?? null,
  };
};

const submitOnce = async (request: OrderRequest): Promise<PlacedOrder> => {
  const known = placed.get(request.submissionId);
  if (known !== undefined) return { ...known, replayed: true };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await loadRecords(true);
    const stored = await loadStoredOrder(request.submissionId);
    if (stored !== undefined) return remember(fromStoredOrder(request.submissionId, stored, true));

    // Pre-flight with the same owner projection the customer saw: a stale cart never reaches the owner.
    const check = validateCart(projectCatalog(snapshot), request.lines);
    if (!check.canCheckout) {
      throw new HttpProblem(409, {
        code: 'cart_changed',
        issues: check.lines.filter((line) => line.status !== 'OK').map((line) => ({
          code: line.status,
          message: line.message ?? 'Položka se změnila.',
          productId: line.productId,
          variantId: line.variantId,
          ...(line.currentPriceMinor === null ? {} : { currentUnitPriceMinor: line.currentPriceMinor }),
        })),
        message: 'Košík se mezitím změnil. Zkontrolujte ceny a dostupnost a potvrďte znovu.',
      });
    }

    const payload = { command: commandOf(request), expectedRevision: snapshot.revision };
    let result: Raw;
    try {
      if (useFixture()) {
        result = { storefrontOrder: placeFixtureOrder(payload.command) };
      } else {
        // Same submission + identical payload (incl. revision) => same idempotency key, so a repeated request is
        // recognised by Core; a changed payload is a new invocation that the owner de-duplicates by clientRequestId.
        const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 20);
        result = (await callAction('merchandise', 'apply-command', payload, `sf-${request.submissionId}-${digest}`)) as Raw;
      }
    } catch (error) {
      if (error instanceof OntosError && error.status === 409 && (error.code === 'merchandise_revision_conflict' || error.code === 'action_already_committed')) {
        invalidateRecords();
        continue; // re-read: either the order is now stored (already committed) or retry on the new revision
      }
      throw error;
    }
    invalidateRecords();
    const order = (result.storefrontOrder ?? undefined) as Raw | undefined;
    if (order === undefined) {
      // Owner without the storefront result shape: resolve the stored order by a read.
      const found = await loadStoredOrder(request.submissionId);
      if (found !== undefined) return remember(fromStoredOrder(request.submissionId, found, false));
      throw new HttpProblem(502, { code: 'order_unconfirmed', message: 'Uložení objednávky nebylo potvrzeno. Zkuste to prosím znovu – objednávka nevznikne dvakrát.' });
    }
    if (order.outcome === 'REJECTED') {
      throw new HttpProblem(409, { code: 'order_rejected', issues: issuesOf(order.issues), message: 'Objednávku nelze uložit: některé položky se změnily.' });
    }
    if (order.outcome !== 'PLACED' && order.outcome !== 'REPLAYED') {
      throw new HttpProblem(502, { code: 'order_unconfirmed', message: 'Uložení objednávky nebylo potvrzeno.' });
    }
    const after = useFixture() ? undefined : await loadStoredOrder(request.submissionId).catch(() => undefined);
    return remember(
      after === undefined
        ? fromResult(request, order, new Date().toISOString())
        : { ...fromStoredOrder(request.submissionId, after, order.outcome === 'REPLAYED') },
    );
  }
  throw new HttpProblem(503, { code: 'order_busy', message: 'Systém je právě zaneprázdněný. Zkuste odeslání za chvíli znovu – objednávka nevznikne dvakrát.' });
};

/** Concurrent duplicates (double-click, retried request) share one in-flight submission. */
export const placeOrder = async (request: OrderRequest): Promise<PlacedOrder> => {
  const running = inflight.get(request.submissionId);
  if (running !== undefined) return await running;
  const run = submitOnce(request);
  inflight.set(request.submissionId, run);
  try {
    return await run;
  } finally {
    inflight.delete(request.submissionId);
  }
};
