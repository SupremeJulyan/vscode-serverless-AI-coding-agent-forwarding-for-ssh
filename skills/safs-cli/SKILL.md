---
name: safs-cli
description: Operate an SSH/SFTP remote workspace through the installed SAFS CLI. Use when the user asks to use SAFS or the current project is a SAFS remote-workspace placeholder.
---

# SAFS remote workspace

SAFS exposes a remote workspace through the global `safs` command while the SAFS VS Code extension is running.

## Start a task

Bind once from the Agent's current working directory and retain the returned `bindingId`:

```bash
safs bind --agent "<agent name>"
```

Pass `--binding <bindingId>` to every later workspace command. Do not guess, cache across tasks, or silently replace an invalid or expired binding.

If binding reports multiple candidates, show them to the user and wait for an explicit choice. Then run:

```bash
safs switch --agent "<agent name>" --workspace <workspaceId> --confirmed
```

A successful switch cancels the previous task context. Stop immediately and wait for the user's next request.

## Operate safely

- Use structured SAFS commands for all remote file operations: listing, reading, searching, editing, writing, moving, deleting, changing permissions, uploading, and downloading.
- Never use local filesystem tools for remote paths. Never use `safs exec` or shell redirection as a fallback for file operations rejected by a structured command.
- Reserve `safs exec` for task commands such as builds, tests, and version-control inspection.
- Prefer concise positional forms. Use `safs <command> --help` when exact syntax is needed.
- Treat a nonzero process exit code as failure. JSON `status: "error"`, an error `code`, or a failed batch item also means failure.
- Continue bounded reads with the returned cursor or offset. Continue retained command output with `safs output`; do not rerun a command merely to retrieve truncated output.

Read [references/commands.md](references/commands.md) when selecting or composing SAFS commands.
