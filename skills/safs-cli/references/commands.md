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
safs list --id ID --json '[{"path":"src","limit":20},{"path":"test","limit":10,"cursor":"CURSOR"}]'
safs list --id ID --json-file FILE
safs read --id ID --json '[{"path":"a.txt","head":20},{"path":"b.txt","offset":200,"length":100}]'
safs read --id ID --json-file FILE
safs read PATH --id ID [--offset N] [--length N]
safs read PATH --id ID --head N
safs read PATH --id ID --tail N
safs read PATH --id ID --start-line N [--line-count N]
safs find-text QUERY [PATH] --id ID [--mode content|files|count]
safs find-name GLOB [PATH] --id ID
safs output OUTPUT_ID stdout|stderr --id ID [--offset N] [--length N]
```

Pass the list JSON inline with `--json` or read it from a local file with `--json-file`. Each item requires `path` and accepts its own `limit` and `cursor`. Omit `limit` for the default of 100 entries and omit `cursor` to start at the first page. Directories are listed concurrently. A failed directory is reported alongside successful results and sets a nonzero exit code. For multiple files, pass an array of 1 to 16 read requests to `read --json` or `read --json-file`. Each file has its own selection and byte limit. Explicit byte lengths must be between 4 and 65,536. The reads run concurrently and results follow input order. `find-text --mode files` finds files whose contents match; `find-name` matches file basenames. Use `--json` or `--json-file` with `find-text` to set `fixedStrings`, `ignoreCase`, `contextLines`, `include`, and `excludeDirs`. A newline in a text query separates search patterns. Search output is line-oriented, so a newline inside a filename also contributes to `returnedLineCount`. A search with no matches returns JSON with `status: "no_matches"` and exits with code 1.

## Structured changes

```bash
safs edit PATH --id ID --json '{"edits":[{"oldText":"old","newText":"new"}]}'
safs write PATH --id ID --content 'short text'
safs create PATH file --id ID [--content 'initial text']
safs create PATH directory --id ID
safs delete PATH --id ID
safs delete PATH --id ID --recursive
safs chmod PATH 755 --id ID
safs move old new --id ID
safs upload [LOCAL_PATH] REMOTE_DIRECTORY --id ID
safs download file --id ID [LOCAL_DIRECTORY]
```

Use `upload` to transfer one local file or directory. The local source can be absolute or relative to the directory where you run `safs`. Omit the upload source to upload the selected workspace’s local placeholder directory. Omit the download destination to save into that directory under the remote name. An explicit download target is also a directory. For example, `safs download reports/a.txt ./downloads` saves `./downloads/a.txt`.

For `list`, `read`, `find-text`, and `edit`, pass large or multiline JSON through `--json-file PATH`; `--json` accepts inline JSON. File options take local file paths.

`write` replaces the full file. For content too long to pass as a command argument, create a local file with the same basename as the remote target and upload it to the target directory. For example, to replace `reports/a.txt`, save the new content as a local `./staging/a.txt` and run `safs upload ./staging/a.txt reports --id ID`. Use `--allow-empty` for an intentional empty replacement. Read, write, and edit are limited to 5 MiB per file. Use download and upload for larger files. Write, edit, and delete save a snapshot before modifying remote files. When the move target is an existing directory, SAFS moves the source into it under its original name. The final destination must not exist. Move does not save a snapshot. Agent Activity can compare a snapshot with the current files and restore it. SAFS keeps the three most recent snapshots per path. The remote host needs Git, GNU tar, and Python 3 for snapshots.

## Task commands

```bash
safs exec "npm test" --id ID
safs exec "git status --short" --id ID
```

`exec` returns JSON and propagates the remote exit code. With `--raw`, the CLI writes the captured stdout and stderr to the corresponding local streams after execution. Use `--file SCRIPT` for multiline commands. If the result includes an output ID, use it and the byte offsets to continue with `safs output`. Terminal-only workspaces support only `exec`, and truncated output cannot be continued there.

Run `safs COMMAND --help` for the named options accepted by that command. Use `--config FILE` to select a local router connection file.


Default selection reads `.awm/workspace.json` in cwd only. An expired ID is refreshed only after unique active-placeholder matching. Missing files, unavailable workspaces, and ambiguous matches require `--id ID`. Explicit IDs never update the marker or fall back. Always specify `--id` on each command for tasks spanning multiple workspaces. Retained output accepts positional OUTPUT_ID or `--output-id OUTPUT_ID`.

Always run `safs` in the Agent current local working directory. Do not change directories or override shell cwd/workdir to select a workspace or find a marker. For other workspaces or a missing current-directory marker, remain in cwd and pass `--id ID`.
