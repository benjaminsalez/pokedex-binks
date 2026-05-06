// ═══════════════════════════════════════════════════
//  Pokédex Binks — Serveur
//  Prix (TCGPlayer + eBay) + Auth + Sync collection
// ═══════════════════════════════════════════════════
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const NodeCache = require('node-cache');
const crypto    = require('crypto');
 
const app   = express();
const cache = new NodeCache({ stdTTL: 3600 });
 
app.use(cors());
app.use(express.json());
 
// ── Config ──────────────────────────────────────────
const EBAY_CLIENT_ID     = process.env.EBAY_CLIENT_ID     || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const POKEMONTCG_API_KEY = process.env.POKEMONTCG_API_KEY || '';
const JWT_SECRET         = process.env.JWT_SECRET         || 'pokedex-binks-secret-change-me';
const PORT               = process.env.PORT               || 3001;
 
// ── Base de données en mémoire (remplacée par Supabase si configuré) ──
// Pour une vraie persistence : utiliser Supabase (voir .env.example)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
let supabase = null;
 
if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('✅ Supabase connecté');
  } catch(e) {
    console.warn('⚠️  Supabase non disponible, mode mémoire');
  }
}
 
// Fallback en mémoire (perdu au redémarrage Railway)
const memDB = {
  users: {},     // email -> {id, email, passwordHash, createdAt}
  collections: {} // userId -> {col, prices, updatedAt}
};
 
// ── JWT simple ──────────────────────────────────────
function createToken(userId, email) {
  const payload = { userId, email, exp: Date.now() + 30 * 24 * 3600 * 1000 }; // 30 jours
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig  = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
  return `${data}.${sig}`;
}
 
function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64').toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
 
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Non authentifié' });
  req.user = payload;
  next();
}
 
function hashPassword(pw) {
  return crypto.createHmac('sha256', JWT_SECRET).update(pw).digest('hex');
}
 
// ── DB helpers (Supabase ou mémoire) ─────────────────
async function dbGetUser(email) {
  if (supabase) {
    const { data } = await supabase.from('users').select('*').eq('email', email).single();
    return data;
  }
  return memDB.users[email] || null;
}
 
async function dbCreateUser(user) {
  if (supabase) {
    const { data, error } = await supabase.from('users').insert(user).select().single();
    if (error) throw error;
    return data;
  }
  memDB.users[user.email] = user;
  return user;
}
 
async function dbGetCollection(userId) {
  if (supabase) {
    const { data } = await supabase.from('collections').select('*').eq('user_id', userId).single();
    return data;
  }
  return memDB.collections[userId] || null;
}
 
async function dbSaveCollection(userId, col, prices) {
  const updatedAt = new Date().toISOString();
  if (supabase) {
    await supabase.from('collections').upsert({ user_id: userId, col, prices, updated_at: updatedAt });
    return;
  }
  memDB.collections[userId] = { col, prices, updatedAt };
}
 
// ══════════════════════════════════════════════════════
//  ROUTES AUTH
// ══════════════════════════════════════════════════════
 
// POST /auth/register
app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  if (password.length < 6)  return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });
 
  try {
    const existing = await dbGetUser(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email déjà utilisé' });
 
    const user = {
      id:           crypto.randomUUID(),
      email:        email.toLowerCase(),
      passwordHash: hashPassword(password),
      createdAt:    new Date().toISOString(),
    };
    await dbCreateUser(user);
    const token = createToken(user.id, user.email);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch(e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
 
// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
 
  try {
    const user = await dbGetUser(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    if (user.passwordHash !== hashPassword(password))
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
 
    const token = createToken(user.id, user.email);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch(e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
 
// GET /auth/me
app.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: { id: req.user.userId, email: req.user.email } });
});
 
// ══════════════════════════════════════════════════════
//  ROUTES COLLECTION SYNC
// ══════════════════════════════════════════════════════
 
// GET /collection — charger
app.get('/collection', authMiddleware, async (req, res) => {
  try {
    const data = await dbGetCollection(req.user.userId);
    if (!data) return res.json({ col: {}, prices: {}, updatedAt: null });
    res.json({ col: data.col || {}, prices: data.prices || {}, updatedAt: data.updatedAt || data.updated_at });
  } catch(e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
 
// POST /collection — sauvegarder
app.post('/collection', authMiddleware, async (req, res) => {
  const { col, prices } = req.body;
  if (!col) return res.status(400).json({ error: 'Données manquantes' });
  try {
    await dbSaveCollection(req.user.userId, col, prices || {});
    res.json({ ok: true, updatedAt: new Date().toISOString() });
  } catch(e) {
    console.error('Save collection error:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
 
// ══════════════════════════════════════════════════════
//  ROUTES PRIX (inchangées)
// ══════════════════════════════════════════════════════
 
let ebayToken = null, ebayTokenExpiry = 0;
async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExpiry) return ebayToken;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) return null;
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!res.ok) return null;
  const data = await res.json();
  ebayToken = data.access_token;
  ebayTokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return ebayToken;
}
 
async function getEurRate() {
  const c = cache.get('eur_rate'); if (c) return c;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const d = await r.json();
    const rate = d.rates?.EUR || 0.92;
    cache.set('eur_rate', rate, 7200); return rate;
  } catch { return 0.92; }
}
 
async function getTcgPrices(cardId, cardName = '') {
  const ck = `tcg_${cardId}`; const c = cache.get(ck); if (c !== undefined) return c;
  const headers = POKEMONTCG_API_KEY ? { 'X-Api-Key': POKEMONTCG_API_KEY } : {};
  try {
    const res = await fetch(`https://api.pokemontcg.io/v2/cards/${cardId}`, { headers });
    if (res.ok) {
      const data = await res.json();
      const prices = data.data?.tcgplayer?.prices || null;
      if (prices && Object.keys(prices).length > 0) { cache.set(ck, prices); return prices; }
    }
  } catch {}
  if (cardName) {
    try {
      const res = await fetch(`https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(cardName)}"&pageSize=10&orderBy=-set.releaseDate`, { headers });
      if (res.ok) {
        const data = await res.json();
        for (const card of (data.data || [])) {
          const p = card.tcgplayer?.prices;
          if (p && Object.keys(p).length > 0 && card.name.toLowerCase().includes(cardName.toLowerCase().split(' ')[0])) {
            cache.set(ck, p); return p;
          }
        }
      }
    } catch {}
  }
  cache.set(ck, null, 1800); return null;
}
 
async function getEbayPrices(cardName, setName, variant) {
  const ck = `ebay_${cardName}_${variant}`; const c = cache.get(ck); if (c) return c;
  const token = await getEbayToken(); if (!token) return null;
  const variantTerm = variant === 'R' ? 'reverse holo' : variant === 'H' ? 'holo' : '';
  const query = `${cardName} pokemon card ${setName} ${variantTerm} french`.trim();
  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&category_ids=183454&filter=conditionIds%3A%7B1000%7C2500%7C3000%7D,buyingOptions%3A%7BFIXED_PRICE%7D&sort=price&limit=20`,
      { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_FR', 'Accept-Language': 'fr-FR' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.itemSummaries || [];
    if (!items.length) return null;
    const priceArr = items.map(i => { const p = i.price; if (!p) return null; let eur = parseFloat(p.value); if (p.currency === 'USD') eur *= 0.92; return eur; }).filter(p => p && p > 0.1 && p < 500).sort((a,b) => a-b);
    if (!priceArr.length) return null;
    const trim = Math.floor(priceArr.length * 0.1);
    const trimmed = priceArr.slice(trim, priceArr.length - trim || undefined);
    const result = { low: Math.round(trimmed[0]*100)/100, median: Math.round(trimmed[Math.floor(trimmed.length/2)]*100)/100, high: Math.round(trimmed[trimmed.length-1]*100)/100, count: items.length };
    cache.set(ck, result, 1800); return result;
  } catch { return null; }
}
 
function computeFinalPrice(tcg, ebay, variant, eurRate) {
  const vk = variant === 'N' ? 'normal' : variant === 'R' ? 'reverseHolofoil' : 'holofoil';
  let tcgEur = null, tcgConf = 0;
  if (tcg && tcg[vk]) { const t = tcg[vk]; const u = t.market || t.mid || ((t.low+t.high)/2); if (u > 0) { tcgEur = u * eurRate * 1.18; tcgConf = t.market ? 90 : 70; } }
  let ebayEur = null, ebayConf = 0;
  if (ebay) { ebayEur = ebay.median; ebayConf = Math.min(85, 40 + ebay.count * 3); }
  let finalPrice = null, confidence = 0, sources = [];
  if (tcgEur && ebayEur) { const tw = tcgConf+ebayConf; finalPrice = (tcgEur*tcgConf+ebayEur*ebayConf)/tw; confidence = Math.round((tcgConf+ebayConf)/2); sources = ['TCGPlayer','eBay']; }
  else if (tcgEur) { finalPrice = tcgEur; confidence = tcgConf; sources = ['TCGPlayer']; }
  else if (ebayEur) { finalPrice = ebayEur; confidence = ebayConf; sources = ['eBay']; }
  if (!finalPrice) return null;
  const rounded = finalPrice < 1 ? Math.round(finalPrice*100)/100 : finalPrice < 10 ? Math.round(finalPrice*10)/10 : Math.round(finalPrice);
  const t = tcg?.[vk]; const trend = t?.market && t?.mid ? (t.market > t.mid*1.05 ? 'up' : t.market < t.mid*0.95 ? 'down' : 'stable') : null;
  return { price: rounded, currency: 'EUR', confidence, sources, breakdown: { tcgplayer: tcgEur ? Math.round(tcgEur*100)/100 : null, ebay: ebayEur ? Math.round(ebayEur*100)/100 : null }, trend };
}
 
app.get('/price/:cardId', async (req, res) => {
  const { cardId } = req.params;
  const { variant = 'N', cardName = '', setName = '' } = req.query;
  const ck = `price_${cardId}_${variant}`; const c = cache.get(ck); if (c) return res.json(c);
  try {
    const [tcg, ebay, eurRate] = await Promise.all([getTcgPrices(cardId, cardName), getEbayPrices(cardName, setName, variant), getEurRate()]);
    const result = computeFinalPrice(tcg, ebay, variant, eurRate);
    if (!result) return res.status(404).json({ error: 'Prix non disponible' });
    cache.set(ck, result, 1800); res.json(result);
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});
 
app.post('/prices', async (req, res) => {
  const { cards } = req.body;
  if (!Array.isArray(cards) || !cards.length) return res.status(400).json({ error: 'Tableau requis' });
  const eurRate = await getEurRate();
  const results = {};
  await Promise.allSettled(cards.slice(0,20).map(async ({ cardId, variant='N', cardName='', setName='' }) => {
    const ck = `price_${cardId}_${variant}`; const c = cache.get(ck);
    if (c) { results[`${cardId}_${variant}`] = c; return; }
    const [tcg, ebay] = await Promise.all([getTcgPrices(cardId, cardName), getEbayPrices(cardName, setName, variant)]);
    const r = computeFinalPrice(tcg, ebay, variant, eurRate);
    if (r) { results[`${cardId}_${variant}`] = r; cache.set(ck, r, 1800); }
  }));
  res.json(results);
});
 
app.get('/health', (req, res) => {
  res.json({ status:'ok', ebay:!!EBAY_CLIENT_ID, tcg:!!POKEMONTCG_API_KEY, supabase:!!supabase, cacheSize:cache.keys().length });
});
 
app.listen(PORT, () => {
  console.log(`\n🎴 Pokédex Binks — Serveur`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   eBay:      ${EBAY_CLIENT_ID ? '✅' : '⚠️  manquant'}`);
  console.log(`   TCGPlayer: ${POKEMONTCG_API_KEY ? '✅' : '⚠️  sans clé'}`);
  console.log(`   Supabase:  ${supabase ? '✅' : '⚠️  mode mémoire (données perdues au redémarrage)'}\n`);
});
