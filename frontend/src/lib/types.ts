export type Status = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed';
export type Source = 'website' | 'walk_in' | 'phone' | 'in_person' | 'other';

export interface User { id: string; fullName: string; email: string; phone: string | null; role: 'customer' | 'admin' | 'staff'; status: string; createdAt: string }
export interface Appointment {
  id: string; reference: string; status: Status; source: Source;
  customer: { userId: string | null; name: string; email: string | null; phone: string | null };
  service: { id: string | null; name: string; price: number; durationMinutes: number };
  currency: string; startAt: string; endAt: string; localDate: string; localTime: string; localEndTime: string;
  notes: string | null; statusReason: string | null; cancelledAt: string | null; cancelledByRole: string | null; createdAt: string;
  history?: { fromStatus: Status | null; toStatus: Status; changedByRole: string; changedByName: string | null; reason: string | null; createdAt: string }[];
  canCancel?: boolean; canReview?: boolean; hasReview?: boolean;
  whatsapp?: { chatLink: string | null; confirmationLink: string | null; cancellationLink: string | null; reminderLink: string | null };
}
export interface Service { id: string; name: string; description: string; price: number; durationMinutes: number; imageUrl: string | null; isActive: boolean; isFeatured: boolean; sortOrder: number }
export interface Notification { id: string; type: string; title: string; body: string; entityType: 'appointment' | 'conversation' | 'review' | null; entityId: string | null; read: boolean; createdAt: string }
export interface Message { id: number; conversationId: string; senderId: string; senderRole: 'customer' | 'staff'; body: string; clientMessageId: string | null; createdAt: string; readAt: string | null }
export interface Conversation { id: string; customer: { id: string; fullName: string; email: string }; lastMessageAt: string | null; lastMessagePreview: string | null; unreadCount: number }
export interface Review { id: string; appointmentId: string; authorName: string; rating: number; comment: string; status: string; createdAt: string; moderatedAt: string | null }
export interface GalleryImage { id: string; url: string; caption: string; sortOrder: number; isActive: boolean }
export interface Faq { id: string; question: string; answer: string; sortOrder: number; isActive: boolean }
export interface DaySchedule { dayOfWeek: number; isOpen: boolean; openTime: string; closeTime: string; breaks: { id?: string; startTime: string; endTime: string; label: string | null }[] }
export interface Closure { id: string; startDate: string; endDate: string; kind: 'holiday' | 'closure'; reason: string | null }
export interface PublicBusiness {
  name: string; tagline: string; description: string; aboutText: string; logoUrl: string | null; heroImageUrl: string | null;
  phone: string; whatsappNumber: string; whatsappLink: string | null; email: string; address: string; currency: string; timezone: string;
  bookingPolicyText: string; cancellationPolicyText: string; cancellationDeadlineHours: number; slotIntervalMinutes: number;
  minNoticeMinutes: number; maxAdvanceDays: number; allowSameDay: boolean;
}
export interface PublicSettings { business: PublicBusiness; openingHours: DaySchedule[]; closures: Closure[] }
export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }
