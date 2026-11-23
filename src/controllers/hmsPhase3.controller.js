/**
 * Phase 3 HMS controllers — ANC, Maternity, PNC, Immunization, Family planning.
 */
import * as mch from '../services/mchService.js';

function actorFrom(req) {
  return {
    id: req.user?.id,
    email: req.user?.email || req.profile?.email,
    role: req.role,
  };
}

function handle(err, res) {
  const status = err.status || (err.code === 'DUPLICATE_PATIENT' ? 409 : 400);
  const payload = { error: err.message, code: err.code || undefined };
  if (err.duplicates) payload.duplicates = err.duplicates;
  return res.status(status).json(payload);
}

// ---------- ANC ----------
export async function ancKpis(req, res) {
  try {
    res.json(await mch.getAncKpis());
  } catch (err) {
    handle(err, res);
  }
}

export async function ancList(req, res) {
  try {
    res.json(await mch.listPregnancies({ status: req.query.status || 'active', q: req.query.q || '' }));
  } catch (err) {
    handle(err, res);
  }
}

export async function ancRegister(req, res) {
  try {
    const row = await mch.registerPregnancy(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function ancVisits(req, res) {
  try {
    res.json(await mch.listAncVisits(req.params.pregnancyId));
  } catch (err) {
    handle(err, res);
  }
}

export async function ancSaveVisit(req, res) {
  try {
    const row = await mch.saveAncVisit(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function ancDefaulters(req, res) {
  try {
    res.json(await mch.listAncDefaulters());
  } catch (err) {
    handle(err, res);
  }
}

export async function ancReferMaternity(req, res) {
  try {
    res.json(await mch.referToMaternity(req.params.pregnancyId, actorFrom(req), req));
  } catch (err) {
    handle(err, res);
  }
}

// ---------- Maternity ----------
export async function maternityKpis(req, res) {
  try {
    res.json(await mch.getMaternityKpis());
  } catch (err) {
    handle(err, res);
  }
}

export async function maternityBoard(req, res) {
  try {
    res.json(await mch.listLabourBoard());
  } catch (err) {
    handle(err, res);
  }
}

export async function maternityAdmit(req, res) {
  try {
    const row = await mch.admitToLabour(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function maternityPartographList(req, res) {
  try {
    res.json(await mch.listPartograph(req.params.admissionId));
  } catch (err) {
    handle(err, res);
  }
}

export async function maternityPartographAdd(req, res) {
  try {
    const row = await mch.addPartographEntry(req.params.admissionId, req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function maternityDelivery(req, res) {
  try {
    const row = await mch.saveDelivery(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function maternityDeliveries(req, res) {
  try {
    res.json(await mch.listDeliveries({ limit: Number(req.query.limit) || 50 }));
  } catch (err) {
    handle(err, res);
  }
}

// ---------- PNC ----------
export async function pncKpis(req, res) {
  try {
    res.json(await mch.getPncKpis());
  } catch (err) {
    handle(err, res);
  }
}

export async function pncDue(req, res) {
  try {
    res.json(await mch.listPncDue({ includeMissed: req.query.missed !== '0' }));
  } catch (err) {
    handle(err, res);
  }
}

export async function pncSaveVisit(req, res) {
  try {
    const row = await mch.savePncVisit(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

// ---------- Immunization ----------
export async function immKpis(req, res) {
  try {
    res.json(await mch.getImmKpis());
  } catch (err) {
    handle(err, res);
  }
}

export async function immScheduleList(req, res) {
  try {
    res.json(await mch.listImmunizationSchedule());
  } catch (err) {
    handle(err, res);
  }
}

export async function immScheduleUpsert(req, res) {
  try {
    const row = await mch.upsertImmunizationSchedule(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function immCards(req, res) {
  try {
    res.json(
      await mch.listVaccineCards({
        status: req.query.status || null,
        overdueOnly: req.query.overdue === '1',
      })
    );
  } catch (err) {
    handle(err, res);
  }
}

export async function immCard(req, res) {
  try {
    res.json(await mch.getChildVaccineCard(req.params.patientId));
  } catch (err) {
    handle(err, res);
  }
}

export async function immRegisterChild(req, res) {
  try {
    const row = await mch.registerImmChild(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function immRecordDose(req, res) {
  try {
    const row = await mch.recordVaccineDose(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

// ---------- Family planning ----------
export async function fpKpis(req, res) {
  try {
    res.json(await mch.getFpKpis());
  } catch (err) {
    handle(err, res);
  }
}

export async function fpMethods(req, res) {
  try {
    res.json(await mch.listFpMethods());
  } catch (err) {
    handle(err, res);
  }
}

export async function fpClients(req, res) {
  try {
    res.json(await mch.listFpClients({ overdueOnly: req.query.overdue === '1' }));
  } catch (err) {
    handle(err, res);
  }
}

export async function fpSave(req, res) {
  try {
    const row = await mch.saveFpEncounter(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function mchHomeCounts(req, res) {
  try {
    res.json(await mch.getMchHomeCounts());
  } catch (err) {
    handle(err, res);
  }
}
