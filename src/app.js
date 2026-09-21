import express from 'express';
import cors from 'cors';
import { apiLimiter, authLimiter } from './middleware/rateLimit.js';

const app = express();

// CORS: allow multiple origins (comma-separated in FRONTEND_URL).
// In production we always allow the Vercel frontend so it works even if FRONTEND_URL is unset on Railway.
const PRODUCTION_FRONTEND = 'https://hms-frontend1.vercel.app';
const fromEnv = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((u) => u.trim().replace(/\/$/, ''))
  .filter(Boolean);
const defaultOrigin = process.env.NODE_ENV === 'production' ? PRODUCTION_FRONTEND : 'http://localhost:5173';
const frontendUrls = fromEnv.length ? fromEnv : [defaultOrigin];
if (process.env.NODE_ENV === 'production' && !frontendUrls.includes(PRODUCTION_FRONTEND)) {
  frontendUrls.push(PRODUCTION_FRONTEND);
}

app.use(cors({
  origin: frontendUrls,
  credentials: true,
  optionsSuccessStatus: 204,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
if (process.env.NODE_ENV !== 'test') {
  console.log('CORS allowed origins:', frontendUrls);
}
app.use(express.json());

// Health / API root (not rate-limited)
app.get('/', (req, res) => {
  res.json({
    message: 'St. Dominic Care API',
    status: 'ok',
    version: '0.0.1',
  });
});
app.get('/api', (req, res) => {
  res.json({ message: 'API root', status: 'ok' });
});

// Auth: current user profile (no role required) – avoids frontend profile timeout
import authRoutes from './routes/auth.routes.js';
import adminRoutes from './routes/admin.routes.js';
import patientRoutes from './routes/patient.routes.js';
import doctorRoutes from './routes/doctor.routes.js';
import ambulanceRoutes from './routes/ambulance.routes.js';
import icuRoutes from './routes/icu.routes.js';
import pharmacyRoutes from './routes/pharmacy.routes.js';
import bloodbankRoutes from './routes/bloodbank.routes.js';
import volunteerRoutes from './routes/volunteer.routes.js';
import geoRoutes from './routes/geo.routes.js';
import trackingRoutes from './routes/tracking.routes.js';
import recordsRoutes from './routes/records.routes.js';
import reportRoutes from './routes/report.routes.js';

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api', apiLimiter);
app.use('/api/admin', adminRoutes);
app.use('/api/patient', patientRoutes);
app.use('/api/doctor', doctorRoutes);
app.use('/api/ambulance', ambulanceRoutes);
app.use('/api/icu', icuRoutes);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/bloodbank', bloodbankRoutes);
app.use('/api/volunteer', volunteerRoutes);
app.use('/api', geoRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/records', recordsRoutes);
app.use('/api/reports', reportRoutes);

export default app;
