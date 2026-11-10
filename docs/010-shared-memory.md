# 记忆集成边界

Superagent 不再提供独立的共享记忆功能。项目集中管理，长期记忆统一使用 Harness 已安装的 Hindsight 插件，不再维护另一套群／项目记忆范围、连接配置或管理入口。

## 会话与配置

主调度与评估共用宿主 DSH 会话，执行器使用宿主 DSH 会话或由 Harness 托管的 Codex／Claude Code 会话。Hindsight 插件的安装、连接配置、记忆库路由和采集由宿主或各执行环境负责；Superagent 不自动安装、启用或转发插件，也不再注册 `orchestrator_memory_read`、`orchestrator_memory_propose`、`orchestrator_memory_forget` 或注入相关提示词。

插件的实际覆盖取决于其在对应运行环境中的安装、作用域及配置。Superagent 的主会话完整提示词与工具限制仍然生效，不能仅凭宿主已安装插件就假定所有会话都能完整检索、采集记忆。

设置页不再显示“记忆”；旧页面状态会回到“来源”设置。旧记忆配置 API 与 `/orchestrator/hindsight/` 控制台代理均已移除。

## 已有数据

此次移除不向 Hindsight 发送删除请求，不删除旧的 `dsh-superagent-` 记忆库，也不自动迁移或合并到 Harness 的仓库记忆库。旧记忆仍可通过 Hindsight 自身的管理入口访问。

Superagent SQLite 中已有的旧记忆配置、凭据和删除标记保持原样，新版本不再读取或使用；旧备份仍可能包含这些凭据，应继续按含密钥的备份管理。宿主插件配置和 Hindsight 后端数据未作修改。
