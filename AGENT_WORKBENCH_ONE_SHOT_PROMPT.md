# ONE-SHOT AUTONOMOUS IMPLEMENTATION PROMPT
## Build a standalone, multi-harness agent capability resolver/workbench

You are the lead engineer for this repository. Work autonomously in the current repository and implement the product described below.

This prompt is intentionally self-contained. Do **not** require any previous conversation, dotfiles repository, architecture document, or separate specification. If the repository is empty, initialize it. If it already contains starter files, inspect and preserve anything useful.

Do not stop at an architecture proposal. Build a working vertical slice, run tests, dogfood it in the coding-agent harness you are currently running under, and keep progressing through the phases below as far as the environment allows.

Do not ask me routine implementation questions. Make reasonable engineering decisions, record important ones in ADRs, and continue. Only stop for something that truly cannot be resolved from the repository, current environment, upstream documentation, or a safe default.

---

# 0. Product definition

Build a standalone open-source developer tool, working name:

```text
agent-workbench
```

If this repository already has a chosen name, use that instead. Keep naming centralized so it can be renamed later.

The product is a **project-aware agent capability resolver** for coding-agent harnesses.

It must:

1. inspect the current project deterministically;
2. understand whether the project is greenfield or brownfield;
3. detect languages, frameworks, packages, services, UI/mobile/backend characteristics, monorepo structure, and existing agent configuration;
4. understand the current development task when task context is available;
5. discover useful Agent Skills, MCP servers, CLIs, plugins, framework tools, and developer tools;
6. rank official **and** community capabilities;
7. account for security, maintenance, permissions, context/token cost, redundancy, and exact project fit;
8. select the **smallest useful capability set**, rather than enabling every high-scoring tool;
9. configure those capabilities project-locally for the coding-agent harness currently being used;
10. provide the same semantic workflow across Codex, OpenCode, Claude Code, OMP/Oh My Pi, and Google Antigravity while still using each harness's native extension mechanisms;
11. maintain a reproducible capability lock;
12. support safe uninstall/rollback without damaging unrelated user configuration;
13. remain usable by other developers without any dependency on my personal dotfiles.

This is **not** a dotfiles project.

My dotfiles are irrelevant to the architecture. The finished product must be installable and usable independently.

---

# 1. Product philosophy

The product is **not**:

```text
"install a giant list of my favorite MCPs"
```

It is:

```text
project
  +
task
  +
environment
  +
active coding harness
  +
current ecosystem state
        |
        v
discover possible capabilities
        |
        v
verify provenance + versions + permissions
        |
        v
score candidates
        |
        v
remove redundant candidates
        |
        v
choose minimum safe capability set
        |
        v
show explainable plan
        |
        v
apply project-local integration
        |
        v
lock exact selected versions/provenance
```

The long-term product is effectively an **agent development environment resolver**.

Think:

```text
asdf/nix/devbox for agent capabilities
+
package resolver for Skills/MCPs
+
project intelligence
+
native harness adapters
+
security policy
```

Do not turn it into a generic AI chat framework.

---

# 2. My common stacks and preferences

Initial framework profiles must strongly support:

```text
TypeScript
Next.js / React
Flutter / Dart
React Native / Expo
Go
Laravel / PHP
```

Common surrounding technologies include:

```text
pnpm
bun
npm
PostgreSQL
SQLite
Docker
REST APIs
GraphQL
Supabase
Neon
Vercel
Cloudflare
GitHub
```

Detect them; never assume they exist.

My coding preference is functional:

```text
pure domain logic
immutable data
explicit inputs and outputs
effects at boundaries
composition over inheritance
discriminated unions / sum types where appropriate
deterministic transformations
small focused functions
dependency injection through arguments/modules
```

Important:

- Do **not** automatically install Effect, fp-ts, or another FP framework.
- If an existing project already uses one, detect it and discover appropriate current docs/skills.
- Existing project conventions win unless there is a clear reason to propose change.
- Build the workbench core in a functional-core / imperative-shell style where practical.

---

# 3. Browser preference: agent-browser first

For browser automation and browser-based testing, **prefer Vercel Labs `agent-browser` over Playwright MCP**.

Reference project:

```text
vercel-labs/agent-browser
```

Current relevant behavior to account for:

```text
agent-browser mcp
agent-browser mcp --tools core
agent-browser mcp --tools core,network,react
```

Its MCP tool profiles include capabilities such as:

```text
core
network
state
debug
tabs
react
mobile
all
```

Its skill system also exposes task-oriented workflows.

Default policy:

```text
UI.browser-test
  -> agent-browser

UI.browser-debug
  -> agent-browser core+network+debug

UI.react-runtime
  -> agent-browser react
     and/or agent-react-devtools when deeper React internals are needed

deep Chrome-specific performance/network/runtime investigation
  -> Chrome DevTools MCP may be added

Playwright MCP
  -> not a default preference
  -> only select when an existing project explicitly depends on Playwright,
     a task requires a Playwright-specific workflow, or it clearly beats agent-browser
```

Do not remove an existing project's Playwright setup.

---

# 4. Architecture

Use a monorepo with a harness-neutral shared core.

Target architecture:

```text
                         agent-workbench
                                |
              +-----------------+------------------+
              |                                    |
        shared core                          shared assets
              |                                    |
      project detection                        SKILL.md
      task classification                      profiles
      workflow engine                          references
      capability model                         policies
      capability scoring
      trust/security
      minimum-set resolver
      lock model
              |
              +------------------+
              |                  |
       registry/discovery     shared MCP
              |                  |
              +---------+--------+
                        |
       +----------------+-------------------------------+
       |                |              |                |
     Codex           OpenCode       Claude Code        OMP
 integration         plugin          plugin         extension
                        |
                  Antigravity
                   integration
```

Aim for roughly:

```text
80-90% shared code/assets
10-20% harness-specific code
```

Never put framework detection or capability-scoring logic inside a harness adapter.

---

# 5. Suggested repository structure

Use this as a starting point; improve it if needed without destroying the separation of concerns.

```text
agent-workbench/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md
├── LICENSE
│
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── project/
│   │       ├── detection/
│   │       ├── task/
│   │       ├── workflows/
│   │       ├── capabilities/
│   │       ├── scoring/
│   │       ├── resolver/
│   │       ├── trust/
│   │       ├── policy/
│   │       └── lock/
│   │
│   ├── profiles/
│   │   └── src/
│   │       ├── typescript.ts
│   │       ├── nextjs.ts
│   │       ├── flutter.ts
│   │       ├── react-native.ts
│   │       ├── expo.ts
│   │       ├── go.ts
│   │       ├── laravel.ts
│   │       ├── database.ts
│   │       ├── web-ui.ts
│   │       └── monorepo.ts
│   │
│   ├── registry/
│   │   └── src/
│   │       ├── builtin/
│   │       ├── mcp-official/
│   │       ├── skills-cli/
│   │       ├── glama/
│   │       ├── smithery/
│   │       └── github/
│   │
│   ├── skills/
│   │   ├── project-start/
│   │   │   └── SKILL.md
│   │   ├── project-hydrate/
│   │   │   └── SKILL.md
│   │   ├── dependency-research/
│   │   │   └── SKILL.md
│   │   ├── architecture-review/
│   │   │   └── SKILL.md
│   │   ├── design-director/
│   │   │   └── SKILL.md
│   │   ├── functional-core/
│   │   │   └── SKILL.md
│   │   └── verification-loop/
│   │       └── SKILL.md
│   │
│   ├── mcp/
│   │   └── src/
│   │       └── server.ts
│   │
│   └── cli/
│       └── src/
│           └── index.ts
│
├── integrations/
│   ├── codex/
│   ├── opencode/
│   ├── claude/
│   ├── omp/
│   └── antigravity/
│
├── docs/
│   ├── architecture.md
│   ├── capability-model.md
│   ├── mcp-resolution.md
│   ├── skill-resolution.md
│   ├── security.md
│   ├── harness-compatibility.md
│   ├── adding-a-profile.md
│   └── adding-a-registry.md
│
├── fixtures/
└── tests/
```

Use TypeScript with strict mode. Prefer pnpm workspaces. Use the current stable Node.js LTS unless the environment strongly suggests another supported baseline. Use a small stable test runner such as Vitest.

Do not use a heavy framework for the core.

---

# 6. Capability taxonomy

This taxonomy is a core product concept.

Keep tool/product names separate from capabilities.

```text
CODE_CONTEXT
  semantic-search
  symbol-navigation
  call-graph
  repo-history
  cross-repo-search
  structural-search
  relationship-graph
  impact-analysis
  token-efficient-reading
  repo-snapshot

DOCS
  package-docs
  repository-docs
  source-inspection
  framework-docs
  api-reference

UI
  design-system
  component-registry
  browser-test
  browser-debug
  react-runtime
  accessibility
  performance
  design-to-code

MOBILE
  framework-analysis
  framework-docs
  runtime-inspection
  component-tree
  emulator-control
  native-dialog-control
  e2e-device-test
  hot-reload
  logs
  performance
  build-release
  app-distribution

API
  api-contract
  api-client
  mocking
  graphql
  api-testing

SECURITY
  sast
  dependency-risk
  quality-analysis
  secret-safety
  sql-safety

DATA
  generic-sql
  schema-inspection
  migrations
  supabase
  neon

OPS
  deployment
  observability
  production-errors
  kubernetes
  terraform
  git-hosting
  ci
  release
```

Framework profiles are **not** capability categories.

For example:

```text
framework profile: Flutter

may require:
  MOBILE.framework-analysis
  MOBILE.runtime-inspection
  DOCS.framework-docs
```

Then candidate tools compete to cover those requirements.

---

# 7. Core domain types

Implement explicit domain models. Exact syntax can change, but preserve these concepts.

```ts
type Lifecycle = "greenfield" | "brownfield"

type CapabilityKind =
  | "mcp"
  | "skill"
  | "plugin"
  | "cli"
  | "framework-tool"

type Scope =
  | "global"
  | "project"
  | "on-demand"

type TrustTier =
  | "official"
  | "verified-maintainer"
  | "community-reviewed"
  | "community"
  | "experimental"
  | "blocked"

interface ProjectProfile {
  root: string
  lifecycle: Lifecycle

  languages: string[]
  frameworks: string[]
  packageManagers: string[]

  dependencies: Record<string, string>
  devDependencies: Record<string, string>

  web: boolean
  ui: boolean
  mobile: boolean
  api: boolean
  database: boolean
  monorepo: boolean

  services: string[]
  existingAgentConfigs: string[]
  detectionSignals: DetectionSignal[]
}

interface TaskProfile {
  summary?: string

  intents: string[]

  requiredCapabilities: string[]
  usefulCapabilities: string[]

  risk: "low" | "medium" | "high"
}

interface CapabilityCandidate {
  id: string
  name: string
  kind: CapabilityKind

  source: {
    registry: string
    repository?: string
    package?: string
    publisher?: string
  }

  version?: string
  updatedAt?: string

  ecosystems: string[]
  provides: string[]
  tags: string[]

  transport?: "stdio" | "http"

  runtime?: {
    kind:
      | "node"
      | "python"
      | "go"
      | "dart"
      | "docker"
      | "binary"
      | "remote"

    command?: string
  }

  permissions: {
    filesystem: "none" | "read" | "write"
    shell: boolean
    network: boolean
    secrets: string[]
    database: "none" | "read" | "write"
    device: boolean
  }

  provenance: {
    official: boolean
    namespaceVerified: boolean
    knownMaintainer: boolean
    repositoryVerified: boolean
    packageRepositoryMatch?: boolean
  }

  metrics?: {
    stars?: number
    installs?: number
    registryScore?: number
    toolCount?: number
  }

  overlapGroups: string[]

  recommendedScope: Scope
}

interface ScoredCapability {
  candidate: CapabilityCandidate
  score: number
  reasons: string[]
  penalties: string[]
  coverage: string[]
}

interface CapabilityPlan {
  project: ProjectProfile
  task?: TaskProfile

  selected: ScoredCapability[]
  optional: ScoredCapability[]
  rejected: Array<{
    capability: ScoredCapability
    reason: string
  }>

  requiredApprovals: ApprovalRequest[]
}
```

Use schema validation at I/O boundaries.

---

# 8. Deterministic project detection

Project detection must not require an LLM.

Inspect signals including:

```text
.git/
package.json
pnpm-lock.yaml
bun.lock
bun.lockb
package-lock.json
yarn.lock

pnpm-workspace.yaml
turbo.json
nx.json

tsconfig.json
next.config.*
vite.config.*
astro.config.*
components.json
.storybook/
*.stories.*

pubspec.yaml
analysis_options.yaml
android/
ios/
macos/
windows/
linux/

go.mod
go.work

composer.json
artisan
routes/
app/

Dockerfile
docker-compose.*
compose.*

.env.example
prisma/schema.prisma
drizzle.config.*
supabase/
vercel.json
.vercel/
wrangler.*
terraform files
helm/
k8s/
.github/workflows/
```

Inspect exact dependency versions from manifests and lockfiles where practical.

Return explanations for every important detection.

Example:

```text
Flutter detected
  pubspec.yaml contains sdk: flutter

Mobile project detected
  Flutter + android/ + ios/

Patrol detected
  patrol package present in pubspec

Widgetbook detected
  widgetbook dependency present

Supabase detected
  @supabase client/package or supabase/ configuration present
```

Never silently guess a framework.

---

# 9. Greenfield workflow

Shared `project-start` skill/workflow:

```text
idea
  |
  v
deep product discovery
  |
  v
domain/context documentation
  |
  v
PRD/spec
  |
  v
constraints
  |
  v
2-4 architecture alternatives
  |
  v
pros / cons / risks / operating cost
  |
  v
stack choice
  |
  v
ADR for important hard-to-reverse choices
  |
  v
resolve relevant capabilities
  |
  v
security/redundancy review
  |
  v
project capability plan
  |
  v
apply approved capabilities
  |
  v
DESIGN.md workflow when UI exists
  |
  v
scaffold
  |
  v
vertical implementation
  |
  v
verify
```

Do **not** choose Next.js, Flutter, Laravel, Go, React Native, etc. before understanding requirements.

Consider:

```text
SEO
offline use
native APIs
background execution
push notifications
mobile/web/desktop
realtime requirements
deployment target
expected traffic
latency
security/compliance
data model
team familiarity
time to market
hosting cost
operational complexity
long-term maintenance
```

## Matt Pocock skills

Support current upstream Matt Pocock skills where relevant.

Important workflow concepts:

```text
grill-me
grill-with-docs
to-spec
architecture review
TDD
```

For serious greenfield discovery prefer:

```text
grill-with-docs
  -> to-spec
```

Do not run `grill-me` and `grill-with-docs` as duplicate full interviews.

Do not vendor upstream skills by default. Discover/install them from their current upstream source and lock provenance/version/revision.

---

# 10. Brownfield workflow

Shared `project-hydrate` skill/workflow:

```text
existing repository
  |
  v
deterministic detection
  |
  v
repo size/topology
  |
  v
choose smallest useful code-intelligence capability
  |
  v
bounded graph/symbol/search queries
  |
  v
targeted source reads
  |
  v
exact dependency versions
  |
  v
task-specific capability discovery
  |
  v
framework-native tools
  |
  v
docs
  |
  v
source inspection only if needed
  |
  v
change
  |
  v
verification
```

Core rule:

```text
understand before recursively reading
```

Never dump a large repository into model context by default.

---

# 11. Capability scoring

Do not use "official always wins".

Official status is a strong provenance signal, not a universal selection rule.

Start with an explainable 100-point score such as:

```text
task fit                        0-25
project/ecosystem fit           0-20
capability coverage             0-15
maintenance/activity            0-10
publisher/provenance            0-10
security/permission profile     0-10
context/token efficiency        0-5
harness portability             0-5
                              ------
                               100
```

Apply explicit penalties for:

```text
stale/deprecated
package/repository mismatch
unknown binary provenance
unnecessary filesystem write
unnecessary shell execution
unnecessary network access
requires secrets unrelated to task
database write access
huge always-loaded MCP tool surface
telemetry with unclear behavior
duplicate capability coverage
experimental runtime patching
unverified community installer
```

Do not use stars alone.

Stars/install count are weak supporting signals.

Return reasons:

```text
Serena: 87

+ exact semantic-navigation fit
+ TypeScript supported
+ actively maintained
+ project-local
+ good multi-harness portability

- filesystem write capability
- overlaps Codanna for current task
```

---

# 12. Minimum-set resolver

This is critical.

After scoring candidates, run a second selection phase.

Goal:

```text
cover required capabilities
while minimizing:
  number of tools
  total context/tool-schema cost
  privilege level
  overlap
  runtime complexity
```

Conceptually solve a weighted set-cover problem.

Example:

```text
required:
  semantic-search
  symbol-navigation
  call-graph

Codanna covers all 3
Serena covers first 2
CodeGraphy covers search + graph

Do NOT select all 3 just because scores are high.

Select the smallest high-confidence set.
```

The plan must explain rejected overlap:

```text
Rejected Serena
  because Codanna already covers semantic search + symbols for this task
  and adding Serena increases write permissions and MCP surface
```

---

# 13. Capability scope

Default scopes:

```text
GLOBAL
  workbench's own small shared skill set
  workbench MCP
  almost no third-party project tools

PROJECT
  stack-specific MCPs
  framework tools
  database tools
  code intelligence

ON-DEMAND
  browser debugging
  source inspection
  design generation
  expensive research
  large tool surfaces
```

Never globally activate every MCP.

A capability can be known to the resolver without being installed.

Installed does not necessarily mean always active.

---

# 14. MCP discovery

Implement a registry abstraction:

```ts
interface CapabilityRegistry {
  id: string

  search(
    query: CapabilityQuery,
  ): Promise<CapabilityCandidate[]>

  resolve(
    id: string,
    version?: string,
  ): Promise<CapabilityCandidate | null>
}
```

Initial registry adapters:

```text
BuiltinRegistry
OfficialMcpRegistry
SkillsCliRegistry
GitHubFallbackRegistry
```

Then add, when current stable APIs can be verified:

```text
GlamaRegistry
SmitheryRegistry
```

Do not scrape brittle HTML when a stable API is unavailable.

## Official MCP Registry

Use the official registry REST API.

Current production base:

```text
https://registry.modelcontextprotocol.io
```

Current search/list endpoint family:

```text
GET /v0.1/servers
```

Support:

```text
search
version=latest
updated_since
cursor pagination
```

Treat the official registry as a metadata/provenance source.

Its metadata is intentionally not a complete quality ranking.

Cache registry data locally with TTL and incremental sync.

Isolate the API behind the registry adapter because the registry is still evolving.

---

# 15. Agent Skill discovery

Use the open Agent Skills ecosystem.

Primary tool:

```text
vercel-labs/skills
```

Supported CLI concepts include:

```text
npx skills find <query>
npx skills add <owner/repo@skill>
npx skills list
npx skills check
npx skills update
npx skills remove
```

For non-interactive agent use, prefer explicit query commands.

Do not assume an undocumented `skills.sh` web API is stable.

Use the Skills CLI as the supported discovery/install interface unless current upstream documentation exposes a stable API.

Score skills for:

```text
task relevance
source reputation
maintainer status
activity
install count
content quality
allowed-tools breadth
scripts
overlap
```

Do not execute scripts from an unknown skill without approval.

Maintain one canonical set of **our own** workbench skills in `packages/skills`.

Use upstream skills as external locked dependencies rather than copying them when possible.

---

# 16. Security/trust policy

Separate:

```text
discovered
recommended
approved
installed
active
```

Suggested trust behavior:

## Can appear in plan automatically

Any non-blocked candidate.

## Can auto-install after user approves the overall plan

Only when all are true:

```text
known/verified source
install mechanism is understood
package/repository provenance matches
permissions are bounded
no surprising secret access
no arbitrary curl|bash
```

## Requires explicit per-capability approval

```text
unknown community MCP
filesystem write from unfamiliar server
shell execution from unfamiliar server
database write
device control
production/cloud write access
secret/API-key requirement
remote third-party data access
experimental runtime instrumentation
```

## Block

```text
known malicious
deprecated with known replacement
package/repository mismatch
unresolved provenance
unsafe installer
suspicious binary
```

Auto mode of the coding agent does **not** mean the finished product should silently install untrusted third-party code.

---

# 17. Capability lock

Project-local state:

```text
.agent-workbench/
├── project.json
├── workflow.json
├── capabilities.lock.json
└── policy.toml
```

Do not store secrets.

Lock entries should record:

```text
capability id
kind
source registry
repository
package
exact resolved version/revision
transport/runtime
trust tier
permissions
scope
reason selected
overlap group
install ownership
```

Do not pin `latest` in the lock.

Upgrade only through explicit review:

```text
agent-workbench upgrades
agent-workbench upgrade --review
```

Never silently upgrade community executables between sessions.

---

# 18. User and project policy layers

Support user preferences:

```text
$XDG_CONFIG_HOME/agent-workbench/preferences.toml
```

Example:

```toml
[code]
style = "functional-core"

[package_manager]
typescript = "pnpm"

[capabilities]
prefer_local = true
prefer_open_source = true
min_trust_score = 70

[browser]
preferred = "agent-browser"
```

Support project policy:

```text
.agent-workbench/policy.toml
```

Example:

```toml
[mcp]
allow_remote = false
allow_shell = false

[database]
max_access = "read"

[skills]
require_review_for_scripts = true
```

My preferences must not become mandatory defaults for all users.

---

# 19. Seed capability catalog

The built-in catalog is a curated **seed**, not a permanent exhaustive list.

Each seed entry needs:

```text
capability coverage
ecosystem triggers
task triggers
trust tier
install/runtime resolver
permissions
scope recommendation
overlap groups
notes
```

Dynamic discovery should be able to find newer alternatives.

Implement enough metadata for the tools below to exercise the resolver.

---

## 19A. CODE_CONTEXT seeds

### Codanna
Reference:

```text
bartolli/codanna
```

Use cases:

```text
semantic search
symbol navigation
call graph
dependency relationships
impact analysis
local code intelligence
```

Strong candidate for medium/large brownfield repos.

Overlap:

```text
Serena
CodeGraphy
```

### CodeGraphy

Use cases:

```text
relationship graph
architecture understanding
workspace map
impact/connection queries
```

Prefer when relationships/graph topology matter more than symbol editing.

### Serena
Reference:

```text
oraios/serena
```

Use cases:

```text
semantic symbols
find references
LSP-powered navigation
targeted edits
brownfield understanding
```

Treat write capability seriously.

### rag-rat
Use cases:

```text
repository history
git/PR/issue context
why-code-exists
decisions/invariants
```

Prefer mature repos with meaningful history.

### TeaRAGs
Use cases:

```text
semantic code retrieval
git churn
ownership
stable implementation discovery
risk-aware reuse
```

### srag
Use cases:

```text
cross-repository semantic search
reuse patterns from previous repos
personal project memory
cross-agent session search when supported
```

### ast-grep
Reference:

```text
ast-grep/ast-grep
ast-grep/ast-grep-mcp
```

Use cases:

```text
structural search
AST codemods
API migrations
large repetitive refactors
structural security search
```

Prefer CLI + skill over MCP when that is more context-efficient.

### pluck
Use cases:

```text
token-efficient code reading
search/peek/symbol/impact
large files
```

### Repomix
Reference:

```text
yamadashy/repomix
```

Use cases:

```text
compact repository snapshot
architecture review
one-shot context pack
remote repo context
```

Do not use it as the default live-edit navigation system.

---

## 19B. DOCS seeds

### Context7

Use cases:

```text
current package/library documentation
framework docs when project-native docs are unavailable
```

Resolution hierarchy:

```text
exact installed version
  >
project-native official tool
  >
version-appropriate official docs
  >
maintainer skill/docs
  >
Context7
  >
GitMCP/DeepWiki when repository understanding is useful
  >
opensrc/source inspection
  >
generic web search
```

### GitMCP
Reference:

```text
idosal/git-mcp
```

Use cases:

```text
turn a GitHub repository into docs/code MCP context
unfamiliar GitHub dependency
repository documentation/code search
```

### DeepWiki
Use cases:

```text
generated repository architecture documentation
questions about public GitHub repositories
```

### opensrc
Reference:

```text
vercel-labs/opensrc
```

Use cases:

```text
inspect exact source of npm/open-source dependency
resolve behavior not explained by docs
```

Prefer CLI/skill invocation; do not keep it loaded as MCP unless a current version makes that clearly superior.

---

## 19C. UI seeds

### agent-browser — DEFAULT BROWSER TOOL
Reference:

```text
vercel-labs/agent-browser
```

Provides:

```text
UI.browser-test
UI.browser-debug
UI.react-runtime
UI.accessibility (through appropriate profiles/workflows)
UI.performance (partially)
```

Default over Playwright MCP.

Use minimal MCP profile:

```text
core
```

and activate extra profiles only when task needs them.

### Chrome DevTools MCP
Use when:

```text
deep network debugging
Chrome runtime debugging
performance traces
console/runtime inspection
```

Usually on-demand.

### Storybook MCP

Trigger:

```text
.storybook/
@storybook/*
*.stories.*
```

Use cases:

```text
component registry
existing component API truth
story generation
component interaction verification
a11y verification
```

### shadcn MCP

Trigger:

```text
components.json
shadcn structure
```

Use cases:

```text
component registry
find/install shadcn components
private component registries
```

### Widgetbook

Trigger:

```text
widgetbook dependency
Widgetbook use cases/components
```

Use as Flutter's component-catalog/design-system truth.

It may be a CLI/framework workflow rather than MCP; model capability, not protocol.

### agent-react-devtools
Reference:

```text
callstackincubator/agent-react-devtools
```

Use cases:

```text
React component tree
props/state
render behavior
re-render profiling
React Native/Expo runtime React inspection
```

### Figma MCP

Select only when:

```text
Figma URL/context exists
Code Connect exists
user asks design-to-code
```

Do not enable just because project has UI.

### UI UX Pro Max
Reference:

```text
nextlevelbuilder/ui-ux-pro-max-skill
```

Use cases:

```text
design-system thinking
UI/UX guidance
design synthesis
```

### Awesome DESIGN.md
Reference:

```text
VoltAgent/awesome-design-md
```

Use cases:

```text
design references
agent-readable design-system examples
```

Never copy another product's design verbatim.

### 21st MCP
Use cases:

```text
component inspiration
component search
UI generation
theme/template assistance
```

Remote/API-key implications should reduce default priority.

### axe accessibility

Use cases:

```text
automated accessibility checks
remediation loop
```

### Lighthouse

Use cases:

```text
standardized performance/a11y/SEO audits
```

Keep distinct from Chrome DevTools runtime debugging.

---

## 19D. MOBILE seeds

### Flutter Agent Plugins
Reference:

```text
flutter/agent-plugins
```

High priority for Flutter.

Includes official Flutter skills and Dart/Flutter MCP wiring in current versions.

### Dart / Flutter MCP

Default Flutter framework tool.

Current typical server command family:

```text
dart mcp-server
```

Use cases:

```text
Dart analysis
symbols/docs
fixes
tests
formatting
package management
Flutter runtime interaction
hot reload/runtime state when supported
```

### Patrol MCP
Reference family:

```text
leancodepl/patrol
```

Use cases:

```text
Flutter integration/E2E
native permission dialogs
Flutter/native boundary
repeatable device tests
screenshots/logs
```

Prefer for authored Flutter-specific permanent tests.

### Marionette MCP
Reference:

```text
leancodepl/marionette_mcp
```

Use cases:

```text
interactive Flutter exploration
inspect widgets
tap/type/scroll/screenshot
```

Prefer for exploratory agent interaction rather than permanent authored E2E.

### Dusk
Reference:

```text
fluttersdk/dusk
```

Community/experimental candidate.

Use cases:

```text
compact Flutter runtime observation
interactive widget-tree actions
```

Require stronger trust review.

### Maestro MCP
Use cases:

```text
cross-platform black-box mobile E2E
Flutter
React Native
native apps
screen inspection
device flows
```

Default cross-platform mobile E2E candidate.

### Mobile MCP
Reference:

```text
mobile-next/mobile-mcp
```

Use cases:

```text
Android/iOS emulator/simulator/device interaction
tap/type/navigation
screenshots
```

Good complement to Dart MCP.

### Appium MCP
Reference:

```text
appium/appium-mcp
```

Use cases:

```text
existing Appium organizations
enterprise device labs
complex native/hybrid automation
```

Usually lower priority than Maestro for a new solo project.

### device-mcp
Reference:

```text
MetaMask/device-mcp
```

Use cases:

```text
device testing
Appium/BrowserStack-oriented workflows
Android/iOS automation
```

### Expo skills + Expo MCP
Reference:

```text
expo/skills
```

When Expo detected, strongly prefer.

Use cases:

```text
Expo Router
Expo framework guidance
compatible dependency install
Expo docs
EAS build/workflow
simulator screenshots
TestFlight/build info when supported
```

### Callstack React Native agent skills
Reference:

```text
callstackincubator/agent-skills
```

Use cases:

```text
React Native performance
FPS/jank
re-renders
memory
lists
animations
startup
Hermes
native threading
Turbo Modules
bundle size
brownfield RN
```

High-priority RN skill candidate.

### Vercel React Native skills
Use cases:

```text
broader React Native implementation practices
navigation
state
UI
animations
monorepos
React Compiler
```

### React Native MCP community candidates

Discover and score current React Native-specific MCPs dynamically.

Do not prefer a single community implementation forever if:

```text
Expo MCP
+
Maestro
+
agent-react-devtools
```

already cover the task with better specialization.

---

## 19E. API seeds

### Postman MCP

Trigger:

```text
Postman collections
OpenAPI
API-heavy task
```

Use cases:

```text
API contract
API client
API testing
collections/environments
```

Prefer minimal/code toolsets when available rather than full surfaces.

### Mockoon MCP

Use cases:

```text
lightweight local API mocks
frontend before backend
unreliable third-party API simulation
```

### WireMock

Use cases:

```text
advanced API simulation
OpenAPI validation
recording
faults/delays
complex backend test environments
```

### Apollo MCP

Trigger:

```text
GraphQL/Apollo
*.graphql
GraphQL schema
```

Use cases:

```text
GraphQL operations
schema-driven testing
contract understanding
```

---

## 19F. SECURITY seeds

### Socket MCP
Reference family:

```text
SocketDev/socket-mcp
```

Use cases:

```text
dependency supply-chain risk
maintenance/quality signals
license/vulnerability checks
pre-install package review
```

Especially valuable because this workbench itself installs third-party capabilities.

### Semgrep

Use cases:

```text
deterministic SAST
security review
AST rules
auth/input/SQL/filesystem-sensitive changes
```

### SonarQube MCP

Trigger only when project already uses SonarQube/SonarCloud or user explicitly wants it.

Use cases:

```text
quality analysis
security findings
existing Sonar workflows
```

### SQL safety candidate

Allow discovery of deterministic SQL safety gates for database-writing agents.

Do not make database write access a default.

---

## 19G. DATA seeds

### DBHub
Reference:

```text
bytebase/dbhub
```

Use cases:

```text
Postgres
MySQL/MariaDB
SQL Server
SQLite
schema inspection
SQL execution
multiple connections
```

Default to read-only.

### Supabase MCP

Trigger:

```text
supabase/
Supabase dependencies/config
```

Use cases:

```text
Supabase project/platform operations
migrations
logs
types
schema
```

Prefer project-scoped/read-only where possible.

### Neon MCP

Trigger:

```text
Neon config/dependencies
```

Use cases:

```text
Neon branching
development migrations
test database branches
```

Never automatically operate on production.

---

## 19H. OPS seeds

### GitHub MCP

Use cases:

```text
repository
PRs/issues
Actions/CI
Dependabot/security
```

Use toolset filtering and read-only mode when task does not require writes.

### Vercel MCP

Trigger:

```text
vercel.json
.vercel/
Vercel project
```

Use cases:

```text
deployments
logs
project operations
Vercel docs
```

### Cloudflare MCP

Trigger:

```text
wrangler config
Cloudflare Workers
```

Use cases:

```text
Cloudflare APIs
docs
observability
Workers
```

Study Cloudflare's compact "code mode" style as an architectural inspiration for reducing huge MCP tool schemas.

Do not copy implementation blindly.

### Sentry MCP

Trigger:

```text
Sentry dependency/config
production-error task
```

Use cases:

```text
production issues
stack traces
traces
error debugging
```

### Grafana MCP

Trigger:

```text
Grafana/Prometheus/Loki config
observability task
```

### Datadog MCP

Trigger:

```text
Datadog config/dependency
observability task
```

### Kubernetes MCP

Trigger:

```text
k8s manifests
Helm
cluster task
```

Default read-only.

### Terraform MCP

Trigger:

```text
*.tf
terraform.lock.hcl
```

Use cases:

```text
IaC understanding
Terraform workflows
```

### Docker MCP Gateway

Important optional runtime/isolation backend.

Use cases:

```text
run approved community MCPs in containers
centralize MCP lifecycle
credential injection
network/filesystem restriction
tool discovery
host pollution reduction
```

Design the runtime abstraction so the workbench can support:

```text
direct
docker-gateway
remote
```

MVP may implement only `direct`, but interfaces must not prevent sandboxing later.

---

# 20. Laravel profile

Laravel detection:

```text
composer.json
laravel/framework
artisan
routes/
app/
```

## Laravel Boost

High-priority Laravel development capability.

Use it for current Laravel-aware:

```text
application info
database/schema inspection
framework/package docs
logs/errors
package-aware skills
```

If Boost is already installed, let it provide package-aware Laravel intelligence rather than duplicating it.

If Laravel is detected and Boost is compatible but absent, recommend it.

## Laravel Agent Skills
Reference:

```text
laravel/agent-skills
```

Discover current official skills for workflows such as:

```text
Laravel upgrades
Laravel Cloud
Nightwatch
ecosystem workflows
```

## Nightwatch MCP

Trigger:

```text
Laravel Nightwatch present
production issue/observability task
```

Use:

```text
OPS.production-errors
OPS.observability
```

## Laravel Cloud skill/tooling

Activate only for Laravel Cloud projects/tasks.

## Laravel MCP framework

Important distinction:

```text
Laravel Boost / Nightwatch MCP
  -> developer tooling for working on project

laravel/mcp
  -> framework feature for making the PRODUCT expose/consume MCP
```

Do not install `laravel/mcp` just because a project is Laravel.

Select it only when product requirements include MCP functionality.

## Laravel AI SDK

If current Laravel AI-agent packages are detected, resolve appropriate AI/MCP development guidance.

---

# 21. React Native / Expo profile

React Native detection:

```text
react-native dependency
android/
ios/
Metro config
```

Expo detection:

```text
expo dependency
app.json/app.config.*
Expo Router/EAS config
```

Recommended resolution:

```text
React Native
  |
  +-> Callstack RN skills
  +-> Vercel RN skills when useful
  |
  +-> Expo?
  |     +-> Expo skills
  |     +-> Expo MCP
  |
  +-> React runtime problem?
  |     +-> agent-react-devtools
  |
  +-> device/E2E?
        +-> Maestro
        +-> Appium only when existing enterprise/Appium context makes it better
```

Avoid selecting three overlapping device controllers.

---

# 22. Flutter profile

Recommended resolution:

```text
Flutter
  |
  +-> Flutter Agent Plugins
  +-> Dart/Flutter MCP
  |
  +-> Widgetbook present?
  |     +-> Widgetbook component workflow
  |
  +-> interactive runtime exploration?
  |     +-> Marionette OR Dusk
  |
  +-> Flutter/native authored E2E?
  |     +-> Patrol
  |
  +-> general cross-platform mobile E2E?
        +-> Maestro
```

Do not install Patrol + Maestro + Mobile MCP + Appium automatically.

Choose based on task.

---

# 23. Next.js / React profile

Detect exact Next/React versions.

Prefer:

```text
current official Next.js development tooling
maintainer Next/React skills
agent-browser
Storybook/shadcn when present
Context7 for unrelated packages
opensrc only when source details matter
```

Design flow for UI work:

```text
PRD
  |
  v
product visual goals
  |
  +-> Awesome DESIGN.md references
  +-> UI UX Pro Max
  +-> relevant framework skills
  +-> Figma only when actual Figma context exists
  |
  v
OUR DESIGN.md
  |
  v
implementation
  |
  v
agent-browser validation
  |
  v
accessibility/performance checks when relevant
```

Do not create a generic trendy design system.

---

# 24. Go profile

Detection:

```text
go.mod
go.work
*.go
```

Prefer:

```text
gopls MCP / current official gopls agent tooling
```

for language semantics.

Add generic code-intelligence tools only when they provide additional relationship/history/context value.

---

# 25. Generic TypeScript profile

Use project-native commands first:

```text
compiler
lint
tests
build
package manager
```

Resolve extra tools from task:

```text
React UI
  -> UI candidates

Node API
  -> API/data candidates

large brownfield repo
  -> code-context candidate

package behavior ambiguity
  -> docs -> source-inspection
```

---

# 26. Documentation resolution policy

When answering/implementing against packages:

```text
1. determine exact installed version
2. use project-native/framework-native tool when it has version-aware truth
3. use exact-version official docs
4. use maintainer skills/docs
5. use Context7
6. use GitMCP/DeepWiki for repository-level understanding
7. inspect source with opensrc when behavior remains unclear
8. broad web research last
```

Never guess package APIs from model memory when exact version can be inspected.

---

# 27. Harness adapters

Define a harness-neutral interface such as:

```ts
interface HarnessAdapter {
  id: string

  inspect(
    root: string,
  ): Promise<HarnessState>

  planInstall(
    plan: CapabilityPlan,
  ): Promise<ConfigMutationPlan>

  apply(
    mutations: ConfigMutationPlan,
  ): Promise<ApplyResult>

  verify(
    root: string,
  ): Promise<Diagnostic[]>

  uninstallOwned(
    root: string,
  ): Promise<ApplyResult>
}
```

Every adapter must:

```text
preserve unrelated config
be idempotent
support dry run
record ownership
support uninstall
avoid writing secrets
```

Do not create framework-specific harness packages such as:

```text
codex-nextjs
codex-flutter
opencode-nextjs
```

Use one integration per harness.

---

# 28. Active harness behavior

This exact prompt may be pasted into Codex **or** OpenCode.

Determine which harness you are currently running under without asking me.

Then:

```text
1. implement shared core
2. implement current harness integration first
3. dogfood it in current harness
4. implement the other of Codex/OpenCode next
5. then Claude, OMP, Antigravity as time/environment allow
```

If native plugin APIs are unavailable or unstable, use the best supported combination of:

```text
Agent Skills
MCP
project instructions
native config
thin launcher/package
```

Do not invent undocumented plugin formats.

---

# 29. Current OpenCode facts to verify/use

OpenCode has a TypeScript/JavaScript plugin system.

Current documented project plugin locations include:

```text
.opencode/plugins/
```

and npm plugins can be loaded from OpenCode configuration.

Current OpenCode also supports Agent Skills and can discover standard agent-compatible skills, including `.agents/skills` in current versions.

OpenCode's newer plugin API can transform/intercept areas such as:

```text
agents
commands
skills
tools
integrations
runtime/tool execution
```

The V2 API is still evolving.

Before writing exact adapter code, inspect current official OpenCode docs and installed version.

Do not rely on stale API shapes.

For OpenCode, build as native a plugin experience as current stable APIs allow.

---

# 30. Current Codex facts to verify/use

Codex currently has a plugin ecosystem where plugins can package workflow skills and integrations.

Current official/curated plugins already exist for ecosystems such as Flutter and Expo.

Do not assume a local custom-plugin file layout from memory.

Inspect:

```text
installed Codex version
current Codex plugin docs/help
current skills behavior
current MCP configuration mechanism
current AGENTS.md behavior
```

Then implement the thinnest native Codex integration supported by the current version.

If custom local plugin packaging is not sufficiently documented, implement the Codex vertical slice with:

```text
shared Agent Skills
+
workbench MCP
+
safe project-level Codex configuration
+
installer/uninstaller
```

and document the limitation rather than inventing configuration.

---

# 31. Claude Code / OMP / Antigravity

Implement after the first Codex/OpenCode vertical slices.

Before each adapter:

```text
research current official docs
record date/version
record plugin model
record skill paths
record MCP config
record hooks/tools
record project/global scope
```

Put this in:

```text
docs/harness-compatibility.md
```

The semantic commands/workflows should remain equivalent across harnesses.

Suggested user-facing concepts:

```text
/workbench:new
/workbench:hydrate
/workbench:plan
/workbench:tools
/workbench:doctor
```

Exact native syntax can differ.

---

# 32. Shared workbench MCP

The workbench itself should expose a **small** MCP surface.

Start with:

```text
workbench_project_detect
workbench_project_plan
workbench_explain
workbench_capability_search
workbench_capability_resolve
workbench_capability_status
workbench_workflow_status
workbench_doctor
```

Avoid dozens of micro-tools.

The workbench MCP is an orchestrator.

It does not reimplement:

```text
agent-browser
Serena
Codanna
CodeGraphy
Context7
Dart MCP
Maestro
DBHub
GitHub
Sentry
```

It discovers/recommends/configures them.

---

# 33. CLI

Build a standalone CLI.

Minimum commands:

```bash
agent-workbench detect
agent-workbench detect --json

agent-workbench plan
agent-workbench plan --json
agent-workbench plan --harness <id>

agent-workbench explain

agent-workbench discover mcp <query>
agent-workbench discover skills <query>

agent-workbench capabilities
agent-workbench capabilities --json

agent-workbench apply
agent-workbench apply --dry-run
agent-workbench apply --harness <id>

agent-workbench remove
agent-workbench doctor

agent-workbench registry sync
agent-workbench registry status

agent-workbench upgrades
agent-workbench upgrade --review

agent-workbench mcp
```

Semantics:

```text
detect
  -> deterministic only, no mutation

plan
  -> resolve capabilities, no mutation

apply
  -> apply approved project capability plan

remove
  -> remove only workbench-owned changes

doctor
  -> verify installation/config/runtime
```

Machine-readable JSON output must be stable enough for harness integrations.

---

# 34. Capability-plan UX

Human output should be useful.

Example:

```text
Project
  lifecycle       brownfield
  stack           Flutter / Dart
  mobile          Android + iOS
  package manager pub
  Widgetbook      yes

Task
  debug checkout flow on Android

Selected minimal set
  [94] Dart/Flutter MCP
       covers: framework-analysis, runtime-inspection

  [91] Maestro MCP
       covers: emulator-control, e2e-device-test

  [83] Widgetbook workflow
       covers: component-registry

On demand
  [76] Context7
       package docs fallback

Rejected by overlap
  Patrol
       excellent Flutter-specific authored E2E,
       but current task is exploratory cross-platform device debugging

  Mobile MCP
       overlaps Maestro's device-control coverage

  Appium
       unnecessary enterprise/device-lab complexity

No changes have been made.
```

---

# 35. Config mutation safety

Never overwrite a complete existing:

```text
AGENTS.md
CLAUDE.md
OpenCode config
Codex config
Claude config
OMP config
Antigravity config
MCP config
```

Use:

```text
parse
merge structurally
preserve unrelated values
write atomically
record workbench ownership
```

If marker blocks are necessary, use explicit owned markers.

Uninstall must only remove owned configuration.

Test it.

---

# 36. Secrets

Never write secrets into:

```text
git
capabilities.lock.json
generated docs
logs
fixtures
```

Use:

```text
environment references
ignored XDG config
OS secret store where appropriate
harness-native secret references
```

Capability plan must clearly say when an MCP requires:

```text
Figma auth
21st API key
database DSN
cloud token
GitHub token
```

---

# 37. Runtime/sandbox abstraction

Model third-party MCP execution separately from selection.

Interface concept:

```ts
type RuntimeBackend =
  | "direct"
  | "docker-gateway"
  | "remote"
```

MVP may implement `direct`.

Design for optional Docker MCP Gateway integration so community MCPs can later run with:

```text
container isolation
read-only mounts
network restrictions
credential injection
central lifecycle
```

Do not make Docker mandatory for MVP.

---

# 38. Registry/cache behavior

Use XDG directories:

```text
$XDG_CONFIG_HOME/agent-workbench
$XDG_CACHE_HOME/agent-workbench
$XDG_STATE_HOME/agent-workbench
```

Provide sensible fallbacks on platforms without XDG variables.

Cache:

```text
official MCP registry metadata
skill-search metadata
GitHub provenance
optional downstream-registry metadata
```

Support TTL and explicit sync.

Network failure should degrade gracefully to:

```text
built-in catalog
+
existing lock
+
local project detection
```

Core project detection/tests must not require internet.

---

# 39. Dynamic community discovery

The seed catalog must not become a hardcoded ceiling.

For a task requiring a capability not adequately covered:

```text
1. query built-in catalog
2. query Official MCP Registry
3. query stable downstream registries if configured
4. query Skills CLI
5. use GitHub fallback for provenance/current alternatives
6. normalize candidates
7. score them
8. require approval based on trust/permissions
```

Examples:

```text
Flutter Bluetooth debugging
  -> search mobile/flutter/bluetooth skills/MCPs

Laravel queue debugging
  -> search Laravel/Horizon/queue tools

React Native Reanimated issue
  -> search RN performance/Reanimated skills

new database vendor
  -> discover vendor MCP + generic DB alternatives
```

Do not require code changes to the workbench every time a new MCP is published.

---

# 40. Verification skill

Before claiming an implementation task complete:

```text
format
lint
typecheck
unit tests
integration tests
build
runtime smoke test
browser/device verification when relevant
```

Use project-native scripts.

Do not invent commands when the project already defines them.

---

# 41. Tests and fixtures

Create fixtures:

```text
empty/
typescript/
nextjs/
nextjs-storybook/
nextjs-shadcn/
nextjs-postgres/
flutter/
flutter-widgetbook/
flutter-patrol/
react-native/
expo/
go/
laravel/
laravel-inertia-react/
laravel-nightwatch/
monorepo/
existing-agent-configs/
```

Unit-test:

```text
greenfield/brownfield detection
framework detection
dependency/version detection
profile composition
task classification
candidate scoring
permission penalties
official vs community comparison
overlap groups
minimum-set resolution
scope selection
lock serialization
secret filtering
```

Integration-test:

```text
official MCP Registry adapter
Skills CLI adapter where practical
registry cache
CLI JSON
workbench MCP startup
active harness config merge
install/apply twice
uninstall
dry-run
```

Safety tests:

```text
install twice is idempotent
uninstall preserves unrelated config
collision is reported, not overwritten
unknown write-capability requests approval
secrets never enter lock
network failure still allows local planning
```

No LLM calls in core unit tests.

---

# 42. Documentation

Create at least:

```text
README.md
docs/architecture.md
docs/capability-model.md
docs/mcp-resolution.md
docs/skill-resolution.md
docs/security.md
docs/harness-compatibility.md
docs/adding-a-profile.md
docs/adding-a-registry.md
```

README should show:

```text
what problem this solves
greenfield flow
brownfield flow
install
detect
plan
apply
doctor
security model
how capability discovery works
```

Do not market unimplemented features as finished.

---

# 43. Implementation phases

Work through these in order.

## Phase 0 — repository + current research

1. initialize monorepo if needed;
2. inspect current harness;
3. inspect current official docs/help for that harness;
4. verify current OpenCode/Codex behavior needed for first adapter;
5. verify official MCP Registry API;
6. record compatibility findings.

Do not spend the entire run researching.

## Phase 1 — pure core

Implement:

```text
ProjectSnapshot
detectors
profiles
TaskProfile
capability taxonomy
candidate model
scoring
trust policy
overlap groups
minimum-set resolver
lock model
```

Add tests.

## Phase 2 — built-in catalog + registry

Implement:

```text
BuiltinRegistry
OfficialMcpRegistry
SkillsCliRegistry
cache
```

GitHub fallback may follow.

Glama/Smithery adapters only if current stable search APIs can be verified; otherwise leave clean interfaces/documentation.

## Phase 3 — CLI

Implement:

```text
detect
plan
explain
discover
capabilities
doctor
```

Then add `apply/remove`.

## Phase 4 — shared workbench MCP

Expose the small MCP tool surface.

Test stdio startup.

## Phase 5 — active harness integration

If running in OpenCode:

```text
implement OpenCode first
dogfood it
then Codex
```

If running in Codex:

```text
implement Codex first
dogfood it
then OpenCode
```

Do not ask which harness you are in.

## Phase 6 — shared skills

Create:

```text
project-start
project-hydrate
dependency-research
architecture-review
design-director
functional-core
verification-loop
```

Keep them harness-neutral.

## Phase 7 — framework profiles / seed catalog

Implement the seed metadata and triggers for:

```text
Next.js
Flutter
React Native
Expo
Laravel
Go
generic TypeScript
```

Do not need to install every seed during tests.

## Phase 8 — remaining harness adapters

Add:

```text
Claude Code
OMP
Antigravity
```

one at a time.

---

# 44. Current upstream reference targets

When you need exact current install/config details, search the current upstream source/docs for these exact identifiers.

Do not rely on stale model memory.

```text
OpenAI Codex
OpenCode

modelcontextprotocol/registry
vercel-labs/skills
vercel-labs/agent-browser

flutter/agent-plugins
dart-lang/skills
leancodepl/patrol
leancodepl/marionette_mcp
fluttersdk/dusk
mobile-next/mobile-mcp
appium/appium-mcp
MetaMask/device-mcp

expo/skills
callstackincubator/agent-skills
callstackincubator/agent-react-devtools

laravel/boost
laravel/agent-skills
laravel/mcp
Laravel Nightwatch docs

bartolli/codanna
oraios/serena
ast-grep/ast-grep
ast-grep/ast-grep-mcp
yamadashy/repomix
idsal/git-mcp
vercel-labs/opensrc

bytebase/dbhub
SocketDev/socket-mcp

microsoft / current GitHub MCP project
Chrome DevTools MCP
Storybook MCP
shadcn MCP
Figma MCP
Supabase MCP
Neon MCP
Sentry MCP
Grafana MCP
Terraform MCP
Kubernetes MCP
Docker MCP Gateway

nextlevelbuilder/ui-ux-pro-max-skill
VoltAgent/awesome-design-md
```

If a repository has moved/renamed, find the maintained successor and record the change.

---

# 45. Things you must NOT do

Do not:

```text
depend on my dotfiles
make GNU Stow part of the product
create five independent implementations
put framework logic in harness adapters
globally load all MCPs
choose official tools blindly
choose popular community tools blindly
silently run unknown community installers
use curl|bash automatically
store secrets in project state
overwrite existing agent config
reimplement browser automation
reimplement a code graph
reimplement package documentation
reimplement a database client
force FP libraries
choose stack before discovery
select all high-scoring MCPs
stop after writing architecture docs
claim a tool works without verifying it
```

---

# 46. MVP definition of done

MVP is complete when all of these are true:

```text
[ ] standalone repository; no dotfiles dependency
[ ] strict TypeScript monorepo
[ ] deterministic project detection
[ ] greenfield/brownfield detection
[ ] profiles: TS, Next, Flutter, RN, Expo, Go, Laravel
[ ] capability taxonomy
[ ] candidate model
[ ] explainable scoring
[ ] trust/permission policy
[ ] overlap detection
[ ] minimum-set resolver
[ ] built-in seed registry
[ ] Official MCP Registry discovery
[ ] Skills CLI discovery
[ ] local cache
[ ] version/provenance capability lock
[ ] CLI detect/plan/explain/discover/doctor
[ ] shared workbench MCP
[ ] shared workbench skills
[ ] current harness integration
[ ] project-local apply
[ ] dry-run
[ ] idempotent install
[ ] safe uninstall
[ ] no secrets tracked
[ ] tests pass
[ ] dogfood verification performed
```

The first vertical slice may support only the currently running harness plus shared core, but continue to the second Codex/OpenCode integration when possible.

---

# 47. Multi-harness v1 definition of done

Eventually:

```text
Codex
OpenCode
Claude Code
OMP
Antigravity
```

must all be able to:

```text
install workbench integration
load shared workbench skills
use shared workbench MCP/core
resolve same ProjectProfile
resolve semantically equivalent CapabilityPlan
configure project-local third-party MCPs safely
preserve native user config
uninstall owned changes
```

Native features may differ.

Semantic workflow must not.

---

# 48. Autonomous working rules

You are in implementation mode.

Follow these rules:

1. Inspect before editing.
2. Do not ask me to choose routine libraries or file names.
3. Prefer boring, maintainable dependencies.
4. Keep core logic pure/testable.
5. Verify fast-changing upstream integration details before encoding them.
6. If one external registry has no stable API, isolate/skip it rather than scraping brittle HTML.
7. Implement working code before polishing docs.
8. Run tests continuously.
9. Keep commits/changes logically organized if git usage is available.
10. Do not install risky third-party MCPs merely to test catalog metadata.
11. Mock registry responses in tests.
12. Dogfood only safe capabilities.
13. Record assumptions and limitations.
14. Continue through phases without waiting for confirmation.
15. If the environment prevents a phase, complete everything possible before it and leave the next phase in a clean documented state.

---

# 49. Start now

Start by inspecting the current repository and identifying the harness you are running under.

Then:

```text
1. initialize/normalize the monorepo
2. create Phase 0 compatibility docs
3. build the shared pure core
4. add fixtures/tests
5. implement capability scoring + minimum-set resolution
6. implement BuiltinRegistry
7. implement Official MCP Registry discovery
8. implement Skills CLI discovery
9. implement CLI detect/plan/explain
10. implement capability lock
11. implement workbench MCP
12. implement the current harness integration
13. create shared skills
14. dogfood the current harness integration
15. implement the other of Codex/OpenCode
16. continue with remaining adapters if feasible
```

Do not stop after making a plan.

---

# 50. Required final report

At the end of your implementation session, provide a concise engineering report:

```text
1. current harness detected
2. architecture implemented
3. packages/files created
4. project detectors implemented
5. capability taxonomy/resolver implemented
6. registry adapters implemented
7. seed capabilities represented
8. CLI commands working
9. workbench MCP tools working
10. harness integration implemented
11. install/apply/uninstall behavior
12. tests run + exact results
13. dogfood verification
14. third-party tools actually tested
15. features represented but not yet verified
16. security/trust behavior
17. known limitations
18. next highest-value step
```

Do not say something is working unless it was actually verified.

Begin implementation now.
