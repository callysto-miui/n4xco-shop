const express = require('express');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const db = require('./database.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Multer for uploads ───────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'screenshot') {
      cb(null, path.join(__dirname, 'public/uploads'));
    } else if (file.fieldname === 'qr_code') {
      cb(null, path.join(__dirname, 'public/images'));
    } else if (file.fieldname === 'logo') {
      cb(null, path.join(__dirname, 'public/images'));
    } else {
      cb(null, path.join(__dirname, 'public/images'));
    }
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Ensure upload directories exist
const fs = require('fs');
const dirs = ['./public/uploads', './public/images'];
dirs.forEach(dir => {
  if (!fs.existsSync(path.join(__dirname, dir))) {
    fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
  }
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'n4xco_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ─── Auth middleware ───────────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  if (req.session?.admin) { req.adminUser = req.session.adminUser; return next(); }
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const sess = await db.verifyToken(token).catch(() => null);
    if (sess) {
      const user = await db.getUser(sess.username).catch(() => null);
      if (user?.role === 'admin') { req.adminUser = sess.username; return next(); }
    }
  }
  res.status(401).json({ success: false, message: 'Unauthorized' });
}

async function requireUser(req, res, next) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const sess = await db.verifyToken(token).catch(() => null);
    if (sess) { req.sessionUser = sess.username; return next(); }
  }
  res.status(401).json({ success: false, message: 'Login required' });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

// Public store data
app.get('/api/store', async (req, res) => {
  try {
    const apk = await db.getApkSettings();
    const plans = await db.getPlans(true);
    const services = await db.getServices();
    const shopSettings = await db.getShopSettings();
    const depositSettings = await db.getDepositSettings();
    const paymentMethods = await db.getPaymentMethods(true);
    res.json({ apk, plans, services, shopSettings, depositSettings, paymentMethods });
  } catch (err) {
    console.error('Store error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Validate a promo code (public, used by checkout UI)
app.post('/api/promo/validate', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.json({ valid: false, message: 'Code required' });
    const p = await db.getPromoByCode(code);
    if (!p || !p.enabled) return res.json({ valid: false, message: 'Invalid code' });
    if (p.expires_at && new Date(p.expires_at) < new Date())
      return res.json({ valid: false, message: 'Code expired' });
    if (p.max_uses > 0 && p.uses >= p.max_uses)
      return res.json({ valid: false, message: 'Code usage limit reached' });
    res.json({ valid: true, code: p.code, discount_type: p.discount_type, discount_value: p.discount_value });
  } catch (e) {
    res.status(500).json({ valid: false, message: 'Server error' });
  }
});

// ─── User Register ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, telegram, facebook } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ success: false, message: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  try {
    await db.createUser(username, password, '', telegram || '', facebook || '', 'user');
    const token = await db.createToken(username);
    const user = await db.getUser(username);
    res.json({ success: true, token, username, role: 'user', balance: user.balance });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ success: false, message: 'Username already taken' });
    console.error('Register error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── User Login ────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await db.getUser(username);
    if (!user || !db.verifyPassword(password, user.password))
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const token = await db.createToken(username);
    res.json({ success: true, token, username: user.username, role: user.role, balance: user.balance });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Get User Info (with balance) ─────────────────────────────────────────────
app.get('/api/user/info', requireUser, async (req, res) => {
  try {
    const user = await db.getUser(req.sessionUser);
    res.json({ success: true, username: user.username, balance: user.balance, telegram: user.telegram, facebook: user.facebook });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── User Orders ──────────────────────────────────────────────────────────────
app.get('/api/user/orders', requireUser, async (req, res) => {
  try {
    const orders = await db.getUserOrders(req.sessionUser);
    res.json({ success: true, orders });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Cancel a pending order (user self-service)
app.post('/api/user/orders/:id/cancel', requireUser, async (req, res) => {
  try {
    const order = await db.getOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.username !== req.sessionUser) return res.status(403).json({ success: false, message: 'Forbidden' });
    if (order.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending orders can be cancelled' });
    await db.cancelOrder(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Purchase with Balance ────────────────────────────────────────────────────
app.post('/api/purchase', requireUser, async (req, res) => {
  const { planId, promoCode } = req.body;
  if (!planId) return res.status(400).json({ success: false, message: 'Plan required' });

  try {
    const plans = await db.getPlans(true);
    const plan = plans.find(p => p.id === planId);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

    const keyAvailable = await db.getKeyAvailable(planId);
    if (keyAvailable === 0) {
      return res.status(400).json({ success: false, message: 'No keys available for this plan. Please try again later.' });
    }

    // Apply promo code if provided
    let finalPrice = plan.price;
    let appliedPromo = null;
    if (promoCode) {
      const p = await db.getPromoByCode(promoCode);
      if (p && p.enabled
          && (!p.expires_at || new Date(p.expires_at) >= new Date())
          && (p.max_uses === 0 || p.uses < p.max_uses)) {
        if (p.discount_type === 'flat') finalPrice = Math.max(0, plan.price - p.discount_value);
        else finalPrice = Math.max(0, Math.round(plan.price * (100 - p.discount_value) / 100));
        appliedPromo = p;
      } else {
        return res.status(400).json({ success: false, message: 'Promo code is invalid or expired' });
      }
    }

    const user = await db.getUser(req.sessionUser);
    if (user.balance < finalPrice) {
      return res.status(400).json({ success: false, message: 'Insufficient balance. Please deposit funds first.' });
    }

    await db.addUserBalance(req.sessionUser, -finalPrice);
    const keyRow = await db.popKey(planId);
    if (!keyRow) {
      await db.addUserBalance(req.sessionUser, finalPrice);
      return res.status(400).json({ success: false, message: 'Key temporarily unavailable. Please try again.' });
    }
    const orderId = uuidv4();
    await db.createOrder({
      id: orderId,
      user_id: user.id,
      username: req.sessionUser,
      plan_id: plan.id,
      plan_label: plan.label + (appliedPromo ? ` (promo ${appliedPromo.code})` : ''),
      price: finalPrice,
      days: plan.days
    });
    await db.markKeyUsed(keyRow.id, orderId);
    await db.fulfillOrder(orderId, keyRow.key_val);
    if (appliedPromo) await db.incrementPromoUses(appliedPromo.id);
    res.json({ success: true, key: keyRow.key_val, orderId, newBalance: user.balance - finalPrice, paid: finalPrice });
  } catch (err) {
    console.error('Purchase error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Deposit Request ──────────────────────────────────────────────────────────
const uploadScreenshot = upload.single('screenshot');
app.post('/api/deposit', requireUser, (req, res) => {
  uploadScreenshot(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, message: 'File upload error: ' + err.message });
    const { amount, telegram, facebook, last4_digits, notes } = req.body;
    if (!amount || !telegram || !facebook || !last4_digits) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    const depositAmount = parseInt(amount);
    if (isNaN(depositAmount) || depositAmount < 50) {
      return res.status(400).json({ success: false, message: 'Minimum deposit is ₱50' });
    }
    const referenceId = 'DEP-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    const screenshotPath = req.file ? '/uploads/' + req.file.filename : '';
    try {
      await db.createDeposit({
        reference_id: referenceId,
        username: req.sessionUser,
        amount: depositAmount,
        telegram: telegram,
        facebook: facebook,
        last4_digits: last4_digits,
        notes: notes || '',
        screenshot: screenshotPath
      });
      res.json({ success: true, message: 'Deposit request submitted! Admin will review and add credits.', referenceId });
    } catch (err) {
      console.error('Deposit error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });
});

// ─── User Deposit History ─────────────────────────────────────────────────────
app.get('/api/user/deposits', requireUser, async (req, res) => {
  try {
    const deposits = await db.getDeposits();
    const userDeposits = deposits.filter(d => d.username === req.sessionUser);
    res.json({ success: true, deposits: userDeposits });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Admin login
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await db.getUser(username);
    if (!user || user.role !== 'admin' || !db.verifyPassword(password, user.password))
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    req.session.admin = true;
    req.session.adminUser = username;
    res.json({ success: true });
  } catch (e) {
    console.error('Admin login error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ admin: !!req.session?.admin, username: req.session?.adminUser });
});

// Full admin data
app.get('/api/admin/data', requireAdmin, async (req, res) => {
  try {
    const [apk, plans, keyCounts, orders, users, deposits, services, shopSettings, depositSettings] = await Promise.all([
      db.getApkSettings(),
      db.getPlans(),
      db.getKeyCounts(),
      db.getOrders(),
      db.getAllUsers(),
      db.getDeposits(),
      db.getAllServices(),
      db.getShopSettings(),
      db.getDepositSettings()
    ]);
    res.json({ apk, plans, keyCounts, orders, users, deposits, services, shopSettings, depositSettings });
  } catch (e) {
    console.error('Admin data error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// APK settings
app.post('/api/admin/apk', requireAdmin, async (req, res) => {
  try {
    const current = await db.getApkSettings();
    await db.updateApkSettings({ ...current, ...req.body });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Logo upload
app.post('/api/admin/logo', requireAdmin, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  const logo = '/images/' + req.file.filename + '?t=' + Date.now();
  const current = await db.getApkSettings();
  await db.updateApkSettings({ ...current, logo });
  res.json({ success: true, logo });
});

// Deposit Settings (GCash number and QR code)
app.get('/api/admin/deposit-settings', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getDepositSettings();
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/deposit-settings', requireAdmin, upload.single('qr_code'), async (req, res) => {
  try {
    const { gcash_number } = req.body;
    let qr_code = req.body.qr_code || '';
    if (req.file) {
      qr_code = '/images/' + req.file.filename + '?t=' + Date.now();
    }
    await db.updateDepositSettings({ gcash_number, qr_code });
    res.json({ success: true });
  } catch (e) {
    console.error('Deposit settings error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Plans
app.get('/api/admin/plans', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getPlans());
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/plans', requireAdmin, async (req, res) => {
  try {
    const { plans } = req.body;
    for (const p of plans) {
      await db.updatePlan(p.id, { label: p.label, days: p.days, price: p.price, enabled: p.enabled });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Keys
app.post('/api/admin/keys', requireAdmin, async (req, res) => {
  try {
    const { planId, keys } = req.body;
    const newKeys = keys.split('\n').map(k => k.trim()).filter(k => k.length > 0);
    const added = await db.addKeys(planId, newKeys);
    res.json({ success: true, added });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/admin/keys', requireAdmin, async (req, res) => {
  try {
    const keys = await db.getAllKeys();
    const counts = await db.getKeyCounts();
    res.json({ success: true, keys, counts });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.delete('/api/admin/keys/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteKey(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Orders
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || null;
    res.json(await db.getOrders(status));
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getAllUsers());
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { username, password, email, telegram, facebook, role, balance } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
  try {
    await db.createUser(username, password, email || '', telegram || '', facebook || '', role || 'user');
    if (balance) await db.addUserBalance(username, parseInt(balance));
    res.json({ success: true });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ success: false, message: 'Username already taken' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await db.updateUser(req.params.id, req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteUser(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Deposits management
app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || null;
    res.json(await db.getDeposits(status));
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { admin_notes } = req.body;
    await db.updateDepositStatus(req.params.id, 'approved', admin_notes || '', req.session.adminUser);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { admin_notes } = req.body;
    await db.updateDepositStatus(req.params.id, 'rejected', admin_notes || '', req.session.adminUser);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.delete('/api/admin/deposits/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteDeposit(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Services management
app.get('/api/admin/services', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getAllServices());
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/services', requireAdmin, async (req, res) => {
  try {
    await db.createService(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.put('/api/admin/services/:id', requireAdmin, async (req, res) => {
  try {
    await db.updateService(req.params.id, req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.delete('/api/admin/services/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteService(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Shop settings
app.post('/api/admin/shop-settings', requireAdmin, async (req, res) => {
  try {
    await db.updateShopSettings(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [orders, users, counts, deposits] = await Promise.all([
      db.getOrders(),
      db.getAllUsers(),
      db.getKeyCounts(),
      db.getDeposits()
    ]);
    const revenue = orders.filter(o => o.status === 'fulfilled').reduce((a, b) => a + b.price, 0);
    const fulfilled = orders.filter(o => o.status === 'fulfilled').length;
    const pendingDeposits = deposits.filter(d => d.status === 'pending').length;
    const totalDeposits = deposits.reduce((a, b) => a + (b.status === 'approved' ? b.amount : 0), 0);
    res.json({ 
      totalOrders: orders.length, 
      fulfilled, 
      revenue, 
      totalUsers: users.length, 
      keyCounts: counts,
      pendingDeposits,
      totalDeposits
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Payment Methods (admin) ───────────────────────────────────────────────────
app.get('/api/admin/payment-methods', requireAdmin, async (req, res) => {
  try { res.json(await db.getPaymentMethods()); }
  catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/payment-methods', requireAdmin, upload.single('qr_code'), async (req, res) => {
  try {
    const body = { ...req.body, enabled: req.body.enabled == 1 || req.body.enabled === 'true' || req.body.enabled === true };
    if (req.file) body.qr_code = '/images/' + req.file.filename;
    await db.createPaymentMethod(body);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Server error' }); }
});
app.put('/api/admin/payment-methods/:id', requireAdmin, upload.single('qr_code'), async (req, res) => {
  try {
    const body = { ...req.body, enabled: req.body.enabled == 1 || req.body.enabled === 'true' || req.body.enabled === true };
    if (req.file) body.qr_code = '/images/' + req.file.filename;
    else if (!body.qr_code) {
      const cur = await db.getPaymentMethod(req.params.id);
      body.qr_code = cur ? cur.qr_code : '';
    }
    await db.updatePaymentMethod(req.params.id, body);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: 'Server error' }); }
});
app.delete('/api/admin/payment-methods/:id', requireAdmin, async (req, res) => {
  try { await db.deletePaymentMethod(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─── Promo codes (admin) ───────────────────────────────────────────────────────
app.get('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  try { res.json(await db.getPromoCodes()); }
  catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  try { await db.createPromoCode(req.body); res.json({ success: true }); }
  catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ success: false, message: 'Code already exists' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
app.put('/api/admin/promo-codes/:id', requireAdmin, async (req, res) => {
  try { await db.updatePromoCode(req.params.id, req.body); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.delete('/api/admin/promo-codes/:id', requireAdmin, async (req, res) => {
  try { await db.deletePromoCode(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─── Dashboard analytics ──────────────────────────────────────────────────────
app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 14, 90);
    const [salesByDay, topPlans, orders, users, deposits, counts] = await Promise.all([
      db.getSalesByDay(days), db.getTopPlans(5),
      db.getOrders(), db.getAllUsers(), db.getDeposits(), db.getKeyCounts()
    ]);
    const fulfilled = orders.filter(o => o.status === 'fulfilled');
    const revenue = fulfilled.reduce((a, b) => a + b.price, 0);
    const today = new Date().toISOString().slice(0, 10);
    const todayRevenue = fulfilled.filter(o => (o.fulfilled_at || o.created_at || '').slice(0, 10) === today)
                                   .reduce((a, b) => a + b.price, 0);
    const lowStock = counts.filter(c => (c.available || 0) <= 3);
    res.json({
      summary: {
        revenue, todayRevenue,
        totalOrders: orders.length,
        fulfilledOrders: fulfilled.length,
        totalUsers: users.length,
        pendingDeposits: deposits.filter(d => d.status === 'pending').length,
      },
      salesByDay, topPlans, lowStock
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.listen(PORT, () => console.log(`N4XCO Shop running on port ${PORT}`));

