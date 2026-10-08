# SAFS

**S**erverless **A**I Coding Agent **F**orwarding for **S**SH

[简体中文](README.md) | [English](README_EN.md)

SAFS lets you browse and edit remote files in VS Code over SFTP and use a remote terminal over SSH, without installing VS Code Server on the server. After Agent Forwarding is enabled, AI Coding Agents such as Copilot, Codex, and Claude Code can also read and write files, search code, and run commands in the current remote workspace.

## When to use SAFS

- VS Code Server cannot or should not be installed on the server.
- You are working with an intranet, VPN, jump host, or environment where port forwarding is prohibited.
- You want an Agent to work on remote code without installing an Agent on the server.
- You need to sync a remote directory locally so you can keep using Git, language servers, build tools, and debuggers.

## Quick start

### 1. Add an SSH configuration

1. Install and enable the SAFS extension.
2. Click the **SAFS** icon in the Activity Bar.
3. Click **+** in the upper-right corner of the Remote Folders view and enter a host name (such as `dev`) and IP address.
4. Click **+** beside the host name and enter the account and password. Passwords are saved using the configuration encryption master password when needed; private-key authentication is also supported.
5. On the first connection, verify and accept the server's host-key fingerprint.

### 2. Open and edit a remote directory

Click **Open Remote Folder** beside a connection in the SAFS view, or run `SAFS: Open Remote Folder`. After you select a directory, SAFS opens it in a new window as a `safs://` virtual workspace.

You can then browse, open, save, create, rename, and delete files just as you would in a local project. SAFS remembers recently opened directories for each connection under its host name; expand the connection to reopen one from its history.

The remote terminal opens in the directory of the active file by default, or at the workspace root when there is no active file. Ctrl+click a file path in the terminal to open it directly; use Cmd+click on macOS.

The first time you open the configured remote home from a parent connection node, SAFS shows the two platform-specific shortcuts for opening a remote folder and terminal. It does not repeat this hint later.

### 3. Let an Agent operate the remote workspace

**CLI mode** is the default. Install **Node.js 18 or later** locally and make sure `node --version` works in your terminal. The extension installs or updates the global `safs` CLI and user-level Skill from its bundled Node.js script. No separate platform binary download or Rust installation is required. Run `safs --version` to verify installation, or run `SAFS: Install or Update Global CLI` to repair it.

Restart VS Code to refresh environment variables, then enter `/safs-cli` in your Agent to use the Skill. The Agent lists the remote workspaces; select one to start working.

For **MCP mode**, first set `safs.agentInterface` to `mcp`:

1. Click **Enable Agent Forwarding** beside a parent connection node in the SAFS view. You can also run `SAFS: Install Agent Forwarding for My Agent` to repair the integration.
2. Enter the Agent name when prompted. The extension copies an English installation prompt containing the local Streamable HTTP URL.
3. Paste the prompt into the Agent so it can install the Streamable HTTP `safs` MCP itself.
4. Open the remote directory for that connection.
5. Restart the Agent, start a new conversation, and confirm that a `safs` service is present through `/mcp` or its MCP management view.
6. Enter `use safs mcp` in the Agent. It lists the workspaces and asks you to choose a target explicitly.

On its first startup, the extension checks environment variables such as `ALL_PROXY`, `HTTPS_PROXY`, and `HTTP_PROXY`. If proxy environment variables are present and `NO_PROXY` does not fully cover loopback, SAFS warns that local Agent forwarding connections may be affected; this does not mean the proxy application is in global mode. You can set `NO_PROXY=localhost,127.0.0.1,::1` and restart the Agent to bypass the proxy for local forwarding requests.

Once enabled, the Agent can operate within the current remote workspace:

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
Use **Switch Workspace** to select and open a remote directory in the current window; cancelling
the picker leaves the current mode unchanged.

To stop forwarding, click **Disable Agent Forwarding**. If MCP was installed manually through a prompt or URL, run `SAFS: Uninstall Agent Forwarding for My Agent`.

## File transfer and local sync

Right-click a file or directory in the Explorer:

- **SAFS: Visual Download** downloads a remote file or directory locally, with recursive transfer, progress, and cancellation.
- **SAFS: Visual Upload** uploads a local file or directory to a selected connection without requiring an open remote workspace.
- **SAFS: Sync to Local** (on a remote directory) is "visual download, then two-way sync": pick the local parent folder, download the whole tree into `<chosen folder>/<remote directory name>` as the initial baseline, and keep syncing incrementally in both directions. The synced directory is recorded in the SAFS view's history list, where the inline button starts the sync when idle and stops it while syncing.
- **SAFS: Visual Sync** (on a local folder) is "visual upload, then two-way sync": pick the remote mount and directory, upload the whole local folder into `<chosen directory>/<local directory name>`, and start two-way sync from the freshly uploaded remote state (nothing is downloaded back a second time, but remote-only content is still pulled down). After synchronization succeeds, the local directory opens automatically in a new window. The remote directory is also added to history with its sync button showing that synchronization is enabled; you can stop it at any time.

### Resuming large transfers

When an upload or download of a large file (1 MiB or more) is interrupted, transferring the same file again **continues from where it stopped** instead of starting over. The progress notification shows the bytes already present and marks the transfer as resumed.

- No `rsync` and nothing installed on the remote host: SFTP read and write packets carry a byte offset, and SAFS uses it for positioned I/O. Only the `scp` fallback channel (used when a gateway has no SFTP subsystem) has to restart from zero.
- Interrupted transfers keep their partial file next to the target (remote `.<name>.safs-part-<hash>` for uploads, local `<name>.safs-part-<hash>` for downloads) and rename it into place on success.
- **A changed source is never resumed**: the partial's name encodes the source file's size and mtime. If the remote (or local) file changed between attempts the name no longer matches and the transfer restarts — two versions are never concatenated into a file that merely looks fine.
- Partials below 1 MiB are not kept, and partials older than 7 days are cleaned up during the next transfer.

## Remote Git source control

Open a remote **Git repository root** with SAFS to see `Git (SAFS)` in VS Code Source Control. Status, diffs, staging, and commits run on the SSH host using its Git configuration and commit identity. Push and pull relay through local Git using local networking and credentials. Workspace synchronization and Agent forwarding are not required.

## Common settings

Search for `SAFS` in VS Code Settings:

| Setting | Default | Purpose |
|---|---:|---|
| `safs.terminalFollowsActiveFile` | `false` | Automatically `cd` an open remote terminal when the active file changes |
| `safs.terminalAutoReconnect` | `true` | Reconnect a remote terminal after an unexpected exit, with bounded backoff retries for transient network errors |
| `safs.agentInterface` | `cli` | Select mutually exclusive MCP or CLI; switching cleans up the other entry point |
| `safs.agentMcpToolProfile` | `full` | Change to `core` to reduce the Agent context used by tool definitions |
| `safs.agentMcpTimeoutMs` | `120000` | Timeout for Agent commands, searches, and transfers; `0` disables it |
| `safs.sftp.watchInterval` | `5` | Polling interval for remote file changes, in seconds |
| `safs.hostKeyChangedAction` | `prompt` | Prompt, reject, or accept when a host key changes |
| `safs.highRiskCommandAction` | `deny` | Reject or allow Agent commands that match high-risk rules |

See the SAFS page in VS Code Settings for additional advanced options.

## How it works

SAFS establishes SSH/SFTP connections inside the local VS Code extension process and maps a remote directory to a `safs://` virtual file system. Browsing and editing use SFTP, while terminals and Agent commands run over SSH. The server therefore needs neither VS Code Server nor an Agent.

With Agent Forwarding enabled, every remote window starts an MCP service accessible only from the local machine. Multiple windows share a stable local routing endpoint. Each routed operation carries an explicit `workspaceId`, so the router can select the exact window and never fall back to focus or a matching remote path.

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
