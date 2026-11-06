/**
 * Phase 1 patient registration / list / deactivate / timeline helpers.
 * Physical storage remains profiles (MRN). Never create a second patient table.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from './auditService.js';
import { validatePassword } from '../utils/passwordPolicy.js';

export const PATIENT_SELECT = [
  'id',
  'email',
  'full_name',
  'first_name',
  'middle_name',
  'last_name',
  'sex',
  'phone',
  'mrn',
  'date_of_birth',
  'national_id',
  'insurance_scheme',
  'insurance_member_no',
  'address_village',
  'next_of_kin',
  'next_of_kin_phone',
  'blood_group',
  'allergies',
  'chronic_conditions',
  'sms_consent',
  'photo_url',
  'role',
  'is_active',
  'merged_into_id',
  'data_consent',
  'data_consent_at',
  'data_consent_method',
  'created_at',
  'updated_at',
].join(', ');

function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^\d+]/g, '');
}

function namesSimilar(a, b) {
  const na = String(a || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
  const nb = String(b || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

export function buildFullName({ first_name, middle_name, last_name, full_name }) {
  if (full_name && String(full_name).trim()) return String(full_name).trim();
  return [first_name, middle_name, last_name].filter(Boolean).join(' ').trim();
}

export async function findDuplicatePatients({
  full_name,
  phone,
  date_of_birth,
  email,
  exclude_id,
} = {}) {
  const { data: candidates, error } = await supabase
    .from('profiles')
    .select(PATIENT_SELECT)
    .eq('role', 'Patient')
    .is('merged_into_id', null)
    .eq('is_active', true)
    .limit(300);
  if (error) throw error;

  const normPhone = normalizePhone(phone);
  const matches = [];
  for (const p of candidates || []) {
    if (exclude_id && p.id === exclude_id) continue;
    const reasons = [];
    if (email && p.email && String(p.email).toLowerCase() === String(email).toLowerCase()) {
      reasons.push('email');
    }
    if (normPhone && normalizePhone(p.phone) && normalizePhone(p.phone) === normPhone) {
      reasons.push('phone');
    }
    if (date_of_birth && p.date_of_birth === date_of_birth && namesSimilar(full_name, p.full_name)) {
      reasons.push('name+dob');
    }
    // Near-match: name + phone without DOB, or name + DOB already covered
    if (
      !reasons.includes('name+dob') &&
      date_of_birth &&
      p.date_of_birth === date_of_birth &&
      normPhone &&
      normalizePhone(p.phone) === normPhone
    ) {
      reasons.push('dob+phone');
    }
    if (reasons.length) matches.push({ ...p, match_reasons: reasons });
  }
  return matches;
}

function randomPassword() {
  const base = `Sd${Math.random().toString(36).slice(2, 10)}!A1`;
  return base;
}

/**
 * Register patient once. Auto-generates login if email/password omitted.
 */
export async function registerHmsPatient(body = {}, actor = {}, req = null) {
  const full_name = buildFullName(body);
  if (!full_name) throw new Error('first_name/last_name or full_name is required');
  if (!body.sex) throw new Error('sex is required');
  if (!body.date_of_birth) throw new Error('date_of_birth is required');
  if (!body.data_consent) {
    throw new Error('Patient data-storage consent is required before registration');
  }

  const email =
    (body.email && String(body.email).trim()) ||
    `pt.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@patients.stdominic.local`;
  const password = body.password || randomPassword();
  const check = validatePassword(password);
  if (!check.ok) throw new Error(check.error);

  if (!body.force_duplicate) {
    const duplicates = await findDuplicatePatients({
      full_name,
      phone: body.phone,
      date_of_birth: body.date_of_birth,
      email: body.email || null,
    });
    if (duplicates.length) {
      const err = new Error('Possible duplicate patient(s) found');
      err.code = 'DUPLICATE_PATIENT';
      err.status = 409;
      err.duplicates = duplicates;
      throw err;
    }
  }

  const now = new Date().toISOString();
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name,
      role: 'Patient',
      phone: body.phone || null,
      date_of_birth: body.date_of_birth || null,
      data_consent: true,
      data_consent_method: 'staff_registration',
    },
  });
  if (authError) throw new Error(authError.message);

  const demo = {
    full_name,
    first_name: body.first_name || null,
    middle_name: body.middle_name || null,
    last_name: body.last_name || null,
    sex: body.sex,
    phone: body.phone || null,
    date_of_birth: body.date_of_birth,
    national_id: body.national_id || null,
    insurance_scheme: body.insurance_scheme || 'none',
    insurance_member_no: body.insurance_member_no || null,
    address_village: body.address_village || null,
    next_of_kin: body.next_of_kin || null,
    next_of_kin_phone: body.next_of_kin_phone || null,
    blood_group: body.blood_group || null,
    allergies: body.allergies || null,
    chronic_conditions: body.chronic_conditions || null,
    sms_consent: Boolean(body.sms_consent),
    photo_url: body.photo_url || null,
    role: 'Patient',
    password_changed_at: now,
    data_consent: true,
    data_consent_at: now,
    data_consent_method: 'staff_registration',
    updated_at: now,
  };

  await supabase.from('profiles').update(demo).eq('id', authData.user.id);

  const { data: finalProfile, error } = await supabase
    .from('profiles')
    .select(PATIENT_SELECT)
    .eq('id', authData.user.id)
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'create',
    resourceType: 'patient_record',
    resourceId: authData.user.id,
    patientId: authData.user.id,
    module: 'records',
    after: finalProfile,
    req,
  });

  return finalProfile;
}

export async function updateHmsPatient(id, body = {}, actor = {}, req = null) {
  const { data: before } = await supabase
    .from('profiles')
    .select(PATIENT_SELECT)
    .eq('id', id)
    .eq('role', 'Patient')
    .single();
  if (!before) throw new Error('Patient not found');

  const updates = { updated_at: new Date().toISOString() };
  const fields = [
    'first_name',
    'middle_name',
    'last_name',
    'sex',
    'phone',
    'date_of_birth',
    'national_id',
    'insurance_scheme',
    'insurance_member_no',
    'address_village',
    'next_of_kin',
    'next_of_kin_phone',
    'blood_group',
    'allergies',
    'chronic_conditions',
    'sms_consent',
    'photo_url',
  ];
  for (const f of fields) {
    if (body[f] !== undefined) updates[f] = body[f];
  }
  if (body.full_name !== undefined || body.first_name !== undefined || body.last_name !== undefined) {
    updates.full_name = buildFullName({ ...before, ...body, ...updates });
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', id)
    .eq('role', 'Patient')
    .select(PATIENT_SELECT)
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'edit',
    resourceType: 'patient_record',
    resourceId: id,
    patientId: id,
    module: 'records',
    before,
    after: data,
    req,
  });

  return data;
}

/** Soft-deactivate — never hard delete. */
export async function deactivatePatient(id, reason, actor = {}, req = null) {
  const { data: before } = await supabase
    .from('profiles')
    .select(PATIENT_SELECT)
    .eq('id', id)
    .eq('role', 'Patient')
    .single();
  if (!before) throw new Error('Patient not found');

  const { data, error } = await supabase
    .from('profiles')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(PATIENT_SELECT)
    .single();
  if (error) throw error;

  try {
    await supabase.auth.admin.updateUserById(id, { ban_duration: '876000h' });
  } catch (e) {
    console.warn('[deactivate] ban failed:', e?.message);
  }

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'delete_void',
    resourceType: 'patient_record',
    resourceId: id,
    patientId: id,
    module: 'records',
    before,
    after: data,
    metadata: { reason: reason || null, action: 'deactivate' },
    req,
  });

  return data;
}

/**
 * Role-filtered timeline: encounters + key clinical rows.
 * HIV module hidden unless can_access_hiv.
 */
export async function getHmsTimeline(patientId, { canAccessHiv = false, actor = {}, req = null } = {}) {
  const { data: patient, error: pErr } = await supabase
    .from('profiles')
    .select(PATIENT_SELECT)
    .eq('id', patientId)
    .eq('role', 'Patient')
    .single();
  if (pErr || !patient) throw new Error('Patient not found');

  const [
    encounters,
    opd,
    appointments,
    labOrders,
    prescriptions,
    invoices,
  ] = await Promise.all([
    supabase
      .from('encounters')
      .select('*')
      .eq('patient_id', patientId)
      .order('date_time', { ascending: false })
      .limit(200),
    supabase
      .from('opd_visits')
      .select('id, visit_date, token_no, status, chief_complaint, diagnosis, diagnosis_icd10, plan, is_urgent, created_at')
      .eq('patient_id', patientId)
      .order('visit_date', { ascending: false })
      .limit(50),
    supabase
      .from('appointments')
      .select('id, scheduled_at, clinic, hms_status, reason, status, created_at')
      .eq('patient_id', patientId)
      .order('scheduled_at', { ascending: false })
      .limit(50),
    supabase
      .from('lab_orders')
      .select('id, status, request_no, priority, created_at')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('prescriptions')
      .select('id, medication, status, created_at')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('invoices')
      .select('id, invoice_no, status, total, created_at')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const events = [];

  for (const e of encounters.data || []) {
    if (e.module === 'hiv' && !canAccessHiv) continue;
    events.push({
      type: 'encounter',
      module: e.module,
      occurred_at: e.date_time,
      status: e.status,
      summary: `${String(e.module).toUpperCase()} · ${e.status}`,
      source_id: e.id,
      data: e,
    });
  }
  for (const v of opd.data || []) {
    events.push({
      type: 'opd',
      module: 'opd',
      occurred_at: v.created_at || `${v.visit_date}T00:00:00Z`,
      status: v.status,
      summary: [v.chief_complaint, v.diagnosis && `Dx ${v.diagnosis}`, v.diagnosis_icd10 && `(${v.diagnosis_icd10})`]
        .filter(Boolean)
        .join(' · ') || `OPD token ${v.token_no}`,
      source_id: v.id,
      data: v,
    });
  }
  for (const a of appointments.data || []) {
    if (a.clinic === 'hiv' && !canAccessHiv) continue;
    events.push({
      type: 'appointment',
      module: 'appointments',
      occurred_at: a.scheduled_at || a.created_at,
      status: a.hms_status || a.status,
      summary: `${(a.clinic || 'opd').toUpperCase()} appointment · ${a.hms_status || a.status}${a.reason ? ` · ${a.reason}` : ''}`,
      source_id: a.id,
      data: a,
    });
  }
  for (const l of labOrders.data || []) {
    events.push({
      type: 'lab',
      module: 'lab',
      occurred_at: l.created_at,
      status: l.status,
      summary: `Lab ${l.request_no || ''} · ${l.status}`.trim(),
      source_id: l.id,
      data: l,
    });
  }
  for (const p of prescriptions.data || []) {
    events.push({
      type: 'pharmacy',
      module: 'pharmacy',
      occurred_at: p.created_at,
      status: p.status,
      summary: `${p.medication || 'Prescription'} (${p.status})`,
      source_id: p.id,
      data: p,
    });
  }
  for (const inv of invoices.data || []) {
    events.push({
      type: 'billing',
      module: 'billing',
      occurred_at: inv.created_at,
      status: inv.status,
      summary: `${inv.invoice_no || 'Invoice'} · ${inv.status}`,
      source_id: inv.id,
      data: inv,
    });
  }

  events.sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0));

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: 'view',
    resourceType: 'patient_timeline',
    resourceId: patientId,
    patientId,
    module: 'records',
    metadata: { event_count: events.length, hiv_filtered: !canAccessHiv },
    req,
  });

  return { patient, events, count: events.length };
}

const PATIENT_SELECT_LEGACY =
  'id, email, full_name, phone, mrn, date_of_birth, role, is_active, merged_into_id, data_consent, data_consent_at, data_consent_method, created_at, updated_at';

export async function listPatientsForHms({ q = '', limit = 50, includeInactive = false } = {}) {
  const run = async (selectCols) => {
    let query = supabase
      .from('profiles')
      .select(selectCols)
      .eq('role', 'Patient')
      .is('merged_into_id', null)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 200));

    if (!includeInactive) query = query.eq('is_active', true);
    if (q) {
      const pattern = `%${q}%`;
      const orClause =
        selectCols === PATIENT_SELECT
          ? `full_name.ilike.${pattern},mrn.ilike.${pattern},phone.ilike.${pattern},national_id.ilike.${pattern}`
          : `full_name.ilike.${pattern},mrn.ilike.${pattern},phone.ilike.${pattern}`;
      query = query.or(orClause);
    }
    return query;
  };

  let { data, error } = await run(PATIENT_SELECT);
  if (error && /column .* does not exist/i.test(error.message)) {
    ({ data, error } = await run(PATIENT_SELECT_LEGACY));
  }
  if (error) throw error;
  return data || [];
}

export async function patientListKpis() {
  const today = new Date().toISOString().slice(0, 10);
  const [total, todayRes, insured] = await Promise.all([
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'Patient')
      .is('merged_into_id', null)
      .eq('is_active', true),
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'Patient')
      .is('merged_into_id', null)
      .gte('created_at', `${today}T00:00:00.000Z`),
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'Patient')
      .is('merged_into_id', null)
      .eq('is_active', true)
      .in('insurance_scheme', ['nhis', 'private']),
  ]);
  return {
    total_patients: total.count || 0,
    registered_today: todayRes.count || 0,
    with_insurance: insured.count || 0,
  };
}

/** Small ICD-10 search corpus for OPD diagnosis field. */
export const ICD10_COMMON = [
  { code: 'A09', label: 'Infectious gastroenteritis and colitis' },
  { code: 'B50', label: 'Plasmodium falciparum malaria' },
  { code: 'B54', label: 'Unspecified malaria' },
  { code: 'E11', label: 'Type 2 diabetes mellitus' },
  { code: 'I10', label: 'Essential (primary) hypertension' },
  { code: 'J06.9', label: 'Acute upper respiratory infection, unspecified' },
  { code: 'J18.9', label: 'Pneumonia, unspecified' },
  { code: 'J45.9', label: 'Asthma, unspecified' },
  { code: 'K29.7', label: 'Gastritis, unspecified' },
  { code: 'M54.5', label: 'Low back pain' },
  { code: 'N39.0', label: 'Urinary tract infection, site not specified' },
  { code: 'O80', label: 'Encounter for full-term uncomplicated delivery' },
  { code: 'R50.9', label: 'Fever, unspecified' },
  { code: 'R51', label: 'Headache' },
  { code: 'Z00.0', label: 'General adult medical examination' },
  { code: 'Z34', label: 'Encounter for supervision of normal pregnancy' },
];

export function searchIcd10(q = '', limit = 20) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return ICD10_COMMON.slice(0, limit);
  return ICD10_COMMON.filter(
    (row) =>
      row.code.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle)
  ).slice(0, limit);
}
