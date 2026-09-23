# SAFS command reference

Use a `workspaceId` returned by `safs workspaces` as `ID` below.

The router identifies the Agent from the connection URL when available.

## Workspace

```bash
safs workspaces
safs current-file --workspace ID
```

## Read and search

```bash
safs list [PATH] --workspace ID [--limit N] [--cursor CURSOR]
safs read PATH --workspace ID [--offset N] [--length N]
safs read PATH --workspace ID --head N
safs read PATH --workspace ID --tail N
safs read PATH --workspace ID --start-line N [--line-count N]
safs search QUERY [PATH] --workspace ID [--mode content|files|count|names]
safs find GLOB [PATH] --workspace ID
safs output OUTPUT_ID stdout|stderr --workspace ID [--offset N] [--length N]
```

Use `read-many --input` for multiple bounded reads. `search --mode files` finds files whose contents match; `find` matches file basenames.

## Structured changes

```bash
safs edit PATH --workspace ID --input '{"edits":[{"oldText":"old","newText":"new"}]}'
safs write PATH --workspace ID --content 'short text'
printf '%s' 'multiline or sensitive content' | safs write PATH --workspace ID --file -
safs create PATH file --workspace ID [--content 'initial text']
safs create PATH directory --workspace ID
safs delete PATH --workspace ID
safs delete PATH --workspace ID --input '{"recursive":true}'
safs chmod PATH 755 --workspace ID
safs move --workspace ID --input '{"sourcePath":"old","targetPath":"new","overwrite":false}'
safs upload --workspace ID --input '{"localPaths":["/absolute/local/path"],"remoteDirectory":"."}'
safs download --workspace ID --input '{"remotePath":"file","localPath":"/absolute/local/target"}'
```

Pass large, multiline, or sensitive JSON through `--input -` on stdin so it is not exposed in command arguments.

## Task commands and batching

```bash
safs exec "npm test" --workspace ID
safs exec "git status --short" --workspace ID
safs batch --workspace ID --input '{"operations":[{"command":"read","arguments":{"path":"README.md"}}]}'
```

`exec` prints remote stdout and stderr directly and returns the remote exit code. When output is truncated, it emits continuation metadata containing an output ID and byte offsets.

Named options such as `--path`, `--query`, and `--command` remain valid when positional arguments are inconvenient.
