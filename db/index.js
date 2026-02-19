const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Database schema initialized');
}

// Projects
async function getProjects() {
  const res = await pool.query(`
    SELECT p.*,
      COUNT(w.id) AS work_order_count
    FROM projects p
    LEFT JOIN work_orders w ON w.project_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `);
  return res.rows;
}

async function getProject(id) {
  const res = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  return res.rows[0];
}

async function createProject(name, clientName, description) {
  const res = await pool.query(
    'INSERT INTO projects (name, client_name, description) VALUES ($1, $2, $3) RETURNING *',
    [name, clientName || null, description || null]
  );
  return res.rows[0];
}

async function deleteProject(id) {
  await pool.query('DELETE FROM projects WHERE id = $1', [id]);
}

async function touchProject(id) {
  await pool.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [id]);
}

// Work Orders
async function getWorkOrders(projectId) {
  const res = await pool.query(`
    SELECT w.*,
      COUNT(v.id) AS version_count,
      MAX(v.saved_at) AS last_saved
    FROM work_orders w
    LEFT JOIN work_order_versions v ON v.work_order_id = w.id
    WHERE w.project_id = $1
    GROUP BY w.id
    ORDER BY w.updated_at DESC
  `, [projectId]);
  return res.rows;
}

async function getWorkOrder(id) {
  const res = await pool.query('SELECT * FROM work_orders WHERE id = $1', [id]);
  return res.rows[0];
}

async function createWorkOrder(projectId, title) {
  const res = await pool.query(
    'INSERT INTO work_orders (project_id, title) VALUES ($1, $2) RETURNING *',
    [projectId, title || 'Untitled Work Order']
  );
  return res.rows[0];
}

async function deleteWorkOrder(id) {
  await pool.query('DELETE FROM work_orders WHERE id = $1', [id]);
}

async function toggleSent(id) {
  const res = await pool.query(
    `UPDATE work_orders
     SET sent = NOT sent,
         sent_at = CASE WHEN NOT sent THEN NOW() ELSE NULL END
     WHERE id = $1
     RETURNING sent, sent_at`,
    [id]
  );
  return res.rows[0];
}

// Work Order Versions
async function getLatestVersion(workOrderId) {
  const res = await pool.query(
    'SELECT * FROM work_order_versions WHERE work_order_id = $1 ORDER BY version_number DESC LIMIT 1',
    [workOrderId]
  );
  return res.rows[0] || null;
}

async function getVersions(workOrderId) {
  const res = await pool.query(
    'SELECT id, work_order_id, version_number, saved_at FROM work_order_versions WHERE work_order_id = $1 ORDER BY version_number DESC',
    [workOrderId]
  );
  return res.rows;
}

async function getVersion(versionId) {
  const res = await pool.query('SELECT * FROM work_order_versions WHERE id = $1', [versionId]);
  return res.rows[0] || null;
}

async function saveVersion(workOrderId, data) {
  // Get next version number
  const countRes = await pool.query(
    'SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM work_order_versions WHERE work_order_id = $1',
    [workOrderId]
  );
  const versionNumber = countRes.rows[0].next;

  const res = await pool.query(
    'INSERT INTO work_order_versions (work_order_id, version_number, data) VALUES ($1, $2, $3) RETURNING *',
    [workOrderId, versionNumber, JSON.stringify(data)]
  );

  // Update work order title and timestamp
  const title = data.title || data.jobName || 'Untitled Work Order';
  await pool.query(
    'UPDATE work_orders SET title = $1, updated_at = NOW() WHERE id = $2',
    [title, workOrderId]
  );

  return res.rows[0];
}

module.exports = { pool, init, getProjects, getProject, createProject, deleteProject, touchProject, getWorkOrders, getWorkOrder, createWorkOrder, deleteWorkOrder, toggleSent, getLatestVersion, getVersions, getVersion, saveVersion };
