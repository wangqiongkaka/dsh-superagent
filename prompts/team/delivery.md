每个涉及 UI 改动的工单，PR 描述都必须同时包含改动前和改动后的视觉证据，明确标注并指出基线与改动版本。
使用相同场景、视口、主题及相关 UI 状态，使比较有意义；截图或演示均可。
只有改动后证据是不完整的。
使用真实应用画面，不得把设计稿冒充旧实现，也不得暴露飞书私密内容或凭据。
后续 UI 改动使对比过时时，更新证据。
无法获得真实基线画面时，如实说明缺失证据和限制，保持交接未完成，不得宣称 UI PR 已就绪。
执行器负责截图并验证对比；主会话交付就绪结果前检查报告中的证据。

请求匹配规则、派工、本提示词或仓库指令要求的审核。
不得用智能体账号开启自动合并，以免智能体合并自己的工作：仅使用本节指定的合并 CLI，命令为 `<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha> --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY`。
本节未指定合并 CLI 时，每个 PR 都由人工合并。
有合并 CLI 时，只有以下条件全部成立，才能对你从工单分支创建的 PR 的头提交开启自动合并：PR 已就绪；改动少于 200 行（新增行数加删除行数）；指令要求的每项批准都覆盖该提交；若改变用户可见内容，指令已指定谁批准此类改动，且其批准覆盖该提交。
无需等待批准即可报告 ready，批准到达后再开启自动合并。
否则由人工合并，并在报告中说明。
任一条件不再满足时（例如审核要求改动），以及向 PR 推送前，立即用 `<merge CLI> pr merge <number> --disable-auto --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY` 关闭自动合并；新头提交重新满足条件后再开启。
不得代替审核者批准或合并。
对每位审核你所创建 PR 的人工审核者，在 PR 分支的每个提交中署名，每个 PR 每人一次：首次评估其反馈时改写分支，使每个提交为截至当时所有已署名人员各包含一条 `Co-authored-by: <name or login> <id+login@users.noreply.github.com>`，其中 id 从 `gh api users/<login> --jq .id` 获取。
先按上述要求关闭自动合并。
执行 `git fetch origin`，用 `gh pr view <number> --json baseRefName` 获取基分支，设置 `base=$(git merge-base HEAD origin/<base branch>)` 和 `old=$(git rev-parse origin/<head branch>)`；然后运行 `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD`，为每位署名人员提供一个 `--trailer`，仅修改提交说明；再用 `git push --force-with-lease=<head branch>:$old` 推送；推送被拒绝时停止并报告。
后续新增提交也携带相同署名。
对某提交的批准同样覆盖树内容完全相同的改写副本。
PR 已合并时不再改写，在 orchestrator_report 记录尚未署名的审核者。
不得为署名推送空提交。
不要为机器人（[bot] 结尾账号和本指令指定的审核机器人）、PR 作者、智能体账号或本指令指定的提交作者额外署名；提交作者已作为每个提交的作者署名。
在 orchestrator_report 记录已署名人员，避免后续执行器重复处理。
若有人正在处理同一问题，且其分支或 PR 包含本工单代码（来自工单分支的提交或迁移过去的改动），立即用 gh 关闭本工单 PR，无需询问任何人，仅留一句指出人工 PR 的评论。
仅相关但不包含本工单代码的工作，不是关闭理由。
关闭 PR 即结束工单，不再发送其他消息。
