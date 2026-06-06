const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data/store.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Ensure public/images directory exists for logo uploads
if (!fs.existsSync(path.join(__dirname, 'public/images'))) {
  fs.mkdirSync(path.join(__dirname, 'public/images'), { recursive: true });
}

// ─── Multer for logo upload ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/images')),
  filename: (req, file, cb) => cb(null, 'logo' + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'n4xco_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── Data helpers ─────────────────────────────────────────────────────────────
function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { 
      apk: { name: 'N4XCO App', logo: '', link: '' }, 
      plans: [
        { id: "03days", label: "03 Days", days: 3, price: 120, enabled: true },
        { id: "07days", label: "07 Days", days: 7, price: 200, enabled: true },
        { id: "15days", label: "15 Days", days: 15, price: 250, enabled: true },
        { id: "20days", label: "20 Days", days: 20, price: 350, enabled: true },
        { id: "30days", label: "30 Days", days: 30, price: 600, enabled: true },
        { id: "60days", label: "60 Days", days: 60, price: 1000, enabled: true },
        { id: "90days", label: "90 Days", days: 90, price: 1300, enabled: true }
      ], 
      keys: {}, 
      orders: [], 
      buyers: [],
      users: [],
      paymongo: { secret_key: '', public_key: '', price_cents: 0 }
    };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Initialize keys object for all plans
function initKeys(data) {
  const planIds = data.plans.map(p => p.id);
  planIds.forEach(id => {
    if (!data.keys[id]) data.keys[id] = [];
  });
  return data;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ success: false, message: 'Unauthorized' });
}

function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  // Also check for bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const data = readData();
    const user = data.users.find(u => u.token === token);
    if (user) {
      req.session.userId = user.id;
      req.session.username = user.username;
      return next();
    }
  }
  res.status(401).json({ success: false, message: 'Please login first' });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  USER AUTHENTICATION ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Register
app.post('/api/register', async (req, res) => {
  const { username, password, telegram } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }
  
  const data = readData();
  
  if (data.users.find(u => u.username === username)) {
    return res.status(400).json({ success: false, message: 'Username already exists' });
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const token = uuidv4();
  
  const newUser = {
    id: uuidv4(),
    username,
    password: hashedPassword,
    telegram: telegram || '',
    role: 'user',
    createdAt: new Date().toISOString(),
    keys: [],
    token: token
  };
  
  data.users.push(newUser);
  writeData(data);
  
  req.session.userId = newUser.id;
  req.session.username = newUser.username;
  req.session.role = newUser.role;
  
  res.json({ success: true, token, user: { id: newUser.id, username: newUser.username, telegram: newUser.telegram, role: newUser.role } });
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  const data = readData();
  const user = data.users.find(u => u.username === username);
  
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
  
  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
  
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  
  const token = user.token || uuidv4();
  user.token = token;
  writeData(data);
  
  res.json({ success: true, token, user: { id: user.id, username: user.username, telegram: user.telegram, role: user.role } });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get current user
app.get('/api/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const data = readData();
    const user = data.users.find(u => u.token === token);
    if (user) {
      return res.json({ 
        success: true, 
        user: { 
          id: user.id, 
          username: user.username, 
          telegram: user.telegram,
          role: user.role,
          keys: user.keys || []
        } 
      });
    }
  }
  
  if (!req.session.userId) {
    return res.json({ success: false, user: null });
  }
  
  const data = readData();
  const user = data.users.find(u => u.id === req.session.userId);
  
  if (!user) {
    return res.json({ success: false, user: null });
  }
  
  res.json({ 
    success: true, 
    user: { 
      id: user.id, 
      username: user.username, 
      telegram: user.telegram,
      role: user.role,
      keys: user.keys || []
    } 
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Main shop page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// Admin page
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

// API: Get store data (public)
app.get('/api/store', (req, res) => {
  const data = readData();
  res.json({
    apk: data.apk,
    plans: data.plans.filter(p => p.enabled)
  });
});

// API: Get shop plans
app.get('/api/shop/plans', (req, res) => {
  const data = readData();
  res.json(data.plans.filter(p => p.enabled));
});

// API: Get user's purchased keys
app.get('/api/shop/mykeys', requireUser, (req, res) => {
  const data = readData();
  const user = data.users.find(u => u.id === req.session.userId);
  res.json({ success: true, keys: user?.keys || [] });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PAYMENT ROUTES (PayMongo)
// ═══════════════════════════════════════════════════════════════════════════════

// Get PayMongo settings (public - only price)
app.get('/api/payment-price', (req, res) => {
  const data = readData();
  res.json({ price_cents: data.paymongo?.price_cents || 0 });
});

// Create payment for key purchase
app.post('/api/shop/checkout', requireUser, async (req, res) => {
  const { planId, telegram } = req.body;
  if (!planId) return res.status(400).json({ success: false, message: 'Missing plan' });

  const data = readData();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
  
  const user = data.users.find(u => u.id === req.session.userId);
  const userTelegram = telegram || user?.telegram || '';

  const PAYMONGO_SECRET = data.paymongo?.secret_key || process.env.PAYMONGO_SECRET_KEY;
  if (!PAYMONGO_SECRET) {
    return res.status(500).json({ success: false, message: 'PayMongo not configured. Contact admin.' });
  }

  try {
    const orderId = uuidv4();
    const amountInCentavos = plan.price * 100;

    const pmRes = await axios.post('https://api.paymongo.com/v1/links', {
      data: {
        attributes: {
          amount: amountInCentavos,
          description: `N4XCO Key - ${plan.label}`,
          remarks: `Order:${orderId}|UserId:${req.session.userId}|Plan:${planId}`
        }
      }
    }, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(PAYMONGO_SECRET + ':').toString('base64'),
        'Content-Type': 'application/json'
      }
    });

    const linkData = pmRes.data.data;
    const checkoutUrl = linkData.attributes.checkout_url;
    const referenceNum = linkData.attributes.reference_number;

    // Save pending order
    const order = {
      id: orderId,
      userId: req.session.userId,
      username: user.username,
      planId,
      label: plan.label,
      price: plan.price,
      days: plan.days,
      telegram: userTelegram,
      status: 'pending',
      referenceNum,
      paymongoLinkId: linkData.id,
      createdAt: new Date().toISOString(),
      keyGiven: null,
      cancelled: false,
      cancelledAt: null
    };
    data.orders.push(order);
    writeData(data);

    res.json({ success: true, checkoutUrl, orderId, referenceNum });
  } catch (err) {
    console.error('PayMongo error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Payment creation failed' });
  }
});

// Cancel order (user initiated)
app.post('/api/shop/order/:id/cancel', requireUser, async (req, res) => {
  const data = readData();
  const order = data.orders.find(o => o.id === req.params.id);
  
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.userId !== req.session.userId && req.session.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  if (order.status !== 'pending') {
    return res.status(400).json({ success: false, message: 'Cannot cancel completed order' });
  }
  
  order.status = 'cancelled';
  order.cancelled = true;
  order.cancelledAt = new Date().toISOString();
  writeData(data);
  
  res.json({ success: true });
});

// PayMongo Webhook
app.post('/api/webhook/paymongo', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    let payload;
    try { payload = JSON.parse(req.body); }
    catch { payload = req.body; }

    const eventType = payload?.data?.attributes?.type;
    const resource = payload?.data?.attributes?.data;

    if (eventType === 'link.payment.paid') {
      const remarks = resource?.attributes?.description || '';
      const match = remarks.match(/Order:([^|]+)\|UserId:([^|]+)\|Plan:([^|]+)/);
      
      if (match) {
        const [, orderId, userId, planId] = match;
        const data = readData();
        const order = data.orders.find(o => o.id === orderId);
        const user = data.users.find(u => u.id === userId);
        
        if (order && order.status === 'pending') {
          order.status = 'paid';
          order.paidAt = new Date().toISOString();
          
          // Auto-assign key from stock
          const keys = data.keys[planId] || [];
          if (keys.length > 0) {
            const assignedKey = keys.shift();
            order.keyGiven = assignedKey;
            order.status = 'fulfilled';
            order.fulfilledAt = new Date().toISOString();
            data.keys[planId] = keys;
            
            // Add key to user's account
            if (user) {
              if (!user.keys) user.keys = [];
              user.keys.push({
                key: assignedKey,
                plan: order.label,
                purchasedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + order.days * 24 * 60 * 60 * 1000).toISOString()
              });
            }
          }
          
          // Add to buyers history
          data.buyers.push({
            userId: userId,
            username: user?.username || order.username,
            telegram: order.telegram,
            plan: order.label,
            price: order.price,
            orderId,
            key: order.keyGiven || 'Pending',
            status: order.status,
            date: new Date().toISOString()
          });
          writeData(data);
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(200);
  }
});

// Check order status
app.get('/api/shop/order/:id', (req, res) => {
  const data = readData();
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false });
  res.json({ success: true, status: order.status, key: order.keyGiven, plan: order.label });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || 'N4XCO';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'N4XCO_0';
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = true;
    req.session.adminUser = username;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ admin: !!req.session?.admin });
});

// Get full admin data
app.get('/api/admin/data', requireAdmin, (req, res) => {
  const data = readData();
  // Don't send password hashes
  const safeUsers = data.users.map(u => ({ 
    id: u.id, 
    username: u.username, 
    role: u.role, 
    telegram: u.telegram, 
    createdAt: u.createdAt,
    keysCount: (u.keys || []).length
  }));
  res.json({
    apk: data.apk,
    plans: data.plans,
    keys: data.keys,
    orders: data.orders,
    buyers: data.buyers,
    users: safeUsers,
    paymongo: { public_key: data.paymongo?.public_key || '', price_cents: data.paymongo?.price_cents || 0 }
  });
});

// Update APK info
app.post('/api/admin/apk', requireAdmin, (req, res) => {
  const { name, link } = req.body;
  const data = readData();
  if (name !== undefined) data.apk.name = name;
  if (link !== undefined) data.apk.link = link;
  writeData(data);
  res.json({ success: true });
});

// Upload logo
app.post('/api/admin/logo', requireAdmin, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  const data = readData();
  data.apk.logo = '/images/' + req.file.filename + '?t=' + Date.now();
  writeData(data);
  res.json({ success: true, logo: data.apk.logo });
});

// Update plan prices
app.post('/api/admin/plans', requireAdmin, (req, res) => {
  const { plans } = req.body;
  const data = readData();
  plans.forEach(updated => {
    const plan = data.plans.find(p => p.id === updated.id);
    if (plan) {
      if (updated.price !== undefined) plan.price = parseInt(updated.price) || plan.price;
      if (updated.enabled !== undefined) plan.enabled = updated.enabled;
    }
  });
  writeData(data);
  res.json({ success: true });
});

// Add keys to stock
app.post('/api/admin/keys', requireAdmin, (req, res) => {
  const { planId, keys } = req.body;
  const data = readData();
  if (!data.keys[planId]) data.keys[planId] = [];
  const newKeys = keys.split('\n').map(k => k.trim()).filter(k => k.length > 0);
  data.keys[planId].push(...newKeys);
  writeData(data);
  res.json({ success: true, added: newKeys.length, total: data.keys[planId].length });
});

// Delete key from stock
app.delete('/api/admin/keys/:planId/:index', requireAdmin, (req, res) => {
  const data = readData();
  const { planId, index } = req.params;
  if (data.keys[planId]) data.keys[planId].splice(parseInt(index), 1);
  writeData(data);
  res.json({ success: true });
});

// Manually fulfill an order
app.post('/api/admin/fulfill/:orderId', requireAdmin, (req, res) => {
  const { key } = req.body;
  const data = readData();
  const order = data.orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  
  order.keyGiven = key;
  order.status = 'fulfilled';
  order.fulfilledAt = new Date().toISOString();
  
  // Add key to user's account
  const user = data.users.find(u => u.id === order.userId);
  if (user) {
    if (!user.keys) user.keys = [];
    user.keys.push({
      key: key,
      plan: order.label,
      purchasedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + order.days * 24 * 60 * 60 * 1000).toISOString()
    });
  }
  
  // Update buyer record
  const buyer = data.buyers.find(b => b.orderId === order.id);
  if (buyer) buyer.key = key;
  
  writeData(data);
  res.json({ success: true });
});

// Cancel order (admin)
app.post('/api/admin/order/:id/cancel', requireAdmin, (req, res) => {
  const data = readData();
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  
  order.status = 'cancelled';
  order.cancelled = true;
  order.cancelledAt = new Date().toISOString();
  writeData(data);
  res.json({ success: true });
});

// ==================== USER MANAGEMENT (ADMIN) ====================

// Get all users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const data = readData();
  const safeUsers = data.users.map(u => ({ 
    id: u.id, 
    username: u.username, 
    role: u.role, 
    telegram: u.telegram, 
    createdAt: u.createdAt,
    keysCount: (u.keys || []).length
  }));
  res.json(safeUsers);
});

// Add user (admin)
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { username, password, role, telegram } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }
  
  const data = readData();
  
  if (data.users.find(u => u.username === username)) {
    return res.status(400).json({ success: false, message: 'Username already exists' });
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const token = uuidv4();
  
  const newUser = {
    id: uuidv4(),
    username,
    password: hashedPassword,
    telegram: telegram || '',
    role: role || 'user',
    createdAt: new Date().toISOString(),
    keys: [],
    token: token
  };
  
  data.users.push(newUser);
  writeData(data);
  
  res.json({ success: true, user: { id: newUser.id, username: newUser.username, role: newUser.role } });
});

// Update user (admin)
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { username, password, role, telegram } = req.body;
  const data = readData();
  const userIndex = data.users.findIndex(u => u.id === req.params.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }
  
  if (username) data.users[userIndex].username = username;
  if (role) data.users[userIndex].role = role;
  if (telegram !== undefined) data.users[userIndex].telegram = telegram;
  if (password) {
    data.users[userIndex].password = await bcrypt.hash(password, 10);
  }
  
  writeData(data);
  res.json({ success: true });
});

// Delete user (admin)
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const data = readData();
  const user = data.users.find(u => u.id === req.params.id);
  
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }
  
  // Don't allow deleting the last admin or N4XCO
  if (user.username === 'N4XCO' || (user.role === 'admin' && data.users.filter(u => u.role === 'admin').length === 1)) {
    return res.status(400).json({ success: false, message: 'Cannot delete this user' });
  }
  
  data.users = data.users.filter(u => u.id !== req.params.id);
  writeData(data);
  res.json({ success: true });
});

// ==================== PAYMONGO SETTINGS (ADMIN) ====================

app.get('/api/admin/paymongo', requireAdmin, (req, res) => {
  const data = readData();
  res.json({ 
    secret_key: data.paymongo?.secret_key ? '********' : '', 
    public_key: data.paymongo?.public_key || '', 
    price_cents: data.paymongo?.price_cents || 0 
  });
});

app.put('/api/admin/paymongo', requireAdmin, (req, res) => {
  const { secret_key, public_key, price_cents } = req.body;
  const data = readData();
  
  if (!data.paymongo) data.paymongo = {};
  if (secret_key && secret_key !== '********') data.paymongo.secret_key = secret_key;
  if (public_key !== undefined) data.paymongo.public_key = public_key;
  if (price_cents !== undefined) data.paymongo.price_cents = parseInt(price_cents) || 0;
  
  writeData(data);
  res.json({ success: true });
});

// ==================== STATIC FILES & FALLBACK ====================

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Handle SPA routing - serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  if (req.path === '/admin') {
    return res.sendFile(path.join(__dirname, 'public/admin.html'));
  }
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 N4XCO Shop running on port ${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin`);
  console.log(`   Shop: http://localhost:${PORT}`);
});