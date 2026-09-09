# SAFS

**S**erverless **A**I Coding **A**gent **F**orwarding for **S**SH

[简体中文](README.md) | [English](README_EN.md)

SAFS lets you browse and edit remote files in VS Code over SFTP and use a remote terminal over SSH, without installing VS Code Server on the server. After Agent Forwarding is enabled, agents such as Copilot, Codex, and Claude Code can also read and write files, search code, and run commands in the current remote workspace.

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

### 3. Let an Agent operate the remote workspace

MCP is the default mode:

1. Click **Enable Agent Forwarding** beside the connection in the SAFS view.
2. Open the remote directory for that connection.
3. Restart the Agent and start a new conversation. A restart is required after MCP is installed, updated, or removed.
4. Enter `/mcp` in the Agent, or open its MCP management view, and confirm that a `safs` service is present.
5. Tell the Agent: `Use the safs MCP to inspect the current remote project and run its tests.`

SAFS detects `codex`, `claude`, `pi`, and `dsh` by default. For another Agent, run `SAFS: Install Agent Forwarding for My Agent` and paste the generated prompt into the Agent. Alternatively, run `SAFS: Copy Streamable HTTP URL` and manually add a Streamable HTTP service named `safs` in the Agent's MCP management view.

> The MCP endpoint listens only on `127.0.0.1`. The Agent and the VS Code instance running SAFS must be in the same operating-system environment. If VS Code runs on Windows and the Agent runs in WSL, set `safs.agentPlatform` to `wsl`.

Once enabled, the Agent can:

- list, read, search, create, and precisely edit remote files;
- move and delete files, change permissions, and upload or download files;
- run commands in the current remote directory and retrieve long output in chunks;
- identify the remote file currently open in VS Code;
- explicitly choose a target workspace when multiple SAFS windows are open.

To stop forwarding, click **Disable Agent Forwarding**. If MCP was installed manually through a prompt or URL, run `SAFS: Uninstall Agent Forwarding for My Agent`.

#### CLI mode

Set `safs.agentInterface` to `cli` to download the native executable for the Agent's platform on demand from the project's GitHub `bin` directory and install the global `safs` command. Reload VS Code, restart the Agent, and enter `run safs bind` in the Agent. The default `mcp` mode is recommended for most users. To minimize token usage, switch to CLI manually; this mode does not install MCP tools.

Pass the `bindingId` returned by `safs bind` or `safs switch` explicitly through
`--binding`, ensuring every operation behind the fixed CLI endpoint still targets
the selected VS Code window. Structured JSON and write content can be read from
stdin to avoid quoting long values in the shell:

```sh
binding_id='binding-id-from-safs-bind'
safs read --binding "$binding_id" --path README.md
safs find --binding "$binding_id" --name '*.ts'
safs search --binding "$binding_id" --query TODO --mode files # content matches, not filenames
printf '%s' '{"edits":[{"oldText":"old","newText":"new"}]}' \
  | safs edit --binding "$binding_id" --path README.md --input -
printf '%s' 'new content' | safs write --binding "$binding_id" --path notes.txt --file -
safs write --binding "$binding_id" --path short.txt --content 'short text'
safs exec --binding "$binding_id" --command 'pwd'
safs switch --workspace 'workspace-id-from-safs-workspaces' --confirmed
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
| `safs.agentPlatform` | `auto` | Change to `wsl` when the Agent runs in WSL |
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
