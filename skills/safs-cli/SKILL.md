---
name: safs-cli
description: Operate an SSH/SFTP remote workspace through the installed SAFS CLI. Use when the user asks to use SAFS or the current project is a SAFS remote-workspace placeholder.
---

# SAFS remote workspace

SAFS exposes a remote workspace through the global `safs` command while the SAFS VS Code extension is running in CLI mode.

The extension installs the CLI and this Skill. If `safs` is unavailable, restart VS Code in CLI mode to trigger automatic installation.

## Select a workspace

Always execute `safs` in the Agent's current local working directory. Do not `cd`, set a different shell cwd/workdir, or search other directories to locate a workspace marker. If the current directory has no `.safs-workspace-id`, pass `--id ID`. To operate on other workspaces, remain in the current directory and pass their explicit IDs.

List active SAFS workspaces and ask the user to choose when there is more than one:

```bash
safs workspaces
```

The extension creates `.safs-workspace-id` in each Agent local working directory. By default SAFS reads the file in the current directory only, without searching parent directories. If its ID is active, use it. If it has expired, SAFS matches the current placeholder path to active workspaces and writes the new ID back only when exactly one workspace matches. Never choose by window focus.

If the file is absent, or stale-ID recovery finds zero or multiple matches, run `safs workspaces` and explicitly pass `--id ID`. Explicit `--id` takes priority, does not modify the marker, and never falls back to another workspace if that ID is stale.

For tasks involving multiple workspaces, always pass `--id` on every command, even inside a directory with a marker:

```bash
safs read README.md --id <workspaceA>
safs read README.md --id <workspaceB>
```

Workspace selection does not cancel operations targeting other workspace IDs. A batch operates on one explicitly selected workspace; use separate calls for different workspaces.

## Operate safely

- Use structured SAFS commands for all remote file operations: listing, reading, searching, creating, editing, writing, moving, deleting, changing permissions, uploading, and downloading.
- Never use local filesystem tools for remote paths. Never use `safs exec` or shell redirection as a fallback for file operations rejected by a structured command.
- Reserve `safs exec` for task commands such as builds, tests, and version-control inspection.
- Prefer concise positional forms. Use `safs <command> --help` when exact syntax is needed.
- Treat a nonzero process exit code as failure. JSON `status: "error"`, an error `code`, or a failed batch item also means failure.
- Continue bounded reads with the returned cursor or offset. Continue retained command output with `safs output`; do not rerun a command merely to retrieve truncated output.

Read [references/commands.md](references/commands.md) when selecting or composing SAFS commands.
