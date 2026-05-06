// ═══════════════════════════════════════════════════
//  Pokédex Binks — Serveur de Prix
//  TCGPlayer (via pokemontcg.io) + eBay Browse API
// ═══════════════════════════════════════════════════
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const NodeCache = require('node-cache');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 }); // Cache 1h

app.use(cors());
app.use(express.json());

// ── Config ──────────────────────────────────────────
const EBAY_CLIENT_ID     = process.env.EBAY_CLIENT_ID     || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const POKEMONTCG_API_KEY = process.env.POKEMONTCG_API_KEY || '';
const PORT               = process.env.PORT || 3001;

// ── Token eBay (OAuth client credentials) ───────────
let ebayToken = null;
let ebayTokenExpiry = 0;

async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExpiry) return ebayToken;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) return null;

  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`,
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!res.ok) {
    console.warn('⚠️  eBay token error:', res.status);
    return null;
  }
  const data = await res.json();
  ebayToken = data.access_token;
  ebayTokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return ebayToken;
}

// ── Taux de change EUR/USD ───────────────────────────
async function getEurRate() {
  const cached = cache.get('eur_rate');
  if (cached) return cached;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const d = await r.json();
    const rate = d.rates?.EUR || 0.92;
    cache.set('eur_rate', rate, 7200); // Cache 2h
    return rate;
  } catch {
    return 0.92; // Fallback
  }
}

// ── Prix TCGPlayer via pokemontcg.io ─────────────────
async function getTcgPrices(cardId) {
  const cacheKey = `tcg_${cardId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const headers = POKEMONTCG_API_KEY
    ? { 'X-Api-Key': POKEMONTCG_API_KEY }
    : {};

  const res = await fetch(`https://api.pokemontcg.io/v2/cards/${cardId}`, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  const prices = data.data?.tcgplayer?.prices || null;
  cache.set(cacheKey, prices);
  return prices;
}

// ── Recherche eBay (annonces actives + vendues) ───────
async function getEbayPrices(cardName, setName, variant) {
  const cacheKey = `ebay_${cardName}_${variant}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const token = await getEbayToken();
  if (!token) return null;

  // Construire une query précise
  const variantTerm = variant === 'R' ? 'reverse holo'
                    : variant === 'H' ? 'holo'
                    : '';
  const query = `${cardName} pokemon card ${setName} ${variantTerm} french`.trim();

  try {
    // Browse API — annonces actives (seul endpoint public disponible)
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?` +
      `q=${encodeURIComponent(query)}&` +
      `category_ids=183454&` + // Catégorie Pokemon TCG
      `filter=conditionIds%3A%7B1000%7C2500%7C3000%7D,` + // NM, VG, Good
      `buyingOptions%3A%7BFIXED_PRICE%7D&` +
      `sort=price&` +
      `limit=20`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_FR',
          'Accept-Language': 'fr-FR',
        },
      }
    );

    if (!res.ok) {
      console.warn('eBay Browse error:', res.status);
      return null;
    }

    const data = await res.json();
    const items = data.itemSummaries || [];

    if (items.length === 0) return null;

    // Extraire les prix en EUR
    const prices = items
      .map(item => {
        const p = item.price;
        if (!p) return null;
        let eur = parseFloat(p.value);
        if (p.currency === 'USD') eur *= 0.92;
        return eur;
      })
      .filter(p => p !== null && p > 0.10 && p < 500)
      .sort((a, b) => a - b);

    if (prices.length === 0) return null;

    // Supprimer les outliers (10% haut et bas)
    const trim = Math.floor(prices.length * 0.1);
    const trimmed = prices.slice(trim, prices.length - trim || undefined);

    const result = {
      low:    Math.round(trimmed[0] * 100) / 100,
      median: Math.round(trimmed[Math.floor(trimmed.length / 2)] * 100) / 100,
      high:   Math.round(trimmed[trimmed.length - 1] * 100) / 100,
      count:  items.length,
      source: 'ebay_active',
    };

    cache.set(cacheKey, result, 1800); // Cache 30 min
    return result;
  } catch (err) {
    console.warn('eBay fetch error:', err.message);
    return null;
  }
}

// ── Calcul prix final (mix TCG + eBay) ───────────────
function computeFinalPrice(tcg, ebay, variant, eurRate) {
  const variantKey = variant === 'N' ? 'normal'
                   : variant === 'R' ? 'reverseHolofoil'
                   : variant === 'H' ? 'holofoil'
                   : 'normal';

  let tcgEur = null;
  let tcgConfidence = 0;

  if (tcg && tcg[variantKey]) {
    const t = tcg[variantKey];
    const mktUsd = t.market || t.mid || ((t.low + t.high) / 2);
    if (mktUsd > 0) {
      // Les cartes FR valent ~15-25% de plus que US sur TCGPlayer
      tcgEur = mktUsd * eurRate * 1.18;
      tcgConfidence = t.market ? 90 : 70;
    }
  }

  let ebayEur = null;
  let ebayConfidence = 0;
  if (ebay) {
    ebayEur = ebay.median;
    // Plus le nombre d'annonces est élevé, plus la confiance est haute
    ebayConfidence = Math.min(85, 40 + ebay.count * 3);
  }

  // Pondération : si les deux sources dispo, moyenne pondérée
  let finalPrice = null;
  let confidence = 0;
  let sources = [];

  if (tcgEur && ebayEur) {
    // Les deux sources : moyenne pondérée
    const totalW = tcgConfidence + ebayConfidence;
    finalPrice = (tcgEur * tcgConfidence + ebayEur * ebayConfidence) / totalW;
    confidence = Math.round((tcgConfidence + ebayConfidence) / 2);
    sources = ['TCGPlayer', 'eBay'];
  } else if (tcgEur) {
    finalPrice = tcgEur;
    confidence = tcgConfidence;
    sources = ['TCGPlayer'];
  } else if (ebayEur) {
    finalPrice = ebayEur;
    confidence = ebayConfidence;
    sources = ['eBay'];
  }

  if (!finalPrice) return null;

  // Arrondir proprement
  const rounded = finalPrice < 1    ? Math.round(finalPrice * 100) / 100
                : finalPrice < 10   ? Math.round(finalPrice * 10) / 10
                : finalPrice < 100  ? Math.round(finalPrice)
                : Math.round(finalPrice);

  return {
    price:      rounded,
    currency:   'EUR',
    confidence, // 0-100
    sources,
    breakdown: {
      tcgplayer: tcgEur ? Math.round(tcgEur * 100) / 100 : null,
      ebay:      ebayEur ? Math.round(ebayEur * 100) / 100 : null,
    },
    trend: computeTrend(tcg, variantKey, eurRate),
  };
}

function computeTrend(tcg, variantKey, eurRate) {
  if (!tcg || !tcg[variantKey]) return null;
  const t = tcg[variantKey];
  if (!t.low || !t.high) return null;
  const spread = (t.high - t.low) / t.low;
  if (spread > 0.5) return 'volatile';
  if (t.market && t.mid && t.market > t.mid * 1.05) return 'up';
  if (t.market && t.mid && t.market < t.mid * 0.95) return 'down';
  return 'stable';
}

// ══════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════

// GET /price/:cardId?variant=N|R|H&cardName=...&setName=...
app.get('/price/:cardId', async (req, res) => {
  const { cardId } = req.params;
  const { variant = 'N', cardName = '', setName = '' } = req.query;

  const cacheKey = `price_${cardId}_${variant}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [tcg, ebay, eurRate] = await Promise.all([
      getTcgPrices(cardId),
      getEbayPrices(cardName, setName, variant),
      getEurRate(),
    ]);

    const result = computeFinalPrice(tcg, ebay, variant, eurRate);

    if (!result) {
      return res.status(404).json({ error: 'Prix non disponible' });
    }

    cache.set(cacheKey, result, 1800);
    res.json(result);
  } catch (err) {
    console.error('Price error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /prices — batch (jusqu'à 20 cartes à la fois)
app.post('/prices', async (req, res) => {
  const { cards } = req.body; // [{cardId, variant, cardName, setName}]
  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: 'Tableau de cartes requis' });
  }

  const eurRate = await getEurRate();
  const results = {};

  await Promise.allSettled(
    cards.slice(0, 20).map(async ({ cardId, variant = 'N', cardName = '', setName = '' }) => {
      const cacheKey = `price_${cardId}_${variant}`;
      const cached = cache.get(cacheKey);
      if (cached) { results[`${cardId}_${variant}`] = cached; return; }

      const [tcg, ebay] = await Promise.all([
        getTcgPrices(cardId),
        getEbayPrices(cardName, setName, variant),
      ]);
      const r = computeFinalPrice(tcg, ebay, variant, eurRate);
      if (r) {
        results[`${cardId}_${variant}`] = r;
        cache.set(cacheKey, r, 1800);
      }
    })
  );

  res.json(results);
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    ebay:     !!EBAY_CLIENT_ID,
    tcg:      !!POKEMONTCG_API_KEY,
    cacheSize: cache.keys().length,
  });
});

app.listen(PORT, () => {
  console.log(`\n🎴 Pokédex Binks — Serveur de Prix`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   eBay:      ${EBAY_CLIENT_ID ? '✅ configuré' : '⚠️  manquant'}`);
  console.log(`   TCGPlayer: ${POKEMONTCG_API_KEY ? '✅ configuré' : '⚠️  (mode sans clé)'}\n`);
});
