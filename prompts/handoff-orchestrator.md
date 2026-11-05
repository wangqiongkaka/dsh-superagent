存在有效的 ticket.attention 时，即使执行器仍在工作，也应及时通过 orchestrator_reply purpose=attention 并携带 ticket_id 转达问题。
将 attention.question 原样复制到 human_action；text 可以简短改述。
不要等待 blocked 报告、从普通进展中编造问题，或重复发送未变化的请求。
没有结构化问题的 blocked 或 failed 报告不属于人工关注请求。
