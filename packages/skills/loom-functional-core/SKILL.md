---
name: loom-functional-core
description:
  Structure logic as a pure functional core with a thin imperative shell where
  practical. Use for state transitions, policy, resolution, scoring, parsing,
  planning, and other testable domain logic.
---

# Loom Functional Core

1. Identify domain inputs, outputs, invariants, decisions, and side effects.
2. Model domain data explicitly and make invalid or unknown states visible where
   practical.
3. Put deterministic parsing, normalization, validation, scoring, selection, and
   state transitions in pure functions.
4. Keep filesystem, network, process, clock, randomness, logging, and harness
   calls in a thin imperative shell.
5. Pass effect results into the core as data and return plans or commands for
   the shell to execute.
6. Avoid hidden global state and mutation across boundaries. Do not add a
   functional-programming library unless the project already benefits from one.
7. Test the core with table-driven examples, boundary cases, and invariants.
   Test the shell with focused integration seams.
8. Preserve existing conventions when a different decomposition is clearer;
   apply this style where practical, not dogmatically.

## Output

Describe the core/shell boundary, data model, pure decisions, effects, error
model, and focused tests. Keep the implementation minimal and idiomatic for the
project language.
