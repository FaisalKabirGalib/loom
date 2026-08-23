# Adding a Profile

Profiles convert detected project evidence into resolver requirements. They do
not install tools.

1. Confirm the detector emits the language/framework signal needed by the
   profile in
   [`packages/core/src/detection.ts`](../packages/core/src/detection.ts).
2. Add a `FrameworkProfile` to
   [`frameworkProfiles`](../packages/profiles/src/index.ts) with a stable ID,
   label, predicate, and capability names from
   [`CAPABILITIES`](../packages/core/src/capabilities.ts).
3. Keep `requiredCapabilities` to features the project cannot reasonably plan
   without. Put enhancements in `usefulCapabilities`; useful capabilities do not
   force resolver selection.
4. Add deterministic composition coverage to
   [`packages/profiles/src/index.test.ts`](../packages/profiles/src/index.test.ts),
   including overlap deduplication when applicable.
5. Run `pnpm verify`.

`composeProfiles` preserves declaration order for matched profile IDs, sorts and
deduplicates capabilities, and removes required capabilities from the useful
list. A required capability with no eligible catalog/registry candidate appears
in `plan.uncovered`.
