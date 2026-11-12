# Comgate fixtures (#1154, #1156, #1157, #1158)

Shapes copied from the Comgate API documentation, read 2026-11-12. Values that identify a real
shop were never present; the `secret` is a fixture string, not a credential. Where a test needs an
OntOS order reference, it overrides `refId` in the test (Comgate's own example uses `2010102600`).

| File                                       | Source                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create-success.json`, `create-error.json` | https://apidoc.comgate.cz/en/api/rest/ ("create", response 201 example; error codes 1100-1500, 1309 incorrect amount)                                              |
| `status-paid.json`, `status-error.json`    | https://apidoc.comgate.cz/en/api/rest/ ("status", example `"test": "false"`, `"price": "10000"`, `"status": "PAID"`) and https://apidoc.comgate.cz/en/stavy-plateb |
| `result-ok.json`, `result-1400.json`       | https://apidoc.comgate.cz/en/api/rest/ ("cancel" / "refund" `{code, message}`; cancel 1400 "the payment cannot be changed to CANCELLED status")                    |
| `push.json`, `push.txt`                    | https://apidoc.comgate.cz/en/push-notifikace (REST v2 JSON example and v1 urlencoded example, verbatim)                                                            |

UNVERIFIED: the documented status `test` is a string (`"false"`) while create/refund requests type it as a
boolean; the decoder accepts both forms (see `comgate-wire.ts`).
