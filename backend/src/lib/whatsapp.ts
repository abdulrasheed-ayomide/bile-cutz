/**
 * WhatsApp click-to-chat helpers (v1). These only build `wa.me` links with a prepared message;
 * a person must review and press send in WhatsApp. Opening a link says NOTHING about delivery
 * or whether the number is even registered on WhatsApp.
 *
 * The messaging layer is deliberately thin so an approved WhatsApp Business Platform provider
 * can later implement the same `MessageComposer` outputs for automated sending.
 */

/** Normalises a phone number to international digits (no +, spaces or punctuation). */
export function normalizePhone(raw: string | null | undefined, defaultCountryCode: string): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  if (!hadPlus) {
    if (s.startsWith('00')) s = s.slice(2);
    else if (s.startsWith('0')) s = defaultCountryCode + s.slice(1);
    else if (s.length <= 10) s = defaultCountryCode + s; // local number without leading zero
  }
  return s.length >= 8 && s.length <= 15 ? s : null;
}

export function waLink(phoneDigits: string | null, message?: string): string | null {
  if (!phoneDigits) return null;
  return `https://wa.me/${phoneDigits}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

export interface WaAppointmentInfo {
  reference: string;
  customerName: string;
  serviceName: string;
  localDate: string;
  localTime: string;
  businessName: string;
}

export const waMessages = {
  confirmation: (a: WaAppointmentInfo) =>
    `Hello ${a.customerName}, your ${a.serviceName} appointment at ${a.businessName} on ${a.localDate} at ${a.localTime} is confirmed. Reference: ${a.reference}. See you then!`,
  cancellation: (a: WaAppointmentInfo) =>
    `Hello ${a.customerName}, your ${a.serviceName} appointment at ${a.businessName} on ${a.localDate} at ${a.localTime} (ref ${a.reference}) has been cancelled. Please contact us to rebook.`,
  reminder: (a: WaAppointmentInfo) =>
    `Hello ${a.customerName}, a friendly reminder of your ${a.serviceName} appointment at ${a.businessName} on ${a.localDate} at ${a.localTime} (ref ${a.reference}).`,
  chat: (a: { customerName: string; businessName: string }) => `Hello ${a.customerName}, this is ${a.businessName}.`,
};
