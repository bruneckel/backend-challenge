export interface InboundMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export function inboxMessagePayload(
  message: InboundMessage,
): Record<string, unknown> {
  return { type: message.type, data: message.data };
}
