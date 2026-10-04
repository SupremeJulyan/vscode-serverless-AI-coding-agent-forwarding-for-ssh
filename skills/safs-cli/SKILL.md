---
name: safs-cli
description: Operate an SSH/SFTP remote workspace through the installed SAFS CLI. Use when the user asks to use SAFS or the current project is a SAFS remote-workspace placeholder.
---

# SAFS remote workspace

SAFS exposes a remote workspace through the global `safs` command while the SAFS VS Code extension is running.

## Select a workspace

List active SAFS workspaces and ask the user to choose when there is more than one:

```bash
safs workspaces
```

Pass the selected `workspaceId` explicitly to every later workspace command:

```bash
safs read README.md --workspace <workspaceId>
```

Do not infer a workspace from focus, host, path, or a previous task. If the selected ID is no longer active, list workspaces again and ask the user to choose.

Workspace selection does not cancel operations targeting other workspace IDs. Always keep the selected ID with each command.

## Operate safely

- Use structured SAFS commands for all remote file operations: listing, reading, searching, creating, editing, writing, moving, deleting, changing permissions, uploading, and downloading.
- Never use local filesystem tools for remote paths. Never use `safs exec` or shell redirection as a fallback for file operations rejected by a structured command.
- Reserve `safs exec` for task commands such as builds, tests, and version-control inspection.
- Prefer concise positional forms. Use `safs <command> --help` when exact syntax is needed.
- Treat a nonzero process exit code as failure. JSON `status: "error"`, an error `code`, or a failed batch item also means failure.
- Continue bounded reads with the returned cursor or offset. Continue retained command output with `safs output`; do not rerun a command merely to retrieve truncated output.

Read [references/commands.md](references/commands.md) when selecting or composing SAFS commands.
