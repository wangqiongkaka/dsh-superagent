/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'
import { questionCard } from './feishu-card.ts'
import type { FeishuConfig } from './feishu.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/**
 * Prefers threaded replies, falling back to a plain quoted reply on Feishu error 2200 with the same idempotency key. With
 * question cards on, a question with options goes out as a card; when Feishu rejects the card, its complete text goes instead.
 */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage, config?: Pick<FeishuConfig, 'cards'>): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = checkedImText(message.text)
  const reply = async (threaded: string[], plain: string[]) => {
    const base = ['im', '+messages-reply', '--message-id', messageId, '--idempotency-key', message.id]
    try { await host.commands.lark([...base, ...threaded, '--reply-in-thread']) }
    catch (error) {
      // Some live messages reject thread creation with 2200 while a plain quoted reply succeeds.
      if (!(error instanceof CliError) || error.code !== 2200) throw error
      await host.commands.lark([...base, ...plain])
    }
  }
  try {
    const { choices, ticketId } = message
    if (config?.cards && choices && ticketId) {
      const card = ['--msg-type', 'interactive', '--content', questionCard({ ...message, choices, ticketId })]
      try { await reply(card, card); return 'sent' }
      catch (error) {
        // Feishu answered and refused the card itself; a timeout, a rate limit or a gone target is not about the card.
        if (!(error instanceof CliError) || error.code === undefined || error.code === 99991400 || gone(error)) throw error
      }
    }
    await reply(['--markdown', text], ['--text', text])
  }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
