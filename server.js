const express = require('express');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const db = require('./database.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Multer for logo ───────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/images')),
  filename: (req, file, cb) => cb(null, 'logo' + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

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
  // Check session admin flag (set at login)
  if (req.session?.admin) { req.adminUser = req.session.adminUser; return next(); }
  // Or check token header
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
  res.json({ apk, plans });
});

// ─── User Register ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, telegram } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ success: false, message: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  try {
    await db.createUser(username, password, '', telegram || '', 'user');
    const token = await db.createToken(username);
    res.json({ success: true, token, username, role: 'user' });
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
    res.json({ success: true, token, username: user.username, role: user.role });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── User Profile / Orders ─────────────────────────────────────────────────────
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

// ─── Checkout (requires login) ─────────────────────────────────────────────────
app.post('/api/checkout', requireUser, async (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ success: false, message: 'Plan required' });

  const plans = await db.getPlans(true);
  const plan = plans.find(p => p.id === planId);
  if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

  const settings = await db.getPaymongoSettings();
  if (!settings?.secret_key) return res.status(503).json({ success: false, message: 'Payment not configured. Contact admin.' });

  try {
    const orderId = uuidv4();
    const user = await db.getUser(req.sessionUser);
    const amountCentavos = plan.price * 100;

    const pmRes = await fetch('https://api.paymongo.com/v1/links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(settings.secret_key + ':').toString('base64')
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: amountCentavos,
            description: `N4XCO Key — ${plan.label}`,
            remarks: `order_id:${orderId}`
          }
        }
      })
    });

    const pmData = await pmRes.json();
    if (!pmRes.ok) {
      const errMsg = pmData?.errors?.[0]?.detail || 'Payment gateway error';
      return res.status(502).json({ success: false, message: errMsg });
    }

    const linkData = pmData.data;
    const checkoutUrl = linkData.attributes.checkout_url;
    const referenceNum = linkData.attributes.reference_number;

    await db.createOrder({
      id: orderId,
      user_id: user?.id,
      username: req.sessionUser,
      telegram: user?.telegram || '',
      plan_id: plan.id,
      plan_label: plan.label,
      price: plan.price,
      days: plan.days,
      paymongo_link_id: linkData.id,
      paymongo_link_url: checkoutUrl,
      reference_num: referenceNum
    });

    res.json({ success: true, checkoutUrl, orderId, referenceNum });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Order Status (polls PayMongo if still pending) ───────────────────────────
app.get('/api/order/:id', async (req, res) => {
  try {
    const order = await db.pollPaymongoStatus(req.params.id);
    if (!order) return res.status(404).json({ success: false });
    res.json({
      success: true,
      status: order.status,
      key: order.key_given,
      plan: order.plan_label,
      price: order.price
    });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// ─── PayMongo Webhook ──────────────────────────────────────────────────────────
app.post('/api/webhook/paymongo', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    let payload;
    try { payload = JSON.parse(req.body); } catch { payload = {}; }

    const eventType = payload?.data?.attributes?.type;
    const resource = payload?.data?.attributes?.data;

    if (eventType === 'link.payment.paid') {
      // Try to extract order_id from remarks
      const remarks = resource?.attributes?.remarks || resource?.attributes?.description || '';
      const match = remarks.match(/order_id:([\w-]+)/);

      if (match) {
        await db.updateOrderPaid(match[1]);
      } else {
        // Fallback: match by paymongo link ID
        const linkId = resource?.id || resource?.attributes?.links?.[0];
        if (linkId) {
          const order = await db.getOrders('pending').then(orders =>
            orders.find(o => o.paymongo_link_id === linkId)
          ).catch(() => null);
          if (order) await db.updateOrderPaid(order.id);
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(200);
  }
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
  const [apk, plans, keyCounts, orders, users] = await Promise.all([
    db.getApkSettings(),
    db.getPlans(),
    db.getKeyCounts(),
    db.getOrders(),
    db.getAllUsers()
  ]);
  res.json({ apk, plans, keyCounts, orders, users });
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

// Keys — add
app.post('/api/admin/keys', requireAdmin, async (req, res) => {
  const { planId, keys } = req.body;
  const newKeys = keys.split('\n').map(k => k.trim()).filter(k => k.length > 0);
  const added = await db.addKeys(planId, newKeys);
  res.json({ success: true, added });
});
// Keys — list
app.get('/api/admin/keys', requireAdmin, async (req, res) => {
  const keys = await db.getAllKeys();
  const counts = await db.getKeyCounts();
  res.json({ success: true, keys, counts });
});
// Keys — delete
app.delete('/api/admin/keys/:id', requireAdmin, async (req, res) => {
  await db.deleteKey(req.params.id);
  res.json({ success: true });
});

// Orders
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const status = req.query.status || null;
  res.json(await db.getOrders(status));
});
app.post('/api/admin/orders/:id/fulfill', requireAdmin, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ success: false, message: 'Key required' });
  await db.fulfillOrder(req.params.id, key);
  res.json({ success: true });
});
app.post('/api/admin/orders/:id/cancel', requireAdmin, async (req, res) => {
  await db.cancelOrder(req.params.id);
  res.json({ success: true });
});

// Users management
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  res.json(await db.getAllUsers());
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { username, password, email, telegram, role } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
  try {
    await db.createUser(username, password, email || '', telegram || '', role || 'user');
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

// PayMongo settings
app.get('/api/admin/paymongo', requireAdmin, async (req, res) => {
  res.json(await db.getPaymongoSettings());
});
app.post('/api/admin/paymongo', requireAdmin, async (req, res) => {
  await db.updatePaymongoSettings(req.body);
  res.json({ success: true });
});

// Stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [orders, users, counts] = await Promise.all([
    db.getOrders(),
    db.getAllUsers(),
    db.getKeyCounts()
  ]);
  const revenue = orders.filter(o => o.status === 'fulfilled' || o.status === 'paid').reduce((a, b) => a + b.price, 0);
  const fulfilled = orders.filter(o => o.status === 'fulfilled').length;
  const pending = orders.filter(o => o.status === 'paid').length;
  res.json({ totalOrders: orders.length, fulfilled, pending, revenue, totalUsers: users.length, keyCounts: counts });
});

app.listen(PORT, () => console.log(`N4XCO Shop running on port ${PORT}`));
