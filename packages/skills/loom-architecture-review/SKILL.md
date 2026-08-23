---
name: loom-architecture-review
description:
  Review a proposed or existing architecture for requirement fit, boundaries,
  failure modes, security, operations, and reversibility. Use before major
  implementation or hard-to-reverse changes.
---

# Loom Architecture Review

1. Establish requirements, constraints, quality attributes, scale assumptions,
   and explicit non-goals.
2. Map components, ownership boundaries, dependencies, data flow, trust
   boundaries, external systems, and deployment topology.
3. Trace critical user and operational paths, including failure, retry,
   recovery, migration, and rollback behavior.
4. Evaluate coupling, cohesion, consistency, concurrency, data integrity,
   security, privacy, observability, performance, availability, cost, and
   maintainability.
5. Challenge unnecessary infrastructure and duplicated capabilities. Prefer the
   smallest design that covers the requirements.
6. Compare two to four alternatives for consequential issues, including
   trade-offs, risks, operating cost, and reversibility.
7. Rank findings by impact and confidence. Tie each finding to evidence and a
   practical remediation.
8. Record accepted hard-to-reverse decisions and identify assumptions that
   require validation.

## Output

Provide a verdict, architecture summary, strengths, prioritized findings,
alternatives, recommended decisions, validation tasks, and residual risks. Do
not redesign areas unrelated to the stated requirements.
