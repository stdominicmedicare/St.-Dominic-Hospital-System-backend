# St Dominic HMS — Phase 5 Users, security, audit & backups

Employer compliance screens: **Users & roles (14)** and **Security, audit log & backups (15)**.

HTML source: `muneeb bhai/St-Dominic-HMS (1).html` / `screens/Roles.html` + `Security.html`.

## Apply migration

```bash
# Run in Supabase SQL editor (or supabase db push):
backend/supabase/migrations/20261106_phase5_security_compliance.sql
```

Then:

```bash
cd backend && node scripts/phase5-verify.js
```

## What was added

### Data

| Area | Changes |
|------|---------|
| Profiles | `department`, `require_password_change`, `mfa_required`, `failed_login_count`, `locked_until`, `last_login_at` |
| Backups | `backup_events` table (status UX + runbook hooks) |
| Audit | Re-asserted append-only trigger; SELECT/INSERT only for service_role |
| View | `hms_phase5_admin_counts` |

### Security behaviours

| Rule | Implementation |
|------|----------------|
| Lock after 5 failed logins | `loginSecurityService` + `/api/auth/failed-login`; 30 min lock |
| Idle auto-logout 15 min | Frontend `useIdleLogout` + `IDLE_TIMEOUT_MS`; logout audited as `idle` |
| Force password change (first login) | `require_password_change` + `/change-password` |
| 2-step for Administrator | `mfa_required` always for Admin; UI + `/api/auth/mfa/*` stub (**TODO** SMS/TOTP provider). Hard gate via `ENABLE_MFA_ENFORCEMENT=true` |
| HTTPS in production | Documented in migration + security policy API |
| Audit immutable | DB trigger + API `PATCH/DELETE /security/audit/:id` → 405 |

### API (`/api/hms/…` — Administrator / `requirePortal`)

**Users & roles** (`requirePortal('roles')`)

- `GET /users/kpis` · `GET /users/matrix` · `GET /users`
- `POST /users` · `PATCH /users/:id` (role/flag changes → `permission_change` audit)
- `GET /users/export.xlsx|pdf`

**Security** (`requirePortal('security')`)

- `GET /security/kpis` · `GET /security/policy`
- `GET /security/audit` (filters: `action`, `action_group`, `actor_id`, `module`, dates)
- `GET /security/audit/export.xlsx|pdf`
- `GET /security/backups` · `POST /security/backups/run` · `POST /security/backups/test-restore`

**Auth hooks**

- Public: `POST /api/auth/check-lock`, `POST /api/auth/failed-login`
- Authed: `POST /api/auth/login-success`, `POST /api/auth/logout`, MFA stub

### UI

| Route | Portal |
|-------|--------|
| `/hms/roles` | `RolesPortal.jsx` — matrix, KPIs, add/edit user, flags, export |
| `/hms/security` | `SecurityPortal.jsx` — audit filters/export, backups, security policy |

Non-admin: nav hidden + `403 PORTAL_FORBIDDEN` on user/security APIs.

### Backups UX

- Shows last backup / test restore / off-site indicator / retention policy
- **Back up now** / **test restore** log events (managed Supabase cannot dump from app) + ops runbook
- Failure → `notifyBackupFailure` hook (`ADMIN_ALERT_EMAIL`; provider TODO)

## Acceptance mapping

| Test | How |
|------|-----|
| Non-admin cannot access user admin APIs | `requirePortal('roles')` / matrix `none` → 403 |
| Failed login lockout works | 5× `/api/auth/failed-login` → `locked_until` + audit `failed_login` |
| Idle logout works in frontend | `IDLE_TIMEOUT_MS = 15 * 60 * 1000` in AuthContext |
| Audit export works; log immutable | Export endpoints + DB trigger + 405 mutate routes |
| Permission change appears in audit log | `updateStaffUser` writes `action: permission_change` |

## Exit checklist

- [x] Users/roles matrix usable  
- [x] Audit log read-only UI  
- [x] Lockout + idle logout verified (unit/script + wiring)

## Notes

- Apply Phase 0–4 migrations before Phase 5.
- Set `ADMIN_ALERT_EMAIL` for backup failure alerts; `ENABLE_MFA_ENFORCEMENT=true` only after MFA provider is live.
- Production: terminate TLS at the host / reverse proxy (HTTPS only).
