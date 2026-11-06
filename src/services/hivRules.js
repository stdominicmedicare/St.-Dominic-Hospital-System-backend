/**
 * Pure HIV care rules (Phase 4 / screen 10).
 * VL due: 6 months after ART start, then yearly.
 * Unsuppressed: viral load ≥ 1000 copies/ml.
 * LTFU: missed refill > 28 days.
 */

export const VL_UNSUPPRESSED_THRESHOLD = 1000;
export const LTFU_DAYS = 28;
export const FIRST_VL_MONTHS = 6;
export const ROUTINE_VL_MONTHS = 12;

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const s = String(value).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

export function isoDate(d) {
  if (!d) return null;
  const dt = toDate(d);
  if (!dt) return null;
  return dt.toISOString().slice(0, 10);
}

export function addMonths(dateStr, months) {
  const d = toDate(dateStr);
  if (!d) return null;
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + Number(months));
  return isoDate(out);
}

export function daysBetween(from, to = new Date()) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

/** First VL due 6 months after ART start; subsequent yearly from last VL date (or start+6m). */
export function nextViralLoadDue({ artStartDate, lastVlDate = null, today = new Date() } = {}) {
  if (!artStartDate) return null;
  const firstDue = addMonths(artStartDate, FIRST_VL_MONTHS);
  if (!lastVlDate) return firstDue;
  const next = addMonths(lastVlDate, ROUTINE_VL_MONTHS);
  // If first VL never done and still before/at first due window, keep first due
  const last = toDate(lastVlDate);
  const first = toDate(firstDue);
  if (last && first && last < first) return firstDue;
  return next || firstDue;
}

export function isViralLoadDue({ nextVlDue, today = new Date() } = {}) {
  if (!nextVlDue) return false;
  return daysBetween(nextVlDue, today) >= 0;
}

export function isUnsuppressed(viralLoad) {
  if (viralLoad == null || viralLoad === '') return false;
  const n = Number(viralLoad);
  if (Number.isNaN(n)) return false;
  return n >= VL_UNSUPPRESSED_THRESHOLD;
}

/** Missed refill > 28 days past next_refill_date → lost to follow-up. */
export function isLostToFollowUp({ nextRefillDate, status = 'active', today = new Date() } = {}) {
  if (status === 'lost') return true;
  if (!nextRefillDate) return false;
  const late = daysBetween(nextRefillDate, today);
  return late != null && late > LTFU_DAYS;
}

export function evaluateEnrollmentFlags(enrollment, today = new Date()) {
  const unsuppressed = Boolean(enrollment?.vl_unsuppressed) || isUnsuppressed(enrollment?.last_viral_load);
  const ltfu = isLostToFollowUp({
    nextRefillDate: enrollment?.next_refill_date,
    status: enrollment?.status,
    today,
  });
  const vlDue = isViralLoadDue({ nextVlDue: enrollment?.next_vl_due, today });
  const refillOverdueDays = enrollment?.next_refill_date
    ? daysBetween(enrollment.next_refill_date, today)
    : null;
  return {
    vl_unsuppressed: unsuppressed,
    ltfu_flag: ltfu,
    vl_due: vlDue,
    refill_overdue_days: refillOverdueDays,
    status_suggested: ltfu && enrollment?.status === 'active' ? 'lost' : enrollment?.status || 'active',
  };
}

/**
 * Mask patient identity in list payloads.
 * showName=true only when caller has full HIV portal access.
 */
export function maskHivClient(row, { showName = false } = {}) {
  if (!row) return row;
  const patient = row.patient || null;
  const artNo = row.art_no || null;
  const displayId = artNo || row.hts_no || 'HIV-****';
  const maskedPatient = patient
    ? {
        id: patient.id,
        mrn: showName ? patient.mrn : null,
        full_name: showName ? patient.full_name : null,
        sex: showName ? patient.sex : null,
        date_of_birth: showName ? patient.date_of_birth : null,
      }
    : null;
  return {
    ...row,
    display_id: displayId,
    patient_name_masked: !showName,
    patient: maskedPatient,
    patient_label: showName
      ? patient?.full_name || displayId
      : displayId,
  };
}
