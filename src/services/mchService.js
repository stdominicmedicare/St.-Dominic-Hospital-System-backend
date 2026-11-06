/**
 * Phase 3 MCH services — ANC, Maternity, PNC, Immunization, Family planning.
 * Cross-links: appointments (bookAppointment), pharmacy (dispenseFefo), billing (addChargeLine),
 * baby MRN (registerHmsPatient), encounters.
 */
import { supabase } from '../config/supabase.js';
import { createEncounter } from './encounterService.js';
import { writeAuditLog } from './auditService.js';
import { bookAppointment } from './appointmentService.js';
import { addChargeLine } from './billingService.js';
import { dispenseFefo } from './stockService.js';
import { registerHmsPatient } from './patientHmsService.js';
import { nextDocumentNo } from './documentSequenceService.js';
import {
  eddFromLmp,
  gaWeeksFromLmp,
  ageFromDob,
  evaluateAncHighRisk,
  partographAlert,
  defaultNextAncVisit,
  buildPncScheduleDates,
  immunizationDoseStatus,
  daysLate,
  fpResupplyDate,
  pncDangerUrgent,
  addDays,
} from './mchRules.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function chargeByCode(code, { patientId, sourceModule, sourceTable, sourceId, actor, req, quantity = 1 }) {
  const { data: item } = await supabase
    .from('charge_items')
    .select('*')
    .eq('code', code)
    .eq('is_active', true)
    .maybeSingle();
  if (!item) return null;
  return addChargeLine({
    patientId,
    chargeItemId: item.id,
    description: item.name,
    quantity,
    unitPrice: item.unit_price ?? item.price ?? 0,
    sourceModule,
    sourceTable,
    sourceId,
    createdBy: actor.id,
    actor,
    req,
  });
}

async function patientBrief(id) {
  if (!id) return null;
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name, first_name, last_name, sex, date_of_birth, phone, mrn, blood_group')
    .eq('id', id)
    .maybeSingle();
  return data;
}

// =============================================================================
// ANC
// =============================================================================

export async function getAncKpis() {
  const { data } = await supabase.from('hms_phase3_mch_counts').select('*').maybeSingle();
  if (data) {
    return {
      active: data.anc_active || 0,
      visits_today: data.anc_visits_today || 0,
      high_risk: data.anc_high_risk || 0,
      due_2w: data.anc_due_2w || 0,
    };
  }
  const today = todayStr();
  const [active, visits, high, due] = await Promise.all([
    supabase.from('anc_pregnancies').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('anc_visits').select('id', { count: 'exact', head: true }).eq('visit_date', today),
    supabase.from('anc_pregnancies').select('id', { count: 'exact', head: true }).eq('status', 'active').eq('high_risk', true),
    supabase
      .from('anc_pregnancies')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .lte('edd', addDays(today, 14))
      .gte('edd', today),
  ]);
  return {
    active: active.count || 0,
    visits_today: visits.count || 0,
    high_risk: high.count || 0,
    due_2w: due.count || 0,
  };
}

export async function listPregnancies({ status = 'active', q = '' } = {}) {
  let query = supabase
    .from('anc_pregnancies')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (status && status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data || [];
  const patientIds = [...new Set(rows.map((r) => r.patient_id))];
  const { data: patients } = patientIds.length
    ? await supabase
        .from('profiles')
        .select('id, full_name, date_of_birth, mrn, blood_group, phone')
        .in('id', patientIds)
    : { data: [] };
  const byId = Object.fromEntries((patients || []).map((p) => [p.id, p]));

  const pregIds = rows.map((r) => r.id);
  const { data: visits } = pregIds.length
    ? await supabase
        .from('anc_visits')
        .select('pregnancy_id, visit_no, visit_date, next_visit_date')
        .in('pregnancy_id', pregIds)
        .order('visit_date', { ascending: false })
    : { data: [] };
  const latestByPreg = {};
  for (const v of visits || []) {
    if (!latestByPreg[v.pregnancy_id]) latestByPreg[v.pregnancy_id] = v;
  }

  return rows
    .map((r) => {
      const p = byId[r.patient_id];
      const latest = latestByPreg[r.id];
      return {
        ...r,
        patient: p || null,
        age: ageFromDob(p?.date_of_birth),
        ga_weeks: gaWeeksFromLmp(r.lmp),
        latest_visit: latest || null,
      };
    })
    .filter((r) => {
      if (!q) return true;
      const s = q.toLowerCase();
      return (
        (r.anc_no || '').toLowerCase().includes(s) ||
        (r.patient?.full_name || '').toLowerCase().includes(s) ||
        (r.patient?.mrn || '').toLowerCase().includes(s)
      );
    });
}

export async function registerPregnancy(body = {}, actor = {}, req = null) {
  if (!body.patient_id) throw new Error('patient_id is required');
  const lmp = body.lmp || null;
  const edd = body.edd || eddFromLmp(lmp);
  const patient = await patientBrief(body.patient_id);
  const age = ageFromDob(patient?.date_of_birth);
  const risk = evaluateAncHighRisk({
    age,
    hb: body.hb_g_dl,
    previousCs: Boolean(body.previous_cs),
    multiplePregnancy: Boolean(body.multiple_pregnancy),
  });

  const ancNo = await nextDocumentNo('anc');
  const payload = {
    patient_id: body.patient_id,
    anc_no: ancNo,
    lmp,
    edd,
    gravida: body.gravida != null ? parseInt(body.gravida, 10) : null,
    para: body.para != null ? parseInt(body.para, 10) : null,
    blood_group: body.blood_group || patient?.blood_group || null,
    hiv_status: body.hiv_status || null,
    syphilis_status: body.syphilis_status || null,
    hb_g_dl: body.hb_g_dl != null ? Number(body.hb_g_dl) : null,
    previous_complications: body.previous_complications || null,
    husband_name: body.husband_name || null,
    next_of_kin: body.next_of_kin || null,
    multiple_pregnancy: Boolean(body.multiple_pregnancy),
    previous_cs: Boolean(body.previous_cs),
    high_risk: risk.high_risk,
    high_risk_reasons: risk.reasons,
    risk_notes: body.risk_notes || (risk.reasons.length ? risk.reasons.join('; ') : null),
    status: 'active',
    created_by: actor.id || null,
  };

  const { data, error } = await supabase.from('anc_pregnancies').insert(payload).select('*').single();
  if (error) throw error;

  const encounter = await createEncounter({
    patientId: body.patient_id,
    module: 'anc',
    staffId: actor.id,
    status: 'in_progress',
    metadata: { anc_no: ancNo, pregnancy_id: data.id },
    sourceTable: 'anc_pregnancies',
    sourceId: data.id,
  });
  await supabase.from('anc_pregnancies').update({ encounter_id: encounter.id }).eq('id', data.id);

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'create',
    resourceType: 'anc_pregnancy',
    resourceId: data.id,
    patientId: body.patient_id,
    module: 'anc',
    after: data,
    req,
  });

  return { ...data, encounter_id: encounter.id, patient };
}

export async function listAncVisits(pregnancyId) {
  const { data, error } = await supabase
    .from('anc_visits')
    .select('*')
    .eq('pregnancy_id', pregnancyId)
    .order('visit_no', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function saveAncVisit(body = {}, actor = {}, req = null) {
  if (!body.pregnancy_id) throw new Error('pregnancy_id is required');
  const { data: preg } = await supabase.from('anc_pregnancies').select('*').eq('id', body.pregnancy_id).single();
  if (!preg) throw new Error('Pregnancy not found');

  const patient = await patientBrief(preg.patient_id);
  const age = ageFromDob(patient?.date_of_birth);
  const visitDate = body.visit_date || todayStr();
  const ga = body.gestational_age_weeks != null ? Number(body.gestational_age_weeks) : gaWeeksFromLmp(preg.lmp, visitDate);

  const risk = evaluateAncHighRisk({
    age,
    bpSystolic: body.bp_systolic,
    bpDiastolic: body.bp_diastolic,
    hb: body.hb_g_dl != null ? body.hb_g_dl : preg.hb_g_dl,
    previousCs: preg.previous_cs,
    multiplePregnancy: preg.multiple_pregnancy,
    extraReasons: preg.high_risk_reasons,
  });

  const existingVisits = await listAncVisits(preg.id);
  const visitNo = body.visit_no != null ? parseInt(body.visit_no, 10) : (existingVisits.length || 0) + 1;
  const nextVisit =
    body.next_visit_date || defaultNextAncVisit(visitDate, { highRisk: risk.high_risk });

  const payload = {
    pregnancy_id: preg.id,
    visit_no: visitNo,
    visit_date: visitDate,
    gestational_age_weeks: ga,
    weight_kg: body.weight_kg != null ? Number(body.weight_kg) : null,
    bp_systolic: body.bp_systolic != null ? parseInt(body.bp_systolic, 10) : null,
    bp_diastolic: body.bp_diastolic != null ? parseInt(body.bp_diastolic, 10) : null,
    fundal_height_cm: body.fundal_height_cm != null ? Number(body.fundal_height_cm) : null,
    fetal_heart_rate: body.fetal_heart_rate != null ? parseInt(body.fetal_heart_rate, 10) : null,
    presentation: body.presentation || null,
    oedema: body.oedema || null,
    iptp_given: Boolean(body.iptp_given),
    iron_folate_given: Boolean(body.iron_folate_given),
    td_given: Boolean(body.td_given),
    bed_net_given: Boolean(body.bed_net_given),
    danger_signs: body.danger_signs || body.notes || null,
    next_visit_date: nextVisit,
    notes: body.notes || null,
    created_by: actor.id || null,
  };

  const { data: visit, error } = await supabase.from('anc_visits').insert(payload).select('*').single();
  if (error) throw error;

  await supabase
    .from('anc_pregnancies')
    .update({
      high_risk: risk.high_risk,
      high_risk_reasons: risk.reasons,
      risk_notes: risk.reasons.join('; ') || preg.risk_notes,
      hb_g_dl: body.hb_g_dl != null ? Number(body.hb_g_dl) : preg.hb_g_dl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', preg.id);

  let appointment = null;
  if (nextVisit) {
    appointment = await bookAppointment({
      patientId: preg.patient_id,
      clinic: 'anc',
      scheduledAt: `${nextVisit}T09:00:00.000Z`,
      reason: `ANC ${visitNo + 1}`,
      sourceModule: 'anc',
      actor,
      req,
    });
    await supabase.from('anc_visits').update({ appointment_id: appointment.id }).eq('id', visit.id);
  }

  const encounter = await createEncounter({
    patientId: preg.patient_id,
    module: 'anc',
    staffId: actor.id,
    status: 'done',
    metadata: { visit_no: visitNo, pregnancy_id: preg.id },
    sourceTable: 'anc_visits',
    sourceId: visit.id,
  });
  await supabase.from('anc_visits').update({ encounter_id: encounter.id }).eq('id', visit.id);

  let charge = null;
  try {
    charge = await chargeByCode('ANC-VISIT', {
      patientId: preg.patient_id,
      sourceModule: 'anc',
      sourceTable: 'anc_visits',
      sourceId: visit.id,
      actor,
      req,
    });
  } catch {
    /* billing optional if not migrated */
  }

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'create',
    resourceType: 'anc_visit',
    resourceId: visit.id,
    patientId: preg.patient_id,
    module: 'anc',
    after: visit,
    req,
  });

  return {
    visit: { ...visit, appointment_id: appointment?.id || null, encounter_id: encounter.id },
    pregnancy: { ...preg, high_risk: risk.high_risk, high_risk_reasons: risk.reasons },
    appointment,
    charge,
    high_risk: risk,
  };
}

export async function listAncDefaulters() {
  const today = todayStr();
  const active = await listPregnancies({ status: 'active' });
  const defaulters = [];
  for (const p of active) {
    const next = p.latest_visit?.next_visit_date;
    if (next && next < today) {
      defaulters.push({
        ...p,
        days_late: daysLate(next, today),
        missed_date: next,
      });
    }
  }
  return defaulters.sort((a, b) => b.days_late - a.days_late);
}

export async function referToMaternity(pregnancyId, actor = {}, req = null) {
  const { data: preg } = await supabase.from('anc_pregnancies').select('*').eq('id', pregnancyId).single();
  if (!preg) throw new Error('Pregnancy not found');
  const { data, error } = await supabase
    .from('anc_pregnancies')
    .update({
      referred_to_maternity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', pregnancyId)
    .select('*')
    .single();
  if (error) throw error;
  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'update',
    resourceType: 'anc_pregnancy',
    resourceId: pregnancyId,
    patientId: preg.patient_id,
    module: 'anc',
    before: preg,
    after: data,
    metadata: { referred_to_maternity: true },
    req,
  });
  return data;
}

// =============================================================================
// Maternity
// =============================================================================

export async function getMaternityKpis() {
  const { data } = await supabase.from('hms_phase3_mch_counts').select('*').maybeSingle();
  if (data) {
    return {
      in_labour: data.maternity_in_labour || 0,
      deliveries_today: data.deliveries_today || 0,
      deliveries_mtd: data.deliveries_mtd || 0,
      beds_free: Math.max(0, 4 - (data.maternity_in_labour || 0)),
    };
  }
  return { in_labour: 0, deliveries_today: 0, deliveries_mtd: 0, beds_free: 4 };
}

export async function listLabourBoard() {
  const { data, error } = await supabase
    .from('maternity_admissions')
    .select('*')
    .in('status', ['in_labour'])
    .order('admitted_at', { ascending: true });
  if (error) throw error;
  const rows = data || [];
  const enriched = [];
  for (const row of rows) {
    const patient = await patientBrief(row.patient_id);
    let pregnancy = null;
    if (row.pregnancy_id) {
      const { data: preg } = await supabase.from('anc_pregnancies').select('*').eq('id', row.pregnancy_id).maybeSingle();
      pregnancy = preg;
    }
    enriched.push({
      ...row,
      patient,
      pregnancy,
      ga_weeks: row.gestational_age_weeks || gaWeeksFromLmp(pregnancy?.lmp),
    });
  }
  // Fill free beds L1–L4
  const occupiedBeds = new Set(enriched.map((r) => r.bed).filter(Boolean));
  const board = [];
  for (let i = 1; i <= 4; i += 1) {
    const bed = `L${i}`;
    const occ = enriched.find((r) => r.bed === bed);
    board.push(occ || { bed, status: 'free' });
  }
  // Also include admissions without bed labels
  for (const r of enriched) {
    if (!r.bed || !/^L[1-4]$/.test(r.bed)) board.push(r);
  }
  return board;
}

export async function admitToLabour(body = {}, actor = {}, req = null) {
  if (!body.patient_id) throw new Error('patient_id is required');
  let pregnancyId = body.pregnancy_id || null;
  let pregnancy = null;
  if (pregnancyId) {
    const { data } = await supabase.from('anc_pregnancies').select('*').eq('id', pregnancyId).single();
    pregnancy = data;
  } else {
    const { data } = await supabase
      .from('anc_pregnancies')
      .select('*')
      .eq('patient_id', body.patient_id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    pregnancy = data;
    pregnancyId = data?.id || null;
  }

  const bed = body.bed || null;
  const payload = {
    patient_id: body.patient_id,
    pregnancy_id: pregnancyId,
    ward: body.ward || 'Labour',
    bed,
    gestational_age_weeks:
      body.gestational_age_weeks != null
        ? Number(body.gestational_age_weeks)
        : gaWeeksFromLmp(pregnancy?.lmp),
    membranes: body.membranes || null,
    cervix_cm: body.cervix_cm != null ? Number(body.cervix_cm) : null,
    contractions_per_10min:
      body.contractions_per_10min != null ? parseInt(body.contractions_per_10min, 10) : null,
    fhr: body.fhr != null ? parseInt(body.fhr, 10) : null,
    notes: body.notes || null,
    status: 'in_labour',
    created_by: actor.id || null,
  };

  const { data, error } = await supabase.from('maternity_admissions').insert(payload).select('*').single();
  if (error) throw error;

  if (pregnancyId) {
    await supabase
      .from('anc_pregnancies')
      .update({
        referred_to_maternity_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', pregnancyId);
  }

  const encounter = await createEncounter({
    patientId: body.patient_id,
    module: 'maternity',
    staffId: actor.id,
    status: 'in_progress',
    metadata: { admission_id: data.id, bed },
    sourceTable: 'maternity_admissions',
    sourceId: data.id,
  });
  await supabase.from('maternity_admissions').update({ encounter_id: encounter.id }).eq('id', data.id);

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'create',
    resourceType: 'maternity_admission',
    resourceId: data.id,
    patientId: body.patient_id,
    module: 'maternity',
    after: data,
    req,
  });

  return { ...data, pregnancy, encounter_id: encounter.id };
}

export async function addPartographEntry(admissionId, body = {}, actor = {}, req = null) {
  const { data: adm } = await supabase.from('maternity_admissions').select('*').eq('id', admissionId).single();
  if (!adm) throw new Error('Admission not found');
  const hours =
    body.hours_in_labour != null
      ? Number(body.hours_in_labour)
      : (Date.now() - new Date(adm.admitted_at).getTime()) / 3600000;
  const alert = partographAlert({
    fhr: body.fhr != null ? parseInt(body.fhr, 10) : null,
    cervixCm: body.cervix_cm != null ? Number(body.cervix_cm) : null,
    hoursInLabour: hours,
    bpSystolic: body.bp_systolic != null ? parseInt(body.bp_systolic, 10) : null,
    pulse: body.pulse != null ? parseInt(body.pulse, 10) : null,
  });

  const payload = {
    admission_id: admissionId,
    recorded_at: body.recorded_at || new Date().toISOString(),
    cervix_cm: body.cervix_cm != null ? Number(body.cervix_cm) : null,
    fhr: body.fhr != null ? parseInt(body.fhr, 10) : null,
    contractions_per_10min:
      body.contractions_per_10min != null ? parseInt(body.contractions_per_10min, 10) : null,
    bp_systolic: body.bp_systolic != null ? parseInt(body.bp_systolic, 10) : null,
    bp_diastolic: body.bp_diastolic != null ? parseInt(body.bp_diastolic, 10) : null,
    pulse: body.pulse != null ? parseInt(body.pulse, 10) : null,
    alert: alert.alert,
    notes: body.notes || null,
    created_by: actor.id || null,
  };

  const { data, error } = await supabase.from('partograph_entries').insert(payload).select('*').single();
  if (error) throw error;

  await supabase
    .from('maternity_admissions')
    .update({
      cervix_cm: payload.cervix_cm ?? adm.cervix_cm,
      fhr: payload.fhr ?? adm.fhr,
      contractions_per_10min: payload.contractions_per_10min ?? adm.contractions_per_10min,
      next_check_at: new Date(Date.now() + 30 * 60000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', admissionId);

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'create',
    resourceType: 'partograph_entry',
    resourceId: data.id,
    patientId: adm.patient_id,
    module: 'maternity',
    after: data,
    req,
  });

  return {
    ...data,
    urgent: alert.urgent,
    expected_cervix_cm: alert.expected_cervix ?? alert.expected_cervix_cm ?? null,
    hours_in_labour: Math.round(hours * 10) / 10,
  };
}

export async function listPartograph(admissionId) {
  const { data, error } = await supabase
    .from('partograph_entries')
    .select('*')
    .eq('admission_id', admissionId)
    .order('recorded_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function saveDelivery(body = {}, actor = {}, req = null) {
  if (!body.admission_id) throw new Error('admission_id is required');
  const { data: adm } = await supabase.from('maternity_admissions').select('*').eq('id', body.admission_id).single();
  if (!adm) throw new Error('Admission not found');

  const deliveredAt = body.delivered_at || new Date().toISOString();
  const deliveryDate = deliveredAt.slice(0, 10);

  const { data: delivery, error } = await supabase
    .from('deliveries')
    .insert({
      admission_id: adm.id,
      delivered_at: deliveredAt,
      mode: body.mode || 'svd',
      outcome: body.outcome || 'live_birth',
      complications: body.complications || null,
      attendant: body.attendant || null,
      blood_loss_ml: body.blood_loss_ml != null ? parseInt(body.blood_loss_ml, 10) : null,
      placenta_complete: body.placenta_complete != null ? Boolean(body.placenta_complete) : null,
      notes: body.notes || null,
      created_by: actor.id || null,
    })
    .select('*')
    .single();
  if (error) throw error;

  await supabase
    .from('maternity_admissions')
    .update({ status: 'delivered', updated_at: new Date().toISOString() })
    .eq('id', adm.id);

  if (adm.pregnancy_id) {
    await supabase
      .from('anc_pregnancies')
      .update({ status: 'delivered', updated_at: new Date().toISOString() })
      .eq('id', adm.pregnancy_id);
  }

  const mother = await patientBrief(adm.patient_id);
  let newborn = null;
  let babyPatient = null;
  let vaccineCard = [];
  let pncSchedule = [];

  const nb = body.newborn || {};
  const isLive = (body.outcome || 'live_birth') === 'live_birth';

  if (isLive) {
    // Baby gets OWN patient record linked to mother
    const motherSurname = (mother?.last_name || mother?.full_name || 'Baby').split(/\s+/).pop();
    babyPatient = await registerHmsPatient(
      {
        first_name: nb.first_name || 'Baby',
        last_name: nb.last_name || `of ${motherSurname}`,
        sex: nb.sex === 'female' ? 'female' : nb.sex === 'male' ? 'male' : 'unknown',
        date_of_birth: deliveryDate,
        next_of_kin: mother?.full_name || null,
        next_of_kin_phone: mother?.phone || null,
        data_consent: true,
        force_duplicate: true,
      },
      actor,
      req
    );

    const weightG =
      nb.birth_weight_g != null
        ? parseInt(nb.birth_weight_g, 10)
        : nb.weight_kg != null
          ? Math.round(Number(nb.weight_kg) * 1000)
          : null;

    const { data: n, error: nErr } = await supabase
      .from('newborns')
      .insert({
        delivery_id: delivery.id,
        sex: nb.sex || null,
        birth_weight_g: weightG,
        apgar_1: nb.apgar_1 != null ? parseInt(nb.apgar_1, 10) : null,
        apgar_5: nb.apgar_5 != null ? parseInt(nb.apgar_5, 10) : null,
        linked_patient_id: babyPatient.id,
        mother_patient_id: adm.patient_id,
        bcg_given: Boolean(nb.bcg_given),
        opv0_given: Boolean(nb.opv0_given),
        notes: nb.notes || null,
      })
      .select('*')
      .single();
    if (nErr) throw nErr;
    newborn = n;

    // Create PNC schedule + appointments
    const scheduleDates = buildPncScheduleDates(deliveryDate);
    for (const s of scheduleDates) {
      let appointment = null;
      try {
        appointment = await bookAppointment({
          patientId: adm.patient_id,
          clinic: 'pnc',
          scheduledAt: `${s.due_date}T09:00:00.000Z`,
          reason: s.label,
          sourceModule: 'maternity',
          notes: `Baby ${babyPatient.mrn || babyPatient.id}`,
          actor,
          req,
        });
      } catch {
        /* continue */
      }
      const { data: sched } = await supabase
        .from('pnc_schedules')
        .insert({
          mother_id: adm.patient_id,
          newborn_id: newborn.id,
          baby_patient_id: babyPatient.id,
          delivery_id: delivery.id,
          visit_code: s.visit_code,
          due_date: s.due_date,
          status: 'booked',
          appointment_id: appointment?.id || null,
        })
        .select('*')
        .single();
      if (sched) pncSchedule.push(sched);
    }

    // Create immunization card from schedule
    vaccineCard = await createImmunizationCardForChild(babyPatient.id, deliveryDate, actor, req, {
      bcgGiven: Boolean(nb.bcg_given),
      opv0Given: Boolean(nb.opv0_given),
    });
  }

  // Delivery charge
  let charge = null;
  try {
    charge = await chargeByCode('MAT-DELIVERY', {
      patientId: adm.patient_id,
      sourceModule: 'maternity',
      sourceTable: 'deliveries',
      sourceId: delivery.id,
      actor,
      req,
    });
    if (charge?.line?.id) {
      await supabase.from('deliveries').update({ invoice_line_id: charge.line.id }).eq('id', delivery.id);
    }
  } catch {
    /* optional */
  }

  // Bed-day charge (at least 1 day)
  try {
    const admitted = new Date(adm.admitted_at);
    const days = Math.max(1, Math.ceil((new Date(deliveredAt) - admitted) / 86400000));
    await chargeByCode('MAT-BED-DAY', {
      patientId: adm.patient_id,
      sourceModule: 'maternity',
      sourceTable: 'maternity_admissions',
      sourceId: adm.id,
      actor,
      req,
      quantity: days,
    });
  } catch {
    /* optional */
  }

  const encounter = await createEncounter({
    patientId: adm.patient_id,
    module: 'maternity',
    staffId: actor.id,
    status: 'done',
    metadata: { delivery_id: delivery.id, baby_patient_id: babyPatient?.id },
    sourceTable: 'deliveries',
    sourceId: delivery.id,
  });
  await supabase.from('deliveries').update({ encounter_id: encounter.id }).eq('id', delivery.id);

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'create',
    resourceType: 'delivery',
    resourceId: delivery.id,
    patientId: adm.patient_id,
    module: 'maternity',
    after: { delivery, newborn, babyPatient },
    req,
  });

  return {
    delivery: { ...delivery, encounter_id: encounter.id },
    newborn,
    baby_patient: babyPatient,
    pnc_schedule: pncSchedule,
    vaccine_card: vaccineCard,
    charge,
  };
}

export async function listDeliveries({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('deliveries')
    .select('*, maternity_admissions(patient_id, bed, pregnancy_id)')
    .order('delivered_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// =============================================================================
// PNC
// =============================================================================

export async function getPncKpis() {
  const { data } = await supabase.from('hms_phase3_mch_counts').select('*').maybeSingle();
  if (data) {
    return {
      mothers: data.pnc_mothers_active || 0,
      due_today: data.pnc_due_today || 0,
      overdue: data.pnc_overdue || 0,
      danger_week: 0,
    };
  }
  return { mothers: 0, due_today: 0, overdue: 0, danger_week: 0 };
}

export async function listPncDue({ includeMissed = true } = {}) {
  const today = todayStr();
  let q = supabase
    .from('pnc_schedules')
    .select('*')
    .in('status', includeMissed ? ['booked', 'arrived', 'missed'] : ['booked', 'arrived'])
    .order('due_date', { ascending: true })
    .limit(100);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  const enriched = [];
  for (const row of rows) {
    const mother = await patientBrief(row.mother_id);
    const baby = row.baby_patient_id ? await patientBrief(row.baby_patient_id) : null;
    let delivery = null;
    if (row.delivery_id) {
      const { data: d } = await supabase.from('deliveries').select('*').eq('id', row.delivery_id).maybeSingle();
      delivery = d;
    }
    let status = row.status;
    if (row.status === 'booked' && row.due_date < today) status = 'missed';
    else if (row.status === 'booked' && row.due_date === today) status = 'booked';
    enriched.push({
      ...row,
      status,
      days_late: daysLate(row.due_date, today),
      mother,
      baby,
      delivery,
    });
  }
  return enriched;
}

export async function savePncVisit(body = {}, actor = {}, req = null) {
  if (!body.mother_id) throw new Error('mother_id is required');
  const visitDate = body.visit_date || todayStr();
  const danger = body.danger_signs || null;
  const urgent = Boolean(body.is_urgent) || pncDangerUrgent(danger);

  const payload = {
    mother_id: body.mother_id,
    newborn_id: body.newborn_id || null,
    delivery_id: body.delivery_id || null,
    schedule_id: body.schedule_id || null,
    visit_code: body.visit_code || null,
    visit_no: body.visit_no != null ? parseInt(body.visit_no, 10) : null,
    visit_date: visitDate,
    mother_bp_systolic: body.mother_bp_systolic != null ? parseInt(body.mother_bp_systolic, 10) : null,
    mother_bp_diastolic: body.mother_bp_diastolic != null ? parseInt(body.mother_bp_diastolic, 10) : null,
    mother_temp_c: body.mother_temp_c != null ? Number(body.mother_temp_c) : null,
    bleeding: body.bleeding || null,
    breastfeeding: body.breastfeeding || null,
    mood_screen: Boolean(body.mood_screen),
    fp_counselled: Boolean(body.fp_counselled),
    baby_weight_kg: body.baby_weight_kg != null ? Number(body.baby_weight_kg) : null,
    baby_temp_c: body.baby_temp_c != null ? Number(body.baby_temp_c) : null,
    cord_status: body.cord_status || null,
    jaundice: body.jaundice || null,
    danger_signs: danger,
    is_urgent: urgent,
    mother_status: body.mother_status || null,
    baby_status: body.baby_status || null,
    next_visit_date: body.next_visit_date || null,
    notes: body.notes || null,
    created_by: actor.id || null,
  };

  const { data: visit, error } = await supabase.from('pnc_visits').insert(payload).select('*').single();
  if (error) throw error;

  if (body.schedule_id) {
    await supabase
      .from('pnc_schedules')
      .update({
        status: 'completed',
        completed_visit_id: visit.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', body.schedule_id);
  }

  let appointment = null;
  // Week-6 links FP + immunization; book week-6 if earlier visit
  if (body.visit_code !== 'pnc4_week6' && body.next_visit_date) {
    appointment = await bookAppointment({
      patientId: body.mother_id,
      clinic: 'pnc',
      scheduledAt: `${body.next_visit_date}T09:00:00.000Z`,
      reason: 'PNC follow-up',
      sourceModule: 'pnc',
      actor,
      req,
    });
    await supabase.from('pnc_visits').update({ appointment_id: appointment.id }).eq('id', visit.id);
  }

  let fpLink = null;
  let immLink = null;
  if (body.visit_code === 'pnc4_week6' || body.link_fp || body.link_immunization) {
    if (body.link_fp !== false) {
      fpLink = { portal: 'fp', mother_id: body.mother_id, counselled: true };
    }
    if (body.baby_patient_id || body.link_immunization) {
      immLink = { portal: 'immunization', patient_id: body.baby_patient_id || null };
    }
  }

  const encounter = await createEncounter({
    patientId: body.mother_id,
    module: 'pnc',
    staffId: actor.id,
    status: 'done',
    metadata: { visit_code: body.visit_code, urgent },
    sourceTable: 'pnc_visits',
    sourceId: visit.id,
  });
  await supabase.from('pnc_visits').update({ encounter_id: encounter.id }).eq('id', visit.id);

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'create',
    resourceType: 'pnc_visit',
    resourceId: visit.id,
    patientId: body.mother_id,
    module: 'pnc',
    after: visit,
    req,
  });

  return {
    visit: { ...visit, encounter_id: encounter.id, is_urgent: urgent },
    appointment,
    links: { fp: fpLink, immunization: immLink },
  };
}

// =============================================================================
// Immunization
// =============================================================================

export async function createImmunizationCardForChild(patientId, dob, actor = {}, req = null, opts = {}) {
  const { data: schedule, error } = await supabase
    .from('immunization_schedule')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw error;
  const card = [];
  for (const s of schedule || []) {
    const due = addDays(dob, s.age_days);
    let status = immunizationDoseStatus({ dueDate: due });
    let givenAt = null;
    // Birth doses optionally marked given at delivery
    if (s.age_days === 0 && s.vaccine_code === 'BCG' && opts.bcgGiven) {
      status = 'given';
      givenAt = dob;
    }
    if (s.age_days === 0 && s.vaccine_code === 'OPV' && s.dose_no === 1 && opts.opv0Given) {
      status = 'given';
      givenAt = dob;
    }
    const { data: dose, error: dErr } = await supabase
      .from('immunization_card_doses')
      .upsert(
        {
          patient_id: patientId,
          schedule_id: s.id,
          vaccine_code: s.vaccine_code,
          dose_no: s.dose_no,
          due_date: due,
          status,
          given_at: givenAt,
          medicine_id: s.medicine_id || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'patient_id,vaccine_code,dose_no' }
      )
      .select('*')
      .single();
    if (!dErr && dose) card.push({ ...dose, vaccine_name: s.vaccine_name });
  }
  return card;
}

export async function getImmKpis() {
  const { data } = await supabase.from('hms_phase3_mch_counts').select('*').maybeSingle();
  if (data) {
    return {
      children: data.imm_children || 0,
      due_week: data.imm_due_week || 0,
      overdue: data.imm_overdue || 0,
      given_today: data.imm_given_today || 0,
    };
  }
  return { children: 0, due_week: 0, overdue: 0, given_today: 0 };
}

export async function listImmunizationSchedule() {
  const { data, error } = await supabase
    .from('immunization_schedule')
    .select('*')
    .order('sort_order');
  if (error) throw error;
  return data || [];
}

export async function upsertImmunizationSchedule(body = {}, actor = {}, req = null) {
  const row = {
    vaccine_code: String(body.vaccine_code || '').trim().toUpperCase(),
    vaccine_name: String(body.vaccine_name || body.vaccine_code || '').trim(),
    dose_no: body.dose_no != null ? parseInt(body.dose_no, 10) : 1,
    age_days: body.age_days != null ? parseInt(body.age_days, 10) : 0,
    sort_order: body.sort_order != null ? parseInt(body.sort_order, 10) : 0,
    is_active: body.is_active !== false,
    medicine_id: body.medicine_id || null,
    updated_at: new Date().toISOString(),
  };
  if (!row.vaccine_code) throw new Error('vaccine_code required');
  const { data, error } = await supabase
    .from('immunization_schedule')
    .upsert(row, { onConflict: 'vaccine_code,dose_no' })
    .select('*')
    .single();
  if (error) throw error;
  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'upsert',
    resourceType: 'immunization_schedule',
    resourceId: data.id,
    module: 'immunization',
    after: data,
    req,
  });
  return data;
}

export async function listVaccineCards({ status = null, overdueOnly = false } = {}) {
  const today = todayStr();
  // Refresh overdue statuses
  await supabase
    .from('immunization_card_doses')
    .update({ status: 'overdue', updated_at: new Date().toISOString() })
    .lt('due_date', today)
    .in('status', ['upcoming', 'due']);

  await supabase
    .from('immunization_card_doses')
    .update({ status: 'due', updated_at: new Date().toISOString() })
    .gte('due_date', today)
    .lte('due_date', addDays(today, 7))
    .eq('status', 'upcoming');

  let q = supabase
    .from('immunization_card_doses')
    .select('*')
    .order('due_date', { ascending: true })
    .limit(200);
  if (overdueOnly) q = q.eq('status', 'overdue');
  else if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  const patientIds = [...new Set(rows.map((r) => r.patient_id))];
  const { data: patients } = patientIds.length
    ? await supabase.from('profiles').select('id, full_name, mrn, date_of_birth').in('id', patientIds)
    : { data: [] };
  const byId = Object.fromEntries((patients || []).map((p) => [p.id, p]));
  return rows.map((r) => ({
    ...r,
    patient: byId[r.patient_id] || null,
    days_late: r.status === 'overdue' ? daysLate(r.due_date, today) : 0,
  }));
}

export async function getChildVaccineCard(patientId) {
  const { data, error } = await supabase
    .from('immunization_card_doses')
    .select('*')
    .eq('patient_id', patientId)
    .order('due_date');
  if (error) throw error;
  const patient = await patientBrief(patientId);
  return { patient, doses: data || [] };
}

export async function registerImmChild(body = {}, actor = {}, req = null) {
  let patientId = body.patient_id;
  let patient = null;
  if (!patientId) {
    patient = await registerHmsPatient(
      {
        first_name: body.first_name,
        last_name: body.last_name,
        sex: body.sex || 'unknown',
        date_of_birth: body.date_of_birth,
        phone: body.phone,
        next_of_kin: body.next_of_kin,
        next_of_kin_phone: body.next_of_kin_phone,
        data_consent: true,
        force_duplicate: Boolean(body.force_duplicate),
      },
      actor,
      req
    );
    patientId = patient.id;
  } else {
    patient = await patientBrief(patientId);
  }
  const dob = body.date_of_birth || patient?.date_of_birth;
  if (!dob) throw new Error('date_of_birth required to build vaccine card');
  const card = await createImmunizationCardForChild(patientId, dob, actor, req);
  return { patient, card };
}

export async function recordVaccineDose(body = {}, actor = {}, req = null) {
  if (!body.patient_id) throw new Error('patient_id required');
  if (!body.card_dose_id && !(body.vaccine_code && body.dose_no)) {
    throw new Error('card_dose_id or vaccine_code+dose_no required');
  }

  let cardDose = null;
  if (body.card_dose_id) {
    const { data } = await supabase.from('immunization_card_doses').select('*').eq('id', body.card_dose_id).single();
    cardDose = data;
  } else {
    const { data } = await supabase
      .from('immunization_card_doses')
      .select('*')
      .eq('patient_id', body.patient_id)
      .eq('vaccine_code', body.vaccine_code)
      .eq('dose_no', body.dose_no)
      .maybeSingle();
    cardDose = data;
  }
  if (!cardDose) throw new Error('Vaccine card dose not found');

  const givenAt = body.given_at || todayStr();
  const medicineId = body.medicine_id || cardDose.medicine_id;

  // Resolve vaccine_id for immunization_records
  const { data: vaccine } = await supabase
    .from('vaccines')
    .select('*')
    .eq('code', cardDose.vaccine_code)
    .maybeSingle();

  let stock = null;
  let batchNo = body.batch_no || null;
  if (medicineId && body.deduct_stock !== false) {
    stock = await dispenseFefo({
      medicineId,
      quantity: Number(body.quantity) || 1,
      referenceType: 'immunization',
      referenceId: cardDose.id,
      actor,
      req,
    });
    batchNo = batchNo || stock.allocations?.[0]?.batch_no || null;
  }

  const { data: record, error } = await supabase
    .from('immunization_records')
    .insert({
      patient_id: body.patient_id,
      vaccine_id: vaccine?.id || body.vaccine_id,
      dose_no: cardDose.dose_no,
      given_at: givenAt,
      batch_no: batchNo,
      site: body.site || null,
      notes: body.reaction_notes || body.notes || null,
      given_by: actor.id || null,
      schedule_id: cardDose.schedule_id,
      card_dose_id: cardDose.id,
      medicine_id: medicineId || null,
      stock_movement_id: stock?.movements?.[0]?.id || null,
    })
    .select('*')
    .single();
  if (error) throw error;

  await supabase
    .from('immunization_card_doses')
    .update({
      status: 'given',
      given_at: givenAt,
      batch_no: batchNo,
      site: body.site || null,
      reaction_notes: body.reaction_notes || null,
      record_id: record.id,
      stock_movement_id: stock?.movements?.[0]?.id || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', cardDose.id);

  // Book next due dose appointment
  const { data: nextDoses } = await supabase
    .from('immunization_card_doses')
    .select('*')
    .eq('patient_id', body.patient_id)
    .in('status', ['upcoming', 'due', 'overdue'])
    .order('due_date', { ascending: true })
    .limit(1);

  let appointment = null;
  const next = nextDoses?.[0];
  if (next) {
    appointment = await bookAppointment({
      patientId: body.patient_id,
      clinic: 'immunization',
      scheduledAt: `${next.due_date}T09:00:00.000Z`,
      reason: `${next.vaccine_code} dose ${next.dose_no}`,
      sourceModule: 'immunization',
      actor,
      req,
    });
    await supabase
      .from('immunization_card_doses')
      .update({ appointment_id: appointment.id })
      .eq('id', next.id);
    await supabase.from('immunization_records').update({ appointment_id: appointment.id, next_due: next.due_date }).eq('id', record.id);
  }

  try {
    await chargeByCode('IMM-DOSE', {
      patientId: body.patient_id,
      sourceModule: 'immunization',
      sourceTable: 'immunization_records',
      sourceId: record.id,
      actor,
      req,
    });
  } catch {
    /* optional */
  }

  const encounter = await createEncounter({
    patientId: body.patient_id,
    module: 'immunization',
    staffId: actor.id,
    status: 'done',
    metadata: { vaccine_code: cardDose.vaccine_code, dose_no: cardDose.dose_no },
    sourceTable: 'immunization_records',
    sourceId: record.id,
  });
  await supabase.from('immunization_records').update({ encounter_id: encounter.id }).eq('id', record.id);

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'create',
    resourceType: 'immunization',
    resourceId: record.id,
    patientId: body.patient_id,
    module: 'immunization',
    after: record,
    metadata: { stock },
    req,
  });

  return { record, stock, appointment, next_dose: next || null };
}

// =============================================================================
// Family planning
// =============================================================================

export async function getFpKpis() {
  const { data } = await supabase.from('hms_phase3_mch_counts').select('*').maybeSingle();
  if (data) {
    return {
      clients_today: data.fp_clients_today || 0,
      new_mtd: data.fp_new_mtd || 0,
      continuing_mtd: data.fp_continuing_mtd || 0,
      resupply_overdue: data.fp_resupply_overdue || 0,
    };
  }
  return { clients_today: 0, new_mtd: 0, continuing_mtd: 0, resupply_overdue: 0 };
}

export async function listFpMethods() {
  const { data, error } = await supabase.from('fp_methods').select('*').eq('is_active', true).order('name');
  if (error) throw error;
  return data || [];
}

export async function listFpClients({ overdueOnly = false } = {}) {
  const today = todayStr();
  let q = supabase.from('fp_encounters').select('*').order('provided_at', { ascending: false }).limit(150);
  if (overdueOnly) {
    q = q.lt('next_visit', today).not('next_visit', 'is', null);
  }
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  // latest per patient
  const seen = new Set();
  const latest = [];
  for (const r of rows) {
    if (seen.has(r.patient_id)) continue;
    seen.add(r.patient_id);
    latest.push(r);
  }
  const patientIds = latest.map((r) => r.patient_id);
  const { data: patients } = patientIds.length
    ? await supabase.from('profiles').select('id, full_name, mrn, date_of_birth, phone').in('id', patientIds)
    : { data: [] };
  const byId = Object.fromEntries((patients || []).map((p) => [p.id, p]));
  return latest.map((r) => ({
    ...r,
    patient: byId[r.patient_id] || null,
    age: ageFromDob(byId[r.patient_id]?.date_of_birth),
    days_late: r.next_visit && r.next_visit < today ? daysLate(r.next_visit, today) : 0,
    chip:
      r.next_visit && r.next_visit < today
        ? 'overdue'
        : r.status === 'counselled'
          ? 'deciding'
          : 'protected',
  }));
}

export async function saveFpEncounter(body = {}, actor = {}, req = null) {
  if (!body.patient_id) throw new Error('patient_id required');

  let method = null;
  if (body.method_id) {
    const { data } = await supabase.from('fp_methods').select('*').eq('id', body.method_id).maybeSingle();
    method = data;
  } else if (body.method_code) {
    const { data } = await supabase
      .from('fp_methods')
      .select('*')
      .eq('code', String(body.method_code).toUpperCase())
      .maybeSingle();
    method = data;
  }

  const providedAt = body.provided_at || todayStr();
  const clientType = body.client_type || 'new';
  const methodCode = method?.code || body.method_code || null;
  const nextVisit =
    body.next_visit ||
    fpResupplyDate(providedAt, methodCode, method?.default_resupply_days ?? null);

  const medicineId = body.medicine_id || method?.medicine_id || null;
  let stock = null;
  if (medicineId && body.quantity && body.deduct_stock !== false) {
    stock = await dispenseFefo({
      medicineId,
      quantity: Number(body.quantity),
      referenceType: 'fp',
      referenceId: null,
      actor,
      req,
    });
  }

  const fpNo = body.fp_no || (await nextDocumentNo('fp'));
  const payload = {
    patient_id: body.patient_id,
    method_id: method?.id || null,
    method_code: methodCode,
    fp_no: fpNo,
    client_type: clientType,
    provided_at: providedAt,
    quantity: body.quantity != null ? Number(body.quantity) : null,
    counseling_notes: body.counseling_notes || null,
    next_visit: nextVisit,
    bp_systolic: body.bp_systolic != null ? parseInt(body.bp_systolic, 10) : null,
    bp_diastolic: body.bp_diastolic != null ? parseInt(body.bp_diastolic, 10) : null,
    weight_kg: body.weight_kg != null ? Number(body.weight_kg) : null,
    side_effects: body.side_effects || null,
    medicine_id: medicineId,
    stock_movement_id: stock?.movements?.[0]?.id || null,
    status: body.status || 'method_given',
    provided_by: actor.id || null,
  };

  const { data: enc, error } = await supabase.from('fp_encounters').insert(payload).select('*').single();
  if (error) throw error;

  // Patch stock reference id
  if (stock?.movements?.[0]?.id) {
    // movements already written; keep id on encounter
  }

  let appointment = null;
  if (nextVisit) {
    appointment = await bookAppointment({
      patientId: body.patient_id,
      clinic: 'fp',
      scheduledAt: `${nextVisit}T09:00:00.000Z`,
      reason: `FP re-supply (${methodCode || 'method'})`,
      sourceModule: 'fp',
      actor,
      req,
    });
    await supabase.from('fp_encounters').update({ appointment_id: appointment.id }).eq('id', enc.id);
  }

  try {
    await chargeByCode('FP-METHOD', {
      patientId: body.patient_id,
      sourceModule: 'fp',
      sourceTable: 'fp_encounters',
      sourceId: enc.id,
      actor,
      req,
    });
  } catch {
    /* optional */
  }

  const encounter = await createEncounter({
    patientId: body.patient_id,
    module: 'fp',
    staffId: actor.id,
    status: 'done',
    metadata: { method_code: methodCode, client_type: clientType },
    sourceTable: 'fp_encounters',
    sourceId: enc.id,
  });
  await supabase.from('fp_encounters').update({ encounter_id: encounter.id }).eq('id', enc.id);

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'create',
    resourceType: 'fp_encounter',
    resourceId: enc.id,
    patientId: body.patient_id,
    module: 'fp',
    after: enc,
    metadata: { stock },
    req,
  });

  return {
    encounter: { ...enc, appointment_id: appointment?.id || null, encounter_id: encounter.id },
    appointment,
    stock,
  };
}

export async function getMchHomeCounts() {
  const { data } = await supabase.from('hms_phase3_mch_counts').select('*').maybeSingle();
  if (data) return data;
  return {};
}
