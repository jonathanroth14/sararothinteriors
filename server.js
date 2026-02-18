require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Template Engine ──────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '50mb' })); // large payloads for image data

app.use(session({
  store: new pgSession({
    pool: db.pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'sri-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/projects');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
  if (password === adminPassword) {
    req.session.authenticated = true;
    res.redirect('/projects');
  } else {
    res.render('login', { error: 'Incorrect password. Please try again.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ─── Root Redirect ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/projects');
  res.redirect('/login');
});

// ─── Projects ─────────────────────────────────────────────────────────────────
app.get('/projects', requireAuth, async (req, res) => {
  try {
    const projects = await db.getProjects();
    const flash = req.session.flash;
    delete req.session.flash;
    res.render('projects', { projects, flash: flash || null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error: ' + err.message);
  }
});

app.post('/projects', requireAuth, async (req, res) => {
  try {
    const { name, client_name, description } = req.body;
    if (!name || !name.trim()) return res.redirect('/projects');
    const project = await db.createProject(name.trim(), client_name, description);
    req.session.flash = `Project "${project.name}" created.`;
    res.redirect('/projects');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating project: ' + err.message);
  }
});

app.post('/projects/:id/delete', requireAuth, async (req, res) => {
  try {
    await db.deleteProject(req.params.id);
    req.session.flash = 'Project deleted.';
    res.redirect('/projects');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting project: ' + err.message);
  }
});

// ─── Project Detail ───────────────────────────────────────────────────────────
app.get('/projects/:id', requireAuth, async (req, res) => {
  try {
    const project = await db.getProject(req.params.id);
    if (!project) return res.status(404).send('Project not found');
    const workOrders = await db.getWorkOrders(project.id);
    const flash = req.session.flash;
    delete req.session.flash;
    res.render('project', { project, workOrders, flash: flash || null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error: ' + err.message);
  }
});

// ─── Work Orders ──────────────────────────────────────────────────────────────
app.post('/projects/:projectId/work-orders', requireAuth, async (req, res) => {
  try {
    const project = await db.getProject(req.params.projectId);
    if (!project) return res.status(404).send('Project not found');
    const title = req.body.title && req.body.title.trim()
      ? req.body.title.trim()
      : 'Untitled Work Order';
    const wo = await db.createWorkOrder(project.id, title);
    await db.touchProject(project.id);
    res.redirect(`/projects/${project.id}/work-orders/${wo.id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating work order: ' + err.message);
  }
});

app.post('/projects/:projectId/work-orders/:woId/delete', requireAuth, async (req, res) => {
  try {
    await db.deleteWorkOrder(req.params.woId);
    req.session.flash = 'Work order deleted.';
    res.redirect(`/projects/${req.params.projectId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting work order: ' + err.message);
  }
});

// ─── Work Order Editor ────────────────────────────────────────────────────────
// Reads the existing HTML tool, injects server-mode scripts, and serves it
let cachedEditorHtml = null;

function getEditorHtml() {
  if (!cachedEditorHtml) {
    cachedEditorHtml = fs.readFileSync(
      path.join(__dirname, 'sri-work-order-builder.html'),
      'utf8'
    );
  }
  return cachedEditorHtml;
}

app.get('/projects/:projectId/work-orders/:woId', requireAuth, async (req, res) => {
  try {
    const project = await db.getProject(req.params.projectId);
    const wo = await db.getWorkOrder(req.params.woId);
    if (!project || !wo || String(wo.project_id) !== String(project.id)) {
      return res.status(404).send('Work order not found');
    }

    const injectedScript = `
<script>
// ═══ SRI SERVER MODE — injected by server.js ═══
const _SRI_WORK_ORDER_ID = '${wo.id}';
const _SRI_PROJECT_ID = '${project.id}';
const _SRI_PROJECT_NAME = ${JSON.stringify(project.name)};
const _SRI_WO_TITLE = ${JSON.stringify(wo.title)};
const _SRI_BACK_URL = '/projects/${project.id}';

// ── Breadcrumb ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  // Inject back nav before the h1
  const topBar = document.querySelector('.top-bar');
  if (topBar) {
    const back = document.createElement('a');
    back.href = _SRI_BACK_URL;
    back.style.cssText = 'color:rgba(255,255,255,0.55);font-size:12px;text-decoration:none;font-family:"DM Sans",sans-serif;font-weight:500;letter-spacing:0.3px;transition:color 0.2s;margin-right:0;';
    back.innerHTML = '&#8592; ' + _SRI_PROJECT_NAME;
    back.onmouseover = () => back.style.color = 'rgba(255,255,255,0.9)';
    back.onmouseout = () => back.style.color = 'rgba(255,255,255,0.55)';
    const h1 = topBar.querySelector('h1');
    if (h1) {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
      h1.parentNode.insertBefore(wrapper, h1);
      wrapper.appendChild(back);
      wrapper.appendChild(h1);
    }
  }
  // Update drafts panel title to "Version History"
  const panelTitle = document.querySelector('.drafts-panel-header h2');
  if (panelTitle) panelTitle.textContent = 'Version History';
  // Hide export/import buttons (we use server storage)
  const panelFooter = document.querySelector('.drafts-panel > div:last-child');
  if (panelFooter) panelFooter.style.display = 'none';

  // Load from server on open
  _sriLoadFromServer();
});

// ── Load latest version from server ────────────────────────────────────────
async function _sriLoadFromServer() {
  try {
    const r = await fetch('/api/work-orders/' + _SRI_WORK_ORDER_ID);
    if (!r.ok) return;
    const json = await r.json();
    if (!json.data) {
      // No saved version yet — seed the title from the work order name
      const titleEl = document.getElementById('woTitle');
      if (titleEl && _SRI_WO_TITLE) titleEl.value = _SRI_WO_TITLE;
      return;
    }
    _sriApplyData(json.data);
    showToast('Work order loaded');
  } catch(e) {
    console.error('SRI: Failed to load from server', e);
  }
}

// ── Apply data to form ──────────────────────────────────────────────────────
function _sriApplyData(d) {
  state.items = d.items || [];
  idCounter = 0;
  state.items.forEach(function(i) {
    if (i.id > idCounter) idCounter = i.id;
    (i.fields||[]).forEach(function(f) { if (f.id > idCounter) idCounter = f.id; });
    (i.images||[]).forEach(function(m) { if (m.id > idCounter) idCounter = m.id; });
  });
  var fields = ['woTitle','jobName','roomName','email','orderDate','clientPhone','designer','installAddress'];
  var keys   = ['title',  'jobName','roomName','email','orderDate','clientPhone','designer','installAddress'];
  fields.forEach(function(fId, i) {
    var el = document.getElementById(fId);
    if (el) el.value = d[keys[i]] || '';
  });
  render();
}

// ── Override saveDraft → save to server ─────────────────────────────────────
var _sriOriginalSaveDraft = typeof saveDraft === 'function' ? saveDraft : null;
saveDraft = async function() {
  var data = gatherFormData();
  try {
    var r = await fetch('/api/work-orders/' + _SRI_WORK_ORDER_ID + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (r.ok) {
      var json = await r.json();
      showToast('Saved — version ' + json.version_number);
      _sriRenderVersionHistory();
    } else {
      showToast('Save failed — please retry');
    }
  } catch(e) {
    showToast('Save failed: ' + e.message);
  }
};

// ── Override renderDrafts → version history ──────────────────────────────────
renderDrafts = async function() {
  _sriRenderVersionHistory();
};

async function _sriRenderVersionHistory() {
  var list = document.getElementById('draftsList');
  if (!list) return;
  list.innerHTML = '<div class="empty-hint">Loading...</div>';
  try {
    var r = await fetch('/api/work-orders/' + _SRI_WORK_ORDER_ID + '/versions');
    if (!r.ok) { list.innerHTML = '<div class="empty-hint">Failed to load</div>'; return; }
    var versions = await r.json();
    if (!versions.length) {
      list.innerHTML = '<div class="empty-hint">No saved versions yet. Click Save to create the first.</div>';
      return;
    }
    list.innerHTML = versions.map(function(v) {
      return '<div class="draft-item" onclick="_sriLoadVersion(' + v.id + ')">' +
        '<div class="draft-item-title">Version ' + v.version_number + '</div>' +
        '<div class="draft-item-meta">' + new Date(v.saved_at).toLocaleString() + '</div>' +
        '</div>';
    }).join('');
  } catch(e) {
    list.innerHTML = '<div class="empty-hint">Failed to load history</div>';
  }
}

async function _sriLoadVersion(versionId) {
  try {
    var r = await fetch('/api/versions/' + versionId);
    if (!r.ok) { showToast('Failed to load version'); return; }
    var json = await r.json();
    if (!json.data) return;
    _sriApplyData(json.data);
    var panel = document.getElementById('draftsPanel');
    var overlay = document.getElementById('overlay');
    if (panel) panel.classList.remove('open');
    if (overlay) overlay.classList.remove('visible');
    showToast('Version loaded');
  } catch(e) {
    showToast('Failed to load version: ' + e.message);
  }
}
</script>
`;

    let html = getEditorHtml();
    // Inject our script just before </body>
    html = html.replace('</body>', injectedScript + '\n</body>');
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading work order editor: ' + err.message);
  }
});

// ─── API: Work Order Data ─────────────────────────────────────────────────────
app.get('/api/work-orders/:id', requireAuth, async (req, res) => {
  try {
    const wo = await db.getWorkOrder(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Not found' });
    const version = await db.getLatestVersion(wo.id);
    res.json({
      id: wo.id,
      title: wo.title,
      data: version ? version.data : null,
      version_number: version ? version.version_number : 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/work-orders/:id/save', requireAuth, async (req, res) => {
  try {
    const wo = await db.getWorkOrder(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Not found' });
    const data = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid data' });
    }
    const version = await db.saveVersion(wo.id, data);
    await db.touchProject(wo.project_id);
    res.json({ ok: true, version_number: version.version_number, saved_at: version.saved_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/work-orders/:id/versions', requireAuth, async (req, res) => {
  try {
    const versions = await db.getVersions(req.params.id);
    res.json(versions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/versions/:id', requireAuth, async (req, res) => {
  try {
    const version = await db.getVersion(req.params.id);
    if (!version) return res.status(404).json({ error: 'Not found' });
    res.json(version);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Sara Roth Interiors admin portal running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
