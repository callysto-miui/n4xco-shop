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

  // Users table with balance
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    password   TEXT NOT NULL,
    email      TEXT DEFAULT '',
    telegram   TEXT DEFAULT '',
    facebook   TEXT DEFAULT '',
    balance    INTEGER DEFAULT 0,
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

  // Plans table
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

  // Orders table (purchases using balance)
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id                 TEXT PRIMARY KEY,
    user_id            INTEGER DEFAULT NULL,
    username           TEXT NOT NULL,
    plan_id            TEXT NOT NULL,
    plan_label         TEXT NOT NULL,
    price              INTEGER NOT NULL,
    days               INTEGER NOT NULL,
    status             TEXT DEFAULT 'pending',
    key_given          TEXT DEFAULT NULL,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    fulfilled_at       DATETIME DEFAULT NULL
  )`);

  // Deposit requests table
  db.run(`CREATE TABLE IF NOT EXISTS deposits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_id    TEXT UNIQUE NOT NULL,
    username        TEXT NOT NULL,
    amount          INTEGER NOT NULL,
    telegram        TEXT NOT NULL,
    facebook        TEXT NOT NULL,
    last4_digits    TEXT NOT NULL,
    notes           TEXT DEFAULT '',
    screenshot      TEXT DEFAULT '',
    status          TEXT DEFAULT 'pending',
    admin_notes     TEXT DEFAULT '',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at    DATETIME DEFAULT NULL,
    processed_by    TEXT DEFAULT NULL
  )`);

  // Deposit settings (GCash number and QR code)
  db.run(`CREATE TABLE IF NOT EXISTS deposit_settings (
    id          INTEGER PRIMARY KEY,
    gcash_number TEXT DEFAULT '09123456789',
    qr_code     TEXT DEFAULT '',
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`INSERT OR IGNORE INTO deposit_settings (id, gcash_number) VALUES (1, '09123456789')`);

  // Payment methods (admin-editable list: GCash, Maya, PayPal, Bank, etc.)
  db.run(`CREATE TABLE IF NOT EXISTS payment_methods (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    account_name TEXT DEFAULT '',
    account_number TEXT NOT NULL,
    instructions TEXT DEFAULT '',
    qr_code     TEXT DEFAULT '',
    enabled     INTEGER DEFAULT 1,
    sort_order  INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Seed a default GCash entry on first run (mirrors deposit_settings)
  db.get('SELECT COUNT(*) AS c FROM payment_methods', (e, row) => {
    if (!e && row && row.c === 0) {
      db.run(`INSERT INTO payment_methods (name, account_name, account_number, instructions, enabled, sort_order)
              VALUES ('GCash', 'N4XCO', '09123456789', 'Send to this GCash number then submit the receipt screenshot.', 1, 1)`);
    }
  });

  // Promo / discount codes
  db.run(`CREATE TABLE IF NOT EXISTS promo_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    discount_type TEXT NOT NULL DEFAULT 'percent', -- 'percent' or 'flat'
    discount_value INTEGER NOT NULL DEFAULT 0,
    max_uses    INTEGER DEFAULT 0, -- 0 = unlimited
    uses        INTEGER DEFAULT 0,
    expires_at  DATETIME DEFAULT NULL,
    enabled     INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Services table
  db.run(`CREATE TABLE IF NOT EXISTS services (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    link        TEXT DEFAULT '',
    price       INTEGER DEFAULT 0,
    "order"     INTEGER DEFAULT 0,
    enabled     INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // APK settings
  db.run(`CREATE TABLE IF NOT EXISTS apk_settings (
    id   INTEGER PRIMARY KEY,
    name TEXT DEFAULT 'N4XCO App',
    logo TEXT DEFAULT '',
    link TEXT DEFAULT 'https://example.com/download'
  )`);
  db.run(`INSERT OR IGNORE INTO apk_settings (id, name) VALUES (1, 'N4XCO App')`);

  // Shop settings (for service categories visibility)
  db.run(`CREATE TABLE IF NOT EXISTS shop_settings (
    id          INTEGER PRIMARY KEY,
    show_android   INTEGER DEFAULT 1,
    show_boosting  INTEGER DEFAULT 1,
    show_jepfx     INTEGER DEFAULT 1,
    show_module    INTEGER DEFAULT 1,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`INSERT OR IGNORE INTO shop_settings (id) VALUES (1)`);

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

  // Seed default services
  const services = [
    ['android', '🔰 REMOTE SERVICE', '⚠️REMOTE SERVICE⚠️\n🔰Root\n🔰Rent tools\n🔰Custom ROM\n🔰Instant unlock BL (Mtk devices only)\n🔰Stock logo\n🔰Root\n🔰Mi cloud remove\n🔰Reflash\n🔰FRP bypass\n🔰Unbrick\n\n‼️REQUIREMENTS‼️\n🌐PC or Laptop\n🌐Original charger\n🌐Internet', '', 0, 1],
    ['android', 'ANDROID SERVICES', 'Custom ROM · Instant unlock BL · Stock logo · Root · Mi cloud remove · Reflash · FRP bypass · Unbrick', '', 0, 2],
    ['boosting', 'Instagram Services', 'Likes · Followers · Views', '', 100, 1],
    ['boosting', 'Telegram Services', 'Subscribers · Reactions · Views', '', 100, 2],
    ['boosting', 'Facebook Services', 'Post shares · Views · Followers', '', 100, 3],
    ['boosting', 'TikTok Services', 'Followers · Likes · Views', '', 100, 4],
    ['jepfx', '03 Hours', 'JEPFX Service Tool Access', 'https://t.me/n4xcoinfos/28', 50, 1],
    ['jepfx', '06 Hours', 'JEPFX Service Tool Access', 'https://t.me/n4xcoinfos/28', 80, 2],
    ['jepfx', '01 Day', 'JEPFX Service Tool Access', 'https://t.me/n4xcoinfos/28', 100, 3],
    ['jepfx', '07 Days', 'JEPFX Service Tool Access', 'https://t.me/n4xcoinfos/28', 150, 4],
    ['jepfx', 'LIFETIME', 'JEPFX Service Tool Access', 'https://t.me/n4xcoinfos/28', 500, 5],
    ['module', 'MODULE FOR ROOTED', 'One time payment · Full features access', 'https://t.me/n4xcoinfos/25', 160, 1],
  ];
  services.forEach(([cat, title, desc, link, price, order]) => {
    db.run(`INSERT OR IGNORE INTO services (category, title, description, link, price, "order") VALUES (?,?,?,?,?,?)`, 
      [cat, title, desc, link, price, order]);
  });

  // Seed default admin
  const adminHash = bcrypt.hashSync('N4XCO_0', 10);
  db.run(`INSERT OR IGNORE INTO users (username, password, role, balance) VALUES (?, ?, ?, ?)`,
    ['N4XCO', adminHash, 'admin', 0]);

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
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await run('INSERT INTO tokens (token, username, expires_at) VALUES (?,?,?)', [token, username, expires]);
    return token;
  },
  verifyToken: (token) => get(
    'SELECT * FROM tokens WHERE token=? AND expires_at > datetime("now")',
    [token]
  ),
  deleteToken: (token) => run('DELETE FROM tokens WHERE token=?', [token]),

  // ==================== USERS ====================
  getAllUsers: () => query('SELECT id, username, email, telegram, facebook, balance, role, created_at FROM users ORDER BY id'),
  createUser: async (username, password, email = '', telegram = '', facebook = '', role = 'user') => {
    const hash = bcrypt.hashSync(password, 10);
    return run('INSERT INTO users (username, password, email, telegram, facebook, role, balance) VALUES (?,?,?,?,?,?,?)',
      [username, hash, email, telegram, facebook, role, 0]);
  },
  updateUser: (id, data) => {
    if (data.password) {
      const hash = bcrypt.hashSync(data.password, 10);
      return run('UPDATE users SET username=?, password=?, email=?, telegram=?, facebook=?, role=?, balance=? WHERE id=?',
        [data.username, hash, data.email || '', data.telegram || '', data.facebook || '', data.role || 'user', data.balance || 0, id]);
    }
    return run('UPDATE users SET username=?, email=?, telegram=?, facebook=?, role=?, balance=? WHERE id=?',
      [data.username, data.email || '', data.telegram || '', data.facebook || '', data.role || 'user', data.balance || 0, id]);
  },
  deleteUser: (id) => run(`DELETE FROM users WHERE id=? AND username != 'N4XCO'`, [id]),
  getUserOrders: (username) => query(
    `SELECT * FROM orders WHERE username=? ORDER BY created_at DESC`, [username]
  ),
  updateUserBalance: (username, newBalance) => run('UPDATE users SET balance=? WHERE username=?', [newBalance, username]),
  addUserBalance: (username, amount) => run('UPDATE users SET balance = balance + ? WHERE username=?', [amount, username]),

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
  getKeyAvailable: (planId) => get('SELECT COUNT(*) as count FROM keys_pool WHERE plan_id=? AND used=0', [planId]).then(r => r?.count || 0),
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
    `INSERT INTO orders (id, user_id, username, plan_id, plan_label, price, days, status)
     VALUES (?,?,?,?,?,?,?,?)`,
    [data.id, data.user_id || null, data.username, data.plan_id, data.plan_label, data.price, data.days, 'pending']
  ),
  getOrder: (id) => get('SELECT * FROM orders WHERE id=?', [id]),
  getOrders: (status) => {
    if (status) return query('SELECT * FROM orders WHERE status=? ORDER BY created_at DESC', [status]);
    return query('SELECT * FROM orders ORDER BY created_at DESC');
  },
  fulfillOrder: async (orderId, key) => {
    await run('UPDATE orders SET status=?, key_given=?, fulfilled_at=datetime("now") WHERE id=?',
      ['fulfilled', key, orderId]);
  },
  cancelOrder: (orderId) => run(
    'UPDATE orders SET status=?, fulfilled_at=datetime("now") WHERE id=?', ['cancelled', orderId]
  ),

  // ==================== DEPOSITS ====================
  createDeposit: (data) => run(
    `INSERT INTO deposits (reference_id, username, amount, telegram, facebook, last4_digits, notes, screenshot)
     VALUES (?,?,?,?,?,?,?,?)`,
    [data.reference_id, data.username, data.amount, data.telegram, data.facebook, data.last4_digits, data.notes || '', data.screenshot || '']
  ),
  getDeposits: (status = null) => {
    if (status) return query('SELECT * FROM deposits WHERE status=? ORDER BY created_at DESC', [status]);
    return query('SELECT * FROM deposits ORDER BY created_at DESC');
  },
  getDeposit: (id) => get('SELECT * FROM deposits WHERE id=?', [id]),
  updateDepositStatus: async (id, status, adminNotes = '', processedBy = '') => {
    await run('UPDATE deposits SET status=?, admin_notes=?, processed_at=datetime("now"), processed_by=? WHERE id=?',
      [status, adminNotes, processedBy, id]);
    if (status === 'approved') {
      const deposit = await get('SELECT * FROM deposits WHERE id=?', [id]);
      if (deposit) {
        await run('UPDATE users SET balance = balance + ? WHERE username=?', [deposit.amount, deposit.username]);
        return deposit;
      }
    }
    return null;
  },
  deleteDeposit: (id) => run('DELETE FROM deposits WHERE id=?', [id]),

  // ==================== DEPOSIT SETTINGS ====================
  getDepositSettings: () => get('SELECT * FROM deposit_settings WHERE id=1'),
  updateDepositSettings: (data) => run(
    'UPDATE deposit_settings SET gcash_number=?, qr_code=?, updated_at=CURRENT_TIMESTAMP WHERE id=1',
    [data.gcash_number || '09123456789', data.qr_code || '']
  ),

  // ==================== SERVICES ====================
  getServices: (category = null) => {
    if (category) return query('SELECT * FROM services WHERE category=? AND enabled=1 ORDER BY "order" ASC', [category]);
    return query('SELECT * FROM services WHERE enabled=1 ORDER BY category, "order" ASC');
  },
  getAllServices: () => query('SELECT * FROM services ORDER BY category, "order" ASC'),
  getService: (id) => get('SELECT * FROM services WHERE id=?', [id]),
  createService: (data) => run(
    'INSERT INTO services (category, title, description, link, price, "order", enabled) VALUES (?,?,?,?,?,?,?)',
    [data.category, data.title, data.description, data.link || '', data.price || 0, data.order || 0, data.enabled ? 1 : 0]
  ),
  updateService: (id, data) => run(
    'UPDATE services SET category=?, title=?, description=?, link=?, price=?, "order"=?, enabled=? WHERE id=?',
    [data.category, data.title, data.description, data.link || '', data.price || 0, data.order || 0, data.enabled ? 1 : 0, id]
  ),
  deleteService: (id) => run('DELETE FROM services WHERE id=?', [id]),

  // ==================== SHOP SETTINGS ====================
  getShopSettings: () => get('SELECT * FROM shop_settings WHERE id=1'),
  updateShopSettings: (data) => run(
    'UPDATE shop_settings SET show_android=?, show_boosting=?, show_jepfx=?, show_module=?, updated_at=CURRENT_TIMESTAMP WHERE id=1',
    [data.show_android ? 1 : 0, data.show_boosting ? 1 : 0, data.show_jepfx ? 1 : 0, data.show_module ? 1 : 0]
  ),

  // ==================== APK SETTINGS ====================
  getApkSettings: () => get('SELECT * FROM apk_settings WHERE id=1'),
  updateApkSettings: (data) => run(
    'UPDATE apk_settings SET name=?, logo=?, link=? WHERE id=1',
    [data.name, data.logo || '', data.link || '']
  ),

  // ==================== PAYMENT METHODS ====================
  getPaymentMethods: (enabledOnly = false) => {
    if (enabledOnly) return query('SELECT * FROM payment_methods WHERE enabled=1 ORDER BY sort_order ASC, id ASC');
    return query('SELECT * FROM payment_methods ORDER BY sort_order ASC, id ASC');
  },
  getPaymentMethod: (id) => get('SELECT * FROM payment_methods WHERE id=?', [id]),
  createPaymentMethod: (d) => run(
    `INSERT INTO payment_methods (name, account_name, account_number, instructions, qr_code, enabled, sort_order)
     VALUES (?,?,?,?,?,?,?)`,
    [d.name, d.account_name || '', d.account_number, d.instructions || '', d.qr_code || '', d.enabled ? 1 : 0, d.sort_order || 0]
  ),
  updatePaymentMethod: (id, d) => run(
    `UPDATE payment_methods SET name=?, account_name=?, account_number=?, instructions=?, qr_code=?, enabled=?, sort_order=? WHERE id=?`,
    [d.name, d.account_name || '', d.account_number, d.instructions || '', d.qr_code || '', d.enabled ? 1 : 0, d.sort_order || 0, id]
  ),
  deletePaymentMethod: (id) => run('DELETE FROM payment_methods WHERE id=?', [id]),

  // ==================== PROMO CODES ====================
  getPromoCodes: () => query('SELECT * FROM promo_codes ORDER BY created_at DESC'),
  getPromoByCode: (code) => get('SELECT * FROM promo_codes WHERE code=? COLLATE NOCASE', [code]),
  createPromoCode: (d) => run(
    `INSERT INTO promo_codes (code, discount_type, discount_value, max_uses, expires_at, enabled)
     VALUES (?,?,?,?,?,?)`,
    [d.code.trim().toUpperCase(), d.discount_type === 'flat' ? 'flat' : 'percent',
     parseInt(d.discount_value) || 0, parseInt(d.max_uses) || 0,
     d.expires_at || null, d.enabled ? 1 : 0]
  ),
  updatePromoCode: (id, d) => run(
    `UPDATE promo_codes SET code=?, discount_type=?, discount_value=?, max_uses=?, expires_at=?, enabled=? WHERE id=?`,
    [d.code.trim().toUpperCase(), d.discount_type === 'flat' ? 'flat' : 'percent',
     parseInt(d.discount_value) || 0, parseInt(d.max_uses) || 0,
     d.expires_at || null, d.enabled ? 1 : 0, id]
  ),
  incrementPromoUses: (id) => run('UPDATE promo_codes SET uses = uses + 1 WHERE id=?', [id]),
  deletePromoCode: (id) => run('DELETE FROM promo_codes WHERE id=?', [id]),

  // ==================== DASHBOARD ANALYTICS ====================
  getSalesByDay: (days = 14) => query(
    `SELECT DATE(created_at) as day,
            COUNT(*) as orders,
            SUM(price) as revenue
       FROM orders
      WHERE status='fulfilled' AND created_at >= datetime('now', ?)
      GROUP BY DATE(created_at)
      ORDER BY day ASC`,
    [`-${days} days`]
  ),
  getTopPlans: (limit = 5) => query(
    `SELECT plan_id, plan_label, COUNT(*) as sold, SUM(price) as revenue
       FROM orders WHERE status='fulfilled'
      GROUP BY plan_id, plan_label
      ORDER BY sold DESC LIMIT ?`, [limit]
  ),
};

module.exports = dbFuncs;
