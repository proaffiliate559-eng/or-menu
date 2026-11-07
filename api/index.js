// Vercel serverless entry: saari /api/* aur /healthz requests yahan aati hain.
// Asli logic server.js mein hai (VERCEL env set hone par wo handler export karta hai).
process.env.VERCEL = process.env.VERCEL || '1';
module.exports = require('../server.js');
