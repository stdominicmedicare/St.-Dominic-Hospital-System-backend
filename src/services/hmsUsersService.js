/**
 * Phase 5 — Administrator-only staff user management (HTML screen 14).
 * One role per user + extra permission flags; role/flag changes audited.
 */
import { supabase } from '../config/supabase.js';
import { validatePassword } from '../utils/passwordPolicy.js';
import { writeAuditLog } from './auditService.js';
import { toHmsRole, PORTAL_MATRIX, HMS_ROLES } from '../permissions/hmsRoles.js';
import { unlockAccount } from './loginSecurityService.js';

const STAFF_SELECT = [
  'id',
  'email',
  'full_name',
  'phone',
  'role',
  'department',
  'is_active',
  'can_access_hiv',
  'can_verify_lab',
  'can_give_discounts',
  'can_export_reports',
  'require_password_change',
  'mfa_required',
  'failed_login_count',
  'locked_until',
  'last_login_at',
  'password_changed_at',
  'created_at',
  'updated_at',
].join(', ');

/** HMS label → app_role stored in profiles.role */
export const HMS_TO_APP_ROLE = {
  Administrator: 'Admin',
  Clerk: 'Clerk',
  Nurse: 'Nurse',
  Doctor: 'Doctor',
  Midwife: 'Midwife',
  Laboratory: 'Laboratory',
  Pharmacy: 'Pharmacy',
  Accounts: 'Accounts',
  // Legacy UI labels
  'Clinical staff': 'Doctor',
};

const DEACTIVATE_BAN = '876000h';

async function setAuthBan(userId, deactivated) {
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: deactivated ? DEACTIVATE_BAN : 'none',
  });
  if (error) console.error('[hmsUsers] ban update failed:', error.message);
  try {
    await supabase.auth.admin.signOut(userId, 'global');
  } catch {
    /* ignore */
  }
}

function randomTempPassword() {
  const base = `Tmp${Math.random().toString(36).slice(2, 8)}A1!`;
  return base.length >= 10 ? base : `${base}Xx1!`;
}

function mapHmsOrAppRole(input) {
  if (!input) return null;
  if (HMS_TO_APP_ROLE[input]) return HMS_TO_APP_ROLE[input];
  if (Object.values(HMS_TO_APP_ROLE).includes(input)) return input;
  return null;
}

function enrichUser(row) {
  if (!row) return null;
  const locked =
    row.locked_until && new Date(row.locked_until).getTime() > Date.now();
  return {
    ...row,
    hms_role: toHmsRole(row.role),
    status: !row.is_active ? 'suspended' : locked ? 'locked' : 'active',
    locked: Boolean(locked),
  };
}

export function getPermissionMatrixPayload() {
  const portals = Object.keys(PORTAL_MATRIX);
  const roles = Object.values(HMS_ROLES);
  const rows = portals.map((portal) => {
    const cell = {};
    for (const role of roles) {
      cell[role] = PORTAL_MATRIX[portal]?.[role] || 'none';
    }
    return { portal, access: cell };
  });
  return {
    roles,
    portals,
    rows,
    legend: {
      full: 'Full',
      edit: 'Edit',
      view: 'View',
      none: '— none',
      flag: 'Flag needed',
    },
    notes: {
      hiv: 'HIV requires can_access_hiv flag for clinical roles; Administrator sees counts only.',
      reports: 'Export requires can_export_reports (Administrator always allowed).',
      lab_verify: 'Lab result verify requires can_verify_lab.',
      discounts: 'Waivers/discounts require can_give_discounts.',
    },
  };
}

export async function getUsersKpis() {
  const { data: view } = await supabase.from('hms_phase5_admin_counts').select('*').maybeSingle();
  if (view) {
    return {
      active_users: view.active_users ?? 0,
      roles: Object.keys(HMS_ROLES).length,
      mfa_on: view.mfa_on_count ?? 0,
      suspended_or_locked: view.suspended_or_locked ?? 0,
    };
  }

  const { data: rows } = await supabase
    .from('profiles')
    .select('id, role, is_active, mfa_required, locked_until')
    .neq('role', 'Patient');

  const now = Date.now();
  let active = 0;
  let mfa = 0;
  let suspended = 0;
  for (const r of rows || []) {
    const locked = r.locked_until && new Date(r.locked_until).getTime() > now;
    if (r.mfa_required) mfa += 1;
    if (!r.is_active || locked) suspended += 1;
    else active += 1;
  }
  return {
    active_users: active,
    roles: Object.keys(HMS_ROLES).length,
    mfa_on: mfa,
    suspended_or_locked: suspended,
  };
}

export async function listStaffUsers({ q, role, status } = {}) {
  let query = supabase
    .from('profiles')
    .select(STAFF_SELECT)
    .neq('role', 'Patient')
    .order('created_at', { ascending: false });

  if (role) {
    const appRole = mapHmsOrAppRole(role) || role;
    query = query.eq('role', appRole);
  }

  let { data, error } = await query;
  if (error && /column|does not exist|require_password|mfa_required|locked_until|failed_login|department|last_login/i.test(error.message || '')) {
    // Pre–Phase 5 DB: fall back to core columns
    let fallback = supabase
      .from('profiles')
      .select(
        'id, email, full_name, phone, role, is_active, can_access_hiv, can_verify_lab, can_give_discounts, can_export_reports, password_changed_at, created_at, updated_at'
      )
      .neq('role', 'Patient')
      .order('created_at', { ascending: false });
    if (role) {
      const appRole = mapHmsOrAppRole(role) || role;
      fallback = fallback.eq('role', appRole);
    }
    ({ data, error } = await fallback);
  }
  if (error) throw new Error(error.message);

  let rows = (data || []).map(enrichUser);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (u) =>
        String(u.email || '').toLowerCase().includes(needle) ||
        String(u.full_name || '').toLowerCase().includes(needle) ||
        String(u.phone || '').toLowerCase().includes(needle)
    );
  }
  if (status === 'active') rows = rows.filter((u) => u.status === 'active');
  if (status === 'suspended') rows = rows.filter((u) => u.status === 'suspended');
  if (status === 'locked') rows = rows.filter((u) => u.status === 'locked');
  return rows;
}

export async function createStaffUser(payload, actor, req) {
  const email = String(payload.email || '').trim().toLowerCase();
  const full_name = String(payload.full_name || '').trim();
  const phone = payload.phone ? String(payload.phone).trim() : null;
  const department = payload.department ? String(payload.department).trim() : null;
  const appRole = mapHmsOrAppRole(payload.role || payload.hms_role);
  if (!email || !appRole) {
    throw Object.assign(new Error('Email and role are required'), { status: 400 });
  }
  if (!full_name) {
    throw Object.assign(new Error('Full name is required'), { status: 400 });
  }

  let password = payload.password;
  if (password) {
    const check = validatePassword(password);
    if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
  } else {
    password = randomTempPassword();
  }

  const forceChange = payload.require_password_change !== false;
  const mfaRequired =
    appRole === 'Admin' ? true : Boolean(payload.mfa_required ?? payload.require_2fa);

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name,
      role: appRole,
      phone,
    },
  });
  if (authError) throw Object.assign(new Error(authError.message), { status: 400 });

  const now = new Date().toISOString();
  const profileUpdate = {
    role: appRole,
    full_name,
    phone,
    department,
    can_access_hiv: Boolean(payload.can_access_hiv),
    can_verify_lab: Boolean(payload.can_verify_lab),
    can_give_discounts: Boolean(payload.can_give_discounts),
    can_export_reports:
      appRole === 'Admin' ? true : Boolean(payload.can_export_reports),
    require_password_change: forceChange,
    mfa_required: mfaRequired,
    // Force change: set password_changed_at far in past if forceChange, else now
    password_changed_at: forceChange ? '1970-01-01T00:00:00.000Z' : now,
    updated_at: now,
  };

  const { error: upErr } = await supabase
    .from('profiles')
    .update(profileUpdate)
    .eq('id', authData.user.id);
  if (upErr) throw new Error(upErr.message);

  const { data: profile } = await supabase
    .from('profiles')
    .select(STAFF_SELECT)
    .eq('id', authData.user.id)
    .single();

  await writeAuditLog({
    actorId: actor?.id,
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'create',
    resourceType: 'user',
    resourceId: authData.user.id,
    module: 'roles',
    after: {
      email,
      role: appRole,
      hms_role: toHmsRole(appRole),
      flags: {
        can_access_hiv: profileUpdate.can_access_hiv,
        can_verify_lab: profileUpdate.can_verify_lab,
        can_give_discounts: profileUpdate.can_give_discounts,
        can_export_reports: profileUpdate.can_export_reports,
        mfa_required: mfaRequired,
      },
    },
    metadata: { invite: true, require_password_change: forceChange },
    req,
  });

  return {
    user: enrichUser(profile),
    temporary_password: payload.password ? undefined : password,
    message: forceChange
      ? 'User created. They must change password on first login.'
      : 'User created.',
  };
}

export async function updateStaffUser(userId, payload, actor, req) {
  const { data: before, error: beforeErr } = await supabase
    .from('profiles')
    .select(STAFF_SELECT)
    .eq('id', userId)
    .single();
  if (beforeErr || !before) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }
  if (before.role === 'Patient') {
    throw Object.assign(new Error('Patient accounts are managed under Patients'), {
      status: 400,
    });
  }

  const updates = { updated_at: new Date().toISOString() };
  const permissionBefore = {};
  const permissionAfter = {};

  if (payload.full_name !== undefined) updates.full_name = String(payload.full_name || '').trim();
  if (payload.phone !== undefined) updates.phone = payload.phone ? String(payload.phone).trim() : null;
  if (payload.department !== undefined) {
    updates.department = payload.department ? String(payload.department).trim() : null;
  }
  if (payload.email !== undefined) {
    const email = String(payload.email || '').trim().toLowerCase();
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email });
    if (authError) throw Object.assign(new Error(authError.message), { status: 400 });
    updates.email = email;
  }

  if (payload.role !== undefined || payload.hms_role !== undefined) {
    const appRole = mapHmsOrAppRole(payload.role || payload.hms_role);
    if (!appRole) throw Object.assign(new Error('Invalid role'), { status: 400 });
    if (appRole !== before.role) {
      permissionBefore.role = before.role;
      permissionBefore.hms_role = toHmsRole(before.role);
      permissionAfter.role = appRole;
      permissionAfter.hms_role = toHmsRole(appRole);
      updates.role = appRole;
      if (appRole === 'Admin') updates.mfa_required = true;
    }
  }

  const flagKeys = [
    'can_access_hiv',
    'can_verify_lab',
    'can_give_discounts',
    'can_export_reports',
    'mfa_required',
    'require_password_change',
  ];
  for (const key of flagKeys) {
    const alt = key === 'mfa_required' ? payload.require_2fa : undefined;
    const val = payload[key] !== undefined ? payload[key] : alt;
    if (val !== undefined) {
      const next = Boolean(val);
      // Admin always requires MFA
      const effective =
        key === 'mfa_required' && (updates.role || before.role) === 'Admin' ? true : next;
      if (Boolean(before[key]) !== effective) {
        permissionBefore[key] = Boolean(before[key]);
        permissionAfter[key] = effective;
      }
      updates[key] = effective;
    }
  }

  if (typeof payload.is_active === 'boolean') {
    updates.is_active = payload.is_active;
  }

  const { data: after, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select(STAFF_SELECT)
    .single();
  if (error) throw new Error(error.message);

  if (typeof payload.is_active === 'boolean' && payload.is_active !== before.is_active) {
    await setAuthBan(userId, !payload.is_active);
  }

  if (payload.unlock === true) {
    await unlockAccount(userId);
    const refreshed = await supabase.from('profiles').select(STAFF_SELECT).eq('id', userId).single();
    Object.assign(after, refreshed.data || {});
  }

  const hadPermissionChange = Object.keys(permissionAfter).length > 0;
  if (hadPermissionChange) {
    await writeAuditLog({
      actorId: actor?.id,
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'permission_change',
      resourceType: 'user',
      resourceId: userId,
      module: 'roles',
      before: permissionBefore,
      after: permissionAfter,
      metadata: {
        target_email: after.email,
        summary: Object.keys(permissionAfter)
          .map((k) => `${k}: ${permissionBefore[k]} → ${permissionAfter[k]}`)
          .join('; '),
      },
      req,
    });
  } else {
    await writeAuditLog({
      actorId: actor?.id,
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'edit',
      resourceType: 'user',
      resourceId: userId,
      module: 'roles',
      before: {
        full_name: before.full_name,
        phone: before.phone,
        is_active: before.is_active,
      },
      after: {
        full_name: after.full_name,
        phone: after.phone,
        is_active: after.is_active,
      },
      req,
    });
  }

  return enrichUser(after);
}

export function usersToExportRows(users) {
  const headers = [
    'Full name',
    'Email',
    'Phone',
    'Role',
    'HMS role',
    'Status',
    'HIV',
    'Verify lab',
    'Discounts',
    'Export reports',
    '2-step',
    'Force password change',
    'Last login',
  ];
  const rows = users.map((u) => [
    u.full_name,
    u.email,
    u.phone,
    u.role,
    u.hms_role,
    u.status,
    u.can_access_hiv ? 'Y' : 'N',
    u.can_verify_lab ? 'Y' : 'N',
    u.can_give_discounts ? 'Y' : 'N',
    u.can_export_reports ? 'Y' : 'N',
    u.mfa_required ? 'Y' : 'N',
    u.require_password_change ? 'Y' : 'N',
    u.last_login_at || '',
  ]);
  return { headers, rows };
}
