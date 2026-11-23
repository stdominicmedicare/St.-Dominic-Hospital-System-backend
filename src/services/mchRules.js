/**
 * Pure MCH business rules (testable without DB).
 * Spec: screens 05–09 yellow boxes in St-Dominic-HMS HTML.
 */

/** EDD = LMP + 280 days (40 weeks). */
export function eddFromLmp(lmp) {
  if (!lmp) return null;
  const d = new Date(`${String(lmp).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 280);
  return d.toISOString().slice(0, 10);
}

/** Gestational age in completed weeks from LMP (or null). */
export function gaWeeksFromLmp(lmp, onDate = new Date()) {
  if (!lmp) return null;
  const start = new Date(`${String(lmp).slice(0, 10)}T00:00:00.000Z`);
  const on = onDate instanceof Date ? onDate : new Date(`${String(onDate).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(on.getTime())) return null;
  const days = Math.floor((on.getTime() - start.getTime()) / 86400000);
  if (days < 0) return 0;
  return Math.floor(days / 7);
}

export function ageFromDob(dob, onDate = new Date()) {
  if (!dob) return null;
  const d = new Date(`${String(dob).slice(0, 10)}T00:00:00.000Z`);
  const on = onDate instanceof Date ? onDate : new Date(`${String(onDate).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(on.getTime())) return null;
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const m = on.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

/**
 * HIGH RISK if age <18 or >35, BP ≥140/90, Hb <10, previous C-section, multiple pregnancy.
 */
export function evaluateAncHighRisk({
  age = null,
  bpSystolic = null,
  bpDiastolic = null,
  hb = null,
  previousCs = false,
  multiplePregnancy = false,
  extraReasons = [],
} = {}) {
  const reasons = [];
  if (age != null && age < 18) reasons.push('age < 18');
  if (age != null && age > 35) reasons.push('age > 35');
  if (bpSystolic != null && bpSystolic >= 140) reasons.push('BP ≥140/90');
  else if (bpDiastolic != null && bpDiastolic >= 90) reasons.push('BP ≥140/90');
  if (hb != null && Number(hb) < 10) reasons.push(`Hb ${hb}`);
  if (previousCs) reasons.push('previous C-section');
  if (multiplePregnancy) reasons.push('multiple pregnancy');
  for (const r of extraReasons || []) {
    if (r && !reasons.includes(r)) reasons.push(r);
  }
  return { high_risk: reasons.length > 0, reasons };
}

/**
 * Partograph alert: FHR <110 or >160, or cervix progress crosses action line.
 * Action line (simplified WHO-style): once active labour (≥4 cm), expect ~1 cm/hour.
 * If cervix < 4 + (hours since reaching 4 cm) → crosses action line.
 * When hoursSinceActiveLabour unknown, use hoursInLabour after cervix≥4 as proxy.
 */
export function partographAlert({
  fhr = null,
  cervixCm = null,
  hoursInLabour = null,
  hoursSinceActiveLabour = null,
  bpSystolic = null,
  pulse = null,
} = {}) {
  const alerts = [];
  if (fhr != null && (fhr < 110 || fhr > 160)) alerts.push(`FHR ${fhr} (alert)`);
  if (bpSystolic != null && bpSystolic >= 160) alerts.push(`BP ${bpSystolic} high`);
  if (pulse != null && (pulse < 50 || pulse > 120)) alerts.push(`Pulse ${pulse}`);

  const activeHours =
    hoursSinceActiveLabour != null
      ? Number(hoursSinceActiveLabour)
      : cervixCm != null && cervixCm >= 4 && hoursInLabour != null
        ? Math.max(0, Number(hoursInLabour))
        : null;

  if (cervixCm != null && activeHours != null && cervixCm >= 4) {
    const expectedMin = 4 + activeHours; // 1 cm/hour from 4 cm
    if (cervixCm + 0.5 < expectedMin) {
      alerts.push(`action line (cervix ${cervixCm} < expected ~${expectedMin.toFixed(1)})`);
    }
  }

  if (!alerts.length) return { alert: 'On track', urgent: false, expected_cervix: null };
  return {
    alert: alerts.join('; '),
    urgent: true,
    expected_cervix: activeHours != null ? 4 + activeHours : null,
  };
}

/** Default next ANC visit: +4 weeks, or sooner if high risk (+2 weeks). */
export function defaultNextAncVisit(fromDate = new Date(), { highRisk = false } = {}) {
  const d = fromDate instanceof Date ? new Date(fromDate) : new Date(`${String(fromDate).slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + (highRisk ? 14 : 28));
  return d.toISOString().slice(0, 10);
}

/** PNC schedule offsets from delivery date. */
export const PNC_SCHEDULE = [
  { visit_code: 'pnc1_48h', label: 'PNC 1 · Within 48 h', offsetDays: 2 },
  { visit_code: 'pnc2_day3', label: 'PNC 2 · Day 3', offsetDays: 3 },
  { visit_code: 'pnc3_day7_14', label: 'PNC 3 · Day 7–14', offsetDays: 10 },
  { visit_code: 'pnc4_week6', label: 'PNC 4 · Week 6', offsetDays: 42 },
];

export function buildPncScheduleDates(deliveryDate) {
  const base = String(deliveryDate).slice(0, 10);
  const start = new Date(`${base}T00:00:00.000Z`);
  return PNC_SCHEDULE.map((s) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + s.offsetDays);
    return { ...s, due_date: d.toISOString().slice(0, 10) };
  });
}

export function addDays(dateStr, days) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Dose status relative to today.
 * Due = within 7 days; Overdue = past due; Given; Upcoming.
 */
export function immunizationDoseStatus({ dueDate, givenAt = null, today = new Date() } = {}) {
  if (givenAt) return 'given';
  if (!dueDate) return 'upcoming';
  const due = String(dueDate).slice(0, 10);
  const t = today instanceof Date ? today.toISOString().slice(0, 10) : String(today).slice(0, 10);
  if (due < t) return 'overdue';
  const dueMs = new Date(`${due}T00:00:00.000Z`).getTime();
  const tMs = new Date(`${t}T00:00:00.000Z`).getTime();
  const days = Math.round((dueMs - tMs) / 86400000);
  if (days <= 7) return 'due';
  return 'upcoming';
}

export function daysLate(dueDate, today = new Date()) {
  if (!dueDate) return 0;
  const due = new Date(`${String(dueDate).slice(0, 10)}T00:00:00.000Z`);
  const t = today instanceof Date ? today : new Date(`${String(today).slice(0, 10)}T00:00:00.000Z`);
  return Math.max(0, Math.floor((t.getTime() - due.getTime()) / 86400000));
}

/** Default FP re-supply interval by method code (days). */
export const FP_RESUPPLY_DAYS = {
  PILL: 28,
  INJ: 90,
  IMPLANT: 1095,
  IUD: 3650,
  CONDOM: 30,
  NATURAL: 90,
  PERM: null,
};

export function fpResupplyDate(fromDate, methodCode, overrideDays = null) {
  const days = overrideDays != null ? overrideDays : FP_RESUPPLY_DAYS[methodCode];
  if (days == null) return null;
  return addDays(fromDate || new Date().toISOString().slice(0, 10), days);
}

export function pncDangerUrgent(dangerSigns) {
  if (!dangerSigns) return false;
  const t = String(dangerSigns).toLowerCase();
  return /bleed|fever|seiz|convuls|breath|unconscious|cord|jaundice|refus/.test(t);
}
