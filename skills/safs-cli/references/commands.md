# SAFS command reference

Use a `workspaceId` returned by `safs workspaces` as `ID` below.

## Workspace

```bash
safs workspaces
safs current-file --id ID
```

## Read and search

```bash
safs list [PATH] --id ID [--limit N] [--cursor CURSOR]
safs read PATH --id ID [--offset N] [--length N]
safs read PATH --id ID --head N
safs read PATH --id ID --tail N
safs read PATH --id ID --start-line N [--line-count N]
safs search QUERY [PATH] --id ID [--mode content|files|count|names]
safs find GLOB [PATH] --id ID
safs output OUTPUT_ID stdout|stderr --id ID [--offset N] [--length N]
```

Use `read-many --json` or `--json-file` for multiple bounded reads. `search --mode files` finds files whose contents match; `find` matches file basenames.

## Structured changes

```bash
safs edit PATH --id ID --json '{"edits":[{"oldText":"old","newText":"new"}]}'
safs write PATH --id ID --content 'short text'
printf '%s' 'multiline or sensitive content' | safs write PATH --id ID --file -
safs create PATH file --id ID [--content 'initial text']
safs create PATH directory --id ID
safs delete PATH --id ID
safs delete PATH --id ID --recursive
safs chmod PATH 755 --id ID
safs move --id ID --json '{"sourcePath":"old","targetPath":"new","overwrite":false}'
safs upload --id ID --json '{"localPaths":["/absolute/local/path"],"remoteDirectory":"."}'
safs download --id ID --json '{"remotePath":"file","localPath":"/absolute/local/target"}'
```

Pass large or multiline JSON through `--json-file PATH`; `--json` accepts inline JSON. JSON stdin is not supported.

`write` replaces the full file. Use `--allow-empty` for an intentional empty replacement. Read, write, and edit are limited to 5 MiB per file. Use download and upload for larger files. Write, edit, delete, and move save a snapshot before modifying remote files. Agent Activity can compare a snapshot with the current files and restore it. SAFS keeps the three most recent snapshots per path. The remote host needs Git, GNU tar, and Python 3 for snapshots.

## Task commands and batching

```bash
safs exec "npm test" --id ID
safs exec "git status --short" --id ID
safs batch --id ID --json '{"operations":[{"command":"read","arguments":{"path":"README.md"}}]}'
```

`exec` returns JSON and propagates the remote exit code. Use `--raw` for remote stdout and stderr streams or `--file SCRIPT` for multiline commands. When output is truncated, use the output ID and byte offsets to continue with `safs output`.

Named options such as `--path`, `--query`, and `--command` remain valid when positional arguments are inconvenient.


Default selection reads `.awm/workspace.json` in cwd only. An expired ID is refreshed only after unique active-placeholder matching. Missing files, unavailable workspaces, and ambiguous matches require `--id ID`. Explicit IDs never update the marker or fall back. Always specify `--id` on each command for tasks spanning multiple workspaces. Retained output accepts positional OUTPUT_ID or `--output-id OUTPUT_ID`.

Always run `safs` in the Agent current local working directory. Do not change directories or override shell cwd/workdir to select a workspace or find a marker. For other workspaces or a missing current-directory marker, remain in cwd and pass `--id ID`.
