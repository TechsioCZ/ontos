import { useEffect, useState } from 'react';
import { useApi } from '../api.ts';
import { EmptyState, ErrorState, Icon, Spinner } from '../components/ui.tsx';
import { readOrder, rememberOrder } from '../orders.ts';
import { Link, useDocumentTitle } from '../router.tsx';
import type { PlacedOrder } from '../shared/types.ts';
import { DEMO_DISCLAIMER } from '../shared/types.ts';
import { formatCzk, formatDateTime } from '../shared/text.ts';

const STATUS: Record<string, string> = {
  CANCELLED: 'Stornovaná',
  CONFIRMED: 'Zpracovává se',
  DELIVERED: 'Dokončená',
  NEW: 'Nová',
  PACKING: 'Připravená k předání',
  SHIPPED: 'Předáno dopravci (simulace)',
};

export const ConfirmationPage = ({ submissionId }: { readonly submissionId: string }) => {
  const [local] = useState<PlacedOrder | undefined>(() => readOrder(submissionId));
  // Always re-read the stored order through the BFF, so a refresh proves the saved number and current state.
  const server = useApi<PlacedOrder>(`/api/orders/${encodeURIComponent(submissionId)}`);
  const order = server.data ?? local;
  useEffect(() => {
    if (server.data !== undefined) rememberOrder(server.data);
  }, [server.data]);
  useDocumentTitle(order === undefined ? 'Potvrzení objednávky' : `DEMO objednávka ${order.orderNumber}`);

  if (order === undefined) {
    if (server.loading) {
      return (
        <div className="container page-pad">
          <Spinner label="Načítám uloženou objednávku…" />
        </div>
      );
    }
    if (server.error?.status === 404) {
      return (
        <div className="container page-pad">
          <EmptyState action={<Link className="button button--primary" to="/">Na úvod</Link>} title="Objednávka nenalezena">
            <p>Pod tímto odkazem není uložená žádná DEMO objednávka.</p>
          </EmptyState>
        </div>
      );
    }
    return (
      <div className="container page-pad">
        <ErrorState error={server.error} onRetry={server.reload} />
      </div>
    );
  }

  const goods = order.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  return (
    <div className="container page-pad confirmation">
      <ol className="steps" aria-label="Postup objednávky">
        <li className="is-done">Košík</li>
        <li className="is-done">Údaje a doprava</li>
        <li className="is-current" aria-current="step">
          Potvrzení
        </li>
      </ol>
      <section className="confirmation__hero">
        <div className="confirmation__check" aria-hidden="true">
          <Icon name="check" size={40} />
        </div>
        <span className="eyebrow">Uloženo v OntOS</span>
        <h1>
          DEMO objednávka č. <span className="order-number">{order.orderNumber}</span> byla uložena do administrace
        </h1>
        <p className="confirmation__disclaimer" role="note">
          <Icon name="info" size={18} /> {DEMO_DISCLAIMER}
        </p>
        <p className="muted">
          Jde o potvrzení testovacího záznamu, nikoliv o příslib plnění. Nic se neplatí, nerezervuje, neodesílá ani nedoručuje.
        </p>
      </section>

      <div className="confirmation__grid">
        <section className="form-card">
          <h2>Souhrn objednávky</h2>
          <dl className="summary__rows summary__rows--meta">
            <div>
              <dt>Číslo</dt>
              <dd>
                <strong>{order.orderNumber}</strong>
              </dd>
            </div>
            <div>
              <dt>Stav</dt>
              <dd>
                <span className="badge badge--status">{STATUS[order.status] ?? order.status}</span>
              </dd>
            </div>
            {order.createdAt === null ? null : (
              <div>
                <dt>Vytvořeno</dt>
                <dd>{formatDateTime(order.createdAt)}</dd>
              </div>
            )}
            {order.contactName === null ? null : (
              <div>
                <dt>Odběratel (fiktivní)</dt>
                <dd>{order.contactName}</dd>
              </div>
            )}
          </dl>
          <ul className="summary__lines summary__lines--plain">
            {order.lines.map((line, index) => (
              <li key={index}>
                <div>
                  <strong>{line.name}</strong>
                  <small>
                    {line.variantLabel === null ? '' : `${line.variantLabel} · `}
                    {line.quantity} × {formatCzk(line.unitPriceMinor)}
                    {line.sku === '' ? '' : ` · ${line.sku}`}
                  </small>
                </div>
                <span>{formatCzk(line.lineTotalMinor)}</span>
              </li>
            ))}
          </ul>
          <dl className="summary__rows">
            <div>
              <dt>Zboží</dt>
              <dd>{formatCzk(goods)}</dd>
            </div>
            {order.shipping === null ? null : (
              <div>
                <dt>{order.shipping.label}</dt>
                <dd>{order.shipping.priceMinor === 0 ? 'Zdarma' : formatCzk(order.shipping.priceMinor)}</dd>
              </div>
            )}
            <div>
              <dt>Platba</dt>
              <dd>neplatíte nic</dd>
            </div>
          </dl>
          {order.totalMinor === null ? null : (
            <div className="summary__total">
              <span>Celkem s DPH (informativně)</span>
              <strong>{formatCzk(order.totalMinor)}</strong>
            </div>
          )}
          {order.totalVatMinor === null ? null : <p className="summary__fine">z toho DPH {formatCzk(order.totalVatMinor)}</p>}
        </section>
        <aside className="confirmation__next">
          <h2>Co bude dál?</h2>
          <ol>
            <li>Objednávka je teď ve stavu „Nová“ v administraci OntOS pod číslem {order.orderNumber}.</li>
            <li>Správce ji může upravit a provést stavy až po „Předáno dopravci (simulace)“ a „Dokončená“.</li>
            <li>Nic se vám neodešle – žádný e-mail, SMS, platba ani zásilka.</li>
          </ol>
          <p className="muted">Po obnovení stránky uvidíte stejné číslo objednávky – načítá se z uloženého záznamu.</p>
          <Link className="button button--primary button--block" to="/produkty">
            Pokračovat v prohlížení
          </Link>
        </aside>
      </div>
    </div>
  );
};
