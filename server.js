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
      apk: {}, 
      plans: [], 
      keys: {}, 
      orders: [], 
      buyers: [],
      users: [] 
    };
  }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ success: false, message: 'Unauthorized' });
}

function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ success: false, message: 'Please login first' });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Main shop page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// Admin page
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

// ─── User Registration ────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, telegram } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }
  
  const data = readData();
  
  // Check if user exists
  if (data.users.find(u => u.username === username)) {
    return res.status(400).json({ success: false, message: 'Username already exists' });
  }
  
  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);
  
  const newUser = {
    id: uuidv4(),
    username,
    password: hashedPassword,
    telegram: telegram || '',
    createdAt: new Date().toISOString(),
    keys: [] // Store user's purchased keys
  };
  
  data.users.push(newUser);
  writeData(data);
  
  // Auto login after registration
  req.session.userId = newUser.id;
  req.session.username = newUser.username;
  
  res.json({ success: true, user: { id: newUser.id, username: newUser.username, telegram: newUser.telegram } });
});

// ─── User Login ───────────────────────────────────────────────────────────────
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
  
  res.json({ success: true, user: { id: user.id, username: user.username, telegram: user.telegram } });
});

// ─── User Logout ──────────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─── Get Current User ─────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
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
      keys: user.keys || []
    } 
  });
});

// ─── Get User's Purchased Keys ────────────────────────────────────────────────
app.get('/api/mykeys', requireUser, (req, res) => {
  const data = readData();
  const user = data.users.find(u => u.id === req.session.userId);
  res.json({ success: true, keys: user?.keys || [] });
});

// ─── API: Get store data (public) ─────────────────────────────────────────────
app.get('/api/store', (req, res) => {
  const data = readData();
  res.json({
    apk: data.apk,
    plans: data.plans.filter(p => p.enabled)
  });
});

// ─── API: Create PayMongo payment link ────────────────────────────────────────
app.post('/api/checkout', requireUser, async (req, res) => {
  const { planId, telegram, days } = req.body;
  if (!planId) return res.status(400).json({ success: false, message: 'Missing plan' });

  const data = readData();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
  
  const user = data.users.find(u => u.id === req.session.userId);
  const userTelegram = telegram || user?.telegram || '';

  const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET_KEY || '';
  if (!PAYMONGO_SECRET) return res.status(500).json({ success: false, message: 'PayMongo not configured.' });

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
      keyGiven: null
    };
    data.orders.push(order);
    writeData(data);

    res.json({ success: true, checkoutUrl, orderId, referenceNum });
  } catch (err) {
    console.error('PayMongo error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Payment creation failed', error: err.response?.data?.errors?.[0]?.detail || err.message });
  }
});

// ─── PayMongo Webhook ─────────────────────────────────────────────────────────
app.post('/api/webhook/paymongo', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = JSON.parse(req.body);
    if (event.data?.attributes?.type === 'link.payment.paid') {
      const remarks = event.data.attributes.data?.attributes?.remarks || '';
      const match = remarks.match(/Order:([^|]+)\|UserId:([^|]+)\|Plan:([^|]+)/);
      if (match) {
        const [, orderId, userId, planId] = match;
        const data = readData();
        const order = data.orders.find(o => o.id === orderId);
        const user = data.users.find(u => u.id === userId);
        
        if (order && order.status === 'pending') {
          order.status = 'paid';
          order.paidAt = new Date().toISOString();
          
          // Auto-assign key if available
          const keys = data.keys[planId] || [];
          if (keys.length > 0) {
            const assignedKey = keys.shift();
            order.keyGiven = assignedKey;
            order.status = 'fulfilled';
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
          
          // Add to buyers
          data.buyers.push({
            userId: userId,
            username: user?.username || order.username,
            telegram: order.telegram,
            plan: order.label,
            price: order.price,
            orderId,
            key: order.keyGiven || 'Pending',
            date: new Date().toISOString()
          });
          writeData(data);
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(400);
  }
});

// ─── API: Check order status ──────────────────────────────────────────────────
app.get('/api/order/:id', (req, res) => {
  const data = readData();
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false });
  res.json({ success: true, status: order.status, key: order.keyGiven, plan: order.label });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES (same as before)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || 'N4XCO';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'N4XCO_0';
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = true;
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

app.get('/api/admin/data', requireAdmin, (req, res) => {
  const data = readData();
  res.json(data);
});

app.post('/api/admin/apk', requireAdmin, (req, res) => {
  const { name, link } = req.body;
  const data = readData();
  data.apk.name = name || data.apk.name;
  data.apk.link = link || data.apk.link;
  writeData(data);
  res.json({ success: true });
});

app.post('/api/admin/logo', requireAdmin, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  const data = readData();
  data.apk.logo = '/images/' + req.file.filename + '?t=' + Date.now();
  writeData(data);
  res.json({ success: true, logo: data.apk.logo });
});

app.post('/api/admin/plans', requireAdmin, (req, res) => {
  const { plans } = req.body;
  const data = readData();
  plans.forEach(updated => {
    const plan = data.plans.find(p => p.id === updated.id);
    if (plan) {
      plan.price = parseInt(updated.price) || plan.price;
      plan.enabled = updated.enabled !== undefined ? updated.enabled : plan.enabled;
    }
  });
  writeData(data);
  res.json({ success: true });
});

app.post('/api/admin/keys', requireAdmin, (req, res) => {
  const { planId, keys } = req.body;
  const data = readData();
  if (!data.keys[planId]) data.keys[planId] = [];
  const newKeys = keys.split('\n').map(k => k.trim()).filter(k => k.length > 0);
  data.keys[planId].push(...newKeys);
  writeData(data);
  res.json({ success: true, added: newKeys.length, total: data.keys[planId].length });
});

app.get('/api/admin/keys', requireAdmin, (req, res) => {
  const data = readData();
  const counts = {};
  Object.keys(data.keys).forEach(k => { counts[k] = data.keys[k].length; });
  res.json({ success: true, counts, keys: data.keys });
});

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

app.delete('/api/admin/keys/:planId/:index', requireAdmin, (req, res) => {
  const data = readData();
  const { planId, index } = req.params;
  if (data.keys[planId]) data.keys[planId].splice(parseInt(index), 1);
  writeData(data);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`N4XCO Shop running on port ${PORT}`));