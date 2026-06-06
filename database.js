const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data/n4xco.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB error:', err.message);
  else console.log('Connected to SQLite at', DB_PATH);
});

const run = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function(err) { err ? rej(err) : res(this); })
);
const get = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => { err ? rej(err) : res(row); })
);
const query = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => { err ? rej(err) : res(rows); })
);

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    password   TEXT NOT NULL,
    email      TEXT DEFAULT '',
    telegram   TEXT DEFAULT '',
    role       TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Sessions/tokens
  db.run(`CREATE TABLE IF NOT EXISTS tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL UNIQUE,
    username   TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  )`);

  // Plans table (mirrors store.json but in DB)
  db.run(`CREATE TABLE IF NOT EXISTS plans (
    id      TEXT PRIMARY KEY,
    label   TEXT NOT NULL,
    days    INTEGER NOT NULL,
    price   INTEGER NOT NULL,
    enabled INTEGER DEFAULT 1
  )`);

  // Keys pool
  db.run(`CREATE TABLE IF NOT EXISTS keys_pool (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id  TEXT NOT NULL,
    key_val  TEXT NOT NULL,
    used     INTEGER DEFAULT 0,
    order_id TEXT DEFAULT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at  DATETIME DEFAULT NULL
  )`);

  // Orders table
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id                 TEXT PRIMARY KEY,
    user_id            INTEGER DEFAULT NULL,
    username           TEXT NOT NULL,
    telegram           TEXT DEFAULT '',
    plan_id            TEXT NOT NULL,
    plan_label         TEXT NOT NULL,
    price              INTEGER NOT NULL,
    days               INTEGER NOT NULL,
    status             TEXT DEFAULT 'pending',
    paymongo_link_id   TEXT DEFAULT '',
    paymongo_link_url  TEXT DEFAULT '',
    reference_num      TEXT DEFAULT '',
    key_given          TEXT DEFAULT NULL,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at            DATETIME DEFAULT NULL,
    fulfilled_at       DATETIME DEFAULT NULL,
    cancelled_at       DATETIME DEFAULT NULL
  )`);

  // APK settings
  db.run(`CREATE TABLE IF NOT EXISTS apk_settings (
    id   INTEGER PRIMARY KEY,
    name TEXT DEFAULT 'N4XCO App',
    logo TEXT DEFAULT '',
    link TEXT DEFAULT 'https://example.com/download'
  )`);
  db.run(`INSERT OR IGNORE INTO apk_settings (id, name) VALUES (1, 'N4XCO App')`);

  // PayMongo settings
  db.run(`CREATE TABLE IF NOT EXISTS paymongo_settings (
    id         INTEGER PRIMARY KEY,
    secret_key TEXT DEFAULT '',
    public_key TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`INSERT OR IGNORE INTO paymongo_settings (id) VALUES (1)`);

  // Seed default plans
  const plans = [
    ['03days', '03 Days', 3, 120],
    ['07days', '07 Days', 7, 200],
    ['15days', '15 Days', 15, 250],
    ['20days', '20 Days', 20, 350],
    ['30days', '30 Days', 30, 600],
    ['60days', '60 Days', 60, 1000],
    ['90days', '90 Days', 90, 1300],
  ];
  plans.forEach(([id, label, days, price]) => {
    db.run(`INSERT OR IGNORE INTO plans (id, label, days, price) VALUES (?,?,?,?)`, [id, label, days, price]);
  });

  // Seed default admin
  const adminHash = bcrypt.hashSync('N4XCO_0', 10);
  db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)`,
    ['N4XCO', adminHash, 'admin']);

  // Cleanup expired tokens
  db.run(`DELETE FROM tokens WHERE expires_at <= datetime('now')`);
});

const dbFuncs = {
  // ==================== AUTH ====================
  getUser: (username) => get('SELECT * FROM users WHERE username = ?', [username]),
  getUserById: (id) => get('SELECT * FROM users WHERE id = ?', [id]),
  verifyPassword: (plain, hash) => bcrypt.compareSync(plain, hash),
  createToken: async (username) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    await run('INSERT INTO tokens (token, username, expires_at) VALUES (?,?,?)', [token, username, expires]);
    return token;
  },
  verifyToken: (token) => get(
    'SELECT * FROM tokens WHERE token=? AND expires_at > datetime("now")',
    [token]
  ),
  deleteToken: (token) => run('DELETE FROM tokens WHERE token=?', [token]),

  // ==================== USERS ====================
  getAllUsers: () => query('SELECT id, username, email, telegram, role, created_at FROM users ORDER BY id'),
  createUser: async (username, password, email = '', telegram = '', role = 'user') => {
    const hash = bcrypt.hashSync(password, 10);
    return run('INSERT INTO users (username, password, email, telegram, role) VALUES (?,?,?,?,?)',
      [username, hash, email, telegram, role]);
  },
  updateUser: (id, data) => {
    if (data.password) {
      const hash = bcrypt.hashSync(data.password, 10);
      return run('UPDATE users SET username=?, password=?, email=?, telegram=?, role=? WHERE id=?',
        [data.username, hash, data.email || '', data.telegram || '', data.role || 'user', id]);
    }
    return run('UPDATE users SET username=?, email=?, telegram=?, role=? WHERE id=?',
      [data.username, data.email || '', data.telegram || '', data.role || 'user', id]);
  },
  deleteUser: (id) => run(`DELETE FROM users WHERE id=? AND username != 'N4XCO'`, [id]),
  getUserOrders: (username) => query(
    `SELECT * FROM orders WHERE username=? ORDER BY created_at DESC`, [username]
  ),

  // ==================== PLANS ====================
  getPlans: (enabledOnly = false) => {
    if (enabledOnly) return query('SELECT * FROM plans WHERE enabled=1 ORDER BY days ASC');
    return query('SELECT * FROM plans ORDER BY days ASC');
  },
  updatePlan: (id, data) => run(
    'UPDATE plans SET label=?, days=?, price=?, enabled=? WHERE id=?',
    [data.label, data.days, data.price, data.enabled ? 1 : 0, id]
  ),

  // ==================== KEYS ====================
  addKeys: async (planId, keysList) => {
    for (const k of keysList) {
      await run('INSERT INTO keys_pool (plan_id, key_val) VALUES (?,?)', [planId, k]);
    }
    return keysList.length;
  },
  getKeyCounts: async () => {
    const rows = await query(
      'SELECT plan_id, COUNT(*) as total, SUM(CASE WHEN used=0 THEN 1 ELSE 0 END) as available FROM keys_pool GROUP BY plan_id'
    );
    return rows;
  },
  getAllKeys: () => query('SELECT * FROM keys_pool ORDER BY plan_id, id'),
  getKeysByPlan: (planId) => query('SELECT * FROM keys_pool WHERE plan_id=? ORDER BY id', [planId]),
  popKey: async (planId) => {
    const k = await get('SELECT * FROM keys_pool WHERE plan_id=? AND used=0 ORDER BY id ASC LIMIT 1', [planId]);
    return k || null;
  },
  markKeyUsed: (keyId, orderId) => run(
    'UPDATE keys_pool SET used=1, order_id=?, used_at=datetime("now") WHERE id=?',
    [orderId, keyId]
  ),
  deleteKey: (id) => run('DELETE FROM keys_pool WHERE id=?', [id]),

  // ==================== ORDERS ====================
  createOrder: (data) => run(
    `INSERT INTO orders (id, user_id, username, telegram, plan_id, plan_label, price, days, paymongo_link_id, paymongo_link_url, reference_num)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [data.id, data.user_id || null, data.username, data.telegram || '', data.plan_id, data.plan_label, data.price, data.days,
     data.paymongo_link_id || '', data.paymongo_link_url || '', data.reference_num || '']
  ),
  getOrder: (id) => get('SELECT * FROM orders WHERE id=?', [id]),
  getOrders: (status) => {
    if (status) return query('SELECT * FROM orders WHERE status=? ORDER BY created_at DESC', [status]);
    return query('SELECT * FROM orders ORDER BY created_at DESC');
  },
  updateOrderPaid: async (orderId) => {
    const order = await get('SELECT * FROM orders WHERE id=?', [orderId]);
    if (!order || order.status !== 'pending') return order;
    // Try to auto-assign a key
    const keyRow = await get('SELECT * FROM keys_pool WHERE plan_id=? AND used=0 ORDER BY id ASC LIMIT 1', [order.plan_id]);
    if (keyRow) {
      await run('UPDATE keys_pool SET used=1, order_id=?, used_at=datetime("now") WHERE id=?', [orderId, keyRow.id]);
      await run('UPDATE orders SET status=?, key_given=?, paid_at=datetime("now"), fulfilled_at=datetime("now") WHERE id=?',
        ['fulfilled', keyRow.key_val, orderId]);
      return { ...order, status: 'fulfilled', key_given: keyRow.key_val };
    } else {
      await run('UPDATE orders SET status=?, paid_at=datetime("now") WHERE id=?', ['paid', orderId]);
      return { ...order, status: 'paid' };
    }
  },
  fulfillOrder: async (orderId, key) => {
    await run('UPDATE orders SET status=?, key_given=?, fulfilled_at=datetime("now") WHERE id=?',
      ['fulfilled', key, orderId]);
  },
  cancelOrder: (orderId) => run(
    'UPDATE orders SET status=?, cancelled_at=datetime("now") WHERE id=?', ['cancelled', orderId]
  ),
  pollPaymongoStatus: async (orderId) => {
    // Used by the status endpoint to actively check PayMongo
    const order = await get('SELECT * FROM orders WHERE id=?', [orderId]);
    if (!order) return null;
    if (order.status !== 'pending') return order;
    const settings = await get('SELECT * FROM paymongo_settings WHERE id=1');
    if (!settings?.secret_key || !order.paymongo_link_id) return order;
    try {
      const resp = await fetch(`https://api.paymongo.com/v1/links/${order.paymongo_link_id}`, {
        headers: { Authorization: 'Basic ' + Buffer.from(settings.secret_key + ':').toString('base64') }
      });
      const pmData = await resp.json();
      const pmStatus = pmData?.data?.attributes?.status;
      const payments = pmData?.data?.attributes?.payments || [];
      if (pmStatus === 'paid' || payments.some(p => p.attributes?.status === 'paid')) {
        return dbFuncs.updateOrderPaid(orderId);
      }
    } catch (e) { console.error('Poll error:', e.message); }
    return order;
  },

  // ==================== APK SETTINGS ====================
  getApkSettings: () => get('SELECT * FROM apk_settings WHERE id=1'),
  updateApkSettings: (data) => run(
    'UPDATE apk_settings SET name=?, logo=?, link=? WHERE id=1',
    [data.name, data.logo || '', data.link || '']
  ),

  // ==================== PAYMONGO ====================
  getPaymongoSettings: () => get('SELECT * FROM paymongo_settings WHERE id=1'),
  updatePaymongoSettings: (data) => run(
    'UPDATE paymongo_settings SET secret_key=?, public_key=?, updated_at=CURRENT_TIMESTAMP WHERE id=1',
    [data.secret_key || '', data.public_key || '']
  ),
};

module.exports = dbFuncs;
