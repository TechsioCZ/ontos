# ADR-0012: Machine prediction is integrated, not built in OntOS V0/V1

Status: Proposed

## Context

Manufacturing and machine prediction are future business opportunities, but the team does not want to build predictive maintenance technology internally. Pulsar Solutions is a likely specialist partner.

## Decision

OntOS should own manufacturing operations, ERP context, service tickets, ISO evidence, documents, audit, and workflows. Pulsar or similar systems should own machine data analytics and predictive maintenance outputs. OntOS integrates their outputs as external events or recommendations.

## Consequences

The manufacturing roadmap becomes lower risk. OntOS remains the operational ontology and workflow layer rather than a machine-learning platform.

## Risks

Integration boundaries must be defined early enough in manufacturing discovery. OntOS must not assume machine event quality or availability without PoC evidence.
