import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { labelOf, ORDER_STATUS_CS } from './labels.ts';
import { czkFromMinor, defineTool, readRecordsOf, VERTICAL } from './shared.ts';
import { MerchandiseRecordsWire } from './wire.ts';

export const ORDER_STATUSES = ['NEW', 'CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;

export const listProductsInput = {
  lowStockOnly: z.boolean().optional().describe('Only products at or below their low-stock threshold.'),
};

export const listOrdersInput = {
  status: z.enum(ORDER_STATUSES).optional().describe('Order status filter.'),
};

export const listProducts = async (input: { readonly lowStockOnly?: boolean | undefined }) => {
  const response = await readRecordsOf(
    VERTICAL.merchandise,
    MerchandiseRecordsWire,
    input.lowStockOnly === undefined ? {} : { view: { lowStockOnly: input.lowStockOnly } },
  );
  return {
    count: response.products.length,
    indicators: {
      lowStockCount: response.indicators.lowStockCount,
      productCount: response.indicators.productCount,
      stockValueCzk: czkFromMinor(response.indicators.stockValueMinor),
    },
    items: response.products.map((product) => ({
      active: product.active,
      category: product.category,
      id: product.id,
      lowStock: product.lowStock,
      lowStockThreshold: product.lowStockThreshold,
      name: product.name,
      priceCzk: czkFromMinor(product.currentPriceMinor),
      sku: product.sku,
      stockOnHand: product.stockOnHand,
      stockValueCzk: czkFromMinor(product.stockValueMinor),
      unit: product.unit,
      vatRate: product.vatRate,
    })),
  };
};

export const listOrders = async (input: { readonly status?: (typeof ORDER_STATUSES)[number] | undefined }) => {
  const response = await readRecordsOf(
    VERTICAL.merchandise,
    MerchandiseRecordsWire,
    input.status === undefined ? {} : { view: { orderStatus: input.status } },
  );
  return {
    count: response.orders.length,
    indicators: {
      openOrderValueCzk: czkFromMinor(response.indicators.openOrderValueMinor),
      orderCount: response.indicators.orderCount,
    },
    items: response.orders.map((order) => ({
      createdAt: order.createdAt,
      id: order.id,
      lines: order.lines.map((line) => ({
        productName: line.productName,
        quantity: line.quantity,
        unitPriceCzk: czkFromMinor(line.unitPriceMinor),
        vatRate: line.vatRate,
      })),
      number: order.number,
      opportunityId: order.opportunityId ?? null,
      partyId: order.partyId,
      status: order.status,
      statusCs: labelOf(ORDER_STATUS_CS, order.status),
      totalCzk: czkFromMinor(order.totalMinor),
      totalVatCzk: czkFromMinor(order.totalVatMinor),
    })),
  };
};

export const registerMerchandiseTools = (server: McpServer): void => {
  defineTool(
    server,
    'list_products',
    'List products (produkty) with current price in CZK, VAT, stock on hand and low-stock flag. Optional lowStockOnly filter.',
    listProductsInput,
    listProducts,
  );
  defineTool(
    server,
    'list_orders',
    'List orders (objednávky) with customer partyId, status, totals in CZK and lines. Optional status filter.',
    listOrdersInput,
    listOrders,
  );
};
