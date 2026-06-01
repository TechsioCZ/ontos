# Module Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Active
  Active --> ReadOnly
  Active --> Suspended
  Active --> Quarantined
  ReadOnly --> Active
  Suspended --> Active
  Quarantined --> Active
  Active --> Deprecated
  Deprecated --> Archived
  Suspended --> Archived
  Quarantined --> Archived
```
