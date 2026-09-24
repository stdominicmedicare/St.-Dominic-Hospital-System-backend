import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/roleGuard.js';
import {
  listChargeItems,
  createChargeItem,
  listInvoices,
  getInvoice,
  createInvoice,
  recordPayment,
  receiptPdf,
  revenueSummary,
} from '../controllers/billing.controller.js';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('Accounts', 'Admin'));

router.get('/charge-items', listChargeItems);
router.post('/charge-items', createChargeItem);
router.get('/invoices', listInvoices);
router.get('/invoices/:id', getInvoice);
router.post('/invoices', createInvoice);
router.post('/invoices/:id/payments', recordPayment);
router.get('/payments/:paymentId/receipt.pdf', receiptPdf);
router.get('/revenue', revenueSummary);

export default router;
