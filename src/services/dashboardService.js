/**
 * Phase 4–6 Home dashboard — alerts + admin security tiles + existing modules.
 */
import { supabase } from '../config/supabase.js';
import { getHivHomeCounts } from './hivService.js';
import { getMchHomeCounts } from './mchService.js';
import { isoDate } from './hivRules.js';
import {
  getExistingModuleCounts,
  buildExistingModuleAlerts,
} from './existingModulesService.js';

async function getPending() {
  const { data } = await supabase.from('hms_pending_counts').select('*').maybeSingle();
  return data || {};
}

async function getPhase1() {
  const { data } = await supabase.from('hms_phase1_counts').select('*').maybeSingle();
  return data || {};
}

async function getAdminCounts() {
  let p5 = null;
  let p4 = null;
  let lastBackup = null;
  try {
    ({ data: p5 } = await supabase.from('hms_phase5_admin_counts').select('*').maybeSingle());
  } catch {
    /* migration optional */
  }
  try {
    ({ data: p4 } = await supabase.from('hms_phase4_admin_counts').select('*').maybeSingle());
  } catch {
    /* optional */
  }
  try {
    ({ data: lastBackup } = await supabase
      .from('backup_events')
      .select('status, finished_at, started_at, offsite_synced')
      .in('event_type', ['full_backup', 'manual_backup'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle());
  } catch {
    /* Phase 5 migration optional */
  }

  if (p5 || p4) {
    const base = { ...(p4 || {}), ...(p5 || {}) };
    const backupAt = lastBackup?.finished_at || lastBackup?.started_at;
    return {
      active_users: base.active_users ?? 0,
      role_count: base.role_count ?? 6,
      failed_logins_24h: base.failed_logins_24h ?? 0,
      exports_this_week: base.exports_this_week ?? 0,
      exports_xlsx_week: base.exports_xlsx_week ?? 0,
      exports_pdf_week: base.exports_pdf_week ?? 0,
      mfa_on_count: base.mfa_on_count ?? 0,
      suspended_or_locked: base.suspended_or_locked ?? 0,
      locked_accounts: base.locked_accounts ?? 0,
      audit_events_today: base.audit_events_today ?? 0,
      last_backup: backupAt
        ? new Date(backupAt).toLocaleString()
        : base.last_backup || '02:00 today',
      last_backup_ok: lastBackup
        ? lastBackup.status === 'success'
        : base.last_backup_ok !== false,
      offsite_ok: lastBackup ? Boolean(lastBackup.offsite_synced) : true,
    };
  }

  const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  const [{ count: activeUsers }, { count: failed }, { count: exports }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .neq('role', 'Patient')
      .eq('is_active', true),
    supabase
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'failed_login')
      .gte('created_at', since24),
    supabase
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'export')
      .gte('created_at', weekStart.toISOString()),
  ]);
  return {
    active_users: activeUsers || 0,
    role_count: 6,
    failed_logins_24h: failed || 0,
    exports_this_week: exports || 0,
    exports_xlsx_week: 0,
    exports_pdf_week: 0,
    last_backup: lastBackup?.finished_at || '02:00 today',
    last_backup_ok: lastBackup ? lastBackup.status === 'success' : true,
    offsite_ok: lastBackup ? Boolean(lastBackup.offsite_synced) : true,
  };
}

export async function buildAlerts({ canAccessHiv = false } = {}) {
  const alerts = [];
  const today = isoDate(new Date());

  // Critical lab (last 7 days)
  try {
    const { data: items } = await supabase
      .from('lab_order_items')
      .select('id, order_id, is_critical, result_value, status, test_name, lab_tests(name)')
      .eq('is_critical', true)
      .in('status', ['resulted', 'verified', 'entered'])
      .limit(20);
    for (const it of items || []) {
      const name = it.lab_tests?.name || it.test_name || 'Lab result';
      alerts.push({
        id: `lab-${it.id}`,
        kind: 'critical',
        pill: 'Critical',
        message: `${name}${it.result_value != null ? ` ${it.result_value}` : ''}`,
        to: '/hms/lab',
        module: 'lab',
      });
    }
  } catch {
    /* optional */
  }

  // Low stock
  try {
    const { data: meds } = await supabase
      .from('medicines')
      .select('id, name, stock_quantity, reorder_level, low_stock_threshold')
      .limit(200);
    for (const m of meds || []) {
      const reorder = m.reorder_level ?? m.low_stock_threshold ?? 10;
      if ((m.stock_quantity ?? 0) <= reorder) {
        alerts.push({
          id: `stock-${m.id}`,
          kind: 'low_stock',
          pill: 'Low stock',
          message: `${m.name} — ${m.stock_quantity ?? 0} left (reorder ${reorder})`,
          to: '/hms/pharmacy',
          module: 'pharmacy',
        });
      }
    }
  } catch {
    /* optional */
  }

  // Overdue immunizations
  try {
    const { count } = await supabase
      .from('immunization_card_doses')
      .select('id', { count: 'exact', head: true })
      .or(`status.eq.overdue,and(due_date.lt.${today},status.in.(upcoming,due))`);
    if (count > 0) {
      alerts.push({
        id: 'imm-overdue',
        kind: 'overdue',
        pill: 'Overdue',
        message: `${count} children with overdue vaccines`,
        to: '/hms/immunization',
        module: 'immunization',
      });
    }
  } catch {
    /* optional */
  }

  // Missed ANC
  try {
    const { count } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('clinic', 'anc')
      .eq('hms_status', 'missed')
      .gte('scheduled_at', `${isoDate(new Date(Date.now() - 30 * 86400000))}T00:00:00.000Z`);
    if (count > 0) {
      alerts.push({
        id: 'anc-missed',
        kind: 'follow_up',
        pill: 'Follow-up',
        message: `${count} ANC defaulters to call`,
        to: '/hms/anc',
        module: 'anc',
      });
    }
  } catch {
    /* optional */
  }

  // Missed HIV / ART refills — only surface to HIV-capable users
  if (canAccessHiv) {
    try {
      const { count: missedHiv } = await supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('clinic', 'hiv')
        .eq('hms_status', 'missed')
        .gte('scheduled_at', `${isoDate(new Date(Date.now() - 30 * 86400000))}T00:00:00.000Z`);
      const hiv = await getHivHomeCounts();
      const refillMissed = hiv.hiv_refills_missed || 0;
      if (refillMissed > 0 || missedHiv > 0) {
        alerts.push({
          id: 'hiv-missed',
          kind: 'missed',
          pill: 'Missed',
          message: `${refillMissed || missedHiv} ART refills not collected`,
          to: '/hms/hiv',
          module: 'hiv',
        });
      }
    } catch {
      /* optional */
    }
  }

  const existingAlerts = await buildExistingModuleAlerts().catch(() => []);
  return [...alerts, ...existingAlerts].slice(0, 25);
}

/**
 * Full home payload: phase1 + pending + mch + hiv + existing + admin + alerts.
 * Tile numbers for today must match Reports for the same date.
 */
export async function getHomeDashboard({ role = null, flags = {} } = {}) {
  const canAccessHiv = Boolean(flags.can_access_hiv);
  const isAdmin = role === 'Admin' || role === 'Administrator';

  const [p1, pending, mch, hiv, existing, admin, alerts] = await Promise.all([
    getPhase1(),
    getPending(),
    getMchHomeCounts().catch(() => ({})),
    getHivHomeCounts().catch(() => ({})),
    getExistingModuleCounts().catch(() => ({})),
    isAdmin ? getAdminCounts().catch(() => ({})) : Promise.resolve({}),
    buildAlerts({ canAccessHiv }),
  ]);

  return {
    as_of: new Date().toISOString(),
    refresh_seconds: 60,
    ...p1,
    ...pending,
    ...mch,
    ...existing,
    // Explicit keys used by HomeDashboard tiles
    opd_visits_today: p1.opd_visits_today ?? 0,
    appointments_today: p1.appointments_today ?? 0,
    appointments_missed_today: p1.appointments_missed_today ?? 0,
    total_patients: p1.total_patients ?? 0,
    patients_registered_today: p1.patients_registered_today ?? 0,
    pending_lab: pending.pending_lab ?? 0,
    pending_lab_urgent: pending.pending_lab_urgent ?? 0,
    to_dispense: pending.to_dispense ?? 0,
    open_invoices: pending.open_invoices ?? 0,
    low_stock_items: pending.low_stock_items ?? 0,
    anc_visits_today: mch.anc_visits_today ?? 0,
    anc_high_risk: mch.anc_high_risk ?? 0,
    maternity_in_labour: mch.maternity_in_labour ?? 0,
    deliveries_mtd: mch.deliveries_mtd ?? 0,
    pnc_due_today: mch.pnc_due_today ?? 0,
    pnc_overdue: mch.pnc_overdue ?? 0,
    imm_due_week: mch.imm_due_week ?? 0,
    imm_overdue: mch.imm_overdue ?? 0,
    fp_clients_today: mch.fp_clients_today ?? 0,
    fp_resupply_overdue: mch.fp_resupply_overdue ?? 0,
    // HIV — aggregate counts OK for dashboard; portal still flag-gated
    hiv_on_art: hiv.hiv_on_art ?? 0,
    hiv_refills_due_today: hiv.hiv_refills_due_today ?? 0,
    hiv_refills_missed: hiv.hiv_refills_missed ?? 0,
    hiv_vl_suppressed_pct: hiv.hiv_vl_suppressed_pct ?? null,
    // Phase 6 existing modules
    doctor_encounters_today: existing.doctor_encounters_today ?? 0,
    icu_occupied_beds: existing.icu_occupied_beds ?? 0,
    icu_total_beds: existing.icu_total_beds ?? 0,
    icu_pending_admissions: existing.icu_pending_admissions ?? 0,
    ambulance_active_trips: existing.ambulance_active_trips ?? 0,
    ambulance_pending_trips: existing.ambulance_pending_trips ?? 0,
    blood_pending_requests: existing.blood_pending_requests ?? 0,
    blood_units_expiring_14d: existing.blood_units_expiring_14d ?? 0,
    alerts,
    admin: isAdmin
      ? {
          active_users: admin.active_users ?? 0,
          role_count: admin.role_count ?? 6,
          failed_logins_24h: admin.failed_logins_24h ?? 0,
          exports_this_week: admin.exports_this_week ?? 0,
          exports_xlsx_week: admin.exports_xlsx_week ?? 0,
          exports_pdf_week: admin.exports_pdf_week ?? 0,
          last_backup: admin.last_backup || '02:00 today',
          last_backup_ok: admin.last_backup_ok !== false,
        }
      : null,
  };
}
