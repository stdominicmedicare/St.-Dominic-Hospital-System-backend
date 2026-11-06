/**
 * Phase 6 — existing module KPIs + alerts (Doctors, ICU, Ambulance, Blood bank).
 */
import { supabase } from '../config/supabase.js';

export async function getExistingModuleCounts() {
  try {
    const { data, error } = await supabase
      .from('hms_phase6_existing_counts')
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (data) return normalize(data);
  } catch {
    /* view may be missing before migration — fall through */
  }
  return computeFallback();
}

function normalize(row = {}) {
  return {
    icu_occupied_beds: row.icu_occupied_beds ?? 0,
    icu_total_beds: row.icu_total_beds ?? 0,
    icu_pending_admissions: row.icu_pending_admissions ?? 0,
    ambulance_active_trips: row.ambulance_active_trips ?? 0,
    ambulance_pending_trips: row.ambulance_pending_trips ?? 0,
    blood_pending_requests: row.blood_pending_requests ?? 0,
    blood_units_expiring_14d: row.blood_units_expiring_14d ?? 0,
    doctor_encounters_today: row.doctor_encounters_today ?? 0,
    icu_encounters_today: row.icu_encounters_today ?? 0,
    ambulance_encounters_today: row.ambulance_encounters_today ?? 0,
    bloodbank_encounters_today: row.bloodbank_encounters_today ?? 0,
  };
}

async function countExact(table, apply = (q) => q) {
  let q = supabase.from(table).select('id', { count: 'exact', head: true });
  q = apply(q);
  const { count } = await q;
  return count || 0;
}

async function computeFallback() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const expiryCut = new Date();
  expiryCut.setDate(expiryCut.getDate() + 14);
  const expiryStr = expiryCut.toISOString().slice(0, 10);

  const [
    icu_occupied_beds,
    icu_total_beds,
    icu_pending_admissions,
    ambulance_active_trips,
    ambulance_pending_trips,
    blood_pending_requests,
    blood_units_expiring_14d,
    doctor_encounters_today,
    icu_encounters_today,
    ambulance_encounters_today,
    bloodbank_encounters_today,
  ] = await Promise.all([
    countExact('icu_beds', (q) => q.eq('status', 'occupied')),
    countExact('icu_beds'),
    countExact('icu_admission_requests', (q) => q.eq('request_status', 'pending')),
    countExact('ambulance_requests', (q) =>
      q.in('status', [
        'pending',
        'assigned',
        'en_route',
        'arrived',
        'patient_picked',
        'arrived_at_hospital',
      ])
    ),
    countExact('ambulance_requests', (q) => q.eq('status', 'pending')),
    countExact('blood_requests', (q) => q.in('request_status', ['pending', 'approved'])),
    countExact('blood_units', (q) =>
      q.eq('status', 'available').not('expiry_date', 'is', null).lte('expiry_date', expiryStr)
    ),
    countExact('encounters', (q) => q.eq('module', 'doctor').gte('date_time', todayIso)),
    countExact('encounters', (q) => q.eq('module', 'icu').gte('date_time', todayIso)),
    countExact('encounters', (q) => q.eq('module', 'ambulance').gte('date_time', todayIso)),
    countExact('encounters', (q) => q.eq('module', 'bloodbank').gte('date_time', todayIso)),
  ]);

  return {
    icu_occupied_beds,
    icu_total_beds,
    icu_pending_admissions,
    ambulance_active_trips,
    ambulance_pending_trips,
    blood_pending_requests,
    blood_units_expiring_14d,
    doctor_encounters_today,
    icu_encounters_today,
    ambulance_encounters_today,
    bloodbank_encounters_today,
  };
}

/**
 * Alerts that deep-link into existing module routes.
 */
export async function buildExistingModuleAlerts() {
  const counts = await getExistingModuleCounts();
  const alerts = [];

  if (counts.icu_pending_admissions > 0) {
    alerts.push({
      id: 'icu-pending',
      kind: 'overdue',
      pill: 'ICU',
      message: `${counts.icu_pending_admissions} ICU admission request(s) pending`,
      to: '/icu/admission-requests',
      module: 'icu',
    });
  }

  if (counts.ambulance_pending_trips > 0) {
    alerts.push({
      id: 'ambulance-pending',
      kind: 'waiting',
      pill: 'Ambulance',
      message: `${counts.ambulance_pending_trips} ambulance trip(s) waiting for a driver`,
      to: '/ambulance',
      module: 'ambulance',
    });
  }

  if (counts.blood_pending_requests > 0) {
    alerts.push({
      id: 'blood-pending',
      kind: 'waiting',
      pill: 'Blood',
      message: `${counts.blood_pending_requests} blood request(s) need action`,
      to: '/bloodbank',
      module: 'bloodbank',
    });
  }

  if (counts.blood_units_expiring_14d > 0) {
    alerts.push({
      id: 'blood-expiring',
      kind: 'low_stock',
      pill: 'Expiring',
      message: `${counts.blood_units_expiring_14d} blood unit(s) expire within 14 days`,
      to: '/bloodbank',
      module: 'bloodbank',
    });
  }

  return alerts;
}
