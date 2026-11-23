/**
 * Phase 4 HIV care — HTS, ART clients, viral load, refills → Pharmacy.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from './auditService.js';
import { bookAppointment } from './appointmentService.js';
import { addChargeLine } from './billingService.js';
import { createEncounter } from './encounterService.js';
import { nextDocumentNo } from './documentSequenceService.js';
import { createPrescription } from './pharmacyDispenseService.js';
import {
  evaluateEnrollmentFlags,
  isUnsuppressed,
  maskHivClient,
  nextViralLoadDue,
  isoDate,
  addMonths,
} from './hivRules.js';

function actorMeta(actor = {}) {
  return {
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
  };
}

async function charge(code, patientId, actor, req, meta = {}) {
  try {
    const { data: item } = await supabase
      .from('charge_items')
      .select('*')
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle();
    if (!item) return null;
    return await addChargeLine({
      patientId,
      chargeItemId: item.id,
      description: item.name,
      quantity: 1,
      unitPrice: item.unit_price ?? item.price ?? 0,
      sourceModule: 'hiv',
      sourceTable: meta.sourceTable || null,
      sourceId: meta.sourceId || meta.hts_id || meta.enrollment_id || meta.lab_id || meta.visit_id || null,
      createdBy: actor.id,
      actor,
      req,
    });
  } catch {
    return null;
  }
}

async function loadPatientsByIds(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return {};
  const { data } = await supabase
    .from('profiles')
    .select('id, mrn, full_name, sex, date_of_birth, phone')
    .in('id', uniq);
  const map = {};
  for (const p of data || []) map[p.id] = p;
  return map;
}

function withFlags(row) {
  const flags = evaluateEnrollmentFlags(row);
  return {
    ...row,
    ...flags,
    chip: flags.ltfu_flag
      ? 'ltfu'
      : flags.vl_unsuppressed
        ? 'unsuppressed'
        : flags.vl_due
          ? 'vl_due'
          : flags.refill_overdue_days > 0
            ? 'refill_overdue'
            : 'ok',
  };
}

/** Reveal names for HIV portal edit/full (counsellor, doctor, pharmacist with flag). */
export function canRevealHivNames(portalAccess) {
  return portalAccess === 'full' || portalAccess === 'edit';
}

// ---------- KPIs ----------
export async function getHivKpis() {
  const { data } = await supabase.from('hms_phase4_hiv_counts').select('*').maybeSingle();
  if (data) {
    return {
      clients_on_art: data.hiv_on_art ?? 0,
      refills_due_today: data.hiv_refills_due_today ?? 0,
      refills_missed: data.hiv_refills_missed ?? 0,
      vl_suppressed_pct: data.hiv_vl_suppressed_pct,
      ltfu: data.hiv_ltfu ?? 0,
      vl_due: data.hiv_vl_due ?? 0,
      unsuppressed: data.hiv_unsuppressed ?? 0,
      hts_today: data.hiv_hts_today ?? 0,
      hts_positive_today: data.hiv_hts_positive_today ?? 0,
    };
  }
  const today = isoDate(new Date());
  const { data: enrollments } = await supabase.from('hiv_enrollments').select('*');
  const list = enrollments || [];
  const activeArt = list.filter((e) => e.status === 'active' && e.art_started);
  const withVl = activeArt.filter((e) => e.last_viral_load != null);
  const suppressed = withVl.filter((e) => Number(e.last_viral_load) < 1000);
  return {
    clients_on_art: activeArt.length,
    refills_due_today: activeArt.filter((e) => e.next_refill_date === today).length,
    refills_missed: activeArt.filter((e) => e.next_refill_date && e.next_refill_date < today).length,
    vl_suppressed_pct: withVl.length
      ? Math.round((1000 * suppressed.length) / withVl.length) / 10
      : null,
    ltfu: list.filter((e) => e.status === 'lost' || e.ltfu_flag).length,
    vl_due: activeArt.filter((e) => e.next_vl_due && e.next_vl_due <= today).length,
    unsuppressed: activeArt.filter((e) => e.vl_unsuppressed || isUnsuppressed(e.last_viral_load)).length,
    hts_today: 0,
    hts_positive_today: 0,
  };
}

export async function getHivHomeCounts() {
  const { data } = await supabase.from('hms_phase4_hiv_counts').select('*').maybeSingle();
  return data || {};
}

// ---------- HTS ----------
export async function listHtsTests({ from = null, to = null, result = null } = {}, actor = {}, req = null) {
  let q = supabase.from('hiv_hts_tests').select('*').order('test_date', { ascending: false }).limit(200);
  if (from) q = q.gte('test_date', from);
  if (to) q = q.lte('test_date', to);
  if (result) q = q.eq('result', result);
  const { data, error } = await q;
  if (error) throw error;
  const patients = await loadPatientsByIds((data || []).map((r) => r.patient_id));
  await writeAuditLog({
    ...actorMeta(actor),
    action: 'view',
    resourceType: 'hiv_hts_test',
    module: 'hiv',
    metadata: { list: true, count: (data || []).length },
    req,
  });
  return (data || []).map((r) => ({
    ...r,
    patient: patients[r.patient_id] || null,
    display_id: r.hts_no || 'HTS-****',
  }));
}

export async function recordHtsTest(body = {}, actor = {}, req = null) {
  if (!body.patient_id && !body.client_name) {
    throw Object.assign(new Error('patient_id or client_name required'), { status: 400 });
  }
  const htsNo = await nextDocumentNo('hts').catch(() => `HTS-${Date.now().toString().slice(-5)}`);
  let encounter = null;
  if (body.patient_id) {
    encounter = await createEncounter({
      patientId: body.patient_id,
      module: 'hiv',
      staffId: actor.id || null,
      status: 'done',
      metadata: { kind: 'hts' },
      sourceTable: 'hiv_hts_tests',
    });
  }
  const payload = {
    hts_no: htsNo,
    patient_id: body.patient_id || null,
    client_name: body.client_name || null,
    sex: body.sex || null,
    age_years: body.age_years != null ? Number(body.age_years) : null,
    test_date: body.test_date || isoDate(new Date()),
    test_type: body.test_type || 'rapid',
    result: body.result || 'pending',
    counsellor_id: actor.id || null,
    notes: body.notes || null,
    created_by: actor.id || null,
    encounter_id: encounter?.id || null,
  };
  const { data, error } = await supabase.from('hiv_hts_tests').insert(payload).select('*').single();
  if (error) throw error;
  if (encounter?.id) {
    await supabase.from('encounters').update({ source_id: data.id }).eq('id', encounter.id);
  }
  if (body.patient_id) {
    await charge('HIV-HTS', body.patient_id, actor, req, { hts_id: data.id });
  }
  await writeAuditLog({
    ...actorMeta(actor),
    action: 'create',
    resourceType: 'hiv_hts_test',
    resourceId: data.id,
    patientId: data.patient_id,
    module: 'hiv',
    after: { id: data.id, result: data.result, hts_no: data.hts_no },
    req,
  });
  return data;
}

// ---------- ART clients ----------
export async function listArtClients(
  { status = 'active', q = '', due = null } = {},
  { showName = false, actor = {}, req = null } = {}
) {
  let query = supabase.from('hiv_enrollments').select('*').order('enrollment_date', { ascending: false }).limit(300);
  if (status && status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  let rows = (data || []).map(withFlags);
  const today = isoDate(new Date());
  if (due === 'refill') {
    rows = rows.filter((r) => r.next_refill_date && r.next_refill_date <= today && r.status === 'active');
  } else if (due === 'vl') {
    rows = rows.filter((r) => r.next_vl_due && r.next_vl_due <= today && r.status === 'active');
  } else if (due === 'ltfu') {
    rows = rows.filter((r) => r.ltfu_flag || r.status === 'lost');
  } else if (due === 'unsuppressed') {
    rows = rows.filter((r) => r.vl_unsuppressed || isUnsuppressed(r.last_viral_load));
  }
  const patients = await loadPatientsByIds(rows.map((r) => r.patient_id));
  const needle = String(q || '').trim().toLowerCase();
  const out = rows
    .map((r) => maskHivClient({ ...r, patient: patients[r.patient_id] || null }, { showName }))
    .filter((r) => {
      if (!needle) return true;
      return (
        String(r.art_no || '').toLowerCase().includes(needle) ||
        String(r.patient?.full_name || '').toLowerCase().includes(needle) ||
        String(r.patient?.mrn || '').toLowerCase().includes(needle)
      );
    });

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'view',
    resourceType: 'hiv_enrollment',
    module: 'hiv',
    metadata: { list: true, count: out.length, status, due, names_revealed: showName },
    req,
  });
  return out;
}

export async function getArtClient(id, { showName = false, actor = {}, req = null } = {}) {
  const { data, error } = await supabase.from('hiv_enrollments').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('ART client not found'), { status: 404 });

  const patients = await loadPatientsByIds([data.patient_id]);
  const [visits, labs] = await Promise.all([
    supabase
      .from('hiv_visits')
      .select('*')
      .eq('enrollment_id', id)
      .order('visit_date', { ascending: false })
      .limit(50),
    supabase
      .from('hiv_lab_results')
      .select('*')
      .eq('enrollment_id', id)
      .order('result_date', { ascending: false })
      .limit(50),
  ]);

  const row = maskHivClient(withFlags({ ...data, patient: patients[data.patient_id] || null }), { showName });
  await writeAuditLog({
    ...actorMeta(actor),
    action: 'view',
    resourceType: 'hiv_enrollment',
    resourceId: id,
    patientId: data.patient_id,
    module: 'hiv',
    metadata: { names_revealed: showName },
    req,
  });
  return {
    ...row,
    visits: visits.data || [],
    labs: labs.data || [],
  };
}

export async function enrollOnArt(body = {}, actor = {}, req = null) {
  if (!body.patient_id) throw Object.assign(new Error('patient_id required'), { status: 400 });

  const { data: existing } = await supabase
    .from('hiv_enrollments')
    .select('id')
    .eq('patient_id', body.patient_id)
    .maybeSingle();
  if (existing) {
    throw Object.assign(new Error('Patient already enrolled in HIV care'), {
      status: 409,
      code: 'DUPLICATE_ENROLLMENT',
    });
  }

  const artNo = body.art_no || (await nextDocumentNo('art').catch(() => `ART-${Date.now().toString().slice(-5)}`));
  const artStart = body.art_started
    ? body.art_start_date || body.enrollment_date || isoDate(new Date())
    : body.art_start_date || null;
  const nextVl = artStart ? nextViralLoadDue({ artStartDate: artStart }) : null;

  const encounter = await createEncounter({
    patientId: body.patient_id,
    module: 'hiv',
    staffId: actor.id || null,
    status: 'in_progress',
    metadata: { kind: 'enrolment' },
    sourceTable: 'hiv_enrollments',
  });

  const payload = {
    patient_id: body.patient_id,
    art_no: artNo,
    enrollment_date: body.enrollment_date || isoDate(new Date()),
    status: 'active',
    art_started: Boolean(body.art_started ?? true),
    art_start_date: artStart,
    who_stage: body.who_stage != null ? Number(body.who_stage) : null,
    regimen: body.regimen || null,
    cd4: body.cd4 != null ? Number(body.cd4) : null,
    tb_screening: body.tb_screening || null,
    adherence: body.adherence || null,
    next_refill_date: body.next_refill_date || null,
    months_dispensed: body.months_dispensed != null ? Number(body.months_dispensed) : null,
    next_vl_due: nextVl,
    notes: body.notes || null,
    created_by: actor.id || null,
    encounter_id: encounter.id,
  };

  const { data, error } = await supabase.from('hiv_enrollments').insert(payload).select('*').single();
  if (error) throw error;
  await supabase.from('encounters').update({ source_id: data.id }).eq('id', encounter.id);

  if (body.hts_id) {
    await supabase
      .from('hiv_hts_tests')
      .update({ linked_to_art: true, enrollment_id: data.id, result: 'positive' })
      .eq('id', body.hts_id);
  }

  await charge('HIV-ART-VISIT', body.patient_id, actor, req, { enrollment_id: data.id });

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'create',
    resourceType: 'hiv_enrollment',
    resourceId: data.id,
    patientId: body.patient_id,
    module: 'hiv',
    after: { id: data.id, art_no: data.art_no, status: data.status },
    req,
  });
  return withFlags(data);
}

export async function updateArtClient(id, body = {}, actor = {}, req = null) {
  const { data: before, error: bErr } = await supabase
    .from('hiv_enrollments')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (bErr) throw bErr;
  if (!before) throw Object.assign(new Error('ART client not found'), { status: 404 });

  const patch = {};
  for (const key of [
    'who_stage',
    'regimen',
    'cd4',
    'tb_screening',
    'adherence',
    'next_refill_date',
    'months_dispensed',
    'notes',
    'status',
    'art_started',
    'art_start_date',
  ]) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (patch.who_stage != null) patch.who_stage = Number(patch.who_stage);
  if (patch.cd4 != null) patch.cd4 = Number(patch.cd4);
  if (patch.months_dispensed != null) patch.months_dispensed = Number(patch.months_dispensed);

  const artStart = patch.art_start_date || before.art_start_date;
  if (artStart && (patch.art_start_date || patch.art_started)) {
    patch.next_vl_due = nextViralLoadDue({
      artStartDate: artStart,
      lastVlDate: before.last_vl_date,
    });
  }

  const merged = { ...before, ...patch };
  const flags = evaluateEnrollmentFlags(merged);
  patch.ltfu_flag = flags.ltfu_flag;
  patch.vl_unsuppressed = flags.vl_unsuppressed;
  if (flags.ltfu_flag && (before.status === 'active' || !patch.status)) {
    patch.status = 'lost';
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('hiv_enrollments').update(patch).eq('id', id).select('*').single();
  if (error) throw error;

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'edit',
    resourceType: 'hiv_enrollment',
    resourceId: id,
    patientId: before.patient_id,
    module: 'hiv',
    before: { status: before.status, regimen: before.regimen },
    after: { status: data.status, regimen: data.regimen },
    req,
  });
  return withFlags(data);
}

// ---------- Viral load ----------
export async function listViralLoads({ dueOnly = false } = {}, { showName = false, actor = {}, req = null } = {}) {
  const clients = await listArtClients(
    { status: 'active', due: dueOnly ? 'vl' : null },
    { showName, actor, req }
  );
  const { data: labs } = await supabase
    .from('hiv_lab_results')
    .select('*')
    .not('viral_load', 'is', null)
    .order('result_date', { ascending: false })
    .limit(100);
  const byEnroll = {};
  for (const lab of labs || []) {
    if (!byEnroll[lab.enrollment_id]) byEnroll[lab.enrollment_id] = lab;
  }
  return clients.map((c) => ({
    ...c,
    latest_vl: byEnroll[c.id] || null,
    unsuppressed: c.vl_unsuppressed || isUnsuppressed(c.last_viral_load),
  }));
}

export async function recordViralLoad(body = {}, actor = {}, req = null) {
  if (!body.enrollment_id) throw Object.assign(new Error('enrollment_id required'), { status: 400 });
  const { data: enr, error: eErr } = await supabase
    .from('hiv_enrollments')
    .select('*')
    .eq('id', body.enrollment_id)
    .maybeSingle();
  if (eErr) throw eErr;
  if (!enr) throw Object.assign(new Error('Enrollment not found'), { status: 404 });

  const vl = body.viral_load != null ? Number(body.viral_load) : null;
  const cd4 = body.cd4 != null ? Number(body.cd4) : null;
  const resultDate = body.result_date || isoDate(new Date());
  const unsuppressed = isUnsuppressed(vl);

  const encounter = await createEncounter({
    patientId: enr.patient_id,
    module: 'hiv',
    staffId: actor.id || null,
    status: 'done',
    metadata: { kind: 'viral_load', unsuppressed },
    sourceTable: 'hiv_lab_results',
  });

  const { data, error } = await supabase
    .from('hiv_lab_results')
    .insert({
      enrollment_id: enr.id,
      result_date: resultDate,
      viral_load: vl,
      cd4,
      test_type: body.test_type || (vl != null ? 'viral_load' : 'cd4'),
      unsuppressed,
      notes: body.notes || (unsuppressed ? 'Unsuppressed — adherence counselling required' : null),
      created_by: actor.id || null,
      encounter_id: encounter.id,
    })
    .select('*')
    .single();
  if (error) throw error;
  await supabase.from('encounters').update({ source_id: data.id }).eq('id', encounter.id);

  const nextVl = nextViralLoadDue({
    artStartDate: enr.art_start_date || enr.enrollment_date,
    lastVlDate: resultDate,
  });
  await supabase
    .from('hiv_enrollments')
    .update({
      last_viral_load: vl != null ? vl : enr.last_viral_load,
      last_vl_date: vl != null ? resultDate : enr.last_vl_date,
      next_vl_due: nextVl,
      vl_unsuppressed: vl != null ? unsuppressed : enr.vl_unsuppressed,
      cd4: cd4 != null ? cd4 : enr.cd4,
      updated_at: new Date().toISOString(),
    })
    .eq('id', enr.id);

  await charge(vl != null ? 'HIV-VL' : 'HIV-CD4', enr.patient_id, actor, req, { lab_id: data.id });

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'create',
    resourceType: 'hiv_lab_result',
    resourceId: data.id,
    patientId: enr.patient_id,
    module: 'hiv',
    after: { viral_load: vl, cd4, unsuppressed },
    req,
  });

  return { ...data, next_vl_due: nextVl, unsuppressed };
}

// ---------- Refills → Pharmacy ----------
export async function listRefills({ dueOnly = true } = {}, opts = {}) {
  return listArtClients({ status: 'active', due: dueOnly ? 'refill' : null }, opts);
}

export async function markRefill(body = {}, actor = {}, req = null) {
  if (!body.enrollment_id) throw Object.assign(new Error('enrollment_id required'), { status: 400 });
  const { data: enr, error: eErr } = await supabase
    .from('hiv_enrollments')
    .select('*')
    .eq('id', body.enrollment_id)
    .maybeSingle();
  if (eErr) throw eErr;
  if (!enr) throw Object.assign(new Error('Enrollment not found'), { status: 404 });

  const months = body.months_dispensed != null ? Number(body.months_dispensed) : enr.months_dispensed || 1;
  const visitDate = body.visit_date || isoDate(new Date());
  const nextRefill = body.next_refill_date || addMonths(visitDate, months);

  const encounter = await createEncounter({
    patientId: enr.patient_id,
    module: 'hiv',
    staffId: actor.id || null,
    status: 'done',
    metadata: { kind: 'refill', months },
    sourceTable: 'hiv_visits',
  });

  let prescription = null;
  if (body.send_to_pharmacy !== false) {
    const items = Array.isArray(body.items) && body.items.length
      ? body.items
      : [
          {
            medicine_id: body.medicine_id || null,
            medication_text: body.regimen || enr.regimen || 'ART regimen',
            quantity: body.quantity || months,
            dosage: body.dosage || null,
            frequency: body.frequency || 'as directed',
            instructions: `ART refill · ${months} month(s)`,
          },
        ];
    prescription = await createPrescription({
      patientId: enr.patient_id,
      items,
      notes: `HIV ART refill ${enr.art_no || ''}`.trim(),
      actor,
      req,
    });
    await supabase.from('prescriptions').update({ source: 'HIV' }).eq('id', prescription.id);
  }

  let appointment = null;
  if (nextRefill) {
    try {
      appointment = await bookAppointment({
        patientId: enr.patient_id,
        clinic: 'hiv',
        scheduledAt: `${nextRefill}T09:00:00.000Z`,
        reason: 'ART refill',
        sourceModule: 'hiv',
        notes: `ART ${enr.art_no || ''}`.trim(),
        actor,
        req,
      });
    } catch {
      appointment = null;
    }
  }

  const { data: visit, error: vErr } = await supabase
    .from('hiv_visits')
    .insert({
      enrollment_id: enr.id,
      visit_date: visitDate,
      who_stage: body.who_stage != null ? Number(body.who_stage) : enr.who_stage,
      weight_kg: body.weight_kg != null ? Number(body.weight_kg) : null,
      adherence: body.adherence || enr.adherence,
      tb_screening: body.tb_screening || enr.tb_screening,
      regimen: body.regimen || enr.regimen,
      months_dispensed: months,
      next_refill_date: nextRefill,
      refill_sent: Boolean(prescription),
      prescription_id: prescription?.id || null,
      appointment_id: appointment?.id || null,
      encounter_id: encounter.id,
      notes: body.notes || null,
      created_by: actor.id || null,
    })
    .select('*')
    .single();
  if (vErr) throw vErr;
  await supabase.from('encounters').update({ source_id: visit.id }).eq('id', encounter.id);

  const flags = evaluateEnrollmentFlags({
    ...enr,
    next_refill_date: nextRefill,
    status: 'active',
    last_refill_date: visitDate,
  });

  const { data: updated } = await supabase
    .from('hiv_enrollments')
    .update({
      regimen: body.regimen || enr.regimen,
      adherence: body.adherence || enr.adherence,
      tb_screening: body.tb_screening || enr.tb_screening,
      who_stage: body.who_stage != null ? Number(body.who_stage) : enr.who_stage,
      months_dispensed: months,
      next_refill_date: nextRefill,
      last_refill_date: visitDate,
      ltfu_flag: false,
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', enr.id)
    .select('*')
    .single();

  await charge('HIV-ART-VISIT', enr.patient_id, actor, req, { visit_id: visit.id });

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'create',
    resourceType: 'hiv_visit',
    resourceId: visit.id,
    patientId: enr.patient_id,
    module: 'hiv',
    after: {
      refill: true,
      prescription_id: prescription?.id || null,
      next_refill_date: nextRefill,
    },
    req,
  });

  return {
    visit,
    enrollment: withFlags(updated || enr),
    prescription,
    appointment,
    flags,
  };
}

/** Scan active clients and mark LTFU when refill missed > 28 days. */
export async function syncLtfuFlags(actor = {}, req = null) {
  const { data } = await supabase.from('hiv_enrollments').select('*').eq('status', 'active');
  let updated = 0;
  for (const row of data || []) {
    const flags = evaluateEnrollmentFlags(row);
    if (flags.ltfu_flag) {
      await supabase
        .from('hiv_enrollments')
        .update({ ltfu_flag: true, status: 'lost', updated_at: new Date().toISOString() })
        .eq('id', row.id);
      updated += 1;
      await writeAuditLog({
        ...actorMeta(actor),
        action: 'edit',
        resourceType: 'hiv_enrollment',
        resourceId: row.id,
        patientId: row.patient_id,
        module: 'hiv',
        metadata: { auto_ltfu: true },
        req,
      });
    }
  }
  return { updated };
}
