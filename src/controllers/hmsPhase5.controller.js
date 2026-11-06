/**
 * Phase 5 — Users & roles (14) + Security / audit / backups (15).
 */
import {
  getPermissionMatrixPayload,
  getUsersKpis,
  listStaffUsers,
  createStaffUser,
  updateStaffUser,
  usersToExportRows,
} from '../services/hmsUsersService.js';
import {
  getBackupStatus,
  requestManualBackup,
  requestTestRestore,
  BACKUP_POLICY,
} from '../services/backupService.js';
import { listAuditLogs, writeAuditLog } from '../services/auditService.js';
import {
  buildExcelBuffer,
  buildPdfBuffer,
  sendBinary,
} from '../services/exportService.js';
import { supabase } from '../config/supabase.js';
import { MAX_FAILED_LOGINS, LOCKOUT_MINUTES } from '../services/loginSecurityService.js';

function actorFrom(req) {
  return { id: req.user?.id, email: req.user?.email, role: req.role };
}

function actionGroupFilter(group) {
  const map = {
    login: ['login', 'logout', 'failed_login'],
    view: ['view'],
    write: ['create', 'edit'],
    delete: ['delete', 'delete_void'],
    export: ['export', 'print'],
    permission: ['permission_change'],
  };
  return map[group] || null;
}

// ---------------------------------------------------------------------------
// Users & roles
// ---------------------------------------------------------------------------

export async function usersKpis(_req, res) {
  try {
    const kpis = await getUsersKpis();
    res.json(kpis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function usersMatrix(_req, res) {
  res.json(getPermissionMatrixPayload());
}

export async function usersList(req, res) {
  try {
    const users = await listStaffUsers({
      q: req.query.q,
      role: req.query.role,
      status: req.query.status,
    });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function usersCreate(req, res) {
  try {
    const result = await createStaffUser(req.body || {}, actorFrom(req), req);
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

export async function usersUpdate(req, res) {
  try {
    const user = await updateStaffUser(req.params.id, req.body || {}, actorFrom(req), req);
    res.json({ user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

export async function usersExport(req, res) {
  try {
    const format = String(req.params.format || '').toLowerCase();
    const users = await listStaffUsers({
      q: req.query.q,
      role: req.query.role,
      status: req.query.status,
    });
    const { headers, rows } = usersToExportRows(users);

    await writeAuditLog({
      actorId: req.user.id,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: 'export',
      resourceType: 'users',
      module: 'roles',
      metadata: { format, count: users.length },
      req,
    });

    if (format === 'xlsx' || format === 'excel') {
      const buf = await buildExcelBuffer('Users', headers, rows);
      return sendBinary(res, buf, {
        filename: `hms-users-${Date.now()}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    }
    if (format === 'pdf') {
      const buf = await buildPdfBuffer('Users & roles', [
        {
          heading: 'Staff directory',
          table: { headers, rows: rows.map((r) => r.map((c) => String(c ?? ''))) },
        },
      ]);
      return sendBinary(res, buf, {
        filename: `hms-users-${Date.now()}.pdf`,
        contentType: 'application/pdf',
      });
    }
    return res.status(400).json({ error: 'format must be xlsx or pdf' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Security / audit / backups
// ---------------------------------------------------------------------------

export async function securityKpis(_req, res) {
  try {
    const [{ data: admin }, backup] = await Promise.all([
      supabase.from('hms_phase5_admin_counts').select('*').maybeSingle(),
      getBackupStatus(),
    ]);
    const last = backup.last_backup;
    const restore = backup.last_test_restore;
    res.json({
      last_backup_at: last?.finished_at || last?.started_at || null,
      last_backup_status: last?.status || 'unknown',
      last_test_restore_at: restore?.finished_at || restore?.started_at || null,
      last_test_restore_status: restore?.status || null,
      failed_logins_24h: admin?.failed_logins_24h ?? 0,
      locked_accounts: admin?.locked_accounts ?? 0,
      audit_events_today: admin?.audit_events_today ?? 0,
      offsite_ok: backup.offsite_ok,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function securityPolicy(_req, res) {
  res.json({
    connection: 'HTTPS only (production assumption)',
    database_encryption_at_rest: 'On (Supabase platform)',
    lock_after_failed_logins: MAX_FAILED_LOGINS,
    lockout_minutes: LOCKOUT_MINUTES,
    idle_logout_minutes: 15,
    password_rule: '10+ chars with upper, lower, digit, special; change yearly (90-day expiry) + first-login force change',
    two_step: 'Required for Administrator; optional flag for other roles',
    mfa_provider: process.env.SMS_PROVIDER
      ? 'configured'
      : 'TODO — SMS/app provider not configured; flags + AAL wiring present',
    hiv_records: 'HIV flag only · every view logged',
    audit: 'Append-only — nobody (including Administrator) can edit or delete logs',
    backups: BACKUP_POLICY,
  });
}

export async function auditList(req, res) {
  try {
    const group = req.query.action_group || null;
    const actions = actionGroupFilter(group);
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const offset = Number(req.query.offset) || 0;

    let result;
    if (actions?.length) {
      // Filter client-side for action groups (PostgREST IN via multiple fetches if needed)
      const { data, error, count } = await supabase
        .from('audit_logs')
        .select('*', { count: 'exact' })
        .in('action', actions)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (req.query.actor_id) {
        /* applied below via listAuditLogs path */
      }
      if (error) throw new Error(error.message);
      let rows = data || [];
      if (req.query.actor_id) rows = rows.filter((r) => r.actor_id === req.query.actor_id);
      if (req.query.module) rows = rows.filter((r) => r.module === req.query.module);
      result = { data: rows, count: count ?? rows.length, error: null };
    } else {
      result = await listAuditLogs({
        actorId: req.query.actor_id,
        action: req.query.action,
        module: req.query.module,
        from: req.query.from,
        to: req.query.to,
        limit,
        offset,
      });
    }

    if (result.error) throw new Error(result.error.message);
    res.json({
      logs: result.data || [],
      count: result.count ?? (result.data || []).length,
      immutable: true,
      note: 'Audit log is append-only. Edit/delete are blocked in the database for all roles including Administrator.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function formatAuditRows(logs) {
  const headers = ['Time', 'User', 'Role', 'Action', 'Module', 'Record', 'Details', 'IP', 'Device'];
  const rows = (logs || []).map((l) => {
    const details =
      l.metadata?.summary ||
      (l.before_data || l.after_data
        ? `${JSON.stringify(l.before_data || {})} → ${JSON.stringify(l.after_data || {})}`
        : JSON.stringify(l.metadata || {}));
    return [
      l.created_at,
      l.actor_email || l.actor_id || '—',
      l.actor_role || '',
      l.action,
      l.module || l.metadata?.module || '',
      [l.resource_type, l.resource_id].filter(Boolean).join(' '),
      String(details).slice(0, 500),
      l.ip_address || '',
      String(l.user_agent || '').slice(0, 120),
    ];
  });
  return { headers, rows };
}

export async function auditExport(req, res) {
  try {
    const format = String(req.params.format || '').toLowerCase();
    const { data, error } = await listAuditLogs({
      actorId: req.query.actor_id,
      action: req.query.action,
      module: req.query.module,
      from: req.query.from,
      to: req.query.to,
      limit: Math.min(Number(req.query.limit) || 500, 1000),
      offset: 0,
    });
    if (error) throw new Error(error.message);
    const { headers, rows } = formatAuditRows(data);

    await writeAuditLog({
      actorId: req.user.id,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: 'export',
      resourceType: 'audit_log',
      module: 'security',
      metadata: { format, count: rows.length },
      req,
    });

    if (format === 'xlsx' || format === 'excel') {
      const buf = await buildExcelBuffer('Audit log', headers, rows);
      return sendBinary(res, buf, {
        filename: `hms-audit-${Date.now()}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    }
    if (format === 'pdf') {
      const buf = await buildPdfBuffer('Audit log (read-only)', [
        {
          heading: 'Events (append-only — cannot be edited or deleted)',
          table: {
            headers,
            rows: rows.slice(0, 80).map((r) => r.map((c) => String(c ?? '').slice(0, 80))),
          },
        },
      ]);
      return sendBinary(res, buf, {
        filename: `hms-audit-${Date.now()}.pdf`,
        contentType: 'application/pdf',
      });
    }
    return res.status(400).json({ error: 'format must be xlsx or pdf' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function backupsStatus(_req, res) {
  try {
    const status = await getBackupStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function backupsRunNow(req, res) {
  try {
    const event = await requestManualBackup({ actor: actorFrom(req), req });
    res.status(201).json({ event, policy: BACKUP_POLICY });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function backupsTestRestore(req, res) {
  try {
    const passed = req.body?.passed !== false;
    const event = await requestTestRestore({
      actor: actorFrom(req),
      req,
      passed,
      notes: req.body?.notes,
    });
    res.status(201).json({ event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Prove immutability: reject any attempt to mutate audit via API. */
export async function auditMutateRejected(_req, res) {
  res.status(405).json({
    error: 'Audit log is append-only. Edit and delete are forbidden for all roles including Administrator.',
    code: 'AUDIT_IMMUTABLE',
  });
}
