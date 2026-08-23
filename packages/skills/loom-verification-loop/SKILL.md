---
name: loom-verification-loop
description:
  Verify an implementation with the project's own checks and runtime evidence
  before claiming completion. Use after changes, during debugging, and before
  handoff.
---

# Loom Verification Loop

1. Inspect project guidance, manifests, and automation to discover existing
   verification commands. Do not invent replacements for project-native scripts.
2. Select the smallest fast check that can expose the current defect, then
   expand coverage as confidence grows.
3. Run applicable formatting checks, lint, type checks, focused tests,
   integration tests, build, and runtime smoke tests in the project's intended
   order.
4. For UI or device behavior, validate the actual runtime and relevant
   viewports, states, interactions, accessibility, and platform behavior.
5. On failure, capture the exact command and diagnostic, identify the root
   cause, make the narrowest correction, and rerun the failed check.
6. After focused checks pass, run the broadest practical project verification to
   catch regressions.
7. Review the final diff for unintended files, generated artifacts, secrets,
   debug code, and scope drift.
8. Report only checks actually run. Mark skipped or blocked checks with the
   reason and remaining risk.

## Output

Provide changed behavior, commands run, pass or fail results, runtime evidence,
corrections made, skipped checks, and residual risks. Never claim success from
code inspection alone.
