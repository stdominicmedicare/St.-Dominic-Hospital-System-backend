/**
 * Phase 4 HMS — HIV portal, home dashboard alerts, reports & export.
 */
import * as hiv from '../services/hivService.js';
import * as dashboard from '../services/dashboardService.js';
import * as reports from '../services/reportsService.js';
import { normalizeFlags, canSeePortal } from '../permissions/hmsRoles.js';
import { sendBinary } from '../services/exportService.js';

function actorFrom(req) {
  return {
    id: req.user?.id,
    email: req.user?.email || req.profile?.email,
    role: req.role,
  };
}

function handle(err, res) {
  const status = err.status || 400;
  return res.status(status).json({ error: err.message, code: err.code || undefined });
}

function showNames(req) {
  return hiv.canRevealHivNames(req.portalAccess);
}

// ---------- Home ----------
export async function homeDashboard(req, res) {
  try {
    const flags = normalizeFlags(req.profile || {});
    const data = await dashboard.getHomeDashboard({ role: req.role, flags });
    // Hide HIV tile numbers from users without HIV portal (Admin sees counts-only on HTML —
    // we still show aggregate ART count for management visibility on home when Admin).
    const canHiv = canSeePortal(req.role, 'hiv', flags);
    if (!canHiv && req.role !== 'Admin') {
      delete data.hiv_on_art;
      delete data.hiv_refills_due_today;
      delete data.hiv_refills_missed;
      delete data.hiv_vl_suppressed_pct;
      data.alerts = (data.alerts || []).filter((a) => a.module !== 'hiv');
    }
    res.json(data);
  } catch (err) {
    handle(err, res);
  }
}

export async function homeAlerts(req, res) {
  try {
    const flags = normalizeFlags(req.profile || {});
    const alerts = await dashboard.buildAlerts({ canAccessHiv: Boolean(flags.can_access_hiv) });
    res.json({ alerts });
  } catch (err) {
    handle(err, res);
  }
}

// ---------- HIV ----------
export async function hivKpis(req, res) {
  try {
    res.json(await hiv.getHivKpis());
  } catch (err) {
    handle(err, res);
  }
}

export async function hivHtsList(req, res) {
  try {
    res.json(
      await hiv.listHtsTests(
        { from: req.query.from, to: req.query.to, result: req.query.result },
        actorFrom(req),
        req
      )
    );
  } catch (err) {
    handle(err, res);
  }
}

export async function hivHtsCreate(req, res) {
  try {
    const row = await hiv.recordHtsTest(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function hivArtList(req, res) {
  try {
    res.json(
      await hiv.listArtClients(
        { status: req.query.status || 'active', q: req.query.q || '', due: req.query.due || null },
        { showName: showNames(req), actor: actorFrom(req), req }
      )
    );
  } catch (err) {
    handle(err, res);
  }
}

export async function hivArtGet(req, res) {
  try {
    res.json(
      await hiv.getArtClient(req.params.id, {
        showName: showNames(req),
        actor: actorFrom(req),
        req,
      })
    );
  } catch (err) {
    handle(err, res);
  }
}

export async function hivArtEnroll(req, res) {
  try {
    const row = await hiv.enrollOnArt(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function hivArtPatch(req, res) {
  try {
    res.json(await hiv.updateArtClient(req.params.id, req.body || {}, actorFrom(req), req));
  } catch (err) {
    handle(err, res);
  }
}

export async function hivVlList(req, res) {
  try {
    res.json(
      await hiv.listViralLoads(
        { dueOnly: String(req.query.due || '') === '1' },
        { showName: showNames(req), actor: actorFrom(req), req }
      )
    );
  } catch (err) {
    handle(err, res);
  }
}

export async function hivVlCreate(req, res) {
  try {
    const row = await hiv.recordViralLoad(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function hivRefills(req, res) {
  try {
    res.json(
      await hiv.listRefills(
        { dueOnly: String(req.query.all || '') !== '1' },
        { showName: showNames(req), actor: actorFrom(req), req }
      )
    );
  } catch (err) {
    handle(err, res);
  }
}

export async function hivRefillMark(req, res) {
  try {
    const row = await hiv.markRefill(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    handle(err, res);
  }
}

export async function hivSyncLtfu(req, res) {
  try {
    res.json(await hiv.syncLtfuFlags(actorFrom(req), req));
  } catch (err) {
    handle(err, res);
  }
}

// ---------- Reports ----------
export async function reportsCatalog(req, res) {
  res.json({ reports: reports.REPORT_CATALOG });
}

export async function reportsRun(req, res) {
  try {
    const type = req.params.type || req.query.type;
    const result = await reports.runReport(type, {
      from: req.query.from,
      to: req.query.to,
      department: req.query.department,
      sex: req.query.sex,
      age_group: req.query.age_group,
    });
    res.json(result);
  } catch (err) {
    handle(err, res);
  }
}

export async function reportsExport(req, res) {
  try {
    const type = req.params.type;
    const format = (req.params.format || 'xlsx').toLowerCase();
    const { buffer, contentType, filename } = await reports.exportReport(
      type,
      format === 'pdf' ? 'pdf' : 'xlsx',
      {
        from: req.query.from,
        to: req.query.to,
        department: req.query.department,
        sex: req.query.sex,
        age_group: req.query.age_group,
      },
      actorFrom(req),
      req
    );
    sendBinary(res, buffer, { filename, contentType });
  } catch (err) {
    handle(err, res);
  }
}

export async function reportsAlignedCounts(req, res) {
  try {
    res.json(
      await reports.getDashboardAlignedCounts({
        from: req.query.from,
        to: req.query.to,
      })
    );
  } catch (err) {
    handle(err, res);
  }
}
