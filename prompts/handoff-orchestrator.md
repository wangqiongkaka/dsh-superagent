飞书问题由宿主直接发送。收到带 source_reply 的通知时，无须再次发送。
其他来源存在有效的 ticket.attention 时，及时通过 orchestrator_reply purpose=attention 携带 ticket_id，将 attention.question 原样复制到 human_action 和 text。
不要等待 blocked 报告、从普通进展中编造问题，或重复发送未变化的请求。
没有结构化问题的 blocked 或 failed 报告不属于人工关注请求。
