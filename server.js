const express = require('express');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const db = require('./database.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Telegram notifications ──────────────────────────────────────────────────

// Parse chat_id field — supports legacy single ID string or JSON array [{label,id}]
function parseChatIds(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(e => (typeof e === 'object' ? e : { label: String(e), id: String(e) }));
  } catch (_) {}
  // Legacy: plain string
  return [{ label: 'Admin', id: String(raw).trim() }];
}

async function sendTelegramToId(chatId, text, botToken, extra = {}) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true, ...extra };
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram rejected the message');
  return result;
}

// Send to ALL configured chat IDs; returns array of results
async function sendTelegram(text, settingsOverride, extra = {}) {
  const settings = settingsOverride || await db.getTelegramSettings();
  if (!settings?.enabled || !settings.bot_token || !settings.chat_id) return null;
  const recipients = parseChatIds(settings.chat_id);
  if (!recipients.length) return null;
  const results = await Promise.allSettled(
    recipients.map(r => sendTelegramToId(r.id, text, settings.bot_token, extra))
  );
  // Return first successful result (for backward compat)
  const first = results.find(r => r.status === 'fulfilled');
  if (!first) throw new Error(results.map(r => r.reason?.message).join('; '));
  return first.value;
}

async function notifyAdmin({ subject, text }) {
  try { return await sendTelegram(`${subject}\n\n${text}`); }
  catch (error) { console.error('Telegram notification error:', error.message); return false; }
}

async function inventorySummary() {
  const [plans, keyCounts, stockCounts, services] = await Promise.all([
    db.getPlans(), db.getKeyCounts(), db.getServiceStockCounts(), db.getAllServices()
  ]);
  const keyLines = plans.map(plan => {
    const count = keyCounts.find(item => item.plan_id === plan.id);
    return `• ${plan.label}: ${count?.available || 0} key(s)`;
  });
  const stockLines = services.filter(service => service.category === 'jepfx').map(service => {
    const count = stockCounts.find(item => item.service_id === service.id);
    return `• ${service.title}: ${count?.available || 0} item(s)`;
  });
  return `🔑 Keys\n${keyLines.join('\n') || '• No plans'}\n\n📦 Service stock\n${stockLines.join('\n') || '• No stocked services'}`;
}

async function sendDailyInventorySummary() {
  const settings = await db.getTelegramSettings();
  if (!settings?.enabled) return;
  await sendTelegram(`📊 N4XCO daily inventory\n\n${await inventorySummary()}`, settings);
}


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
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'N4XCO').toLowerCase();
function isOwnerName(name){ return (name||'').toLowerCase() === OWNER_USERNAME; }

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

function requireOwner(req, res, next){
  requireAdmin(req, res, () => {
    const who = req.adminUser || req.session?.adminUser;
    if (!isOwnerName(who)) return res.status(403).json({ success:false, message:'Owner only — only N4XCO can perform this action.' });
    next();
  });
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
    const categories = await db.getCategories(true);
    const tiers = await db.getAllTiers();
    services.forEach(sv => { sv.tiers = tiers.filter(t => t.service_id === sv.id); });
    const shopSettings = await db.getShopSettings();
    const depositSettings = await db.getDepositSettings();
    const paymentMethods = await db.getPaymentMethods(true);
    res.json({ apk, plans, services, categories, shopSettings, depositSettings, paymentMethods });
  } catch (err) {
    console.error('Store error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public key-stock counts (no auth) so the shop shows real availability per plan
app.get('/api/key-counts', async (req, res) => {
  try {
    const counts = await db.getKeyCounts();
    res.json({ success: true, counts });
  } catch (e) {
    console.error('Key counts error:', e);
    res.status(500).json({ success: false, counts: [] });
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
  const { username, password, email, telegram, facebook } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ success: false, message: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  const gmail = (email || '').trim().toLowerCase();
  if (!gmail) return res.status(400).json({ success: false, message: 'Gmail address is required' });
  if (!/^[a-z0-9._%+-]+@gmail\.com$/.test(gmail)) {
    return res.status(400).json({ success: false, message: 'A valid @gmail.com address is required' });
  }
  try {
    await db.createUser(username, password, gmail, telegram || '', facebook || '', 'user');
    const token = await db.createToken(username);
    const user = await db.getUser(username);
    notifyAdmin({
      subject: '👤 New user registered',
      text: `Username: ${username}\nGmail: ${gmail}\nTelegram: ${telegram || '(none)'}\nFacebook: ${facebook || '(none)'}`
    });
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
    notifyAdmin({
      subject: '🔑 Key purchased',
      text: `Order: ${orderId}\nUser: ${req.sessionUser}\nPlan: ${plan.label}\nPaid: ₱${finalPrice}`
    });
    const remaining = await db.getKeyAvailable(planId);
    const telegramSettings = await db.getTelegramSettings();
    if (telegramSettings?.enabled && remaining <= telegramSettings.low_stock_threshold) {
      notifyAdmin({ subject: '⚠️ Low key stock', text: `${plan.label} has ${remaining} key(s) remaining.` });
    }
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
      // Send deposit notification with inline approve/decline buttons
      try {
        const tgSettings = await db.getTelegramSettings();
        if (tgSettings?.enabled && tgSettings.bot_token && tgSettings.chat_id) {
          const msgText = `💰 New deposit request — ${referenceId}

User: ${req.sessionUser}
Amount: ₱${depositAmount}
Telegram: ${telegram}
Facebook: ${facebook}
Last 4 digits: ${last4_digits}
Notes: ${notes || '(none)'}
Screenshot: ${screenshotPath || '(none)'}`;
          const allDeposits = await db.getDeposits();
          const dep = allDeposits.find(d => d.reference_id === referenceId);
          const depId = dep ? dep.id : null;
          if (depId) {
            await sendTelegram(msgText, tgSettings, {
              reply_markup: { inline_keyboard: [[
                { text: '✅ Approve', callback_data: `dep_approve_${depId}` },
                { text: '❌ Decline', callback_data: `dep_decline_${depId}` }
              ]]}
            });
          } else {
            await sendTelegram(msgText, tgSettings);
          }
        }
      } catch (tgErr) {
        console.error('Telegram deposit notify error:', tgErr.message);
      }
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
  const who = req.session?.adminUser || '';
  res.json({ admin: !!req.session?.admin, username: who, isOwner: isOwnerName(who), owner: OWNER_USERNAME });
});

// Full admin data
app.get('/api/admin/data', requireAdmin, async (req, res) => {
  try {
    const [apk, plans, keyCounts, orders, users, deposits, services, shopSettings, depositSettings, categories, tiers] = await Promise.all([
      db.getApkSettings(),
      db.getPlans(),
      db.getKeyCounts(),
      db.getOrders(),
      db.getAllUsers(),
      db.getDeposits(),
      db.getAllServices(),
      db.getShopSettings(),
      db.getDepositSettings(),
      db.getCategories(),
      db.getAllTiers()
    ]);
    services.forEach(sv => { sv.tiers = tiers.filter(t => t.service_id === sv.id); });
    res.json({ apk, plans, keyCounts, orders, users, deposits, services, shopSettings, depositSettings, categories, tiers });
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
    const cat = (req.query.category || '').trim();
    if (cat) return res.json(await db.getPlansByCategory(cat));
    res.json(await db.getPlans());
  } catch (e) {
    console.error('Get plans error:', e);
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
});

app.post('/api/admin/plans', requireAdmin, async (req, res) => {
  try {
    const { plans } = req.body;
    for (const p of plans) {
      await db.updatePlan(p.id, {
        label: p.label, days: p.days, price: p.price,
        enabled: p.enabled, category: p.category || 'android',
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Save plans error:', e);
    res.status(500).json({ success: false, message: 'Server error', detail: e.message });
  }
});

// Create a single plan (used by per-category plan builder)
app.post('/api/admin/plan', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const id = String(b.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const label = String(b.label || '').trim();
    const category = String(b.category || '').trim().toLowerCase();
    if (!id || !label || !category) {
      return res.status(400).json({ success: false, message: 'id, label and category are required' });
    }
    if (!/^[a-z0-9_-]+$/.test(category)) {
      return res.status(400).json({ success: false, message: 'Invalid category key' });
    }
    await db.createPlan({ ...b, id, label, category });
    res.json({ success: true, id });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ success: false, message: 'A plan with that id already exists' });
    }
    console.error('Create plan error:', e);
    res.status(500).json({ success: false, message: 'Could not create plan', detail: e.message });
  }
});

app.delete('/api/admin/plans/:id', requireAdmin, async (req, res) => {
  try {
    await db.deletePlan(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Delete plan error:', e);
    res.status(500).json({ success: false, message: 'Could not delete plan', detail: e.message });
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

app.delete('/api/admin/users/:id', requireOwner, async (req, res) => {
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

// Per owner request: no user emails on approve/reject. Admin only gets the
// notification when a user submits a deposit (handled in /api/deposit).

app.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { admin_notes } = req.body;
    await db.updateDepositStatus(req.params.id, 'approved', admin_notes || '', req.adminUser || req.session.adminUser);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { admin_notes } = req.body;
    await db.updateDepositStatus(req.params.id, 'rejected', admin_notes || '', req.adminUser || req.session.adminUser);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// ─── Telegram settings (admin) ────────────────────────────────────────────────
app.get('/api/admin/telegram', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getTelegramSettings();
    if (!settings) return res.json({});
    const recipients = parseChatIds(settings.chat_id);
    res.json({ ...settings, bot_token: settings.bot_token ? '••••••••' : '', recipients });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/telegram', requireAdmin, async (req, res) => {
  try {
    const current = await db.getTelegramSettings();
    const body = req.body || {};
    if (!body.bot_token || body.bot_token === '••••••••') body.bot_token = current?.bot_token || '';
    // Accept recipients array [{label, id}, ...] and store as JSON in chat_id column
    if (Array.isArray(body.recipients)) {
      const cleaned = body.recipients.filter(r => r.id && String(r.id).trim());
      body.chat_id = JSON.stringify(cleaned.map(r => ({ label: r.label || 'Admin', id: String(r.id).trim() })));
    }
    const hasRecipients = parseChatIds(body.chat_id).length > 0;
    if (body.enabled && (!body.bot_token || !hasRecipients)) {
      return res.status(400).json({ success: false, message: 'Bot token and at least one chat ID are required when Telegram is enabled' });
    }
    await db.updateTelegramSettings(body);
    res.json({ success: true });
  } catch (e) {
    console.error('Telegram save error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/admin/telegram/test', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getTelegramSettings();
    if (!settings?.bot_token || !settings.chat_id) return res.status(400).json({ success: false, message: 'Save a bot token and chat ID first' });
    if (!settings.enabled) return res.status(400).json({ success: false, message: 'Enable Telegram notifications first' });
    await sendTelegram('✅ N4XCO Shop Telegram notifications are working.', settings);
    res.json({ success: true, message: 'Test message sent to Telegram' });
  } catch (e) {
    console.error('Telegram test error:', e);
    res.status(502).json({ success: false, message: e.message || 'Telegram test failed' });
  }
});

// Register telegram webhook so approve/decline buttons work
app.post('/api/admin/telegram/setup-webhook', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getTelegramSettings();
    if (!settings?.bot_token) return res.status(400).json({ success: false, message: 'Bot token not set' });
    const { siteUrl } = req.body || {};
    const webhookUrl = (siteUrl || `${req.protocol}://${req.get('host')}`) + '/api/telegram/webhook';
    const r = await fetch(`https://api.telegram.org/bot${settings.bot_token}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const result = await r.json().catch(() => ({}));
    if (!result.ok) return res.status(502).json({ success: false, message: result.description || 'Failed to set webhook' });
    res.json({ success: true, message: `Webhook registered: ${webhookUrl}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Remove/disable telegram webhook (needed before using getUpdates for chat IDs)
app.post('/api/admin/telegram/delete-webhook', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getTelegramSettings();
    if (!settings?.bot_token) return res.status(400).json({ success: false, message: 'Bot token not set' });
    const r = await fetch(`https://api.telegram.org/bot${settings.bot_token}/deleteWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false })
    });
    const result = await r.json().catch(() => ({}));
    if (!result.ok) return res.status(502).json({ success: false, message: result.description || 'Failed to delete webhook' });
    res.json({ success: true, message: 'Webhook removed. You can now use getUpdates to find chat IDs. Re-register the webhook when done.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
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

// ─── Backup & Restore (admin) ─────────────────────────────────────────────────
// Export: returns all setup data as JSON
app.get('/api/admin/backup', requireAdmin, async (req, res) => {
  try {
    const [apk, shopSettings, depositSettings, paymentMethods, categories, services, tiers] = await Promise.all([
      db.getApkSettings(),
      db.getShopSettings(),
      db.getDepositSettings(),
      db.getPaymentMethods(),
      db.getCategories(),
      db.getAllServices(),
      db.getAllTiers(),
    ]);
    services.forEach(sv => { sv.tiers = tiers.filter(t => t.service_id === sv.id); });
    res.json({
      exportedAt: new Date().toISOString(),
      version: 1,
      apkSettings: apk,
      shopSettings,
      depositSettings,
      paymentMethods,
      categories,
      services,
    });
  } catch (e) {
    console.error('Backup error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Import: restore setup from JSON body
app.post('/api/admin/restore', requireAdmin, async (req, res) => {
  try {
    const data = req.body || {};
    const results = {};
    if (data.apkSettings) {
      const cur = await db.getApkSettings();
      await db.updateApkSettings({ ...cur, ...data.apkSettings });
      results.apkSettings = 'ok';
    }
    if (data.shopSettings) {
      await db.updateShopSettings(data.shopSettings);
      results.shopSettings = 'ok';
    }
    if (data.depositSettings) {
      const { gcash_number, qr_code } = data.depositSettings;
      await db.updateDepositSettings({ gcash_number: gcash_number || '', qr_code: qr_code || '' });
      results.depositSettings = 'ok';
    }
    if (Array.isArray(data.paymentMethods)) {
      for (const pm of data.paymentMethods) {
        const { id, ...fields } = pm;
        // Try update first, then create
        try {
          await db.updatePaymentMethod(id, fields);
        } catch (_) {
          await db.createPaymentMethod(fields);
        }
      }
      results.paymentMethods = 'ok';
    }
    if (Array.isArray(data.categories)) {
      for (const cat of data.categories) {
        const { id, ...fields } = cat;
        try { await db.updateCategory(id, fields); } catch (_) {
          try { await db.createCategory(fields); } catch (__) {}
        }
      }
      results.categories = 'ok';
    }
    res.json({ success: true, results });
  } catch (e) {
    console.error('Restore error:', e);
    res.status(500).json({ success: false, message: 'Server error during restore: ' + e.message });
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

// ═══════════════════════════════════════════════════════════════════════════════
//  SERVICE PURCHASES (boosting / jepfx / module)
// ═══════════════════════════════════════════════════════════════════════════════

// User: purchase a paid service using balance
app.post('/api/service/purchase', requireUser, async (req, res) => {
  const { serviceId, tierId, telegram, facebook, user_link, promoCode } = req.body || {};
  if (!serviceId) return res.status(400).json({ success: false, message: 'Service required' });
  if (!telegram && !facebook) return res.status(400).json({ success: false, message: 'Provide Telegram or Facebook contact' });
  try {
    const svc = await db.getService(serviceId);
    if (!svc || !svc.enabled) return res.status(404).json({ success: false, message: 'Service unavailable' });
    let chosenTier = null;
    if (tierId) {
      chosenTier = await db.getTier(tierId);
      if (!chosenTier || chosenTier.service_id !== svc.id) return res.status(400).json({ success:false, message:'Invalid tier' });
    } else {
      const tiers = await db.getTiersByService(svc.id);
      if (tiers.length > 0) return res.status(400).json({ success:false, message:'Please choose a quantity tier' });
    }
    const basePrice = chosenTier ? chosenTier.price : svc.price;
    if (!basePrice || basePrice <= 0) return res.status(400).json({ success: false, message: 'This service has no price' });

    // Apply promo
    let finalPrice = basePrice;
    let appliedPromo = null;
    if (promoCode) {
      const p = await db.getPromoByCode(promoCode);
      if (p && p.enabled
          && (!p.expires_at || new Date(p.expires_at) >= new Date())
          && (p.max_uses === 0 || p.uses < p.max_uses)) {
        if (p.discount_type === 'flat') finalPrice = Math.max(0, finalPrice - p.discount_value);
        else finalPrice = Math.max(0, Math.round(finalPrice * (1 - p.discount_value / 100)));
        appliedPromo = p;
      } else {
        return res.status(400).json({ success: false, message: 'Invalid or expired promo code' });
      }
    }

    const user = await db.getUser(req.sessionUser);
    if (user.balance < finalPrice) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    // Decide delivery based on the category's delivery_type:
    //   'key'   → pop a pre-loaded key from the stock pool
    //   'link'  → pop a pre-loaded link from the stock pool
    //   'admin' → no auto-delivery; admin contacts the user
    let deliveredValue = '';
    let stockRow = null;
    const cat = await db.getCategoryByKey(svc.category);
    const deliveryType = (cat && cat.delivery_type) || 'admin';
    if (deliveryType === 'key' || deliveryType === 'link') {
      stockRow = await db.popServiceStock(svc.id);
      if (!stockRow) {
        const label = deliveryType === 'key' ? 'keys' : 'links';
        return res.status(400).json({ success: false, message: `Out of stock — no ${label} available. Please try again later.` });
      }
      deliveredValue = stockRow.value;
    } else {
      // admin approval: we'll contact the user on their provided info
      deliveredValue = svc.contact || svc.link || '';
    }

    await db.addUserBalance(req.sessionUser, -finalPrice);
    const orderId = uuidv4();
    await db.createServiceOrder({
      id: orderId, username: req.sessionUser, service_id: svc.id,
      category: svc.category, title: svc.title + (appliedPromo ? ` (promo ${appliedPromo.code})` : ''),
      price: finalPrice, telegram: telegram || '', facebook: facebook || '',
      user_link: user_link || '', delivered: deliveredValue,
      status: (deliveryType === 'key' || deliveryType === 'link') ? 'fulfilled' : 'pending',
      tier_id: chosenTier ? chosenTier.id : null,
      tier_label: chosenTier ? chosenTier.label : '',
      quantity: chosenTier ? chosenTier.quantity : 1
    });
    if (stockRow) await db.markServiceStockUsed(stockRow.id, orderId);
    if (appliedPromo) await db.incrementPromoUses(appliedPromo.id);
    notifyAdmin({
      subject: '🛒 Service purchased',
      text: `Order: ${orderId}\nUser: ${req.sessionUser}\nService: ${svc.title}\nPaid: ₱${finalPrice}\nTelegram: ${telegram || '(none)'}\nFacebook: ${facebook || '(none)'}`
    });
    if (stockRow) {
      const counts = await db.getServiceStockCounts();
      const remaining = counts.find(item => item.service_id === svc.id)?.available || 0;
      const telegramSettings = await db.getTelegramSettings();
      if (telegramSettings?.enabled && remaining <= telegramSettings.low_stock_threshold) {
        notifyAdmin({ subject: '⚠️ Low service stock', text: `${svc.title} has ${remaining} item(s) remaining.` });
      }
    }

    res.json({
      success: true, orderId,
      newBalance: user.balance - finalPrice, paid: finalPrice,
      delivered: deliveredValue, category: svc.category,
      delivery_type: deliveryType,
      title: svc.title
    });
  } catch (e) {
    console.error('Service purchase error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// User: list service orders
app.get('/api/user/service-orders', requireUser, async (req, res) => {
  try { res.json({ success: true, orders: await db.getUserServiceOrders(req.sessionUser) }); }
  catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// Admin: list stock and add stock for a service
app.get('/api/admin/service-stock', requireAdmin, async (req, res) => {
  try {
    const counts = await db.getServiceStockCounts();
    // Show stock for every service in a category whose delivery_type is 'key' or 'link'
    const cats = await db.getCategories();
    const stockCats = new Set(cats.filter(c => c.delivery_type === 'key' || c.delivery_type === 'link').map(c => c.key));
    const all = await Promise.all(
      (await db.getAllServices()).filter(s => stockCats.has(s.category)).map(async s => ({
        service: s,
        items: await db.getServiceStock(s.id),
        delivery_type: cats.find(c => c.key === s.category)?.delivery_type || 'admin'
      }))
    );
    res.json({ counts, services: all });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/service-stock', requireAdmin, async (req, res) => {
  try {
    const { serviceId, values } = req.body || {};
    if (!serviceId || !values) return res.status(400).json({ success: false, message: 'Missing fields' });
    const list = String(values).split('\n').map(s => s.trim()).filter(Boolean);
    const added = await db.addServiceStock(parseInt(serviceId), list);
    res.json({ success: true, added });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.delete('/api/admin/service-stock/:id', requireAdmin, async (req, res) => {
  try { await db.deleteServiceStock(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// Admin: list all service orders
app.get('/api/admin/service-orders', requireAdmin, async (req, res) => {
  try { res.json(await db.getServiceOrders()); }
  catch (e) { res.status(500).json({ error: 'Server error' }); }
});


// ==================== ADMIN: CATEGORIES ====================
app.get('/api/admin/categories', requireAdmin, async (req, res) => {
  try { res.json(await db.getCategories()); }
  catch(e){ console.error('Get categories error:', e); res.status(500).json({error:'Server error', detail:e.message}); }
});
app.post('/api/admin/categories', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    b.key = String(b.key || '').trim().toLowerCase();
    b.name = String(b.name || '').trim();
    b.delivery_type = ['key','link','admin'].includes(b.delivery_type) ? b.delivery_type : 'admin';
    if (!b.key || !b.name) return res.status(400).json({success:false,message:'Key and name are required'});
    if (!/^[a-z0-9_-]+$/.test(b.key)) return res.status(400).json({success:false,message:'Key can only contain lowercase letters, numbers, dashes, and underscores'});
    await db.createCategory(b);
    res.json({success:true});
  } catch(e){
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({success:false,message:'That category key already exists'});
    console.error('Create category error:', e);
    res.status(500).json({success:false,message:'Could not add category', detail:e.message});
  }
});
app.put('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    b.key = String(b.key || '').trim().toLowerCase();
    b.name = String(b.name || '').trim();
    b.delivery_type = ['key','link','admin'].includes(b.delivery_type) ? b.delivery_type : 'admin';
    if (!b.key || !b.name) return res.status(400).json({success:false,message:'Key and name are required'});
    if (!/^[a-z0-9_-]+$/.test(b.key)) return res.status(400).json({success:false,message:'Invalid category key'});
    const result = await db.updateCategory(req.params.id, b);
    if (!result.changes) return res.status(404).json({success:false,message:'Category not found'});
    res.json({success:true});
  } catch(e){
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({success:false,message:'That category key already exists'});
    console.error('Update category error:', e);
    res.status(500).json({success:false,message:'Could not update category', detail:e.message});
  }
});
app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  try { await db.deleteCategory(req.params.id); res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ==================== ADMIN: SERVICE TIERS ====================
app.get('/api/admin/services/:id/tiers', requireAdmin, async (req, res) => {
  try { res.json(await db.getTiersByService(req.params.id)); }
  catch(e){ res.status(500).json({error:'Server error'}); }
});
app.post('/api/admin/services/:id/tiers', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.label || b.price == null) return res.status(400).json({success:false,message:'label and price required'});
    await db.createTier({ service_id: req.params.id, ...b });
    res.json({success:true});
  } catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});
app.put('/api/admin/tiers/:id', requireAdmin, async (req, res) => {
  try { await db.updateTier(req.params.id, req.body||{}); res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});
app.delete('/api/admin/tiers/:id', requireAdmin, async (req, res) => {
  try { await db.deleteTier(req.params.id); res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});



// ─── Telegram Webhook (inline button callbacks for deposit approve/decline) ────
app.post('/api/telegram/webhook', express.json(), async (req, res) => {
  res.sendStatus(200); // always ack fast
  try {
    const update = req.body;
    if (!update?.callback_query) return;
    const cb = update.callback_query;
    const data = cb.data || '';
    const settings = await db.getTelegramSettings();
    if (!settings?.enabled || !settings.bot_token) return;

    const answerCallback = async (text) => {
      await fetch(`https://api.telegram.org/bot${settings.bot_token}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text, show_alert: false })
      });
    };
    const editMessage = async (text) => {
      await fetch(`https://api.telegram.org/bot${settings.bot_token}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          text, reply_markup: { inline_keyboard: [] }
        })
      });
    };

    if (data.startsWith('dep_approve_')) {
      const id = data.replace('dep_approve_', '');
      await db.updateDepositStatus(id, 'approved', 'Approved via Telegram', 'telegram-bot');
      await answerCallback('✅ Deposit approved!');
      const origText = cb.message?.text || '';
      await editMessage(origText + '\n\n✅ APPROVED via Telegram');
    } else if (data.startsWith('dep_decline_')) {
      const id = data.replace('dep_decline_', '');
      await db.updateDepositStatus(id, 'rejected', 'Declined via Telegram', 'telegram-bot');
      await answerCallback('❌ Deposit declined.');
      const origText = cb.message?.text || '';
      await editMessage(origText + '\n\n❌ DECLINED via Telegram');
    }
  } catch (e) {
    console.error('TG webhook error:', e.message);
  }
});

// 404 fallback
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success:false, message:'Not found' });
  }
  res.status(404).send(`<!doctype html><html><head><meta charset=utf-8><title>404 — N4XCO</title>
<style>body{background:#0a0a0a;color:#eee;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}
h1{font-size:6rem;margin:0;letter-spacing:.1em}p{color:#888;margin:.5rem 0 1.5rem}
a{color:#0af;text-decoration:none;border:1px solid #0af;padding:.6rem 1.2rem;letter-spacing:.1em;text-transform:uppercase;font-size:.8rem}</style>
</head><body><div><h1>404</h1><p>This page does not exist.</p><a href="/">Go home</a></div></body></html>`);
});

let lastSummaryDate = '';
setInterval(async () => {
  try {
    const settings = await db.getTelegramSettings();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (settings?.enabled && now.getHours() === settings.daily_summary_hour && lastSummaryDate !== today) {
      await sendDailyInventorySummary();
      lastSummaryDate = today;
    }
  } catch (error) { console.error('Daily inventory summary error:', error.message); }
}, 60 * 1000);

app.listen(PORT, () => console.log(`N4XCO Shop running on port ${PORT}`));


