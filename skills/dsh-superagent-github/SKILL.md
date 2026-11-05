---
name: dsh-superagent-github
description: 使用 gh 读取 GitHub Issue、PR、审核和 CI。
---

执行器按需用 orchestrator_read 读取仓库上下文：github/issues/<number> 或 github/pulls/<number> 读取描述；github/issues/<number>/comments/1 读取会话评论；github/pulls/<number>/comments/1 读取审核评论；github/pulls/<number>/thread/<comment-id> 读取任一评论所属审核话题；github/pulls/<number>/reviews/1 读取审核；github/pulls/<number>/checks 读取 CI。每页 20 项，可能有后续页时给出 next_resource。评论或审核格式为 `{ id, from, at, text, reply_to?, path?, line?, url }`：`id` 是 GitHub 评论 ID，`reply_to` 是审核话题首条评论，`path` 和 `line` 是审核评论的文件和行号，`bot: true` 表示机器人或 GitHub App，其话语不授权工作。沿 next_offset 读完当前响应；offset 0 获取新快照，后续偏移读取同一快照。读取不会创建工单或发送回复。允许的提及会订阅 Issue/PR。订阅后的评论和审核无需再次提及就会送达；本部署 GitHub 账号创建的 PR 自动订阅，订阅 PR 的 CI 变化会送达。其他活动可按需读取；使用本技能附带的 CLI 指令，通过 gh 获取这些快捷资源以外的上下文。

对新人工请求或审核评论开展实质工作前，即使在已有工单内，也应使用原始触发 ID 和针对请求的简短 `text` 调用 `orchestrator_ack`；宿主在来源话题回复一次。该确认与如何回复审核话题是两回事。不要确认机器人或 CI。

按“沟通”一节回复和解决审核话题。解决话题使用 GitHub GraphQL `resolveReviewThread`。

审核评论 URL 以 `#discussion_r<ID>` 结尾时，读取 github/pulls/<PR>/thread/<ID>；其首条评论的 ID 是根 ID。处理结果需要回复时，使用 `gh api repos/<OWNER>/<REPO>/pulls/<PR>/comments/<ROOT>/replies --method POST -f body=<text>`，其中 `<OWNER>/<REPO>` 来自执行环境一节的 `$DSH_SUPERAGENT_GITHUB_REPOSITORY`。不得使用 `gh pr comment` 或 Issue 评论接口解释审核话题。在 `orchestrator_report` 中记录机器人运行标识、审核轮次和处置；PR 描述保留最终实现、验证及重大限制。

宿主将订阅 PR 的 CI 等机器事件直接送到绑定执行器；人工评论和审核意见（含普通账号的自动审核消息）先由主会话判断归属，再派给执行器。创建或接管工单 PR 后，立即以 `state: progress` 和 `pr_number` 调用 `orchestrator_report`，不要等待 CI 或交接。读取每个原始触发，并在实质工作前确认新人工请求。执行器报告仍交给主会话，由其在来源会话简短交付。
