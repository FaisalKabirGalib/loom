---
name: loom-project-hydrate
description:
  Build a bounded, evidence-backed understanding of an existing repository
  before changing it. Use for brownfield tasks, onboarding, debugging, or
  planning modifications.
---

# Loom Project Hydrate

1. Read repository guidance and inspect status without modifying files.
2. Detect languages, frameworks, package managers, topology, deployment
   artifacts, and exact dependency versions from manifests and lockfiles. Cite
   evidence; never silently infer a framework.
3. Estimate repository size and identify the task boundary.
4. Choose the smallest useful understanding method: filenames and search first,
   then symbols or bounded graph queries when scale or relationships justify
   them.
5. Trace only the relevant entry points, callers, callees, tests, configuration,
   and data flow. Prefer targeted reads over recursive context loading.
6. Resolve task-specific capabilities and framework-native tools only when the
   repository lacks sufficient support. Avoid overlapping or always-loaded
   tools.
7. Research exact-version documentation before source inspection; inspect
   dependency source only when documented behavior remains unclear.
8. Summarize established conventions, affected surfaces, risks, assumptions, and
   the narrow change plan before editing.
9. Make the smallest coherent change and run `loom-verification-loop`.

## Output

Report detected facts with evidence, the bounded architecture map, dependency
versions, relevant conventions, selected capabilities, change plan, risks, and
verification results.
