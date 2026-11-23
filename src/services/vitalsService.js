/**
 * Urgent vitals rules from HTML OPD spec:
 * BP ≥ 160/110, temp ≥ 38.5, SpO2 < 92 → URGENT (top of queue).
 */

export function parseBp(bp) {
  if (bp == null) return null;
  if (typeof bp === 'object' && bp.systolic != null) {
    return {
      systolic: Number(bp.systolic),
      diastolic: Number(bp.diastolic),
    };
  }
  const s = String(bp).trim();
  const m = s.match(/^(\d{2,3})\s*[\/\\]\s*(\d{2,3})$/);
  if (!m) return null;
  return { systolic: Number(m[1]), diastolic: Number(m[2]) };
}

/**
 * @param {object} vitals
 * @returns {{ urgent: boolean, reasons: string[] }}
 */
export function evaluateUrgentVitals(vitals = {}) {
  const reasons = [];
  const bp = parseBp(vitals.bp ?? vitals.blood_pressure);
  if (bp && Number.isFinite(bp.systolic) && Number.isFinite(bp.diastolic)) {
    if (bp.systolic >= 160 || bp.diastolic >= 110) {
      reasons.push(`BP ${bp.systolic}/${bp.diastolic}`);
    }
  }
  const temp = Number(vitals.temp ?? vitals.temperature ?? vitals.temp_c);
  if (Number.isFinite(temp) && temp >= 38.5) {
    reasons.push(`Temp ${temp}°C`);
  }
  const spo2 = Number(vitals.spo2 ?? vitals.spO2 ?? vitals.oxygen_sat);
  if (Number.isFinite(spo2) && spo2 < 92) {
    reasons.push(`SpO2 ${spo2}%`);
  }
  return { urgent: reasons.length > 0, reasons };
}

export function computeBmi(weightKg, heightCm) {
  const w = Number(weightKg);
  const h = Number(heightCm);
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return null;
  const m = h / 100;
  return Math.round((w / (m * m)) * 10) / 10;
}

/** Map OPD visit status → workflow stepper index (0–6). */
export const OPD_STEPS = [
  'Check-in',
  'Triage / vitals',
  'Waiting',
  'Consultation',
  'Lab / Pharmacy',
  'Billing',
  'Done',
];

export function opdStatusToStep(status) {
  const map = {
    check_in: 0,
    waiting: 0,
    triage: 1,
    triaged: 1,
    waiting_doctor: 2,
    in_consult: 3,
    in_consultation: 3,
    lab_pharmacy: 4,
    billing: 5,
    completed: 6,
    cancelled: 6,
  };
  return map[status] ?? 0;
}

export function normalizeOpdStatus(status) {
  if (!status) return 'waiting';
  if (status === 'in_consult') return 'in_consultation';
  if (status === 'triaged') return 'waiting_doctor';
  return status;
}
