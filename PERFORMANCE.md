# Performance Notes

- SFTP sessions are pooled by SSH host, so folders using the same host reuse a connection.
- Concurrent requests for a disconnected host share one connection attempt.
- File metadata and directory listings use a configurable short-lived cache.
- Successful writes and directory mutations invalidate affected cache entries immediately.
- Remote change detection uses configurable polling because SFTP has no push notification API.
- File content is not cached, avoiding stale editor reads after external updates.
- Remote search runs on the SSH host instead of downloading the workspace.

## Bounded MCP results

- Directory lists default to 100 sorted entries. Pass `nextCursor` back as `cursor`;
  changes to entry names/types or the requested path invalidate the cursor.
- Search preserves grep exit status: `matches`, `no_matches`, or `error`. Returned
  line counts are not total match counts, especially when output is incomplete.
- Command/search previews default to 8 KiB (`safs.agentMcpMaxOutputBytes`, preview
  ceiling 64 KiB). Use `remote_output` with `outputId`, `stream`, and the stream's
  next byte offset to fetch retained output without executing the command again.
- Capture is limited to 16 MiB per MCP execution; `retentionTruncated` indicates
  that even retained output is incomplete. Results expire after 10 minutes, on
  window server shutdown, or earlier when the 32 MiB cache evicts older results.
  Expired handles fail explicitly and must not trigger automatic command reruns.
- Retention is in local process memory, scoped to the window/workspace and Agent
  source. It is not a persistent command log or an unbounded output archive.
- `remote_read` defaults to 8 KiB. Choose byte offset, `head`, `tail`, or
  `startLine`/`lineCount`; the byte budget applies to every selection. Tail lookup
  reads a bounded suffix and reports `selectionTruncated` when requested lines
  do not fit. Line lookup scans at most 16 MiB and fails explicitly beyond that.
- `remote_search` supports content, matching-file, and per-file-count modes;
  literal queries, case folding, context lines, basename include globs, and
  explicit directory exclusions. `excludeDirs: []` disables default exclusions.
  Context lines are only valid in content mode. Counts include zero-match files.
- `remote_read_many` batches up to 16 selections under a 16 KiB default shared
  content budget (metadata excluded). Each item explicitly reports `ok`, `error`,
  or `not_read`; earlier reads cannot silently starve later files.
- `safs.agentMcpToolProfile: "core"` omits current-editor metadata, transfers,
  delete/move/chmod tools while keeping typed edit/write, discovery, inspection,
  commands and continuation. The default `full` profile preserves compatibility.
  This is tool discovery configuration, not a permissions boundary (commands still
  have SSH account permissions). Set consistently across windows, then restart
  the Agent so its cached tool list is refreshed.
- `remote_list` also accepts `paths` for up to 16 directories sharing one entry
  limit (default 100). Each result has its own status and continuation cursor;
  resume a truncated directory using a single-path call. `paths` cannot be
  combined with `path` or a single-directory `cursor`.

## Repeatable efficiency checks

Run `npm run benchmark:mcp` for schema byte counts and synthetic code-reading,
long-output and multi-file workloads. It verifies exact selected evidence and
lossless continuation within retention capacity. Defaults distribute a batch's
remaining content budget across remaining files; explicit lengths can override
that allocation, while the total cap still applies.

These are UTF-8 JSON byte measurements, not tokenizer counts or measured Agent
success rates. For a model-level comparison, fix model/version, reasoning settings,
initial context and repository snapshot; repeat directory exploration, bug diagnosis,
multi-file editing and failing-test tasks. Record total input/output usage, cached
input separately, retries, elapsed time and objective correctness. Compare full MCP,
core MCP and the CLI, rather than extrapolating from one session.

Symbol/LSP retrieval remains optional future work: this implementation deliberately
keeps the existing no-remote-service deployment model and adds no language server
or indexing dependency. A real remote integration/token benchmark requires a live
SAFS connection and Agent usage telemetry; the offline benchmark does not supply it.

## CLI-first Agent integration

`agentInterface` now defaults to `cli`. On forwarding setup SAFS writes a private
connection JSON file and removes detected Agent-facing MCP registrations. The
internal HTTP/MCP backend remains shared: replacing that internal protocol would
not remove additional model-visible schemas, since the CLI never requests them.
`mcp` remains an explicit compatibility mode; `agentMcpToolProfile` controls that
mode, while the CLI backend exposes all structured operations.

Local SAFS-owned placeholder parents receive managed AGENTS.md/CLAUDE.md blocks
with an absolute CLI command and connection-file path. Remote projects and local
sync mirrors are not modified. Clients that do not inherit those files can receive
the same token-free instructions via the existing installation command. All modes
require consistent settings across windows, a window reload and Agent restart on
migration. Undetected/manual MCP registrations cannot be assumed removed.

CLI file commands reuse structured backend validation and accept JSON argument
files for edits/filters/batches. Search preserves grep exit codes (1 for no match,
2 for errors); batch item errors set exit code 1, while budget-deferred items remain
explicit in JSON. No binding recovery or workspace switching occurs implicitly.
