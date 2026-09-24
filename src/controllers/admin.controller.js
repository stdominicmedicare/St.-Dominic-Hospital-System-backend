/**
 * Admin controller: users, roles. Uses Supabase (service role) for RLS bypass.
 * Supports getUsers, getUser, createUser, updateUser, deleteUser, resetPassword, getRoles.
 * Users enter system: (1) Patients self-signup; (2) Staff created by Admin only.
 */
import { supabase } from '../config/supabase.js';
import { validatePassword } from '../utils/passwordPolicy.js';

const PROFILES_SELECT = 'id, email, full_name, phone, mrn, date_of_birth, role, is_active, created_at, password_changed_at';
const DOCTORS_SELECT = 'id, email, full_name, phone, role, is_active, specialty, department, license_number, years_experience, consultation_fee, schedule, doctor_status, created_at, updated_at';
const DOCTOR_STATUSES = ['Available', 'On Leave', 'Busy', 'Inactive'];

/** Ban ~100 years so deactivated staff cannot use existing JWTs. */
const DEACTIVATE_BAN = '876000h';

/** Ensure department name exists in the configurable departments catalog. */
async function ensureDepartment(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  const { error } = await supabase.from('departments').upsert(
    { name: trimmed, updated_at: new Date().toISOString() },
    { onConflict: 'name', ignoreDuplicates: false }
  );
  if (error) console.error('[admin] department upsert failed:', error.message);
}

async function setAuthBan(userId, deactivated) {
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: deactivated ? DEACTIVATE_BAN : 'none',
  });
  if (error) console.error('[admin] ban update failed:', error.message);
  try {
    await supabase.auth.admin.signOut(userId, 'global');
  } catch {
    /* older supabase-js may not support signOut(userId) */
  }
}

export async function createUser(req, res) {
  try {
    const { email, password, full_name, role, phone, date_of_birth } = req.body;
    if (!email || !password || !role) {
      return res.status(400).json({ error: 'Email, password, and role are required' });
    }
    const check = validatePassword(password);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: full_name || email,
        role,
        phone: phone || null,
        date_of_birth: date_of_birth || null,
      },
    });
    if (authError) {
      return res.status(400).json({ error: authError.message });
    }
    const now = new Date().toISOString();
    await supabase
      .from('profiles')
      .update({
        role,
        full_name: full_name || email,
        phone: phone || null,
        date_of_birth: date_of_birth || null,
        password_changed_at: now,
        updated_at: now,
      })
      .eq('id', authData.user.id);

    const { data: profile } = await supabase
      .from('profiles')
      .select(PROFILES_SELECT)
      .eq('id', authData.user.id)
      .single();
    res.status(201).json(profile || { id: authData.user.id, email, full_name: full_name || null, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getUsers(req, res) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILES_SELECT)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getUser(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILES_SELECT)
      .eq('id', id)
      .single();

    if (error) {
      return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { full_name, email, phone, role, is_active } = req.body;

    if (email !== undefined) {
      const { error: authError } = await supabase.auth.admin.updateUserById(id, { email });
      if (authError) {
        return res.status(400).json({ error: authError.message });
      }
    }

    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;
    if (role !== undefined) updates.role = role;
    if (typeof is_active === 'boolean') updates.is_active = is_active;
    updates.updated_at = new Date().toISOString();

    if (Object.keys(updates).length <= 1) {
      return res.json({ message: 'No profile updates' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (typeof is_active === 'boolean') {
      await setAuthBan(id, !is_active);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) {
      return res.status(error.status === 404 ? 404 : 500).json({ error: error.message });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function resetPassword(req, res) {
  try {
    const { id } = req.params;
    const { password } = req.body;
    const check = validatePassword(password);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const { error } = await supabase.auth.admin.updateUserById(id, { password });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    const now = new Date().toISOString();
    await supabase
      .from('profiles')
      .update({ password_changed_at: now, updated_at: now })
      .eq('id', id);
    res.json({ message: 'Password updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getRoles(req, res) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, role')
      .order('email');

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ——— Doctor Management ———

export async function getDoctors(req, res) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(DOCTORS_SELECT)
      .eq('role', 'Doctor')
      .order('full_name');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getDoctor(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('profiles')
      .select(DOCTORS_SELECT)
      .eq('id', id)
      .eq('role', 'Doctor')
      .single();

    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createDoctor(req, res) {
  try {
    const {
      email,
      password,
      full_name,
      phone,
      specialty,
      department,
      license_number,
      years_experience,
      consultation_fee,
      schedule,
      doctor_status,
    } = req.body;
    if (!email || !password || !full_name || !specialty || !department || !license_number) {
      return res.status(400).json({
        error: 'Email, password, full_name, specialty, department, and license_number are required',
      });
    }
    const check = validatePassword(password);
    if (!check.ok) return res.status(400).json({ error: check.error });

    await ensureDepartment(department);

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, role: 'Doctor' },
    });
    if (authError) return res.status(400).json({ error: authError.message });

    const profileUpdates = {
      full_name,
      role: 'Doctor',
      phone: phone || null,
      specialty: specialty || null,
      department: department || null,
      license_number: license_number || null,
      years_experience: years_experience != null ? Number(years_experience) : null,
      consultation_fee: consultation_fee != null ? String(consultation_fee) : null,
      schedule: schedule != null && String(schedule).trim() ? String(schedule).trim() : null,
      doctor_status: doctor_status && DOCTOR_STATUSES.includes(doctor_status) ? doctor_status : 'Available',
      password_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from('profiles')
      .update(profileUpdates)
      .eq('id', authData.user.id);

    if (updateError) {
      return res.status(500).json({ error: 'Profile update failed: ' + updateError.message });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select(DOCTORS_SELECT)
      .eq('id', authData.user.id)
      .single();
    res.status(201).json(profile || { id: authData.user.id, email, full_name, role: 'Doctor' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateDoctor(req, res) {
  try {
    const { id } = req.params;
    const {
      full_name,
      email,
      phone,
      specialty,
      department,
      license_number,
      years_experience,
      consultation_fee,
      schedule,
      doctor_status,
      is_active,
    } = req.body;

    const { data: existing } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', id)
      .single();
    if (!existing || existing.role !== 'Doctor') {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    if (email !== undefined) {
      const { error: authError } = await supabase.auth.admin.updateUserById(id, { email });
      if (authError) return res.status(400).json({ error: authError.message });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;
    if (specialty !== undefined) updates.specialty = specialty;
    if (department !== undefined) {
      updates.department = department;
      if (department) await ensureDepartment(department);
    }
    if (license_number !== undefined) updates.license_number = license_number;
    if (years_experience !== undefined) updates.years_experience = years_experience == null ? null : Number(years_experience);
    if (consultation_fee !== undefined) updates.consultation_fee = consultation_fee == null ? null : String(consultation_fee);
    if (schedule !== undefined) updates.schedule = schedule == null || String(schedule).trim() === '' ? null : String(schedule).trim();
    if (doctor_status !== undefined && DOCTOR_STATUSES.includes(doctor_status)) updates.doctor_status = doctor_status;
    if (typeof is_active === 'boolean') updates.is_active = is_active;

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (typeof is_active === 'boolean') {
      await setAuthBan(id, !is_active);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function deleteDoctor(req, res) {
  try {
    const { id } = req.params;
    const { data: existing } = await supabase.from('profiles').select('id, role').eq('id', id).single();
    if (!existing || existing.role !== 'Doctor') {
      return res.status(404).json({ error: 'Doctor not found' });
    }
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) return res.status(error.status === 404 ? 404 : 500).json({ error: error.message });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getDoctorStatistics(req, res) {
  try {
    const { id } = req.params;
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', id)
      .single();
    if (!profile || profile.role !== 'Doctor') {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    const [appointmentsRes, recordsRes, patientsRes] = await Promise.all([
      supabase.from('appointments').select('id, patient_id', { count: 'exact', head: true }).eq('doctor_id', id),
      supabase.from('medical_records').select('id', { count: 'exact', head: true }).eq('doctor_id', id),
      supabase.from('appointments').select('patient_id').eq('doctor_id', id),
    ]);

    const totalAppointments = appointmentsRes.count ?? 0;
    const totalRecords = recordsRes.count ?? 0;
    const patientIds = [...new Set((patientsRes.data || []).map((r) => r.patient_id).filter(Boolean))];
    const uniquePatients = patientIds.length;

    res.json({
      total_appointments: totalAppointments,
      unique_patients: uniquePatients,
      total_medical_records: totalRecords,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Dashboard stats for Admin Home: users by role, appointments, ICU beds, ambulances. */
export async function getDashboardStats(req, res) {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalUsersRes,
      patientsRes,
      doctorsRes,
      appointmentsTodayRes,
      appointmentsWeekRes,
      appointmentsMonthRes,
      icuBedsRes,
      ambulancesRes,
      bloodBankRes,
      pharmacyPendingRes,
      opdTodayRes,
      openInvoicesRes,
      pendingLabRes,
      labourRes,
      deliveriesMonthRes,
    ] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'Patient'),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'Doctor'),
      supabase.from('appointments').select('id', { count: 'exact', head: true }).gte('scheduled_at', startOfToday.toISOString()).lt('scheduled_at', endOfToday.toISOString()),
      supabase.from('appointments').select('id', { count: 'exact', head: true }).gte('scheduled_at', startOfWeek.toISOString()),
      supabase.from('appointments').select('id', { count: 'exact', head: true }).gte('scheduled_at', startOfMonth.toISOString()),
      supabase.from('icu_beds').select('id, status'),
      supabase.from('ambulances').select('id, status'),
      supabase.from('blood_units').select('id', { count: 'exact', head: true }),
      supabase.from('prescriptions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('opd_visits').select('id', { count: 'exact', head: true }).eq('visit_date', startOfToday.toISOString().slice(0, 10)),
      supabase.from('invoices').select('id', { count: 'exact', head: true }).in('status', ['issued', 'partial']),
      supabase.from('lab_orders').select('id', { count: 'exact', head: true }).in('status', ['ordered', 'collected', 'in_progress']),
      supabase.from('maternity_admissions').select('id', { count: 'exact', head: true }).eq('status', 'in_labour'),
      supabase.from('deliveries').select('id', { count: 'exact', head: true }).gte('delivered_at', startOfMonth.toISOString()),
    ]);

    const icuBeds = icuBedsRes.data || [];
    const totalIcuBeds = icuBeds.length;
    const icuBedsAvailable = icuBeds.filter((b) => b.status === 'available').length;

    const ambulancesList = ambulancesRes.data || [];
    const totalAmbulances = ambulancesList.length;
    const ambulancesAvailable = ambulancesList.filter((a) => a.status === 'Available').length;
    const ambulancesOnDuty = ambulancesList.filter((a) => a.status === 'On Duty').length;

    const totalBloodUnits = bloodBankRes?.error ? 0 : (bloodBankRes?.count ?? 0);

    res.json({
      totalUsers: totalUsersRes.count ?? 0,
      totalPatients: patientsRes.count ?? 0,
      totalDoctors: doctorsRes.count ?? 0,
      appointmentsToday: appointmentsTodayRes.count ?? 0,
      appointmentsThisWeek: appointmentsWeekRes.count ?? 0,
      appointmentsThisMonth: appointmentsMonthRes.count ?? 0,
      icuBedsTotal: totalIcuBeds,
      icuBedsAvailable,
      ambulancesTotal: totalAmbulances,
      ambulancesAvailable,
      ambulancesOnDuty,
      totalBloodUnits,
      pendingPrescriptions: pharmacyPendingRes?.count ?? 0,
      opdToday: opdTodayRes?.error ? 0 : (opdTodayRes?.count ?? 0),
      openInvoices: openInvoicesRes?.error ? 0 : (openInvoicesRes?.count ?? 0),
      pendingLabOrders: pendingLabRes?.error ? 0 : (pendingLabRes?.count ?? 0),
      inLabour: labourRes?.error ? 0 : (labourRes?.count ?? 0),
      deliveriesThisMonth: deliveriesMonthRes?.error ? 0 : (deliveriesMonthRes?.count ?? 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ——— Volunteer Management ———

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

export async function getVolunteers(req, res) {
  try {
    const { data: profiles, error: pErr } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, role, is_active, created_at')
      .eq('role', 'Volunteer')
      .order('full_name');
    if (pErr) return res.status(500).json({ error: pErr.message });
    const userIds = (profiles || []).map((p) => p.id);
    const { data: vpList } = userIds.length
      ? await supabase.from('volunteer_profiles').select('user_id, blood_group, is_available').in('user_id', userIds)
      : { data: [] };
    const vpMap = Object.fromEntries((vpList || []).map((v) => [v.user_id, v]));
    const list = (profiles || []).map((p) => ({
      ...p,
      blood_group: vpMap[p.id]?.blood_group ?? null,
      is_available: vpMap[p.id]?.is_available ?? false,
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createVolunteer(req, res) {
  try {
    const adminId = req.user.id;
    const { email, password, full_name, phone, blood_group } = req.body;
    if (!email || !password || !blood_group) {
      return res.status(400).json({ error: 'Email, password, and blood_group are required' });
    }
    if (!BLOOD_GROUPS.includes(blood_group)) {
      return res.status(400).json({ error: 'Invalid blood_group' });
    }
    const check = validatePassword(password);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: full_name || email, role: 'Volunteer' },
    });
    if (authError) return res.status(400).json({ error: authError.message });

    await supabase
      .from('profiles')
      .update({
        full_name: full_name || email,
        phone: phone != null ? String(phone).trim() : null,
        role: 'Volunteer',
        password_changed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', authData.user.id);

    const { error: vpErr } = await supabase.from('volunteer_profiles').insert({
      user_id: authData.user.id,
      blood_group,
      is_available: false,
      created_by: adminId,
      updated_at: new Date().toISOString(),
    });
    if (vpErr) return res.status(500).json({ error: 'Volunteer profile create failed: ' + vpErr.message });

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, role, is_active, created_at')
      .eq('id', authData.user.id)
      .single();
    res.status(201).json({
      ...profile,
      blood_group,
      is_available: false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateVolunteer(req, res) {
  try {
    const { id } = req.params;
    const { full_name, phone, email, blood_group, is_active } = req.body;

    const { data: existing } = await supabase.from('profiles').select('id, role').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'Volunteer not found' });
    if (existing.role !== 'Volunteer') return res.status(400).json({ error: 'User is not a volunteer' });

    if (email !== undefined) {
      const { error: authError } = await supabase.auth.admin.updateUserById(id, { email });
      if (authError) return res.status(400).json({ error: authError.message });
    }

    const profileUpdates = { updated_at: new Date().toISOString() };
    if (full_name !== undefined) profileUpdates.full_name = full_name;
    if (phone !== undefined) profileUpdates.phone = phone;
    if (typeof is_active === 'boolean') profileUpdates.is_active = is_active;
    if (Object.keys(profileUpdates).length > 1) {
      await supabase.from('profiles').update(profileUpdates).eq('id', id);
    }
    if (typeof is_active === 'boolean') {
      await setAuthBan(id, !is_active);
    }

    if (blood_group !== undefined) {
      if (!BLOOD_GROUPS.includes(blood_group)) return res.status(400).json({ error: 'Invalid blood_group' });
      const { data: existingVp } = await supabase.from('volunteer_profiles').select('user_id').eq('user_id', id).maybeSingle();
      if (existingVp) {
        const { error: vpErr } = await supabase
          .from('volunteer_profiles')
          .update({ blood_group, updated_at: new Date().toISOString() })
          .eq('user_id', id);
        if (vpErr) return res.status(500).json({ error: vpErr.message });
      } else {
        const { error: insErr } = await supabase.from('volunteer_profiles').insert({
          user_id: id,
          blood_group,
          is_available: false,
          created_by: req.user.id,
          updated_at: new Date().toISOString(),
        });
        if (insErr) return res.status(500).json({ error: insErr.message });
      }
    }

    const { data: profile } = await supabase.from('profiles').select('id, email, full_name, phone, role, is_active').eq('id', id).single();
    const { data: vp } = await supabase.from('volunteer_profiles').select('blood_group, is_available').eq('user_id', id).maybeSingle();
    res.json({ ...profile, blood_group: vp?.blood_group ?? null, is_available: vp?.is_available ?? false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** List active departments (extensible catalog — no redeploy needed to add names). */
export async function getDepartments(req, res) {
  try {
    const includeInactive = String(req.query.all || '') === '1';
    let query = supabase
      .from('departments')
      .select('id, name, code, is_active, created_at, updated_at')
      .order('name', { ascending: true });
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Create or reactivate a department name without schema/code changes. */
export async function createDepartment(req, res) {
  try {
    const name = String(req.body?.name || '').trim();
    const code = req.body?.code != null ? String(req.body.code).trim() || null : null;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { data: existing } = await supabase
      .from('departments')
      .select('id, name, code, is_active')
      .eq('name', name)
      .maybeSingle();

    if (existing) {
      const { data, error } = await supabase
        .from('departments')
        .update({
          is_active: true,
          code: code ?? existing.code,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    }

    const { data, error } = await supabase
      .from('departments')
      .insert({
        name,
        code,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
