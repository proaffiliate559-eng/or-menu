# filmujha-loyalty

**Restaurant loyalty system: QR scan, menu se order, har dish par points, aur free rewards.**

Customer apne phone par QR scan karke menu se order karta hai, aur har dish ke fix points kamata hai. Staff order confirm karta hai, points apne aap judte hain, aur points se free khana redeem hota hai. Do alag apps hain, aur dono ek hi server se chalte hain.

| App | Kaun use karega | URL |
|---|---|---|
| 👤 Customer | Customer apne phone par | `http://<computer-IP>:3000` |
| 🔐 Admin | Owner / Staff, counter ke laptop ya tablet par | `http://<computer-IP>:3000/admin` |

Koi `npm install` nahi chahiye. Sirf Node.js (18+) se chalta hai.

---

## 🚀 Chalane ka tarika

```bash
node server.js        # ya Windows par start.bat double-click
```

1. Terminal mein `http://192.168.x.x:3000` jaisa address dikhega.
2. Admin kholiye: `/admin`. Pehla login `owner` / `1234` hai, login karte hi naya password set karna hoga.
3. **Counter QR** tab (ya ⛶ Kiosk mode) ko customers ki taraf rakhiye.
4. Customer ka phone same WiFi par ho, toh QR scan karte hi app khul jayega.

**Password bhool gaye?** Server band karke `node reset-owner.js` chalaiye. Ek temporary password milega.

---

## 🍛 Menu (sample, har dish ke fix points)

Ye menu pehli baar chalane par apne aap banta hai. Owner ise **Admin → Menu & points** mein badal sakta hai: dish jodna ya hatana, price, points, category, Veg/Non-veg.

| Category | Dish | Type | Price | Points |
|---|---|---|---:|---:|
| Starters | 🧀 Paneer Tikka | 🟢 Veg | ₹260 | 26 |
| Starters | 🍗 Chicken 65 | 🔴 Non-veg | ₹280 | 28 |
| Starters | 🥦 Veg Manchurian | 🟢 Veg | ₹220 | 22 |
| Main Course | 🍛 Butter Chicken | 🔴 Non-veg | ₹340 | 34 |
| Main Course | 🧈 Paneer Butter Masala | 🟢 Veg | ₹290 | 29 |
| Main Course | 🍲 Dal Makhani | 🟢 Veg | ₹240 | 24 |
| Main Course | 🍚 Veg Biryani | 🟢 Veg | ₹250 | 25 |
| Main Course | 🍗 Chicken Biryani | 🔴 Non-veg | ₹320 | 32 |
| Breads | 🫓 Butter Naan | 🟢 Veg | ₹50 | 5 |
| Breads | 🫓 Tandoori Roti | 🟢 Veg | ₹30 | 3 |
| Drinks | 🥤 Sweet Lassi | 🟢 Veg | ₹90 | 9 |
| Drinks | ☕ Masala Chai | 🟢 Veg | ₹40 | 4 |
| Desserts | 🍮 Gulab Jamun | 🟢 Veg | ₹80 | 8 |
| Desserts | 🍨 Kesar Kulfi | 🟢 Veg | ₹100 | **15** (bonus points dish) |

**Points ka hisaab:** order ke har item ke points jode jaate hain, phir tier ka multiplier lagta hai.
Example: 2× Paneer Tikka + 1× Sweet Lassi = 26+26+9 = **61 points** (Gold par 1.25x = 76).

### 🎁 Rewards (sample)

| Reward | Points |
|---|---:|
| 🥤 Free Sweet Lassi | 80 |
| 🍰 Free Dessert | 150 |
| 🏷️ 20% Off on Bill | 300 |
| 🍛 Free Thali | 500 |
| 🎟️ Stamp card: 10 visits | Free Meal for 1 |
| 🎂 Birthday (±3 din) | Free dessert |

---

## 🔄 Flow

1. **Customer:** QR scan karta hai, join ya login karta hai (mobile + 4-digit PIN), aur visit + 1 stamp milta hai.
2. **Customer:** 🍛 Menu se dishes chunta hai aur order bhejta hai. QR scan ke bina bhi order kar sakta hai, lekin stamp sirf scan par milta hai.
3. **Staff:** Live Order Board par order dikhta hai (ding ke saath). Staff check karke **Confirm** karta hai, aur points apne aap customer ko mil jaate hain.
4. **Customer:** reward redeem karta hai, 6-digit code milta hai (10 min valid).
5. **Staff:** **Redeem verify** mein code daalta hai, confirm karta hai, aur reward serve hota hai. Code use na ho toh points apne aap wapas aa jaate hain.

---

## ✨ Features

**Customer app**
- Home: tier ke rang ka wallet card, agla reward, stamp card, rewards carousel, "Kaise kaam karta hai" steps
- Menu: categories, Veg only filter, ★ Bestseller aur "Zyada points" tags, cart bar, extra orders
- Rewards: points wallet, ready rewards, progress rings, live code, bharosa CTA
- History: mahine ka summary, filters, rangeen timeline
- Invite: referral code ticket, WhatsApp/Share/Link, dost list. Invite link (`/?ref=CODE`) se code apne aap bhar jata hai.
- Light/Dark mode, line icons, celebration animations

**Admin app**
- Login: username + password. Roles: 👑 Owner (sab kuch) / 👨‍🍳 Staff (daily kaam)
- Live Order Board: wait timer (🟢/🟡/🔴), FIFO, NEW tag, confirm / edit / remove
- Counter QR + Kiosk mode (QR har 60 second mein badalta hai)
- Redeem verify keypad, customers list + tier filter + points adjust
- Menu & points editor, rewards editor, settings, staff accounts
- Har bill aur redeem par kis staff ne kiya, ye record hota hai

**Fraud se bachaav:** dynamic QR, 4 ghante mein ek check-in, points sirf staff ke confirm par, redeem sirf staff ke verify par.

---

## 📁 Files

| File | Kaam |
|---|---|
| `server.js` | Backend: API, data, login, roles (koi dependency nahi) |
| `public/index.html` | Customer app |
| `public/admin.html` | Admin app |
| `public/style.css` | Shared design (light/dark) |
| `reset-owner.js` | Owner password reset |
| `start.bat` | Windows par ek click se chalaiye |

Saara data `data.json` mein save hota hai: customers, orders, passwords ke hash. **Ye file git mein nahi jaati** (`.gitignore`). Iska alag se backup rakhiye.
Hosting par `DATA_DIR=/data` set karke data ko persistent disk par rakh sakte hain.

> ⚠️ Ye ek sample project hai. Asli restaurant mein lagane se pehle: HTTPS wali hosting, real SMS OTP aur proper database lagana chahiye.
