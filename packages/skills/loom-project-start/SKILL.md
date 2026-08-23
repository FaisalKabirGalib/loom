---
name: loom-project-start
description:
  Turn a new product idea into an evidence-based specification, architecture
  choice, capability plan, scaffold, vertical slice, and verified
  implementation. Use for greenfield projects before choosing a stack.
---

# Loom Project Start

1. Discover the product deeply: users, jobs, workflows, success criteria,
   non-goals, domain language, data, security, compliance, delivery constraints,
   and unresolved questions.
2. Write or update concise context and product requirements. Separate facts,
   decisions, and assumptions.
3. Evaluate SEO, offline behavior, native APIs, background work, notifications,
   target platforms, realtime needs, deployment, traffic, latency, team
   familiarity, cost, operations, and maintenance.
4. Propose two to four viable architectures. Compare benefits, drawbacks, risks,
   reversibility, operating cost, and delivery speed without favoring a stack
   prematurely.
5. Recommend a stack only after requirements justify it. Record important
   hard-to-reverse choices as decision records.
6. Determine the smallest capability set needed for implementation. Explain
   overlap, permissions, provenance, and why rejected capabilities are
   unnecessary.
7. Review the plan for security, failure modes, redundancy, and operational
   burden. Obtain approval before mutating configuration or installing
   capabilities.
8. If the product has a UI, run `loom-design-director` before scaffolding.
9. Scaffold the minimum structure, implement one end-to-end vertical slice, and
   run `loom-verification-loop`.

## Output

Produce requirements, alternatives, recommendation, decisions, capability plan,
risks, implementation sequence, and verification evidence. Ask targeted
questions only where missing answers materially change the result.
