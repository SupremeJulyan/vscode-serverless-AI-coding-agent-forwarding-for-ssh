# SAFS command reference

Use the `bindingId` returned by `safs bind` as `ID` below.

## Workspace

```bash
safs bind --agent Codex
safs workspaces
safs current-file --binding ID
safs switch --agent Codex --workspace WORKSPACE_ID --confirmed
```

## Read and search

```bash
safs list [PATH] --binding ID [--limit N] [--cursor CURSOR]
safs read PATH --binding ID [--offset N] [--length N]
safs read PATH --binding ID --head N
safs read PATH --binding ID --tail N
safs read PATH --binding ID --start-line N [--line-count N]
safs search QUERY [PATH] --binding ID [--mode content|files|count|names]
safs find GLOB [PATH] --binding ID
safs output OUTPUT_ID stdout|stderr --binding ID [--offset N] [--length N]
```

Use `read-many --input` for multiple bounded reads. `search --mode files` finds files whose contents match; `find` matches file basenames.

## Structured changes

```bash
safs edit PATH --binding ID --input '{"edits":[{"oldText":"old","newText":"new"}]}'
safs write PATH --binding ID --content 'short text'
printf '%s' 'multiline or sensitive content' | safs write PATH --binding ID --file -
safs delete PATH --binding ID
safs delete PATH --binding ID --input '{"recursive":true}'
safs chmod PATH 755 --binding ID
safs move --binding ID --input '{"sourcePath":"old","targetPath":"new","overwrite":false}'
safs upload --binding ID --input '{"localPaths":["/absolute/local/path"],"remoteDirectory":"."}'
safs download --binding ID --input '{"remotePath":"file","localPath":"/absolute/local/target"}'
```

Pass large, multiline, or sensitive JSON through `--input -` on stdin so it is not exposed in command arguments.

## Task commands and batching

```bash
safs exec "npm test" --binding ID
safs exec "git status --short" --binding ID --cwd subdirectory
safs batch --binding ID --input '{"operations":[{"command":"read","arguments":{"path":"README.md"}}]}'
```

`exec` prints remote stdout and stderr directly and returns the remote exit code. When output is truncated, it emits continuation metadata containing an output ID and byte offsets.

Named options such as `--path`, `--query`, and `--command` remain valid when positional arguments are inconvenient.
