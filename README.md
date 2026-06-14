# N4XCO SHOP v2

Full-stack key shop with user accounts, PayMongo GCash integration, and auto key delivery.

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

### Step 3 — Add a Disk (for DB + images)
Render → Your Service → Disks → Add Disk:
- **Name:** shop-data
- **Mount Path:** `/data`
- **Size:** 1 GB

> ⚠️ Without a disk, data resets on redeploy.

### Step 4 — Set Environment Variables
In Render → Environment, add:

| Key | Value |
|-----|-------|
| `DB_PATH` | `/data/n4xco.db` |
| `SESSION_SECRET` | any random string |

### Step 5 — Set Up Telegram Alerts
1. Message [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the bot token.
2. Send any message to your new bot.
3. Open `https://api.telegram.org/botYOUR_TOKEN/getUpdates` and copy `message.chat.id`.
4. Go to **Admin → Settings → Telegram bot notifications**.
5. Paste the token and chat ID, enable alerts, save, then send a test message.

The bot alerts the admin for registrations, deposits, key purchases, service purchases, low stock, and a daily inventory summary.

---

## 🔑 Admin Panel
URL: `https://your-app.onrender.com/admin`
- Username: `N4XCO`
- Password: `N4XCO_0`

### Admin Features:
- **Overview** — stats, recent orders
- **APK Settings** — set app name, download link, upload logo
- **Plans & Prices** — edit prices, days, enable/disable plans
- **Key Manager** — paste unused keys per plan, view/delete pool
- **Orders** — view all orders, manually give keys to paid orders
- **Users** — view all registered users, add/edit/delete accounts, set roles (user/admin)
- **Categories** — add, edit, and delete shop/service categories
- **Telegram** — configure and test admin notifications without SMTP

---

## 👤 User Flow
1. User visits shop → sees plans
2. Clicks **Buy Now** → prompted to **Login or Register** if not logged in
3. After login → confirms plan → GCash payment link opens
4. Buyer pays via GCash
5. Webhook fires → key auto-assigned from pool → popup shows key instantly
6. If no key in pool → order stays "Paid (Awaiting Key)" → admin manually gives key in Orders tab
7. User can view order history in **MY ORDERS** tab
8. Users can **cancel pending orders** from their history

---

## 📲 CONTACTS Tab
Fixed Telegram links shown in the public UI:
- **JEPFX SERVICES** — t.me/JEPFX
- **N4XCO CHANNEL** — t.me/n4xcoall
- **N4XCO ACCOUNT** — t.me/zekielsZ

---

## 💳 Payment Flow Details
- Key auto-pops up in a modal immediately after payment detection
- Client polls `/api/order/:id` every 5 seconds while waiting
- PayMongo webhook also fires to confirm instantly
- Both mechanisms ensure no missed deliveries

---

## 📦 Default Key Pricing
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
