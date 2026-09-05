// Conversation routing is deliberately separate from product search. A greeting
// must never become a catalog query just because it has no budget or category.
const GREETING = /^(?:hi+|hello+|hey+|namaste|good\s+(?:morning|afternoon|evening)|hii+|bhai|bhaiya)[!,.\s]*$/i;
const CANCEL = /^(?:cancel|stop|never mind|nevermind|abort|no thanks)[!,.\s]*$/i;
const REFINE = /\b(?:lighter|lightweight|battery|cheaper|cheap|less expensive|show cheaper|show another|another one|different one|better one|change that|under\s*(?:₹|rs\.?|inr)?\s*\d+)\b/i;
const MANDATE_VIEW = /\b(?:show|view|my)\s+(?:purchase )?mandate\b|\bmy (?:daily )?limit\b/i;
const MANDATE_EDIT = /\b(?:edit|change|update|set|increase|decrease)\b.*\b(?:mandate|daily limit|purchase limit|spending limit|max(?:imum)? transaction)\b/i;
const HELP = /^(?:help|what can you do|how does this work)[?!.\s]*$/i;
const PRODUCT_SELECTION = /^(?:\d+|(?:the )?(?:first|second|third|fourth|last)(?: one)?)$/i;
const PRODUCT_QUESTION = /\b(?:what about|tell me about|does it have|is it|how much|which one)\b/i;
const PAYMENT_METHOD = /^(?:cod|cash on delivery|online|card|upi|pay online)$/i;

export function classifyConversation(message) {
  const text = (message || '').trim();
  if (!text) return 'CLARIFICATION';
  if (GREETING.test(text)) return 'GREETING';
  if (CANCEL.test(text)) return 'CANCELLATION';
  if (HELP.test(text)) return 'HELP';
  if (MANDATE_EDIT.test(text)) return 'MANDATE_EDIT';
  if (MANDATE_VIEW.test(text)) return 'MANDATE_VIEW';
  if (PAYMENT_METHOD.test(text)) return 'PAYMENT_METHOD';
  if (PRODUCT_SELECTION.test(text)) return 'PRODUCT_SELECTION';
  if (REFINE.test(text)) return 'REFINE_SEARCH';
  if (PRODUCT_QUESTION.test(text)) return 'PRODUCT_QUESTION';
  return 'PRODUCT_OR_UNKNOWN';
}

export const CONVERSATION_STATE = Object.freeze({
  IDLE: 'IDLE', DISCOVERY: 'DISCOVERY', PRODUCT_SELECTED: 'PRODUCT_SELECTED',
  NEGOTIATION: 'NEGOTIATION', DEAL_READY: 'DEAL_READY', PAYMANDATE_CHECK: 'PAYMANDATE_CHECK',
  APPROVAL: 'APPROVAL', RECIPIENT: 'RECIPIENT', ORDER_SUMMARY: 'ORDER_SUMMARY',
  PAYMENT_METHOD: 'PAYMENT_METHOD', PAYMENT: 'PAYMENT/COD', COMPLETE: 'COMPLETE',
  MANDATE_EDIT: 'MANDATE_EDIT'
});

export function stateForStage(stage) {
  const mapping = {
    greeting: 'IDLE', clarification: 'IDLE', no_match: 'DISCOVERY', awaiting_budget_range: 'DISCOVERY', product_choice: 'DISCOVERY',
    negotiation_offered: 'NEGOTIATION', negotiation_counter: 'NEGOTIATION', awaiting_approval: 'APPROVAL', step_up_required: 'APPROVAL',
    awaiting_delivery_choice: 'RECIPIENT', awaiting_recipient_name: 'RECIPIENT', awaiting_recipient_phone: 'RECIPIENT',
    awaiting_recipient_email: 'RECIPIENT', awaiting_recipient_address_map: 'RECIPIENT', awaiting_final_approval: 'ORDER_SUMMARY',
    awaiting_payment_method: 'PAYMENT_METHOD', awaiting_online_payment: 'PAYMENT/COD', success: 'COMPLETE',
    mandate_edit_limit: 'MANDATE_EDIT', mandate_otp_required: 'MANDATE_EDIT', mandate_updated: 'IDLE'
  };
  return mapping[stage] || 'IDLE';
}
