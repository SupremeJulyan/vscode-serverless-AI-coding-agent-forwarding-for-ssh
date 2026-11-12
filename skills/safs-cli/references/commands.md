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

Use `read-many --input` for multiple bounded reads. `search --mode files` finds files whose contents match; `find` matches file basenames.

## Structured changes

```bash
safs edit PATH --id ID --input '{"edits":[{"oldText":"old","newText":"new"}]}'
safs write PATH --id ID --content 'short text'
printf '%s' 'multiline or sensitive content' | safs write PATH --id ID --file -
safs create PATH file --id ID [--content 'initial text']
safs create PATH directory --id ID
safs delete PATH --id ID
safs delete PATH --id ID --input '{"recursive":true}'
safs chmod PATH 755 --id ID
safs move --id ID --input '{"sourcePath":"old","targetPath":"new","overwrite":false}'
safs upload --id ID --input '{"localPaths":["/absolute/local/path"],"remoteDirectory":"."}'
safs download --id ID --input '{"remotePath":"file","localPath":"/absolute/local/target"}'
```

Pass large, multiline, or sensitive JSON through `--input -` on stdin so it is not exposed in command arguments.

## Task commands and batching

```bash
safs exec "npm test" --id ID
safs exec "git status --short" --id ID
safs batch --id ID --input '{"operations":[{"command":"read","arguments":{"path":"README.md"}}]}'
```

`exec` prints remote stdout and stderr directly and returns the remote exit code. When output is truncated, it emits continuation metadata containing an output ID and byte offsets.

Named options such as `--path`, `--query`, and `--command` remain valid when positional arguments are inconvenient.


Default selection reads `.awm/workspace.json` in cwd only. An expired ID is refreshed only after unique active-placeholder matching. Missing files, unavailable workspaces, and ambiguous matches require `--id ID`. Explicit IDs never update the marker or fall back. Always specify `--id` on each command for tasks spanning multiple workspaces. Retained output accepts positional OUTPUT_ID or `--output-id OUTPUT_ID`.

Always run `safs` in the Agent current local working directory. Do not change directories or override shell cwd/workdir to select a workspace or find a marker. For other workspaces or a missing current-directory marker, remain in cwd and pass `--id ID`.
