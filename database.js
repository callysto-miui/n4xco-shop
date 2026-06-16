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

  // Plans table (scoped to a category so each brand has its own plans)
  db.run(`CREATE TABLE IF NOT EXISTS plans (
    id       TEXT PRIMARY KEY,
    label    TEXT NOT NULL,
    days     INTEGER NOT NULL,
    price    INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'android',
    enabled  INTEGER DEFAULT 1
  )`);
  // Migration for existing deployments (idempotent)
  db.run(`ALTER TABLE plans ADD COLUMN category TEXT NOT NULL DEFAULT 'android'`, () => {});

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
    contact     TEXT DEFAULT '',
    price       INTEGER DEFAULT 0,
    "order"     INTEGER DEFAULT 0,
    enabled     INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`ALTER TABLE services ADD COLUMN contact TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE service_orders ADD COLUMN tier_id INTEGER`, () => {});
  db.run(`ALTER TABLE service_orders ADD COLUMN tier_label TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE service_orders ADD COLUMN quantity INTEGER DEFAULT 1`, () => {});


  // Editable shop categories (admin can add/edit/delete)
  db.run(`CREATE TABLE IF NOT EXISTS service_categories (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    key     TEXT NOT NULL UNIQUE,
    name    TEXT NOT NULL,
    target  TEXT NOT NULL DEFAULT 'shop',
    sort    INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1
  )`);
  const seedCats = [
    ['android','ANDROID SERVICES','services',1],
    ['boosting','BOOSTING SERVICES','shop',2],
    ['jepfx','JEPFX SERVICE TOOL','shop',3],
    ['module','MODULE FOR ROOTED','shop',4],
  ];
  seedCats.forEach(([k,n,t,o]) =>
    db.run(`INSERT OR IGNORE INTO service_categories (key,name,target,sort) VALUES (?,?,?,?)`,[k,n,t,o])
  );

  // Per-service pricing tiers (quantity / price variants)
  db.run(`CREATE TABLE IF NOT EXISTS service_tiers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL,
    label      TEXT NOT NULL,
    quantity   INTEGER DEFAULT 1,
    price      INTEGER NOT NULL,
    sort       INTEGER DEFAULT 0,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
  )`);

  // JEPFX (auto-delivered) stock links pool
  db.run(`CREATE TABLE IF NOT EXISTS service_stock (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id  INTEGER NOT NULL,
    value       TEXT NOT NULL,
    used        INTEGER DEFAULT 0,
    order_id    TEXT DEFAULT NULL,
    added_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at     DATETIME DEFAULT NULL
  )`);

  // Service purchase orders
  db.run(`CREATE TABLE IF NOT EXISTS service_orders (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    service_id    INTEGER NOT NULL,
    category      TEXT NOT NULL,
    title         TEXT NOT NULL,
    price         INTEGER NOT NULL,
    telegram      TEXT DEFAULT '',
    facebook      TEXT DEFAULT '',
    user_link     TEXT DEFAULT '',
    delivered     TEXT DEFAULT '',
    status        TEXT DEFAULT 'pending',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
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

  // Telegram bot settings — configured from the admin panel
  db.run(`CREATE TABLE IF NOT EXISTS telegram_settings (
    id          INTEGER PRIMARY KEY,
    bot_token   TEXT DEFAULT '',
    chat_id     TEXT DEFAULT '',
    enabled     INTEGER DEFAULT 0,
    low_stock_threshold INTEGER DEFAULT 3,
    daily_summary_hour INTEGER DEFAULT 9,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`INSERT OR IGNORE INTO telegram_settings (id) VALUES (1)`);

  // Seed default plans (legacy ML plans live under the "android" category)
  const plans = [
    ['03days', '03 Days', 3, 120, 'android'],
    ['07days', '07 Days', 7, 200, 'android'],
    ['15days', '15 Days', 15, 250, 'android'],
    ['20days', '20 Days', 20, 350, 'android'],
    ['30days', '30 Days', 30, 600, 'android'],
    ['60days', '60 Days', 60, 1000, 'android'],
    ['90days', '90 Days', 90, 1300, 'android'],
  ];
  plans.forEach(([id, label, days, price, category]) => {
    db.run(`INSERT OR IGNORE INTO plans (id, label, days, price, category) VALUES (?,?,?,?,?)`,
      [id, label, days, price, category]);
  });
  // Backfill category for any pre-existing rows that were inserted before the column existed
  db.run(`UPDATE plans SET category='android' WHERE category IS NULL OR category=''`);


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
    if (enabledOnly) return query('SELECT * FROM plans WHERE enabled=1 ORDER BY category ASC, days ASC');
    return query('SELECT * FROM plans ORDER BY category ASC, days ASC');
  },
  getPlansByCategory: (category, enabledOnly = false) => {
    const sql = enabledOnly
      ? 'SELECT * FROM plans WHERE category=? AND enabled=1 ORDER BY days ASC'
      : 'SELECT * FROM plans WHERE category=? ORDER BY days ASC';
    return query(sql, [category]);
  },
  getPlan: (id) => get('SELECT * FROM plans WHERE id=?', [id]),
  createPlan: (d) => run(
    'INSERT INTO plans (id, label, days, price, category, enabled) VALUES (?,?,?,?,?,?)',
    [
      String(d.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
      String(d.label || '').trim(),
      parseInt(d.days) || 0,
      parseInt(d.price) || 0,
      String(d.category || 'android').trim().toLowerCase(),
      d.enabled === false ? 0 : 1,
    ]
  ),
  updatePlan: (id, data) => run(
    'UPDATE plans SET id=?, label=?, days=?, price=?, category=?, enabled=? WHERE id=?',
    [
      data.new_id || data.id || id,
      data.label,
      parseInt(data.days) || 0,
      parseInt(data.price) || 0,
      String(data.category || 'android').trim().toLowerCase(),
      data.enabled ? 1 : 0,
      id,
    ]
  ),
  deletePlan: async (id) => {
    // Remove associated keys first so they don't dangle
    await run('DELETE FROM keys_pool WHERE plan_id=?', [id]);
    return run('DELETE FROM plans WHERE id=?', [id]);
  },


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
    'INSERT INTO services (category, title, description, link, contact, price, "order", enabled) VALUES (?,?,?,?,?,?,?,?)',
    [data.category, data.title, data.description, data.link || '', data.contact || '', data.price || 0, data.order || 0, data.enabled ? 1 : 0]
  ),
  updateService: (id, data) => run(
    'UPDATE services SET category=?, title=?, description=?, link=?, contact=?, price=?, "order"=?, enabled=? WHERE id=?',
    [data.category, data.title, data.description, data.link || '', data.contact || '', data.price || 0, data.order || 0, data.enabled ? 1 : 0, id]
  ),
  deleteService: (id) => run('DELETE FROM services WHERE id=?', [id]),

  // ==================== SERVICE STOCK (e.g. JEPFX links) ====================
  getServiceStock: (serviceId) => query('SELECT * FROM service_stock WHERE service_id=? ORDER BY id', [serviceId]),
  getServiceStockCounts: () => query(
    `SELECT service_id, COUNT(*) total, SUM(CASE WHEN used=0 THEN 1 ELSE 0 END) available
     FROM service_stock GROUP BY service_id`
  ),
  addServiceStock: async (serviceId, values) => {
    for (const v of values) await run('INSERT INTO service_stock (service_id, value) VALUES (?,?)', [serviceId, v]);
    return values.length;
  },
  popServiceStock: (serviceId) =>
    get('SELECT * FROM service_stock WHERE service_id=? AND used=0 ORDER BY id ASC LIMIT 1', [serviceId]),
  markServiceStockUsed: (id, orderId) =>
    run('UPDATE service_stock SET used=1, order_id=?, used_at=datetime("now") WHERE id=?', [orderId, id]),
  deleteServiceStock: (id) => run('DELETE FROM service_stock WHERE id=?', [id]),


  // ==================== CATEGORIES ====================
  getCategories: (enabledOnly=false) => enabledOnly
    ? query('SELECT * FROM service_categories WHERE enabled=1 ORDER BY sort ASC, id ASC')
    : query('SELECT * FROM service_categories ORDER BY sort ASC, id ASC'),
  getCategoryByKey: (key) => get('SELECT * FROM service_categories WHERE key=?',[key]),
  createCategory: (d) => run(
    'INSERT INTO service_categories (key,name,target,sort,enabled) VALUES (?,?,?,?,?)',
    [String(d.key||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,''), d.name, (d.target==='services'?'services':'shop'), parseInt(d.sort)||0, d.enabled?1:0]
  ),
  updateCategory: (id,d) => run(
    'UPDATE service_categories SET key=?,name=?,target=?,sort=?,enabled=? WHERE id=?',
    [String(d.key||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,''), d.name, (d.target==='services'?'services':'shop'), parseInt(d.sort)||0, d.enabled?1:0, id]
  ),
  deleteCategory: (id) => run('DELETE FROM service_categories WHERE id=?',[id]),

  // ==================== SERVICE TIERS ====================
  getTiersByService: (serviceId) => query('SELECT * FROM service_tiers WHERE service_id=? ORDER BY sort ASC, id ASC',[serviceId]),
  getAllTiers: () => query('SELECT * FROM service_tiers ORDER BY service_id, sort ASC, id ASC'),
  getTier: (id) => get('SELECT * FROM service_tiers WHERE id=?',[id]),
  createTier: (d) => run(
    'INSERT INTO service_tiers (service_id,label,quantity,price,sort) VALUES (?,?,?,?,?)',
    [parseInt(d.service_id), d.label, parseInt(d.quantity)||1, parseInt(d.price)||0, parseInt(d.sort)||0]
  ),
  updateTier: (id,d) => run(
    'UPDATE service_tiers SET label=?,quantity=?,price=?,sort=? WHERE id=?',
    [d.label, parseInt(d.quantity)||1, parseInt(d.price)||0, parseInt(d.sort)||0, id]
  ),
  deleteTier: (id) => run('DELETE FROM service_tiers WHERE id=?',[id]),

  // ==================== SERVICE ORDERS ====================
  createServiceOrder: (d) => run(
    `INSERT INTO service_orders (id, username, service_id, category, title, price, telegram, facebook, user_link, delivered, status, tier_id, tier_label, quantity)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [d.id, d.username, d.service_id, d.category, d.title, d.price, d.telegram || '', d.facebook || '', d.user_link || '', d.delivered || '', d.status || 'pending', d.tier_id||null, d.tier_label||'', d.quantity||1]
  ),
  getServiceOrders: () => query('SELECT * FROM service_orders ORDER BY created_at DESC'),
  getUserServiceOrders: (username) => query('SELECT * FROM service_orders WHERE username=? ORDER BY created_at DESC', [username]),


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

  // ==================== TELEGRAM SETTINGS ====================
  getTelegramSettings: () => get('SELECT * FROM telegram_settings WHERE id=1'),
  updateTelegramSettings: (d) => run(
    `UPDATE telegram_settings SET bot_token=?, chat_id=?, enabled=?, low_stock_threshold=?, daily_summary_hour=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`,
    [d.bot_token || '', d.chat_id || '', d.enabled ? 1 : 0,
      Math.max(0, parseInt(d.low_stock_threshold) || 3),
      Math.min(23, Math.max(0, parseInt(d.daily_summary_hour) || 9))]
  ),
};

module.exports = dbFuncs;
