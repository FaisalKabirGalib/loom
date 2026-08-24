---
name: loom-project-setup
description:
  Recommend a task-specific Loom setup plan and hand its validated command to
  the user. Use when a project needs capabilities configured or installed.
---

# Loom Project Setup

1. Understand the task, project context, constraints, and required capabilities
   before requesting a setup recommendation.
2. Call the read-only `loom_setup_recommend` tool with the established intent.
3. Show the returned summary and every warning, then present exactly the
   returned `loom setup --intent ...` command for the user to execute.
4. Do not execute the command. Loom CLI revalidates the recommendation at
   execution time and asks the user for one consolidated confirmation.

## Safety

- Never invent, edit, decode, or reconstruct the returned intent token or
  command.
- Never add `--yes`, `--approve`, or any other approval-bypassing option.
- Never install capabilities directly or substitute arbitrary shell commands,
  package managers, scripts, or network requests for Loom.
- If no valid command is returned, report the failure and request a new
  recommendation rather than improvising.

## Output

Provide the recommendation summary, warnings, and the exact returned command,
clearly separated. Tell the user to run the command themselves.
