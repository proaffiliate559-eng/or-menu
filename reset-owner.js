// Owner password bhool gaye? Server band karke chalaiye:  node reset-owner.js
// Ek naya temporary password banega. Login karte hi naya password set karna hoga.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const owner = (db.staff || []).find(s => s.username === 'owner') || (db.staff || []).find(s => s.role === 'owner');
if (!owner) { console.error('Koi owner account nahi mila.'); process.exit(1); }

const temp = 'fm' + crypto.randomInt(100000, 999999);
owner.salt = crypto.randomBytes(8).toString('hex');
owner.passHash = crypto.scryptSync(temp, owner.salt, 32).toString('hex');
owner.mustChange = true;
owner.active = true;
for (const [k, v] of Object.entries(db.adminSessions || {})) if (v && v.staffId === owner.id) delete db.adminSessions[k];

fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db, null, 2));
fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
console.log(`\nOwner password reset ho gaya.\n  Username: ${owner.username}\n  Temporary password: ${temp}\nLogin karte hi naya password set karna hoga.\n`);
