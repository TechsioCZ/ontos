import type { Metadata } from "next";
import NextLink from "next/link";
import { Input } from "@techsio/ui-kit/atoms/input";

import { AccountShell } from "@/components/account-shell";
import { mockOrders } from "@/mock-storefront/fixtures/account";

export const metadata: Metadata = { title: "Historie objednávek" };

export default function OrderHistoryPage() {
  return (
    <AccountShell active="orders">
      <h1>Historie objednávek</h1>
      <div className="akros-order-filters">
        <Input
          aria-label="Hledat číslo objednávky"
          placeholder="Hledat číslo objednávky…"
          size="sm"
        />
        <label>
          Filtrovat podle data
          <select defaultValue="all">
            <option value="all">Všechny</option>
            <option value="month">Poslední měsíc</option>
          </select>
        </label>
        <label>
          Všechny stavy
          <select defaultValue="all">
            <option value="all">Všechny stavy</option>
            <option value="sent">Odesláno</option>
            <option value="delivered">Doručeno</option>
          </select>
        </label>
      </div>
      <div className="akros-order-table">
        <table>
          <thead>
            <tr>
              <th>Číslo objednávky</th>
              <th>Datum</th>
              <th>Počet položek</th>
              <th>Celková cena</th>
              <th>Stav</th>
              <th>Akce</th>
            </tr>
          </thead>
          <tbody>
            {mockOrders.map((order) => (
              <tr key={order.number}>
                <th scope="row">{order.number}</th>
                <td>{order.date}</td>
                <td>{order.items} položky</td>
                <td>
                  <strong>{order.total}</strong>
                </td>
                <td>
                  <span className="akros-status-badge">{order.status}</span>
                </td>
                <td>
                  <NextLink href="/detail-objednavky">Detail</NextLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AccountShell>
  );
}
