# 项目与群共享记忆

记忆正文、事实提取、检索、重复与冲突整合、编辑及历史由 Hindsight 统一管理。Superagent 只提供来源验证、项目/群访问控制、读写工具和最小删除标记，不再直接调用 Jev，也不维护候选评分、待确认队列、本地记忆副本或版本历史。

## 连接配置

在 **设置 → 记忆** 的“连接设置”填写 Hindsight API 地址、服务访问密钥和管理页面地址并保存；需要会话读写共享记忆时，再开启共享记忆。默认地址分别为 `http://127.0.0.1:8888` 和 `http://127.0.0.1:9999/orchestrator/hindsight`，均由 Superagent 服务端访问。也可用服务进程环境中的 `HINDSIGHT_API_KEY` 提供 API 密钥。密钥只保存于服务端，输入框留空保留原值，不在响应和浏览器草稿中返回。

生成式模型、embedding、重排和 Jev 等 decision model 均在 Hindsight 服务中配置，与 DSH 会话模型独立。Superagent 中旧的模型、阈值设置会被忽略；保存新连接配置时清除其旧筛选凭据，不会修改 Hindsight 自己的 Jev 配置。

## 原生记忆管理

**设置 → 记忆** 页内直接嵌入 Hindsight 原生管理控制台，保留原生 bank、事实、来源文档、派生知识、编辑、删除和历史管理。控制台独立登录；管理密钥从 Hindsight 部署配置取得，不能把服务端 API 密钥当作 UI 登录密钥。Superagent 不向内嵌页面或 URL 注入 API 密钥、管理密钥，也不复制一套本地记忆管理界面。

已配置连接时，“连接设置”默认收起；未配置时默认展开。手动展开或收起后，页面轮询不会改回默认状态。内嵌控制台与“在新窗口打开”均通过 Superagent 的同源 `/orchestrator/hindsight/` 入口转发至已保存的管理页面地址，未保存的地址草稿不生效；“重新加载”只重新加载控制台，不刷新整个设置页。关闭共享记忆仍可管理已有记忆。

手机和远程浏览器只访问 Superagent 的现有入口，不直接访问 `127.0.0.1:9999`，也不需要单独开放 Hindsight 端口。打开记忆设置后，受同源校验保护的管理 API 签发 HttpOnly、SameSite=Strict 的控制台访问 Cookie；转发时只传递 Hindsight 登录／语言 Cookie，不传递 Superagent 凭据或 API 密钥。重启后可重新打开记忆设置获取访问资格；Hindsight 仍要求独立登录。连接失败时显示错误说明，可重新加载或在新窗口打开。

控制台必须按 Hindsight 的子路径部署方式，以 `NEXT_PUBLIC_BASE_PATH=/orchestrator/hindsight` **构建**，并在管理页面地址中填写该路径。仅给已构建的根路径镜像添加运行时变量无法修改 Next.js 静态资源与路由。使用官方 Dockerfile 可指定 `--build-arg NEXT_PUBLIC_BASE_PATH=/orchestrator/hindsight --target cp-only`；记忆 API 可继续使用原地址。转发保留完整路径，重写控制台跳转与 Cookie 路径，并拒绝跨站请求；不提供任意目标代理。Superagent 此处只管理连接，不提供 Hindsight 服务启停或模型配置。

Hindsight 1.2.0 的语言路由匹配会跳过子路径根入口；Superagent 将该入口转发到子路径下的 `/dashboard`，避免根入口返回 404，后续登录及管理路由仍由原生控制台处理。

切换 API 地址只改变连接，不自动迁移后端数据。更换服务前，先通过 Hindsight 完成备份或迁移。

## 写入和范围

会话在新任务或评估前通过 `orchestrator_memory_read` 查询 Hindsight，返回内容和当前允许的 `scopes`。需要保留原始消息或本工单报告时，调用 `orchestrator_memory_propose` 直接提交给 Hindsight，由它提取事实并决定如何整合，无需逐条人工审核。

- 不指定范围时，飞书群消息默认留在原群；私聊没有群范围时必须明确选择。
- 项目知识跨关联群共享，必须从读取结果选择获准项目，并提供不含群私密上下文的逐字 `quote`。
- 群范围可以省略 `quote`，此时提交原始人类消息或报告；长于 16000 字符时需明确选择原文片段。
- 主调度提交报告时提供 `ticket_id` 和 `report_id`（assignment ID），执行器不能引用其他工单。

普通代码检查来源用户、工单归属、仓库绑定、原文引用和常见密钥模式。原文及时间、来源标识会发送给 Hindsight 及其配置的模型服务；本机部署不等于全离线。会话应只提交有保留价值的内容，不能伪造依据、将猜测当事实，或把旧记忆再次当作新来源。

项目按平台及规范化仓库地址建立 bank，群按平台及 chat ID 建立独立 bank，名称以 `dsh-superagent-` 开头。模型不能传入任意 bank ID、借其他工单访问记忆或获取后端密钥；改绑同名仓库不会继承旧地址对应的记忆。

`retained: true` 确认来源同步写入，不代表后台 observation 整合已结束。相同来源片段使用稳定文档 ID，重复和变化交给 Hindsight 处理；发布失败直接报错，不再创建第二套本地待确认状态。

## 读取与删除

读取直接访问授权范围的 Hindsight bank，不要求存在本地发布记录，也能读取通过 Hindsight 管理界面维护的事实。返回事实和整合知识，最多 8 条，来源通过 `sources[].document_id` 标识；不请求原文文档或整块会话转录。服务失败返回 `degraded: true`，不得假称已读取，也不会回退到旧 SQLite 正文。

仅在获准用户明确要求遗忘时，会话可调用 `orchestrator_memory_forget`，提供当前人类消息、`scope.id` 和来源 `document_id`。代码验证消息与范围权限，不再额外请求语义模型确认意图；会话必须遵循明确授权，不能把第三方引用当作删除许可。一个 observation 可能依赖多个来源，遗忘整项知识时需处理全部适用来源。

该工具撤回 Hindsight 来源文档，并保留不含正文的范围/文档哈希标记，阻止相同来源片段再次写入。删除意图在请求后端前落盘，后端失败会返回错误，标记仍保留以阻止重写，可再次调用以完成清理。并发召回会检查删除标记及读取期间的变更，已遗忘的来源或依赖它的派生结果不会返回。

原生控制台的删除使用 Hindsight 自身语义，不会回写 Superagent 的防重写标记；未来明确重新提交原始来源时，依照 Hindsight 的处理结果执行。已经进入会话的内容、原始业务消息、工单、外部模型记录、日志和备份不会因此全部擦除。Hindsight 的手动摘要和日志有独立生命周期，应按原生管理规则处理。

## 备份和边界

Hindsight 数据库保存记忆，Superagent 状态保存业务来源、连接和删除标记，两者均应备份。本次精简前，本地候选、版本历史和发布索引均为 0 条，不涉及正文迁移；旧永久删除标记保留。主会话重建、归档、上下文压缩或清理 worktree 不会清空后端记忆。

本次未安装全局会话采集插件，也不采集任意会话转录；会话仍需调用现有工具，可能漏记。记忆只作参考，不改变用户指令、仓库规则、权限或任务范围。模型判断准确性、摘要刷新及删除日志覆盖面由 Hindsight 的配置和实际表现决定。

协议参考：[Hindsight Retain](https://hindsight.vectorize.io/developer/retain)、[Hindsight Recall](https://hindsight.vectorize.io/developer/retrieval)。
