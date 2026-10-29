import { Router } from 'express';
import { adminAccountRouter, adminAuth, customerAccountRouter, customerAuth } from './auth.js';
import { adminAppointmentsRouter } from './adminAppointments.js';
import { registerExtraRoutes } from './extra.js';
import { meRouter } from './me.js';
import { publicRouter } from './public.js';

export const apiRouter = Router();

apiRouter.use(publicRouter); // /public/*, /guest/*
apiRouter.use('/auth', customerAuth.router);
apiRouter.use('/me', customerAccountRouter); // profile, password
apiRouter.use('/me', meRouter); // appointments, claim, review
apiRouter.use('/admin/auth', adminAuth.router);
apiRouter.use('/admin', adminAccountRouter);
registerExtraRoutes(apiRouter);
apiRouter.use('/admin', adminAppointmentsRouter);
