require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const NodeCache = require('node-cache');
const crypto    = require('crypto');
const fs        = require('fs');
 
const app   = express();
const cache = new NodeCache({ stdTTL: 3600 });
app.use(cors());
app.use(express.json());
 
const EBAY_CLIENT_ID     = process.env.EBAY_CLIENT_ID     || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const POKEMONTCG_API_KEY = process.env.POKEMONTCG_API_KEY || '';
const JWT_SECRET         = process.env.JWT_SECRET         || 'pokedex-binks-secret';
const SUPABASE_URL       = process.env.SUPABASE_URL       || '';
const SUPABASE_KEY       = process.env.SUPABASE_KEY       || '';
const PORT               = process.env.PORT               || 3001;
 
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
 
// ════════════════════════════════════════
// BASE DE DONNÉES
// Supabase (permanent) ou fichier local (fallback)
// ════════════════════════════════════════
 
// ── Helpers Supabase REST (sans package, juste fetch) ──
async function sbGet(table, filters = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filters}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data[0] || null : data;
}
 
async function sbUpsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }
  return res.json();
}
 
async function sbInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.message || 'Supabase insert error');
  return Array.isArray(result) ? result[0] : result;
}
 
// ── Fallback fichier local ──
const DB_FILE = '/tmp/pokedex_db.json';
function loadLocalDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
  return { users: {}, collections: {} };
}
function saveLocalDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(localDB), 'utf8'); } catch(e) {}
}
let localDB = loadLocalDB();
 
// ── DB Interface unifiée ──
async function dbGetUser(email) {
  if (useSupabase) return sbGet('pb_users', `email=eq.${encodeURIComponent(email)}&select=*`);
  return localDB.users[email] || null;
}
async function dbCreateUser(user) {
  if (useSupabase) return sbInsert('pb_users', user);
  localDB.users[user.email] = user; saveLocalDB(); return user;
}
async function dbGetCollection(userId) {
  if (useSupabase) return sbGet('pb_collections', `user_id=eq.${userId}&select=*`);
  return localDB.collections[userId] || null;
}
async function dbSaveCollection(userId, col, prices) {
  const updatedAt = new Date().toISOString();
  if (useSupabase) {
    await sbUpsert('pb_collections', { user_id: userId, col, prices, updated_at: updatedAt });
    return;
  }
  localDB.collections[userId] = { col, prices, updatedAt }; saveLocalDB();
}
 
// ════════════════════════════════════════
// JWT
// ════════════════════════════════════════
function createToken(userId, email) {
  const payload = { userId, email, exp: Date.now() + 30 * 24 * 3600 * 1000 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig  = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
  return `${data}.${sig}`;
}
function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    if (sig !== crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex')) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64').toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function authMiddleware(req, res, next) {
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: 'Non authentifié' });
  req.user = payload; next();
}
function hashPw(pw) {
  return crypto.createHmac('sha256', JWT_SECRET).update(pw).digest('hex');
}
 
// ════════════════════════════════════════
// ROUTES AUTH
// ════════════════════════════════════════
app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min)' });
  try {
    const existing = await dbGetUser(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email déjà utilisé' });
    const user = { id: crypto.randomUUID(), email: email.toLowerCase(), password_hash: hashPw(password), created_at: new Date().toISOString() };
    await dbCreateUser(user);
    res.json({ token: createToken(user.id, user.email), user: { id: user.id, email: user.email } });
  } catch(e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Erreur serveur: ' + e.message });
  }
});
 
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  try {
    const user = await dbGetUser(email.toLowerCase());
    if (!user || user.password_hash !== hashPw(password))
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    res.json({ token: createToken(user.id, user.email), user: { id: user.id, email: user.email } });
  } catch(e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
 
app.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: { id: req.user.userId, email: req.user.email } });
});
 
// ════════════════════════════════════════
// ROUTES COLLECTION
// ════════════════════════════════════════
app.get('/collection', authMiddleware, async (req, res) => {
  try {
    const data = await dbGetCollection(req.user.userId);
    if (!data) return res.json({ col: {}, prices: {}, updatedAt: null });
    res.json({ col: data.col || {}, prices: data.prices || {}, updatedAt: data.updatedAt || data.updated_at });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});
 
app.post('/collection', authMiddleware, async (req, res) => {
  const { col, prices } = req.body;
  if (!col) return res.status(400).json({ error: 'Données manquantes' });
  try {
    await dbSaveCollection(req.user.userId, col, prices || {});
    const updatedAt = new Date().toISOString();
    res.json({ ok: true, updatedAt });
  } catch(e) {
    console.error('Save collection error:', e.message);
    res.status(500).json({ error: 'Erreur serveur: ' + e.message });
  }
});
 
// ════════════════════════════════════════
// ROUTES PRIX
// ════════════════════════════════════════
let ebayToken = null, ebayTokenExpiry = 0;
async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExpiry) return ebayToken;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) return null;
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  try {
    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    });
    if (!res.ok) return null;
    const d = await res.json();
    ebayToken = d.access_token;
    ebayTokenExpiry = Date.now() + (d.expires_in - 300) * 1000;
    return ebayToken;
  } catch { return null; }
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
      const d = await res.json();
      const p = d.data?.tcgplayer?.prices || null;
      if (p && Object.keys(p).length > 0) { cache.set(ck, p); return p; }
    }
  } catch {}
  if (cardName) {
    try {
      const res = await fetch(`https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(cardName)}"&pageSize=10&orderBy=-set.releaseDate`, { headers });
      if (res.ok) {
        const d = await res.json();
        for (const card of (d.data || [])) {
          const p = card.tcgplayer?.prices;
          if (p && Object.keys(p).length > 0) { cache.set(ck, p); return p; }
        }
      }
    } catch {}
  }
  cache.set(ck, null, 1800); return null;
}
 
async function getEbayPrices(cardName, setName, variant) {
  const ck = `ebay_${cardName}_${variant}`; const c = cache.get(ck); if (c) return c;
  const token = await getEbayToken(); if (!token) return null;
  const vt = variant==='R'?'reverse holo':variant==='H'?'holo':'';
  const query = `${cardName} pokemon card ${setName} ${vt} french`.trim();
  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&category_ids=183454&filter=conditionIds%3A%7B1000%7C2500%7C3000%7D,buyingOptions%3A%7BFIXED_PRICE%7D&sort=price&limit=20`,
      { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_FR' } }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const items = d.itemSummaries || [];
    if (!items.length) return null;
    const arr = items.map(i => { const p=i.price; if(!p) return null; let e=parseFloat(p.value); if(p.currency==='USD')e*=0.92; return e; }).filter(p=>p&&p>0.1&&p<500).sort((a,b)=>a-b);
    if (!arr.length) return null;
    const trim = Math.floor(arr.length*0.1);
    const tr = arr.slice(trim, arr.length-trim||undefined);
    const result = { low:Math.round(tr[0]*100)/100, median:Math.round(tr[Math.floor(tr.length/2)]*100)/100, high:Math.round(tr[tr.length-1]*100)/100, count:items.length };
    cache.set(ck, result, 1800); return result;
  } catch { return null; }
}
 
function computePrice(tcg, ebay, variant, eurRate) {
  const vk = variant==='N'?'normal':variant==='R'?'reverseHolofoil':'holofoil';
  let tcgEur=null,tcgConf=0;
  if (tcg&&tcg[vk]) { const t=tcg[vk]; const u=t.market||t.mid||((t.low+t.high)/2); if(u>0){tcgEur=u*eurRate*1.18;tcgConf=t.market?90:70;} }
  let ebayEur=null,ebayConf=0;
  if (ebay) { ebayEur=ebay.median; ebayConf=Math.min(85,40+ebay.count*3); }
  let final=null,conf=0,sources=[];
  if (tcgEur&&ebayEur){final=(tcgEur*tcgConf+ebayEur*ebayConf)/(tcgConf+ebayConf);conf=Math.round((tcgConf+ebayConf)/2);sources=['TCGPlayer','eBay'];}
  else if (tcgEur){final=tcgEur;conf=tcgConf;sources=['TCGPlayer'];}
  else if (ebayEur){final=ebayEur;conf=ebayConf;sources=['eBay'];}
  if (!final) return null;
  const rounded=final<1?Math.round(final*100)/100:final<10?Math.round(final*10)/10:Math.round(final);
  const t=tcg?.[vk]; const trend=t?.market&&t?.mid?(t.market>t.mid*1.05?'up':t.market<t.mid*0.95?'down':'stable'):null;
  return { price:rounded, currency:'EUR', confidence:conf, sources, breakdown:{tcgplayer:tcgEur?Math.round(tcgEur*100)/100:null,ebay:ebayEur?Math.round(ebayEur*100)/100:null}, trend };
}
 
app.get('/price/:cardId', async (req, res) => {
  const { cardId } = req.params;
  const { variant='N', cardName='', setName='' } = req.query;
  const ck=`price_${cardId}_${variant}`; const c=cache.get(ck); if(c) return res.json(c);
  try {
    const [tcg,ebay,eurRate]=await Promise.all([getTcgPrices(cardId,cardName),getEbayPrices(cardName,setName,variant),getEurRate()]);
    const result=computePrice(tcg,ebay,variant,eurRate);
    if (!result) return res.status(404).json({ error:'Prix non disponible' });
    cache.set(ck,result,1800); res.json(result);
  } catch(e) { res.status(500).json({ error:'Erreur serveur' }); }
});
 
app.post('/prices', async (req, res) => {
  const { cards } = req.body;
  if (!Array.isArray(cards)||!cards.length) return res.status(400).json({ error:'Tableau requis' });
  const eurRate=await getEurRate();
  const results={};
  await Promise.allSettled(cards.slice(0,20).map(async ({cardId,variant='N',cardName='',setName=''})=>{
    const ck=`price_${cardId}_${variant}`; const c=cache.get(ck);
    if(c){results[`${cardId}_${variant}`]=c;return;}
    const [tcg,ebay]=await Promise.all([getTcgPrices(cardId,cardName),getEbayPrices(cardName,setName,variant)]);
    const r=computePrice(tcg,ebay,variant,eurRate);
    if(r){results[`${cardId}_${variant}`]=r;cache.set(ck,r,1800);}
  }));
  res.json(results);
});
 
app.get('/health', (req, res) => {
  res.json({ status:'ok', ebay:!!EBAY_CLIENT_ID, tcg:!!POKEMONTCG_API_KEY, supabase:useSupabase, cacheSize:cache.keys().length });
});
 
app.listen(PORT, () => {
  console.log(`\n🎴 Pokédex Binks — Serveur`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   eBay:      ${EBAY_CLIENT_ID?'✅':'⚠️  manquant'}`);
  console.log(`   TCGPlayer: ${POKEMONTCG_API_KEY?'✅':'⚠️  sans clé'}`);
  console.log(`   Supabase:  ${useSupabase?'✅ actif':'⚠️  mode local (données dans /tmp)'}\n`);
