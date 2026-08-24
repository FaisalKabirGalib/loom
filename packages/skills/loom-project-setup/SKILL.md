---
name: loom-project-setup
description:
  Recommend a task-specific Loom setup plan and hand its validated command to
  the user. Use when a project needs capabilities configured or installed.
---

# Loom Project Setup

1. Understand the task, project context, constraints, and required capabilities
   before requesting a setup recommendation.
2. For Dart or Flutter projects, call read-only `loom_skill_search` with the
   task. Compare each candidate's locked package/revision, description,
   provenance, content hash, and metrics against the task and dependencies.
3. Call `loom_setup_recommend` once without `selectedSkills`. If it returns
   `selectionRequired`, select only relevant exact IDs and call it again with a
   nonblank reason for each selection. Explicitly pass `selectedSkills: []` and
   `selectionRationale` when none are relevant. Never select all by default.
4. Show the returned summary and every warning, then present exactly the
   returned `loom setup --intent ...` command for the user to execute.
5. Do not execute the command. Loom CLI revalidates the recommendation at
   execution time and asks the user for one consolidated confirmation.

## Safety

- Never invent, edit, decode, or reconstruct the returned intent token or
  command.
- Never add `--yes`, `--approve`, or any other approval-bypassing option.
- Never install capabilities directly or substitute arbitrary shell commands,
  package managers, scripts, or network requests for Loom.
- If no valid command is returned, report the failure and request a new
  recommendation rather than improvising.
- Never use `--all`; every skill must be selected by exact ID and justified.

## Output

Provide the recommendation summary, warnings, and the exact returned command,
clearly separated. Tell the user to run the command themselves.
