# N4XCO SHOP

Full-stack key shop with PayMongo integration.

---

## 🚀 Deploy to Render

### Step 1 — Push to GitHub
Upload this entire folder to a new GitHub repo.

### Step 2 — Create Render Web Service
1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Runtime:** Node

### Step 3 — Set Environment Variables
In Render → Environment, add:

| Key | Value |
|-----|-------|
| `PAYMONGO_SECRET_KEY` | `sk_live_YOUR_KEY_HERE` |
| `SESSION_SECRET` | any random string |
| `ADMIN_USER` | `N4XCO` |
| `ADMIN_PASS` | `N4XCO_0` |

### Step 4 — Add a Disk (for data persistence)
Render → Your Service → Disks → Add Disk:
- **Name:** shop-data
- **Mount Path:** `/opt/render/project/src/data`
- **Size:** 1 GB

> ⚠️ Without a disk, data resets on redeploy. The disk keeps your keys/orders persistent.

### Step 5 — Set Up PayMongo Webhook
1. Go to [PayMongo Dashboard](https://dashboard.paymongo.com) → Developers → Webhooks
2. Add webhook URL: `https://your-app.onrender.com/api/webhook/paymongo`
3. Select event: `link.payment.paid`

---

## 🔑 Admin Panel
URL: `https://your-app.onrender.com/admin`
- Username: `N4XCO`
- Password: `N4XCO_0`

### Admin Features:
- **Overview** — stats, recent orders
- **APK Settings** — set app name, download link, upload logo
- **Plans & Prices** — edit prices, enable/disable plans
- **Key Manager** — paste unused keys per plan, view/delete pool
- **Orders** — view all orders, manually give keys
- **Buyer History** — full history with keys given

---

## 💳 How Payment Flow Works
1. Buyer selects plan → fills Telegram username → clicks Pay
2. PayMongo payment link opens in new tab
3. Buyer pays via GCash, card, etc.
4. Webhook fires → key auto-assigned from pool
5. Modal on shop page shows key when ready
6. If no key in pool → order stays "paid" → admin manually gives key in Orders tab

---

## 📦 Key Pricing
| Plan | Price (₱) |
|------|-----------|
| 03 Days | 120 |
| 07 Days | 200 |
| 15 Days | 250 |
| 20 Days | 350 |
| 30 Days | 600 |
| 60 Days | 1,000 |
| 90 Days | 1,300 |

All prices are editable from the admin panel.
