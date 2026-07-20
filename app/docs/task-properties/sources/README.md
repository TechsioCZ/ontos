# Task Property authoritative source archive

This directory preserves durable, byte-for-byte snapshots of the original Task Property sources used by the consistency audit.

- `product-owner/` contains the 18 product-owner specifications formerly available only under `/private/tmp/product/`.
- `handoffs/` contains the 19 technical and general handoffs formerly available only under `/tmp/`.
- `SHA256SUMS` records the archived snapshot hashes.

The absolute temporary paths that appear inside a snapshot are historical provenance text from the original file. Active Task Property specifications cite the corresponding durable file in this directory. The archive copies are not edited to rewrite their original wording.

Mapping:

- `/private/tmp/product/<file>` → `docs/task-properties/sources/product-owner/<file>`
- `/tmp/<file>` → `docs/task-properties/sources/handoffs/<file>`

