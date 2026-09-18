---
status: accepted
---

# Inventory demand is defined before Stock Position allocation

For Launch, each exact Catalog Selection meaning has exactly one Stock Item. The purchase Quantity and Unit are preserved exactly as supplied by the purchase/Catalog contract and form one Stock Requirement for that selection before any Stock Location or Stock Position is chosen.

Inventory does not convert Units, derive purchase Quantity from Product Configuration attributes, decompose a Package into contained pieces, decompose a Set into components, or choose an alternative Stock Item because another Location has different stock. A material change of the exact Catalog Selection meaning, including material Package Content, Set Composition, or Product Configuration meaning, requires a new Stock Item under the one-to-one Catalog-to-Stock binding.

Later Stock Allocation may satisfy one Stock Requirement from one or more owner-valid Stock Positions/Locations for the same Stock Item and Unit. The allocation quantities must cover the unchanged requested Quantity; allocation cannot change the Catalog Selection, Stock Item, Quantity, or Unit.

## Considered Options

- Bind one exact Catalog Selection to one Stock Item and preserve its requested Quantity + Unit before Location/Position allocation — accepted.
- Add a separate alternative stock-representation/decomposition layer that may represent Package/Set selections through components — rejected because the exact Package/Set is itself the selected stock subject and decomposition changes the selected meaning.
- Convert Product Configuration attributes or Units into a different Inventory Quantity — rejected because attributes of one unit and purchase Quantity are distinct business facts, and Inventory must preserve the explicit Unit.
- Select Location first or choose an alternative stock representation according to current availability — rejected because allocation must not redefine the purchase demand.
