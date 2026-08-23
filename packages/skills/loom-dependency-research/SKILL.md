---
name: loom-dependency-research
description:
  Resolve package or framework behavior against the exact project version using
  authoritative evidence. Use before relying on unfamiliar, changing, or
  ambiguous dependency APIs.
---

# Loom Dependency Research

1. Identify the package, ecosystem, task, and exact installed version from
   manifests and lockfiles.
2. Check project-native or framework-native tooling for version-aware behavior.
3. Consult exact-version official documentation, then maintainer documentation
   or skills.
4. Use a reputable documentation index when primary material is incomplete.
5. Use repository-level documentation or code navigation when behavior depends
   on implementation relationships.
6. Inspect the installed or upstream source only when documentation remains
   ambiguous.
7. Use broad web research last. Treat third-party examples as supporting, not
   authoritative, evidence.
8. Reconcile conflicting sources by version, release date, and provenance. Do
   not guess from memory.

## Output

State the installed version, question, answer, evidence hierarchy, relevant API
or behavior, version caveats, conflicts, and implementation recommendation.
Distinguish verified facts from inference.
