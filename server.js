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
  const apk = await db.getApkSettings();
  const plans = await db.getPlans(true);
  const services = await db.getServices();
  const shopSettings = await db.getShopSettings();
  res.json({ apk, plans, services, shopSettings });
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
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Get User Info (with balance) ─────────────────────────────────────────────
app.get('/api/user/info', requireUser, async (req, res) => {
  const user = await db.getUser(req.sessionUser);
  res.json({ success: true, username: user.username, balance: user.balance, telegram: user.telegram, facebook: user.facebook });
});

// ─── User Orders ──────────────────────────────────────────────────────────────
app.get('/api/user/orders', requireUser, async (req, res) => {
  const orders = await db.getUserOrders(req.sessionUser);
  res.json({ success: true, orders });
});

// Cancel a pending order (user self-service)
app.post('/api/user/orders/:id/cancel', requireUser, async (req, res) => {
  const order = await db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.username !== req.sessionUser) return res.status(403).json({ success: false, message: 'Forbidden' });
  if (order.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending orders can be cancelled' });
  await db.cancelOrder(req.params.id);
  res.json({ success: true });
});

// ─── Purchase with Balance ────────────────────────────────────────────────────
app.post('/api/purchase', requireUser, async (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ success: false, message: 'Plan required' });

  const plans = await db.getPlans(true);
  const plan = plans.find(p => p.id === planId);
  if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

  // Check if key available
  const keyAvailable = await db.getKeyAvailable(planId);
  if (keyAvailable === 0) {
    return res.status(400).json({ success: false, message: 'No keys available for this plan. Please try again later.' });
  }

  const user = await db.getUser(req.sessionUser);
  if (user.balance < plan.price) {
    return res.status(400).json({ success: false, message: 'Insufficient balance. Please deposit funds first.' });
  }

  try {
    // Deduct balance
    await db.addUserBalance(req.sessionUser, -plan.price);
    
    // Get key
    const keyRow = await db.popKey(planId);
    if (!keyRow) {
      // Refund if no key (shouldn't happen but just in case)
      await db.addUserBalance(req.sessionUser, plan.price);
      return res.status(400).json({ success: false, message: 'Key temporarily unavailable. Please try again.' });
    }
    
    const orderId = uuidv4();
    await db.createOrder({
      id: orderId,
      user_id: user.id,
      username: req.sessionUser,
      plan_id: plan.id,
      plan_label: plan.label,
      price: plan.price,
      days: plan.days
    });
    
    await db.markKeyUsed(keyRow.id, orderId);
    await db.fulfillOrder(orderId, keyRow.key_val);
    
    res.json({ success: true, key: keyRow.key_val, orderId, newBalance: user.balance - plan.price });
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
  const deposits = await db.getDeposits();
  const userDeposits = deposits.filter(d => d.username === req.sessionUser);
  res.json({ success: true, deposits: userDeposits });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Admin login (session-based for admin panel)
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
  const [apk, plans, keyCounts, orders, users, deposits, services, shopSettings] = await Promise.all([
    db.getApkSettings(),
    db.getPlans(),
    db.getKeyCounts(),
    db.getOrders(),
    db.getAllUsers(),
    db.getDeposits(),
    db.getAllServices(),
    db.getShopSettings()
  ]);
  res.json({ apk, plans, keyCounts, orders, users, deposits, services, shopSettings });
});

// APK settings
app.post('/api/admin/apk', requireAdmin, async (req, res) => {
  const current = await db.getApkSettings();
  await db.updateApkSettings({ ...current, ...req.body });
  res.json({ success: true });
});

// Logo upload
app.post('/api/admin/logo', requireAdmin, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  const logo = '/images/' + req.file.filename + '?t=' + Date.now();
  const current = await db.getApkSettings();
  await db.updateApkSettings({ ...current, logo });
  res.json({ success: true, logo });
});

// Plans
app.get('/api/admin/plans', requireAdmin, async (req, res) => {
  res.json(await db.getPlans());
});
app.post('/api/admin/plans', requireAdmin, async (req, res) => {
  const { plans } = req.body;
  for (const p of plans) {
    await db.updatePlan(p.id, { label: p.label, days: p.days, price: p.price, enabled: p.enabled });
  }
  res.json({ success: true });
});

// Keys
app.post('/api/admin/keys', requireAdmin, async (req, res) => {
  const { planId, keys } = req.body;
  const newKeys = keys.split('\n').map(k => k.trim()).filter(k => k.length > 0);
  const added = await db.addKeys(planId, newKeys);
  res.json({ success: true, added });
});
app.get('/api/admin/keys', requireAdmin, async (req, res) => {
  const keys = await db.getAllKeys();
  const counts = await db.getKeyCounts();
  res.json({ success: true, keys, counts });
});
app.delete('/api/admin/keys/:id', requireAdmin, async (req, res) => {
  await db.deleteKey(req.params.id);
  res.json({ success: true });
});

// Orders
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const status = req.query.status || null;
  res.json(await db.getOrders(status));
});

// Users management
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  res.json(await db.getAllUsers());
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
  await db.updateUser(req.params.id, req.body);
  res.json({ success: true });
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  await db.deleteUser(req.params.id);
  res.json({ success: true });
});

// Deposits management
app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  const status = req.query.status || null;
  res.json(await db.getDeposits(status));
});
app.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
  const { admin_notes } = req.body;
  const deposit = await db.updateDepositStatus(req.params.id, 'approved', admin_notes || '', req.session.adminUser);
  res.json({ success: true, deposit });
});
app.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
  const { admin_notes } = req.body;
  await db.updateDepositStatus(req.params.id, 'rejected', admin_notes || '', req.session.adminUser);
  res.json({ success: true });
});
app.delete('/api/admin/deposits/:id', requireAdmin, async (req, res) => {
  await db.deleteDeposit(req.params.id);
  res.json({ success: true });
});

// Services management
app.get('/api/admin/services', requireAdmin, async (req, res) => {
  res.json(await db.getAllServices());
});
app.post('/api/admin/services', requireAdmin, async (req, res) => {
  await db.createService(req.body);
  res.json({ success: true });
});
app.put('/api/admin/services/:id', requireAdmin, async (req, res) => {
  await db.updateService(req.params.id, req.body);
  res.json({ success: true });
});
app.delete('/api/admin/services/:id', requireAdmin, async (req, res) => {
  await db.deleteService(req.params.id);
  res.json({ success: true });
});

// Shop settings (toggle service categories)
app.post('/api/admin/shop-settings', requireAdmin, async (req, res) => {
  await db.updateShopSettings(req.body);
  res.json({ success: true });
});

// Stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
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
});

app.listen(PORT, () => console.log(`N4XCO Shop running on port ${PORT}`));
