---
name: loom-design-director
description:
  Direct a product-specific UI design from requirements through DESIGN.md,
  implementation guidance, and visual validation. Use when a project has
  user-facing interfaces or visual changes.
---

# Loom Design Director

1. Read the product requirements and identify users, primary tasks, content
   hierarchy, desired perception, brand constraints, platforms, and
   accessibility needs.
2. Audit existing UI, tokens, components, assets, and design references.
   Preserve intentional conventions unless requirements justify change.
3. Gather a small set of relevant references and explain what to borrow or
   avoid. Use actual design files only when they are part of the project
   context.
4. Define a distinct visual direction rather than a generic trend-driven system.
5. Create or update `DESIGN.md` with principles, layout, typography, color,
   spacing, components, states, interaction, responsive behavior, accessibility,
   and platform constraints.
6. Translate the direction into a bounded implementation plan that reuses
   framework-native patterns and existing components.
7. Implement representative screens or states, including loading, empty, error,
   focus, disabled, and reduced-motion behavior where relevant.
8. Validate in the real runtime across relevant viewports. Compare against the
   direction, test keyboard and screen-reader fundamentals, and check
   performance when material.
9. Iterate on observed discrepancies and record verification evidence.

## Output

Produce the visual goals, reference rationale, `DESIGN.md` decisions,
implementation plan, state matrix, and runtime validation findings.
