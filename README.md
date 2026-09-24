# SAFS

**S**erverless **A**I Coding Agent **F**orwarding for **S**SH

[简体中文](README.md) | [English](README_EN.md)

SAFS 让你在 VS Code 中通过 SFTP 浏览、编辑远程文件，并通过 SSH 使用远程终端；服务器无需安装 VS Code Server。启用 Agent 转发后，Copilot、Codex、Claude Code 等 AI Coding Agent 也能在当前远程工作区读写文件、搜索代码和执行命令。

![启动 Agent 转发](images/start-agent-forwarding.gif)

![SAFS 完整界面](https://raw.githubusercontent.com/SupremeJulyan/vscode-serverless-agent-forwarding-for-remotes/main/images/safs-interface.png)

远程挂载的浏览范围为 `/`，默认打开 SSH 登录家目录。打开／切换目录支持家目录之外的绝对路径（如 `/data/project`），实际访问权限由远程账号决定。Agent 的写入和命令范围以当前打开的工作区为准。

## 适用场景

- 服务器不能或不方便安装 VS Code Server。
- 内网、VPN、跳板机或禁止端口转发的环境。
- 希望 Agent 操作远程代码，但不想在服务器安装 Agent 服务。
- 需要将远程目录同步到本地，继续使用 Git、语言服务器、构建和调试工具。

## 快速开始

### 1. 添加 SSH 配置

1. 安装并启用 SAFS 扩展。
2. 点击左侧活动栏的 **SAFS** 图标。
3. 点击远程目录视图右上角的 **＋**，填写主机名和 IP 地址。
4. 在远程目录视图的 **...** 菜单中切换新/旧视图；新视图按“主机/IP → 账号 → 历史目录”展示，相同 IP 会合并到同一节点。
5. 在主机名旁点击 **＋**，填写账号和密码；密码会在需要时使用配置加密主口令保存，也可以选择私钥认证。配置名会自动生成为 `IP(账号)`（例如 `10.68.0.1(zhuyuan)`），主机别名只作为节点显示名。
6. 首次连接时核对并确认服务器主机密钥指纹。

主机节点（相同 IP 合并的那一项）上的 **🗑** 会删除整组账号配置（同一 IP 下的所有账号及其挂载），账号节点上的 **🗑** 只删该账号；任一节点右键选择 **打开配置**，会打开 `~/.safs/config.json` 并把光标定位到这条记录（视图标题栏的 **打开配置** 按当前选中项定位）。

配置保存在 `~/.safs/config.json`。一般使用界面添加即可；需要手动维护时，可运行 `SAFS: 打开配置`：

```json
{
  "encrypt_passwords": true,
  "hosts": [
    {
      "name": "10.0.0.2(alice)",
      "ip": "10.0.0.2",
      "user": "alice",
      "port": 22,
      "private_key_path": "~/.ssh/id_ed25519"
    }
  ]
}
```

旧版本生成的 `账号_主机名`（以及更早的 `主机@账号`）配置名会在启动时自动迁移成 `IP(账号)`，挂载、历史目录、转发开关、同步任务与同步配对会一起改名；已打开的 `safs://` 远程窗口用的是旧名字，迁移后需要从 SAFS 面板重新打开一次。

### 2. 打开并编辑远程目录

在 SAFS 视图中点击连接项旁的 **打开远程目录**，或运行 `SAFS: 打开远程目录`。选择目录后，SAFS 会在新窗口中打开 `safs://` 虚拟工作区。

之后可以像编辑本地项目一样浏览、打开、保存、新建、重命名和删除文件。SAFS 会记住每个连接最近打开的目录；展开连接项即可从历史记录重新打开。

| 操作 | 方式 |
|---|---|
| 在新窗口打开远程目录 | `SAFS: 打开远程目录` |
| 在当前窗口更换目录 | `SAFS: 切换远程目录` |
| 打开 SSH 终端 | `SAFS: 打开远程终端` |
| 查看连接状态 | `SAFS: 显示状态` |
| 断开连接 | `SAFS: 断开 SFTP 连接` |

远程终端默认在当前文件所在目录打开；没有活动文件时使用工作区根目录。终端中的文件路径支持 `Ctrl+点击`（macOS 为 `Cmd+点击`）直接打开。

首次从连接父节点打开配置的远程家目录时，SAFS 会提示当前平台用于“打开远程目录 / 终端”的两个快捷键，之后不再重复显示。

### 3. 让 Agent 操作远程工作区

默认使用 **MCP 模式**：

1. 在 SAFS 视图中点击连接父节点旁的 **启用 Agent 转发**。也可以主动运行 `SAFS: 为我的Agent安装转发功能` 进行修复。
2. 按提示输入 Agent 名称，扩展会复制一段包含本机 Streamable HTTP URL 的英文安装提示词。
3. 将提示词粘贴给 Agent，由 Agent 自行安装 Streamable HTTP 类型的 `safs` MCP。
4. 打开该连接的远程目录。
5. 重启 Agent 并新建对话，然后通过 `/mcp` 或 MCP 管理界面确认存在 `safs` 服务。
6. 告诉 Agent：`use safs mcp`，Agent 会列出工作区并让你明确选择目标；后续操作都使用返回的 `workspaceId`。

插件首次启动时会检查 `ALL_PROXY`、`HTTPS_PROXY` 和 `HTTP_PROXY` 等环境变量。检测到代理环境变量且 `NO_PROXY` 未完整覆盖本机回环地址时，会提示可能影响 Agent 本机转发连接；这不代表代理软件开启了全局模式。可设置 `NO_PROXY=localhost,127.0.0.1,::1`，然后重启 Agent，让本机转发请求绕过代理。

也可切换 **CLI 模式**:
设置 `safs.agentInterface` 支持两种模式：

- `mcp`（默认）：所有操作使用 MCP，加载 `safs.agentMcpToolProfile` 选择的完整或核心工具集；切换到该模式会卸载全局 CLI，并清理 SAFS 安装到各 Agent 用户目录中的 Skill。
- `cli`：切换到该模式时安装或更新全局 `safs` CLI 与用户级 Skill，同时复制 MCP 卸载提示词；将提示词粘贴给 Agent、完成注销并重启 Agent 后，运行 `safs workspaces` 获取 `workspaceId`，此后每个 CLI 命令显式传入目标工作区。

MCP 与 CLI 模式互斥。通过命令面板运行 `SAFS: 安装或更新全局 CLI` 会在需要时先切换到 CLI 模式，然后安装或修复 CLI 和 Skill，并复制 MCP 卸载提示词。

每个 `workspaceId` 精确对应一个 VS Code 窗口中的远程工作区。即使另一窗口打开相同挂载
和目录，两个工作区 ID 也不同；窗口或远程目录变化后旧 ID 会失效，SAFS 不会回退到当前
焦点窗口。多个候选时必须明确选择目标 ID。

无论使用哪种模式，SAFS 后端都会按 `workspaceId` 对应记录中的 `workspaceRoot` 校验写操作，无需依赖
Agent 根据提示词自行判断边界。远程文件的读取、搜索、创建、修改、移动、删除和传输应
使用对应的 SAFS 结构化命令；`safs exec` 仅用于构建、测试等任务命令，不应用来执行
文件操作。边界拒绝会标记为不可重试，并明确禁止改用 `safs exec` 绕过；CLI 会直接显示
拒绝原因。例如工作区为 `/A/B` 时，SAFS 会拒绝在 `/A` 创建文件。

启用后，Agent 可以：

- 列出、读取、搜索、创建和精确修改远程文件；
- 移动、删除、修改权限以及上传或下载文件；
- 在当前远程目录执行命令并分段读取长输出；
- 获取 VS Code 当前打开的远程文件；
- 在多个 SAFS 窗口之间明确选择目标工作区。

#### 查看 Agent 活动

打开 SAFS 活动栏中的 **Agent 活动**，可以实时查看当前远程窗口实际执行的 MCP/CLI
操作。顶部动画显示执行中、成功或失败状态，下方时间线按最新操作优先排列，并可按
操作类型和状态筛选。连续的读取、列目录和搜索会自动折叠。

面板顶部只显示当前生效的 **工作区模式** 或 **终端模式**。
打开远程目录时使用工作区模式；没有打开远程目录、只打开 SAFS 远程终端时使用终端模式。
点击 **切换工作区** 可在当前窗口选择并打开远程目录；取消选择时保留当前模式。
SAFS 会读取终端实际目录并把它作为 Agent 的 `workspaceRoot`；命令继承该终端当前的用户
权限和环境变量，下方会显示绑定的终端及目录。

共享 MCP 地址始终提供相同的工具列表。Agent 调用 `list_remote_workspaces` 后，每项结果中的
`workspaceId` 和 `workspace.mode` 会明确标出目标窗口是 `workspace` 还是 `terminal`。选中终端模式工作区时，
只有 `run_remote_command` 可以执行远程操作；文件、搜索、传输及长输出续读会被拒绝。
其他窗口的工作区不受影响。CLI 使用 `workspaces` 列出目标 ID；终端工作区
只允许 `safs exec --workspace <workspaceId> -- 'COMMAND'` 执行远程操作，且不能用 `--cwd` 覆盖
终端目录。每个命令都必须显式传入 `--workspace <workspaceId>`。

终端模式只在当前窗口会话内有效；终端关闭或在当前窗口切换远程目录后会退出。
若在新窗口打开远程目录，原窗口仍保持终端模式。转发期间不要在该终端中同时操作前台程序。

活动视图仅保留当前窗口最近 200 条脱敏记录；文件正文、Diff、命令输出不会写入记录，
命令和错误只保存经过脱敏的短摘要。“清空”不会删除
`~/.safs/mcp_logs` 中的审计日志。普通 SSH 终端和 VS Code 原生 Language Model Tools
不属于该视图的采集范围。

关闭时点击 **关闭 Agent 转发**。如果 MCP 是通过提示词或 URL 手动安装的，请运行 `SAFS: 为我的Agent卸载转发功能`。

#### CLI 模式

CLI 使用插件包内置的原生 `safs` 程序，六个平台的二进制均随插件安装，不再运行时联网下载。切换到 CLI 模式会安装当前扩展环境对应的程序与用户级 `~/.agents/skills/safs-cli`；运行 `SAFS: 安装或更新全局 CLI` 也会切换到该模式并主动安装或修复。扩展会读取 CLI 的真实版本；与当前插件版本不一致或旧版不支持版本查询时，会直接从当前插件包自动更新。进入 CLI 模式或在全局首次开启 Agent 转发时，扩展会复制 MCP 卸载提示词；请粘贴给 Agent，注销用户级 `safs` MCP 后重启 Agent。之后在Agent 里`输入使用safs-cli`，或者`/safs-cli` 即可使用这Skill。


`safs workspaces` 返回的 `workspaceId` 通过 `--workspace` 显式传给每个命令，
确保固定 CLI 入口后的每次操作仍指向用户选定的 VS Code 窗口。结构化 JSON 和写入内容
支持从 stdin 读取，避免长内容的 Shell 转义：

```sh
safs workspaces
workspace_id='workspace-id-from-safs-workspaces'
safs read README.md --workspace "$workspace_id"
safs find --workspace "$workspace_id" --name '*.ts'
safs search --workspace "$workspace_id" --query TODO --mode files # 内容匹配文件，不是文件名
printf '%s' '{"edits":[{"oldText":"old","newText":"new"}]}' \
  | safs edit --workspace "$workspace_id" --path README.md --input -
printf '%s' 'new content' | safs write --workspace "$workspace_id" --path notes.txt --file -
safs write --workspace "$workspace_id" --path short.txt --content 'short text'
safs create --workspace "$workspace_id" --path src/new-dir directory
safs create --workspace "$workspace_id" --path src/new.txt file --content 'initial text'
safs exec 'pwd' --workspace "$workspace_id"
```

`search --mode files` 返回“内容匹配的文件路径”；按文件名查找请使用 `find --name`、
`search --name` 或 `search --mode names`。`--name` 使用 Shell glob，例如 `*.ts`。

CLI 语法或参数错误会直接附带当前子命令的正确 Usage，不需要预先调用 `safs <命令> -h`；
连接、权限和远程执行等运行期错误保持简短。`-h`/`--help` 仍可用于主动查询。

## 文件传输与本地同步

在资源管理器中右键文件或目录：

- **SAFS：可视化下载**：将远程文件或目录下载到本地，支持递归、进度显示和取消。
- **SAFS：可视化上传**：将本地文件或目录上传到选定连接，无需先打开远程工作区。
- **SAFS：同步到本地**（远程目录右键）：等价于"先可视化下载，再开启双向同步"。选本地父目录，先整棵下载到 `<所选目录>/<远程目录名>` 作为首次基线，随后持续进行本地 ↔ 远程双向增量同步；同步完成的目录会写进 SAFS 视图的历史列表，条目上的按钮未同步时是「启动同步」，同步中是「关闭本地同步」。
- **SAFS：同步到远程**（本地文件夹右键）：等价于"先可视化上传，再开启双向同步"。选远程挂载与远程目录，本地目录整棵上传到 `<所选目录>/<本地目录名>`，再以刚上传的远程状态为基线开启双向同步（不会把刚上传的内容重复下载回来，远程独有的内容仍会补齐到本地）；该远程目录同样进入历史列表。

**同一个目录同步一次就够**：历史条目会记住本地副本的位置，点击条目直接打开本地副本。再次对同一目录执行同步会弹窗提示（该目录已在历史列表中，同步过一次了），可以选择打开本地副本、重新同步，正在同步时还可以直接停止同步。删除历史条目会同时忘掉这组配对，之后再执行就是全新一次同步。

如果命令行工具或 VS Code 扩展不支持 `safs://`，请选择双向同步。同步后的工作区是真实的本地 `file://` 目录，可正常使用 Git、语言服务器、构建和调试工具；本地保存会自动上传，远程变化也会自动拉取。

首次同步会显示扫描与下载进度，并可取消。任务会在窗口重载后恢复，也会用文件锁避免多个 VS Code 窗口同时处理同一任务。

## 常用设置

在 VS Code 设置中搜索 `SAFS`：

| 设置 | 默认值 | 用途 |
|---|---:|---|
| `safs.terminalFollowsActiveFile` | `false` | 切换文件时，让已打开的远程终端自动 `cd` 到对应目录 |
| `safs.terminalAutoReconnect` | `true` | 远程终端意外结束后自动重连；瞬时网络错误会有限退避重试 |
| `safs.agentInterface` | `mcp` | 选择互斥的 MCP 或 CLI 接口；切换时清理另一入口 |
| `safs.agentMcpToolProfile` | `full` | 改为 `core` 可减少 Agent 工具定义的上下文开销 |
| `safs.agentMcpTimeoutMs` | `120000` | Agent 命令、搜索和传输的超时；`0` 表示关闭 |
| `safs.sftp.watchInterval` | `5` | 轮询远程文件变化的间隔（秒） |
| `safs.hostKeyChangedAction` | `prompt` | 主机密钥变化时询问、拒绝或接受 |
| `safs.highRiskCommandAction` | `deny` | Agent 命中高风险命令规则时拒绝或放行 |

更多高级选项及说明可直接查看 VS Code 的 SAFS 设置页。

## 工作原理

SAFS 在本地 VS Code 扩展进程中建立 SSH/SFTP 连接，将远程目录映射为 `safs://` 虚拟文件系统。文件浏览与编辑通过 SFTP 完成，终端和 Agent 命令通过 SSH 执行，因此服务器无需安装 VS Code Server 或 Agent。

启用 Agent 转发后，每个远程窗口都会启动仅本机可访问的 MCP 服务。多个窗口共用固定的本地路由入口；每次路由操作都显式携带 `workspaceId`，精确指向目标窗口，避免将命令发到错误的服务器或工作区。

结构化写入被限制在当前远程工作区。Agent 发起的 SSH 命令若命中高风险规则，默认会被拒绝并记录脱敏审计日志。但 SSH 命令不是沙箱：获准执行后仍拥有登录账号的权限，建议使用非 root、最小权限账号并禁用免密提权。

## 限制

- 本地命令行和只支持 `file://` 的扩展不能直接访问 `safs://`；需要时请使用双向同步。
- SFTP 没有原生文件变更通知，SAFS 通过轮询检测远程修改。
- 支持Agent转发的 safs MCP/CLI 依赖本地 VS Code 持续运行，并保持对应挂载的转发已启用。
- 服务器没有 SFTP 子系统时会回退到 SCP/exec；基础文件操作仍可用，但性能和兼容性可能不同。
- MCP 工具能限制结构化文件操作，但无法拦截 Agent 自己调用的其他本地工具。

## SAFS 与免密 SSH alias 对比

另一种常见的无Agent服务操作远程主机的方式是在 `~/.ssh/config` 中配置主机别名和密钥，让 Agent 直接执行 `ssh dev '命令'`。两者都不需要在远程安装 Agent，但侧重点不同。

| 对比项 | SAFS | 免密 SSH alias |
|---|---|---|
| 上手成本 | 在扩展内添加连接并启用转发，步骤集中 | 需自行配置密钥、`authorized_keys`、alias，并告诉 Agent 正确用法 |
| 浏览与编辑 | 有远程文件树、编辑器集成、历史目录和当前文件感知 | 没有文件树；依赖 `ssh`、`scp`、`rsync` 或 Shell 命令 |
| Agent 工具 | 读取、搜索、精确编辑、传输和命令均为结构化工具 | 主要是自由形式 Shell，灵活但更依赖 Agent 正确解析与修改 |
| 工作区定位 | 绑定当前 SAFS 窗口和目录，多窗口可明确切换 | alias 只定位主机，工作目录需在命令中自行维护 |
| 写入边界 | 结构化写工具限制在当前工作区，另有高风险命令规则 | 默认拥有 SSH 账号的全部权限，没有额外工作区边界 |
| 安全控制 | 主机密钥确认、本地 MCP Token、高危命令拦截与脱敏日志 | 可充分利用 OpenSSH；安全性取决于密钥、账号和服务器权限 |
| 文件传输 | 内置可视化上传、下载和双向同步 | `scp`/`rsync` 成熟通用，适合脚本化和批量传输 |
| 兼容性 | 对密码、私钥、部分 VPN/网关和无 SFTP 环境做了兼容 | OpenSSH 能连接即可；特殊网络和交互认证需自行编排 |
| 依赖 | 必须运行 VS Code 与 SAFS；Agent 需支持 MCP 或 SAFS CLI | 只依赖 SSH 客户端和密钥，对编辑器与 Agent 要求较少 |
| 更适合 | 交互式开发，让 Agent 安全操作当前项目 | 已有 SSH 运维体系、CI 脚本和跨工具自动化 |

选择建议：

- 需要文件树、编辑器、同步，并希望 Agent 明确绑定当前工作区：选择 **SAFS**。
- 已有成熟的 SSH 密钥和权限体系，只需执行命令或现有脚本：**SSH alias** 更简单。
- 两者可以并用：日常编辑与 Agent 文件操作走 SAFS，已审查的运维脚本或批量传输走 SSH/rsync。

> “免密”不等于“无保护”。建议使用带口令的私钥配合 `ssh-agent`，为 Agent 单独创建最小权限账号，并按需用 `from=`、`command=` 等 `authorized_keys` 限制；不要向 Agent 开放 root 登录或免密 `sudo`。
