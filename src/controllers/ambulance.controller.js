/**
 * Ambulance module: driver dashboard, status updates, accept/start trip.
 * All operations scoped to req.user.id (driver = Ambulance role).
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';
import { createEncounter } from '../services/encounterService.js';
import { PATIENT_MIN_FIELDS, safeCreateEncounter } from '../services/patientProfileFields.js';

const DRIVER_FLEET_DEPOT = { lat: 40.7128, lng: -74.006 };
const ACTIVE_TRIP_STATUSES = ['en_route', 'arrived', 'patient_picked', 'arrived_at_hospital'];

function parseCurrentLocation(current_location) {
  if (!current_location || typeof current_location !== 'string') return null;
  const trimmed = current_location.trim();
  let lat; let lng;
  if (trimmed.startsWith('{')) {
    try {
      const o = JSON.parse(trimmed);
      lat = typeof o.lat === 'number' ? o.lat : parseFloat(o.lat);
      lng = typeof o.lng === 'number' ? o.lng : parseFloat(o.lng);
    } catch {
      return null;
    }
  } else {
    const parts = trimmed.split(/[,;\s]+/);
    if (parts.length >= 2) {
      lat = parseFloat(parts[0]);
      lng = parseFloat(parts[1]);
    } else return null;
  }
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

/** Fleet view for driver: all ambulances with position and status; driver's own ambulance id; trip info for popups. */
export async function getDriverFleetView(req, res) {
  try {
    const driverId = req.user.id;

    const { data: myAmbulance } = await supabase
      .from('ambulances')
      .select('id')
      .eq('driver_id', driverId)
      .maybeSingle();

    const [ambulancesRes, tripsRes] = await Promise.all([
      supabase.from('ambulances').select('id, vehicle_number, status, driver_id, current_location').order('vehicle_number'),
      supabase
        .from('ambulance_requests')
        .select('id, ambulance_id, status, from_address, to_address')
        .in('status', ACTIVE_TRIP_STATUSES),
    ]);

    const ambulances = ambulancesRes.data || [];
    const trips = tripsRes.data || [];
    const tripByAmbulanceId = {};
    trips.forEach((t) => {
      if (t.ambulance_id) tripByAmbulanceId[t.ambulance_id] = t;
    });

    const driverIds = [...new Set(ambulances.map((a) => a.driver_id).filter(Boolean))];
    let driverMap = {};
    if (driverIds.length > 0) {
      const { data: drivers } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', driverIds);
      driverMap = Object.fromEntries((drivers || []).map((d) => [d.id, d]));
    }

    const list = ambulances.map((a) => {
      const loc = parseCurrentLocation(a.current_location) || DRIVER_FLEET_DEPOT;
      const trip = tripByAmbulanceId[a.id] || null;
      const driver = a.driver_id ? driverMap[a.driver_id] || null : null;
      return {
        id: a.id,
        vehicle_number: a.vehicle_number,
        status: a.status,
        lat: loc.lat,
        lng: loc.lng,
        driver: driver ? { full_name: driver.full_name } : null,
        trip: trip ? { from_address: trip.from_address, to_address: trip.to_address, status: trip.status } : null,
      };
    });

    const stats = {
      total: ambulances.length,
      available: ambulances.filter((a) => a.status === 'Available').length,
      onTrip: trips.length,
      returning: ambulances.filter((a) => a.status === 'On Duty' && !tripByAmbulanceId[a.id]).length,
      offline: ambulances.filter((a) => a.status === 'Offline').length,
      maintenance: ambulances.filter((a) => a.status === 'Maintenance').length,
    };

    res.json({
      myAmbulanceId: myAmbulance?.id ?? null,
      ambulances: list,
      stats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Get dashboard for current driver: assigned ambulance, stats, trip requests. */
export async function getDashboard(req, res) {
  try {
    const driverId = req.user.id;

    const { data: ambulance, error: ambError } = await supabase
      .from('ambulances')
      .select('id, vehicle_number, ambulance_type, status, current_location')
      .eq('driver_id', driverId)
      .maybeSingle();

    if (ambError) return res.status(500).json({ error: ambError.message });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: pendingRequests } = await supabase
      .from('ambulance_requests')
      .select('id, patient_id, from_address, to_address, priority, status, requested_at, notes')
      .eq('status', 'pending')
      .order('requested_at', { ascending: false })
      .limit(20);

    const { data: assignedToMe } = await supabase
      .from('ambulance_requests')
      .select('id, patient_id, from_address, to_address, priority, status, requested_at, notes')
      .eq('assigned_driver_id', driverId)
      .in('status', ['assigned', 'en_route', 'arrived', 'patient_picked', 'arrived_at_hospital'])
      .order('requested_at', { ascending: false });

    const { data: completedByMe } = await supabase
      .from('ambulance_requests')
      .select('id, patient_id, from_address, to_address, priority, status, requested_at, completed_at, trip_notes')
      .eq('assigned_driver_id', driverId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(50);

    const tripsToday = (completedByMe || []).filter(
      (r) => r.completed_at && new Date(r.completed_at) >= todayStart
    ).length;

    const completedWithTimes = (completedByMe || []).filter((r) => r.completed_at && r.requested_at);
    const avgResponseMins = completedWithTimes.length
      ? Math.round(
          completedWithTimes.reduce((sum, r) => sum + (new Date(r.completed_at) - new Date(r.requested_at)) / 60000, 0) / completedWithTimes.length
        )
      : 0;
    const distanceKm = 0;

    const allRequestIds = [...new Set([
      ...(assignedToMe || []).map((r) => r.patient_id),
      ...(pendingRequests || []).map((r) => r.patient_id),
    ].filter(Boolean))];
    const patientMap = {};
    if (allRequestIds.length > 0) {
      const { data: patients } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', allRequestIds);
      (patients || []).forEach((p) => { patientMap[p.id] = p; });
    }

    const completedPatientIds = [...new Set((completedByMe || []).map((r) => r.patient_id).filter(Boolean))];
    completedPatientIds.forEach((id) => { if (!patientMap[id]) allRequestIds.push(id); });
    if (completedPatientIds.length > 0) {
      const { data: completedPatients } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', completedPatientIds);
      (completedPatients || []).forEach((p) => { patientMap[p.id] = p; });
    }

    const tripRequests = [
      ...(assignedToMe || []).map((r) => ({ ...r, _source: 'assigned', patient: patientMap[r.patient_id] || null })),
      ...(pendingRequests || []).filter(
        (p) => !(assignedToMe || []).some((a) => a.id === p.id)
      ).map((r) => ({ ...r, _source: 'pending', patient: patientMap[r.patient_id] || null })),
    ].sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));

    const tripHistory = (completedByMe || []).map((r) => ({ ...r, patient: patientMap[r.patient_id] || null }));

    res.json({
      ambulance: ambulance || null,
      stats: {
        tripsToday,
        avgResponseMins,
        distanceKm,
        status: ambulance?.status || 'Available',
      },
      tripRequests,
      tripHistory,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Update current driver's ambulance status and/or location. */
export async function updateStatus(req, res) {
  try {
    const driverId = req.user.id;
    const { status, current_location } = req.body;

    const { data: ambulance } = await supabase
      .from('ambulances')
      .select('id')
      .eq('driver_id', driverId)
      .maybeSingle();

    if (!ambulance) return res.status(404).json({ error: 'No ambulance assigned to you' });

    const updates = { updated_at: new Date().toISOString() };
    if (['Available', 'On Duty', 'Maintenance', 'Offline'].includes(status)) updates.status = status;
    if (current_location !== undefined) updates.current_location = String(current_location).trim() || null;

    const { data, error } = await supabase
      .from('ambulances')
      .update(updates)
      .eq('id', ambulance.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'ambulance',
      resourceId: ambulance.id,
      patientId: null,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Accept a pending trip (assign driver's ambulance to request). */
export async function acceptTrip(req, res) {
  try {
    const driverId = req.user.id;
    const { id } = req.params;

    const { data: ambulance } = await supabase
      .from('ambulances')
      .select('id')
      .eq('driver_id', driverId)
      .maybeSingle();

    if (!ambulance) return res.status(404).json({ error: 'No ambulance assigned to you' });

    const { data: request } = await supabase
      .from('ambulance_requests')
      .select('id, status')
      .eq('id', id)
      .single();

    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

    const { data, error } = await supabase
      .from('ambulance_requests')
      .update({
        status: 'assigned',
        ambulance_id: ambulance.id,
        assigned_driver_id: driverId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await supabase
      .from('ambulances')
      .update({ status: 'On Duty', updated_at: new Date().toISOString() })
      .eq('id', ambulance.id);

    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'ambulance_request',
      resourceId: id,
      patientId: data.patient_id || null,
      after: data,
      before: { status: request.status },
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Reject a pending request (driver declines) or unassign an already-accepted request. */
export async function rejectTrip(req, res) {
  try {
    const driverId = req.user.id;
    const { id } = req.params;

    const { data: request } = await supabase
      .from('ambulance_requests')
      .select('id, status, assigned_driver_id, ambulance_id')
      .eq('id', id)
      .single();

    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.assigned_driver_id !== driverId) return res.status(403).json({ error: 'Not your trip' });
    if (!['assigned', 'en_route', 'arrived', 'patient_picked', 'arrived_at_hospital'].includes(request.status)) {
      return res.status(400).json({ error: 'Can only reject assigned or in-progress trips' });
    }

    const { data, error } = await supabase
      .from('ambulance_requests')
      .update({
        status: 'pending',
        ambulance_id: null,
        assigned_driver_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    if (request.ambulance_id) {
      await supabase
        .from('ambulances')
        .update({ status: 'Available', updated_at: new Date().toISOString() })
        .eq('id', request.ambulance_id);
    }

    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'ambulance_request',
      resourceId: id,
      patientId: data.patient_id || null,
      after: data,
      before: { status: request.status, assigned_driver_id: request.assigned_driver_id },
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Start trip (set request to en_route). */
export async function startTrip(req, res) {
  try {
    const driverId = req.user.id;
    const { id } = req.params;

    const { data: request } = await supabase
      .from('ambulance_requests')
      .select('id, status, assigned_driver_id')
      .eq('id', id)
      .single();

    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.assigned_driver_id !== driverId) return res.status(403).json({ error: 'Not your trip' });
    if (request.status !== 'assigned') return res.status(400).json({ error: 'Trip must be accepted first' });

    const { data, error } = await supabase
      .from('ambulance_requests')
      .update({ status: 'en_route', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'ambulance_request',
      resourceId: id,
      patientId: data.patient_id || null,
      after: data,
      before: { status: request.status },
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Mark arrived at pickup location. */
export async function arrivedTrip(req, res) {
  try {
    const driverId = req.user.id;
    const { id } = req.params;

    const { data: request } = await supabase
      .from('ambulance_requests')
      .select('id, status, assigned_driver_id')
      .eq('id', id)
      .single();

    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.assigned_driver_id !== driverId) return res.status(403).json({ error: 'Not your trip' });
    if (request.status !== 'en_route') return res.status(400).json({ error: 'Trip must be en route first' });

    const { data, error } = await supabase
      .from('ambulance_requests')
      .update({ status: 'arrived', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'ambulance_request',
      resourceId: id,
      patientId: data.patient_id || null,
      after: data,
      before: { status: request.status },
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Mark patient picked up. */
export async function patientPickedTrip(req, res) {
  try {
    const driverId = req.user.id;
    const { id } = req.params;

    const { data: request } = await supabase
      .from('ambulance_requests')
      .select('id, status, assigned_driver_id')
      .eq('id', id)
      .single();

    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.assigned_driver_id !== driverId) return res.status(403).json({ error: 'Not your trip' });
    if (request.status !== 'arrived') return res.status(400).json({ error: 'Mark arrived first' });

    const { data, error } = await supabase
      .from('ambulance_requests')
      .update({ status: 'patient_picked', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'ambulance_request',
      resourceId: id,
      patientId: data.patient_id || null,
      after: data,
      before: { status: request.status },
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Mark arrived at hospital (after patient picked, before complete). */
export async function arrivedAtHospitalTrip(req, res) {
  try {
    const driverId = req.user.id;
    const { id } = req.params;

    const { data: request } = await supabase
      .from('ambulance_requests')
      .select('id, status, assigned_driver_id')
      .eq('id', id)
      .single();

    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.assigned_driver_id !== driverId) return res.status(403).json({ error: 'Not your trip' });
    if (request.status !== 'patient_picked') return res.status(400).json({ error: 'Mark patient picked first' });

    const { data, error } = await supabase
      .from('ambulance_requests')
      .update({ status: 'arrived_at_hospital', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'ambulance_request',
      resourceId: id,
      patientId: data.patient_id || null,
      after: data,
      before: { status: request.status },
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Complete trip (with optional trip notes). */
export async function completeTrip(req, res) {
  try {
    const driverId = req.user.id;
    const { id } = req.params;
    const { trip_notes } = req.body || {};

    const { data: request } = await supabase
      .from('ambulance_requests')
      .select('id, status, assigned_driver_id, ambulance_id')
      .eq('id', id)
      .single();

    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.assigned_driver_id !== driverId) return res.status(403).json({ error: 'Not your trip' });
    if (!['assigned', 'en_route', 'arrived', 'patient_picked', 'arrived_at_hospital'].includes(request.status)) return res.status(400).json({ error: 'Invalid status' });

    const updates = { status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (trip_notes !== undefined) updates.trip_notes = String(trip_notes).trim() || null;

    const { data, error } = await supabase
      .from('ambulance_requests')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    if (request.ambulance_id) {
      await supabase
        .from('ambulances')
        .update({ status: 'Available', updated_at: new Date().toISOString() })
        .eq('id', request.ambulance_id);
    }

    if (data.patient_id) {
      await safeCreateEncounter(createEncounter, {
        patientId: data.patient_id,
        module: 'ambulance',
        staffId: driverId,
        status: 'done',
        metadata: { kind: 'trip_complete' },
        sourceTable: 'ambulance_requests',
        sourceId: id,
      });
    }

    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'ambulance_request',
      resourceId: id,
      patientId: data.patient_id || null,
      after: data,
      before: { status: request.status },
      req,
      module: 'ambulance',
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
