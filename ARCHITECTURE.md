# 源码架构

源码按功能直接放在 `src/` 下，不增加 `modules/` 中间层。构建入口保留为
`src/extension.ts` 和 `src/safs-cli.ts`，输出仍为 `dist/extension.js` 和
`dist/safs-cli.js`。

```text
src/
├── extension.ts   VS Code 扩展入口与功能装配
├── safs-cli.ts    独立 CLI 入口与参数处理
├── agent/        Agent 发现、IPC、CLI、活动记录与工作区标识
├── cli/          CLI 帮助、安装、连接配置与 Skill 集成
├── config/       主机配置、账号、别名与校验
├── git/          远程 Git、SCM、历史记录与本地中转推拉
├── platform/     平台检测、进程执行、代理诊断与 WSL 文件支持
├── remote/       远程读写、批量读取、搜索、结果分页与目录操作
├── security/     主机密钥、密码加密、命令策略与日志脱敏
├── shared/       批处理、队列、性能记录与 shell 引号工具
├── ssh2/         SSH 连接共享、终端、SFTP、SCP 与文件系统提供器
├── sync/         双向同步、差异扫描、回声抑制与跨窗口协调
├── terminal/     终端输出协议、Shell Integration、路径链接与重连判断
├── transfer/     上传下载、流处理、权限与断点续传
└── ui/           快捷键提示与界面操作控制
```

## 常用入口

| 功能 | 主要文件 |
| --- | --- |
| 扩展激活、命令注册、工作区装配 | [extension.ts](src/extension.ts) |
| CLI 参数与请求发送 | [safs-cli.ts](src/safs-cli.ts) |
| 连接配置模型与保存 | [config/config.ts](src/config/config.ts) |
| SSH2 命令与终端 | [ssh2/ssh2.ts](src/ssh2/ssh2.ts)、[ssh2/terminal.ts](src/ssh2/terminal.ts) |
| 终端与文件浏览器 SSH 连接复用 | [ssh2/shared-connection.ts](src/ssh2/shared-connection.ts) |
| SSH sudo 交互 | [ssh2/sudo.ts](src/ssh2/sudo.ts) |
| SFTP 文件操作 | [ssh2/sftp-client.ts](src/ssh2/sftp-client.ts) |
| 资源管理器文件系统 | [ssh2/filesystem-provider.ts](src/ssh2/filesystem-provider.ts) |
| Agent 请求转发与窗口后端 | [agent/agent-http-router.ts](src/agent/agent-http-router.ts)、[agent/agent-backend.ts](src/agent/agent-backend.ts) |
| Git 界面与命令 | [git/remote-git-scm.ts](src/git/remote-git-scm.ts)、[git/remote-git.ts](src/git/remote-git.ts) |
| 同步协调 | [sync/remote-sync.ts](src/sync/remote-sync.ts)、[sync/sync-coordination.ts](src/sync/sync-coordination.ts) |
| 上传下载与续传 | [transfer/remote-upload.ts](src/transfer/remote-upload.ts)、[transfer/remote-download.ts](src/transfer/remote-download.ts) |

终端与远程文件系统按主机、端口、用户和凭据共享底层 `ssh2` 连接，各自打开 shell 或 SFTP 通道。任一方关闭时只释放自己的 lease；最后一个使用方退出后才关闭 TCP/SSH 连接。独立打开远程目录时仍可由 SFTP 连接池单独建连。

## 组织约定

- 功能代码放入所属目录；`shared/` 仅放不依赖具体业务的通用工具。
- `ssh/` 管理原生连接与通道，`sftp/` 提供文件操作适配，`terminal/` 放终端协议与路径处理。
- `sync/` 负责同步策略，`transfer/` 负责文件传输和续传，`remote/` 放远程数据处理。
- 模块之间使用明确的文件导入，不批量导出整个目录，避免独立 CLI 意外加载 VS Code 或原生 SSH 依赖。
- 测试保留在 `test/`，构建和验证脚本保留在 `build/`，运行时资源保留在 `resources/`。

这次调整的是文件归属和引用路径，各目录尚不是独立发布的包，也未通过工具强制限制模块依赖。
`extension.ts` 仍承担较多状态管理和功能装配；后续拆分它时，应将逻辑移入对应功能目录，逐步明确接口。

## 验证

```bash
npm run check-types
npm run package
npm test
```

`build/sync-high-risk-defaults.ts` 从 `security/` 读取默认命令策略，
`build/backend-efficiency.ts` 从 `agent/` 和 `remote/` 读取其基准测试入口。
