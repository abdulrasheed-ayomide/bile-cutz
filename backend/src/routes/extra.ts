import type { Router } from 'express';
import { adminContentRouter } from './adminContent.js';
import { adminManageRouter } from './adminManage.js';
import { adminChatRouter, customerChatRouter } from './chat.js';
import { adminNotificationsRouter, customerNotificationsRouter } from './notifications.js';
import { adminReviewsRouter, customerReviewsRouter } from './reviews.js';

export function registerExtraRoutes(router: Router) {
  router.use('/notifications', customerNotificationsRouter);
  router.use('/chat', customerChatRouter);
  router.use('/me', customerReviewsRouter);
  router.use('/admin/notifications', adminNotificationsRouter);
  router.use('/admin/chat', adminChatRouter);
  router.use('/admin', adminReviewsRouter);
  router.use('/admin', adminContentRouter);
  router.use('/admin', adminManageRouter);
}
