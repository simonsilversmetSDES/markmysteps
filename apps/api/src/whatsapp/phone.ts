/**
 * A phone number as people type it, in E.164 (+32471234567), or null when it
 * cannot be one. Without a country code it is taken to be Belgian: 0471 12 34
 * 56 is +32471123456, which is how nearly everybody at home will write theirs.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.trim().replace(/[\s.\-/()]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  else if (digits.startsWith('0')) digits = `+32${digits.slice(1)}`;
  else if (!digits.startsWith('+')) digits = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** The WhatsApp chat id WAHA addresses a number by. */
export function chatIdFor(phone: string): string {
  return `${phone.replace(/^\+/, '')}@c.us`;
}

/** And back, for a message that came in; null for ids that are not numbers. */
export function phoneFromChatId(chatId: string): string | null {
  const match = /^(\d{8,15})@c\.us$/.exec(chatId);
  return match ? `+${match[1]}` : null;
}
