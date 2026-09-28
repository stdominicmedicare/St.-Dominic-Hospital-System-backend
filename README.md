# St. Dominic Care – Backend (Node.js + Express)

REST API with RBAC, Supabase (DB + Auth JWT), and role-based routes.

## Tech Stack

- **Node.js** + **Express**
- **Supabase** (PostgreSQL, Auth JWT, RLS)
- **JWT** for session/API auth
- **RBAC** enforced in middleware and routes

## Roles

Admin | Patient | Doctor | Ambulance | ICU | Pharmacy | Blood Bank

## Folder Structure

```
src/
├── config/
│   └── supabase.js    # Supabase client (DB + Auth)
├── middleware/        # Auth, RBAC, audit, error handler
├── routes/            # auth, admin, patient, doctor, ambulance, icu, pharmacy, bloodbank
├── controllers/       # Per-domain controllers
├── services/          # Business logic, Supabase queries, audit
├── app.js             # Express app
└── index.js           # Server entry
```

## Environment Variables

1. Copy `.env.example` to `.env`.
2. Set:
   - `PORT` – Server port (default 5000)
   - `SUPABASE_URL` – Supabase project URL
   - `SUPABASE_ANON_KEY` – Supabase anon key
   - `SUPABASE_SERVICE_ROLE_KEY` – Service role key (server-only)
   - `SUPABASE_JWT_SECRET` – JWT secret for verifying tokens
   - `FRONTEND_URL` – Frontend origin for CORS

## Getting Started

```bash
npm install
npm run dev
```

Production:

```bash
npm start
```

## API Routes (Placeholders)

- `POST /api/auth/login` – Login (email/password, JWT)
- `POST /api/auth/register` – Register
- `/api/admin/*` – Admin-only
- `/api/patient/*` – Patient
- `/api/doctor/*` – Doctor
- `/api/ambulance/*` – Ambulance
- `/api/icu/*` – ICU
- `/api/pharmacy/*` – Pharmacy
- `/api/bloodbank/*` – Blood Bank

RBAC and Supabase RLS must be applied per route.
