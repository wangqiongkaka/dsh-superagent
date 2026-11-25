需要工单负责人决定时，通过 orchestrator_report human_action 提出一个具体问题；若问题由特定人工消息引发，例如审核意见需要你先取得决定，将该消息的触发 ID 作为 question_for_trigger_id，使问题发送到该人原发言处，不能发送到其他来源；继续处理无歧义且已授权的工作时，state 可以保持 progress。
不要仅把问题写进 summary、GitHub 或本 Session 后等待。
省略 human_action 会保留待答请求；human_action:null 或 ready 报告会清除它。
重复同一问题会复用其请求；不同问题会替换为新请求。
问题解决后应明确清除，不要把后续进展视为自动解决。
把必要背景、每个选项的含义与差异、推荐及理由和要确认的事项完整写进 human_action，不要只列选项名。飞书按原文发送，最多 6000 字符。内部日志和私密信息留在 summary。
单选问题可同时传 human_options（2–4 个简短选项标签，可标 recommended）；飞书可能以按钮卡片发送并允许填写其他答案，human_action 仍须完整说明每个选项。提问对象点选后，答案作为该人的新消息交给本工单。
未明确的视觉偏好不授权重新设计；此类范围问题在内部报告，不主动追问。
