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
