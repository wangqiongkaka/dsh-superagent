# 飞书群、多仓库与 GitLab

## 配置

1. 启用随 bundle 提供的 `dsh-superagent/git-watch`，在来源的“Git 仓库（多仓库）”添加仓库。
2. 每个仓库填写稳定标识、平台、HTTPS 项目地址，以及已登录的 `gh` 或 `glab` 命令名/绝对路径。地址可带 `.git`；不填写令牌、密码或克隆命令。
3. 飞书“接收的群”每行填写该群可用的仓库标识，多个用逗号分隔。私聊使用单独的“私聊可用仓库”。
4. 名单与准入仍决定谁能发起工作。多仓库来源的账号使用 `主机名/用户名`，例如 `gitlab.example.com/wangqiong`，避免实例间同名账号混淆。

示例：

| 标识 | 平台 | 项目地址 | CLI |
| --- | --- | --- | --- |
| idcrm | GitHub | `https://github.com/wangqiongkaka/idcrm` | `/opt/homebrew/bin/gh` |
| backend | GitLab | `https://gitlab.example.com/team/backend` | `/opt/homebrew/bin/glab` |

IDCRM 群填写 `idcrm,backend`；另一群可以仅填写 `backend`。未绑定群（包括“其他群”）和未绑定私聊只能提示配置，不能创建执行任务。没有全局 GitHub 回退。

同一个 GitHub 项目不能同时启用旧 GitHub 来源和多仓库来源，以免产生重复工单。迁移时先关闭旧来源，再添加新来源；旧工单及历史不改写，旧工单的 PR 跟踪需要保留旧来源时，应待旧工单结束再迁移。

## GitLab 账号

使用支持 `auth git-credential` 的 `glab`，为智能体单独登录自建实例，例如 `glab auth login --hostname gitlab.example.com`。需要 API 与 Git 读写权限，以及项目 Developer 或更高权限；受保护分支仍遵从实例规则。已有默认分支的 HTTPS 项目可用，支持多级 group/subgroup 路径；不关闭 TLS 校验。

不同账号可使用不同 CLI 包装脚本隔离配置。令牌由 CLI 自己保存；设置、工单和环境清单不保存令牌。Git 的项目 URL 级凭据助手调用对应 CLI。它是同一操作系统用户下的默认凭据隔离，不是沙箱；勿给智能体所在 OS 用户不必要的凭据。

## 工作与监听

- 单一绑定可自动选中；多个仓库由智能体按请求选择一个或多个，不明确时向发起人澄清。
- 工单保存选定仓库快照，各仓库克隆到 `<工单目录>/<仓库标识>`；使用 `DSH_SUPERAGENT_REPOSITORIES` 的 JSON 清单获取目录、CLI、身份和默认分支。
- 多仓库目录自动检出后才运行已有 `executor.prepare` 命令。多仓库模式的 prepare 应做安装或初始化，不应再次克隆到工单根目录；旧单仓库克隆脚本需要调整。
- GitHub 使用 `gh` 创建 PR；GitLab 使用对应 `glab` 创建 MR。分支最后一段使用 `DSH_SUPERAGENT_NAME`。通过 `orchestrator_report.pull_requests` 上报所有 `{repository_id, number}`。
- Issue、PR/MR、评论和默认分支 CI 按来源开关与准入处理。首次启用从当前时间开始，不派发旧历史；已绑定线程继续跟踪。仓库独立游标，单仓库失败不阻止其他仓库。
- 事件身份包含仓库地址，GitLab Issue 和 MR 编号分别隔离。回复携带幂等标记，网络重试前检查是否已发送。
- 修改项目地址、CLI 或启停多仓库来源会重新检查并重启。已有工单不会静默改到新地址，恢复原配置后才能继续。

本地私有 GitLab 需要运行 DSH 的机器能访问其 HTTPS 地址和受信任证书；本实现不支持 `file://`、裸仓库路径、HTTP 明文或 SSH-only 项目地址。
