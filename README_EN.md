# SAFS

**S**erverless **A**I Coding Agent **F**orwarding for **S**SH

[简体中文](README.md) | [English](README_EN.md)

SAFS lets you browse and edit remote files in VS Code over SFTP and use a remote terminal over SSH, without installing VS Code Server on the server. After Agent Forwarding is enabled, AI Coding Agents such as Copilot, Codex, and Claude Code can also read and write files, search code, and run commands in the current remote workspace.

![Start Agent Forwarding](images/start-agent-forwarding.gif)

![Full SAFS interface](https://raw.githubusercontent.com/SupremeJulyan/vscode-serverless-agent-forwarding-for-remotes/main/images/safs-interface.png)

## When to use SAFS

- VS Code Server cannot or should not be installed on the server.
- You are working with an intranet, VPN, jump host, or environment where port forwarding is prohibited.
- You want an Agent to work on remote code without installing an Agent service on the server.
- You need to sync a remote directory locally so you can keep using Git, language servers, build tools, and debuggers.

## Quick start

### 1. Add an SSH configuration

1. Install and enable the SAFS extension.
2. Click the **SAFS** icon in the Activity Bar.
3. Click **+** in the upper-right corner of the Remote Folders view, or run `SAFS: Add SSH Config`.
4. Enter a configuration name, `user@host`, and port, then choose password or private-key authentication.
5. On the first connection, verify and accept the server's host-key fingerprint.

Configurations are stored in `~/.safs/config.json`. The UI is recommended for normal use. To edit the file manually, run `SAFS: Open Config`:

```json
{
  "encrypt_passwords": true,
  "hosts": [
    {
      "name": "dev",
      "ip": "10.0.0.2",
      "user": "alice",
      "port": 22,
      "private_key_path": "~/.ssh/id_ed25519"
    }
  ]
}
```

### 2. Open and edit a remote directory

Click **Open Remote Folder** beside a connection in the SAFS view, or run `SAFS: Open Remote Folder`. After you select a directory, SAFS opens it in a new window as a `safs://` virtual workspace.

You can then browse, open, save, create, rename, and delete files just as you would in a local project. SAFS remembers recently opened directories for every connection; expand a connection to reopen one from its history.

| Action | Command |
|---|---|
| Open a remote directory in a new window | `SAFS: Open Remote Folder` |
| Change the directory in the current window | `SAFS: Switch Remote Directory` |
| Open an SSH terminal | `SAFS: Open Remote Terminal` |
| View connection status | `SAFS: Show Status` |
| Disconnect | `SAFS: Disconnect` |

The remote terminal opens in the directory of the active file by default, or at the workspace root when there is no active file. Ctrl+click a file path in the terminal to open it directly; use Cmd+click on macOS.

The first time you open the configured remote home from a parent connection node, SAFS shows the two platform-specific shortcuts for opening a remote folder and terminal. It does not repeat this hint later.

### 3. Let an Agent operate the remote workspace

**MCP mode** is the default:

1. Click **Enable Agent Forwarding** beside a parent connection node in the SAFS view. You can also explicitly run `SAFS: Install Agent Forwarding for My Agent` to repair the integration.
2. Enter the Agent name when prompted. The extension copies an English installation prompt containing the local Streamable HTTP URL.
3. Paste the prompt into the Agent so it can install the Streamable HTTP `safs` MCP itself.
4. Open the remote directory for that connection.
5. Restart the Agent, start a new conversation, and confirm that a `safs` service is present through `/mcp` or its MCP management view.
6. Tell the Agent: `use safs mcp`. The Agent will ask you to choose which workspace to bind; when it is running inside VS Code, it can bind to the currently open remote workspace automatically.

On its first startup, the extension checks environment variables such as `ALL_PROXY`, `HTTPS_PROXY`, and `HTTP_PROXY`. If proxy environment variables are present and `NO_PROXY` does not fully cover loopback, SAFS warns that local Agent forwarding connections may be affected; this does not mean the proxy application is in global mode. You can set `NO_PROXY=localhost,127.0.0.1,::1` and restart the Agent to bypass the proxy for local forwarding requests.

You can also switch to **CLI mode**:
Set `safs.agentInterface` to choose between the two modes:

- `mcp` (default): every operation uses the MCP tool set selected by `safs.agentMcpToolProfile`. Switching to this mode uninstalls the global CLI and removes SAFS-managed Skills from the supported Agent user directories.
- `cli`: switching to this mode installs or updates the global `safs` CLI and user-level Skill, then copies an MCP removal prompt. Paste it into the Agent, unregister MCP, and restart the Agent. The Agent then runs `safs bind --agent "<Agent name>"` and uses CLI exclusively.

MCP and CLI modes are mutually exclusive. Running `SAFS: Install or Update Global CLI` from the Command Palette switches to CLI mode when necessary, installs or repairs the CLI and Skill, and copies the MCP removal prompt.

When the same host, mount, and remote root are republished, an existing binding automatically
resumes on the unique new instance. Selection is requested again only when the target is gone or
ambiguous.

In MCP mode, a successful bind returns the target workspace and `bindingId`. Switching first lists
candidates and waits for an explicit user choice; after a successful switch, the Agent stops the
current task and waits for a new user request.

In every mode, the SAFS backend validates write operations against the bound `workspaceRoot`, so
the boundary does not depend on the Agent interpreting a prompt. Use the corresponding structured
SAFS commands for remote reads, searches, creation, edits, moves, deletion, and transfers. Reserve
`safs exec` for task commands such as builds and tests, never for file operations. A boundary
rejection is marked non-retryable, explicitly prohibits falling back to `safs exec`, and is printed
directly by the CLI. For example, SAFS rejects creating a file under `/A` when the workspace is
rooted at `/A/B`.

Once enabled, the Agent can:

- list, read, search, create, and precisely edit remote files;
- move and delete files, change permissions, and upload or download files;
- run commands in the current remote directory and retrieve long output in chunks;
- identify the remote file currently open in VS Code;
- explicitly choose a target workspace when multiple SAFS windows are open.

#### View Agent activity

Open **Agent Activity** in the SAFS Activity Bar to see MCP and CLI operations that are
actually executed by the current remote window. The status animation shows running,
successful, and failed operations. The timeline keeps the newest operation first and can be
filtered by operation type and status. Consecutive reads, directory listings, and searches
are grouped automatically.

The panel shows only the active **Workspace Mode** or **Terminal Mode**.
Opening a remote directory uses Workspace Mode; opening an SAFS remote terminal without a remote
directory uses Terminal Mode. SAFS reads the terminal's actual directory and publishes it as the
Agent `workspaceRoot`. Commands inherit the terminal's current user privileges and exported
environment; the bound terminal and directory are shown below the status.

In Terminal Mode, MCP exposes only `run_remote_command`. Even if an Agent cached the earlier tool
list, calling another tool returns an actionable message directing it to the only available tool,
`run_remote_command`. The CLI is shared by every window, so `bind`/`workspaces`/`switch` remain
available for routing. Once bound to this window, the only remote-operation command is
`safs exec --binding <bindingId> -- 'COMMAND'`; other operations and batches return that command
as guidance, and `--cwd` cannot override the terminal directory. File, search, transfer,
workspace-switching, and retained-output tools are unavailable in this mode.

Terminal Mode lasts only for the current window session. Closing the terminal or opening a remote
directory restores Workspace Mode. Do not interact with a foreground program in the selected
terminal while forwarding is active.

The view keeps the latest 200 redacted records for this window. It never stores file
contents, diffs, stdout, or stderr; commands and errors are persisted only as short,
redacted summaries. Clearing the view does not delete the audit logs under
`~/.safs/mcp_logs`. Ordinary SSH terminals and native
VS Code Language Model Tools are outside this view's capture scope.

To stop forwarding, click **Disable Agent Forwarding**. If MCP was installed manually through a prompt or URL, run `SAFS: Uninstall Agent Forwarding for My Agent`.

#### CLI mode

CLI uses the native `safs` executable bundled with the extension. Binaries for all six platforms are installed with the extension, so no runtime download is required. Switching to CLI mode installs the executable and the user-level `~/.agents/skills/safs-cli`; `SAFS: Install or Update Global CLI` also switches modes and installs or repairs both. The executable's real version is checked and automatically replaced from the current extension package if it differs or is too old to report a version. When CLI mode is selected, or when Agent forwarding is enabled globally for the first time, the extension copies the MCP removal prompt. Paste it into the Agent, remove the user-level `safs` MCP registration, and restart the Agent. It can then load the Skill on demand and starts with `safs bind --agent "<Agent name>"`. Switching back to MCP mode, or running the forwarding uninstall command while in CLI mode, removes the global CLI and every SAFS-managed Skill under the `.agents`, `.claude`, `.codex`, and `.copilot` user directories. Use CLI mode when an Agent does not support MCP or when you want a CLI-only workflow. The native CLI no longer provides the stdio `mcp-bridge`; MCP mode connects directly to the Streamable HTTP URL in the copied prompt.

You can also install a project-level Skill directly, following the Playwright CLI pattern:

```sh
safs install --skills
```

The default target is `.agents/skills/safs-cli` in the current project; add `-g` for the user-level directory. Use `--skills=claude`, `--skills=codex`, or `--skills=copilot` for an Agent-specific directory. Skill content is embedded in the binary, so installation and updates do not require network access.

CLI installation is global and Agent-independent. The Agent name is recorded only when
`bind` creates a binding; later operations inherit it through `--binding`. The label is
used for the activity view, diagnostics, and binding isolation, not local router
authentication. Multiple Agents can therefore share one `safs` command.

Pass the `bindingId` returned by `safs bind` or `safs switch` explicitly through
`--binding`, ensuring every operation behind the fixed CLI endpoint still targets
the selected VS Code window. Structured JSON and write content can be read from
stdin to avoid quoting long values in the shell:

```sh
safs bind --agent 'Codex'
binding_id='binding-id-from-safs-bind'
safs read README.md --binding "$binding_id"
safs find --binding "$binding_id" --name '*.ts'
safs search --binding "$binding_id" --query TODO --mode files # content matches, not filenames
printf '%s' '{"edits":[{"oldText":"old","newText":"new"}]}' \
  | safs edit --binding "$binding_id" --path README.md --input -
printf '%s' 'new content' | safs write --binding "$binding_id" --path notes.txt --file -
safs write --binding "$binding_id" --path short.txt --content 'short text'
safs exec 'pwd' --binding "$binding_id"
safs switch --agent 'Codex' --workspace 'workspace-id-from-safs-workspaces' --confirmed
```

`search --mode files` returns paths of files whose contents match. To search by
filename, use `find --name`, `search --name`, or `search --mode names`. `--name`
accepts shell globs such as `*.ts`.

CLI syntax and argument errors include the relevant command Usage automatically,
so calling `safs <command> -h` first is unnecessary. Connection, permission, and
remote execution failures remain concise. `-h`/`--help` remains available for
proactive discovery.

## File transfer and local sync

Right-click a file or directory in the Explorer:

- **SAFS: Visual Download** downloads a remote file or directory locally, with recursive transfer, progress, and cancellation.
- **SAFS: Visual Upload** uploads a local file or directory to a selected connection without requiring an open remote workspace.
- **SAFS: Visual Sync** creates a local mirror of a remote directory and continuously performs incremental two-way local ↔ remote synchronization.

If a command-line tool or VS Code extension does not support `safs://`, use two-way sync. The synced workspace is a real local `file://` directory, so Git, language servers, build tools, and debuggers work normally. Local saves are uploaded automatically, and remote changes are pulled down.

The initial sync shows scanning and download progress and can be cancelled. A task resumes after a window reload, and file locking prevents multiple VS Code windows from processing the same task simultaneously.

## Common settings

Search for `SAFS` in VS Code Settings:

| Setting | Default | Purpose |
|---|---:|---|
| `safs.terminalFollowsActiveFile` | `false` | Automatically `cd` an open remote terminal when the active file changes |
| `safs.terminalAutoReconnect` | `true` | Reconnect a remote terminal after an unexpected exit |
| `safs.agentInterface` | `mcp` | Select mutually exclusive MCP or CLI; switching cleans up the other entry point |
| `safs.agentMcpToolProfile` | `full` | Change to `core` to reduce the Agent context used by tool definitions |
| `safs.agentMcpTimeoutMs` | `120000` | Timeout for Agent commands, searches, and transfers; `0` disables it |
| `safs.sftp.watchInterval` | `5` | Polling interval for remote file changes, in seconds |
| `safs.hostKeyChangedAction` | `prompt` | Prompt, reject, or accept when a host key changes |
| `safs.highRiskCommandAction` | `deny` | Reject or allow Agent commands that match high-risk rules |

See the SAFS page in VS Code Settings for additional advanced options.

## How it works

SAFS establishes SSH/SFTP connections inside the local VS Code extension process and maps a remote directory to a `safs://` virtual file system. Browsing and editing use SFTP, while terminals and Agent commands run over SSH. The server therefore needs neither VS Code Server nor an Agent.

With Agent Forwarding enabled, every remote window starts an MCP service accessible only from the local machine. Multiple windows share a stable local routing endpoint. On its first call, the Agent binds to a specific window and keeps that binding for later operations, preventing commands from being sent to the wrong server or workspace.

Structured writes are restricted to the current remote workspace. An SSH command matching a high-risk rule is denied by default and recorded in a redacted audit log. SSH commands are not a sandbox, however: an allowed command still has all permissions of the login account. Use a non-root, least-privilege account and disable passwordless privilege escalation.

## Limitations

- Local command-line tools and extensions that only support `file://` cannot access `safs://` directly; use two-way sync when needed.
- SFTP has no native file-change notification, so SAFS polls for remote changes.
- The SAFS MCP/CLI used for Agent Forwarding requires the local VS Code instance to remain running with forwarding enabled for the relevant mount.
- If the server has no SFTP subsystem, SAFS falls back to SCP/exec. Basic file operations remain available, but performance and compatibility may differ.
- MCP tools can constrain structured file operations, but they cannot intercept other local tools invoked directly by the Agent.

## SAFS vs. a passwordless SSH alias

Another common way to operate a remote host without an Agent service is to configure a host alias and key in `~/.ssh/config`, then let the Agent run `ssh dev 'command'` directly. Neither approach installs an Agent remotely, but they serve different priorities.

| Category | SAFS | Passwordless SSH alias |
|---|---|---|
| Setup | Add a connection and enable forwarding in one extension | Configure keys, `authorized_keys`, an alias, and teach the Agent how to use them |
| Browsing and editing | Remote file tree, editor integration, directory history, and active-file awareness | No file tree; relies on `ssh`, `scp`, `rsync`, or shell commands |
| Agent tools | Structured tools for reading, searching, precise edits, transfers, and commands | Mostly free-form shell: flexible, but more dependent on correct Agent parsing and edits |
| Workspace targeting | Binds to the current SAFS window and directory; explicit switching across windows | The alias identifies only a host; every command must maintain its own working directory |
| Write boundaries | Structured writes stay within the workspace, with separate high-risk command rules | Has all permissions of the SSH account by default, with no additional workspace boundary |
| Security controls | Host-key confirmation, local MCP token, high-risk command blocking, and redacted logs | Full OpenSSH capabilities; security depends on key, account, and server permission design |
| File transfer | Built-in visual upload, download, and two-way sync | Mature, portable `scp`/`rsync` workflows suit scripts and bulk transfers |
| Compatibility | Handles passwords, keys, some VPN/gateway cases, and servers without SFTP | Works wherever OpenSSH connects; special networks and interactive auth require custom setup |
| Dependencies | Requires VS Code and SAFS to stay running; the Agent needs MCP or SAFS CLI support | Requires only an SSH client and key, with fewer editor or Agent requirements |
| Best suited for | Interactive development with safer Agent access to the current project | Existing SSH operations, CI scripts, and tool-independent automation |

Recommendations:

- Choose **SAFS** when you need a file tree, editor integration, sync, and an Agent explicitly bound to the current workspace.
- A **passwordless SSH alias** is simpler when you already have a mature SSH key and permission setup and only need to run commands or existing scripts.
- They can be combined: use SAFS for daily editing and Agent file operations, and SSH/rsync for reviewed operations scripts or bulk transfers.

> “Passwordless” does not mean “unprotected.” Prefer a passphrase-protected private key with `ssh-agent`, create a dedicated least-privilege account for the Agent, and use `from=` or `command=` restrictions in `authorized_keys` where appropriate. Do not give the Agent root login or passwordless `sudo`.
