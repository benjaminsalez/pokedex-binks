require('dotenv').config();
const express=require('express');
const cors=require('cors');
const NodeCache=require('node-cache');
const crypto=require('crypto');
const fs=require('fs');

const app=express();
const cache=new NodeCache({stdTTL:3600});
app.use(cors());
app.use(express.json());

const EBAY_ID=process.env.EBAY_CLIENT_ID||'';
const EBAY_SECRET=process.env.EBAY_CLIENT_SECRET||'';
const TCG_KEY=process.env.POKEMONTCG_API_KEY||'';
const JWT_SECRET=process.env.JWT_SECRET||'pokedex-binks-secret';
const SB_URL=process.env.SUPABASE_URL||'';
const SB_KEY=process.env.SUPABASE_KEY||'';
const PORT=process.env.PORT||3001;
const useSB=!!(SB_URL&&SB_KEY); 
console.log('SB_URL=',process.env.SUPABASE_URL);
console.log('SB_KEY=',process.env.SUPABASE_KEY?'OK':'VIDE');
console.log('DEBUG SB_URL:', SB_URL?SB_URL.slice(0,30)+'...':'VIDE');
console.log('DEBUG SB_KEY:', SB_KEY?SB_KEY.slice(0,10)+'...':'VIDE');
console.log('DEBUG useSB:', useSB);
console.log('DEBUG SB_URL:', SB_URL?SB_URL.slice(0,30)+'...':'VIDE');
console.log('DEBUG SB_KEY:', SB_KEY?SB_KEY.slice(0,10)+'...':'VIDE');
console.log('DEBUG useSB:', useSB);

// ── DB locale (fallback) ──
const DB_FILE='/tmp/pkdb.json';
function loadDB(){try{if(fs.existsSync(DB_FILE))return JSON.parse(fs.readFileSync(DB_FILE,'utf8'));}catch(e){}return{users:{},cols:{}};}
function saveDB(){try{fs.writeFileSync(DB_FILE,JSON.stringify(db),'utf8');}catch(e){}}
let db=loadDB();

// ── Supabase REST ──
async function sbFetch(method,table,params,body){
  const url=`${SB_URL}/rest/v1/${table}${params?'?'+params:''}`;
  const res=await fetch(url,{method,headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Content-Type':'application/json','Prefer':method==='POST'?'resolution=merge-duplicates,return=representation':''},body:body?JSON.stringify(body):undefined});
  if(!res.ok){const t=await res.text();throw new Error('SB error: '+t);}
  const data=await res.json();
  return Array.isArray(data)?data[0]||null:data;
}

// ── DB interface ──
async function getUser(email){
  if(useSB)return sbFetch('GET','pb_users','email=eq.'+encodeURIComponent(email)+'&select=*');
  return db.users[email]||null;
}
async function createUser(u){
  if(useSB)return sbFetch('POST','pb_users','',u);
  db.users[u.email]=u;saveDB();return u;
}
async function getCol(uid){
  if(useSB)return sbFetch('GET','pb_collections','user_id=eq.'+uid+'&select=*');
  return db.cols[uid]||null;
}
async function saveCol(uid,col,prices){
  const now=new Date().toISOString();
  if(useSB){await sbFetch('POST','pb_collections','',{user_id:uid,col,prices,updated_at:now});return;}
  db.cols[uid]={col,prices,updatedAt:now};saveDB();
}

// ── JWT ──
function makeToken(uid,email){
  const p={userId:uid,email,exp:Date.now()+30*24*3600*1000};
  const d=Buffer.from(JSON.stringify(p)).toString('base64');
  const s=crypto.createHmac('sha256',JWT_SECRET).update(d).digest('hex');
  return d+'.'+s;
}
function checkToken(token){
  try{
    const[d,s]=token.split('.');
    if(s!==crypto.createHmac('sha256',JWT_SECRET).update(d).digest('hex'))return null;
    const p=JSON.parse(Buffer.from(d,'base64').toString());
    return Date.now()>p.exp?null:p;
  }catch{return null;}
}
function hashPw(pw){return crypto.createHmac('sha256',JWT_SECRET).update(pw).digest('hex');}
function auth(req,res,next){
  const p=checkToken((req.headers.authorization||'').replace('Bearer ',''));
  if(!p)return res.status(401).json({error:'Non authentifié'});
  req.user=p;next();
}

// ── AUTH ──
app.post('/auth/register',async(req,res)=>{
  const{email,password}=req.body;
  if(!email||!password)return res.status(400).json({error:'Email et mot de passe requis'});
  if(password.length<6)return res.status(400).json({error:'Mot de passe trop court (6 min)'});
  try{
    const ex=await getUser(email.toLowerCase());
    if(ex)return res.status(409).json({error:'Email déjà utilisé'});
    const u={id:crypto.randomUUID(),email:email.toLowerCase(),password_hash:hashPw(password),created_at:new Date().toISOString()};
    await createUser(u);
    res.json({token:makeToken(u.id,u.email),user:{id:u.id,email:u.email}});
  }catch(e){console.error(e);res.status(500).json({error:'Erreur: '+e.message});}
});

app.post('/auth/login',async(req,res)=>{
  const{email,password}=req.body;
  if(!email||!password)return res.status(400).json({error:'Email et mot de passe requis'});
  try{
    const u=await getUser(email.toLowerCase());
    if(!u||u.password_hash!==hashPw(password))return res.status(401).json({error:'Email ou mot de passe incorrect'});
    res.json({token:makeToken(u.id,u.email),user:{id:u.id,email:u.email}});
  }catch(e){res.status(500).json({error:'Erreur serveur'});}
});

app.get('/auth/me',auth,(req,res)=>{
  res.json({user:{id:req.user.userId,email:req.user.email}});
});

// ── COLLECTION ──
app.get('/collection',auth,async(req,res)=>{
  try{
    const d=await getCol(req.user.userId);
    if(!d)return res.json({col:{},prices:{},updatedAt:null});
    res.json({col:d.col||{},prices:d.prices||{},updatedAt:d.updatedAt||d.updated_at});
  }catch(e){res.status(500).json({error:'Erreur serveur'});}
});

app.post('/collection',auth,async(req,res)=>{
  const{col,prices}=req.body;
  if(!col)return res.status(400).json({error:'Données manquantes'});
  try{
    await saveCol(req.user.userId,col,prices||{});
    res.json({ok:true,updatedAt:new Date().toISOString()});
  }catch(e){console.error(e);res.status(500).json({error:'Erreur: '+e.message});}
});

// ── PRIX ──
let ebayTok=null,ebayExp=0;
async function getEbayToken(){
  if(ebayTok&&Date.now()<ebayExp)return ebayTok;
  if(!EBAY_ID||!EBAY_SECRET)return null;
  try{
    const r=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Authorization':'Basic '+Buffer.from(EBAY_ID+':'+EBAY_SECRET).toString('base64')},body:'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'});
    if(!r.ok)return null;
    const d=await r.json();ebayTok=d.access_token;ebayExp=Date.now()+(d.expires_in-300)*1000;return ebayTok;
  }catch{return null;}
}

async function getEurRate(){
  const c=cache.get('eur');if(c)return c;
  try{const r=await fetch('https://open.er-api.com/v6/latest/USD');const d=await r.json();const rate=d.rates?.EUR||0.92;cache.set('eur',rate,7200);return rate;}
  catch{return 0.92;}
}

async function getTcg(cardId,cardName){
  const ck='tcg_'+cardId;const c=cache.get(ck);if(c!==undefined)return c;
  const h=TCG_KEY?{'X-Api-Key':TCG_KEY}:{};
  try{
    const r=await fetch('https://api.pokemontcg.io/v2/cards/'+cardId,{headers:h});
    if(r.ok){const d=await r.json();const p=d.data?.tcgplayer?.prices;if(p&&Object.keys(p).length){cache.set(ck,p);return p;}}
  }catch{}
  if(cardName){
    try{
      const r=await fetch('https://api.pokemontcg.io/v2/cards?q=name:"'+encodeURIComponent(cardName)+'"&pageSize=10&orderBy=-set.releaseDate',{headers:h});
      if(r.ok){const d=await r.json();for(const c of(d.data||[])){const p=c.tcgplayer?.prices;if(p&&Object.keys(p).length){cache.set(ck,p);return p;}}}
    }catch{}
  }
  cache.set(ck,null,1800);return null;
}

async function getEbay(cardName,setName,variant){
  const ck='ebay_'+cardName+'_'+variant;const c=cache.get(ck);if(c)return c;
  const tok=await getEbayToken();if(!tok)return null;
  const vt=variant==='R'?'reverse holo':variant==='H'?'holo':'';
  try{
    const r=await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q='+encodeURIComponent(cardName+' pokemon '+setName+' '+vt+' french')+'&category_ids=183454&filter=conditionIds%3A%7B1000%7C2500%7C3000%7D,buyingOptions%3A%7BFIXED_PRICE%7D&sort=price&limit=20',{headers:{'Authorization':'Bearer '+tok,'X-EBAY-C-MARKETPLACE-ID':'EBAY_FR'}});
    if(!r.ok)return null;
    const d=await r.json();const items=d.itemSummaries||[];if(!items.length)return null;
    const arr=items.map(i=>{const p=i.price;if(!p)return null;let e=parseFloat(p.value);if(p.currency==='USD')e*=0.92;return e;}).filter(p=>p&&p>0.1&&p<500).sort((a,b)=>a-b);
    if(!arr.length)return null;
    const t=Math.floor(arr.length*0.1);const tr=arr.slice(t,arr.length-t||undefined);
    const result={low:Math.round(tr[0]*100)/100,median:Math.round(tr[Math.floor(tr.length/2)]*100)/100,high:Math.round(tr[tr.length-1]*100)/100,count:items.length};
    cache.set(ck,result,1800);return result;
  }catch{return null;}
}

function calcPrice(tcg,ebay,variant,eurRate){
  const vk=variant==='N'?'normal':variant==='R'?'reverseHolofoil':'holofoil';
  let tE=null,tC=0;
  if(tcg&&tcg[vk]){const t=tcg[vk];const u=t.market||t.mid||((t.low+t.high)/2);if(u>0){tE=u*eurRate*1.18;tC=t.market?90:70;}}
  let eE=null,eC=0;
  if(ebay){eE=ebay.median;eC=Math.min(85,40+ebay.count*3);}
  let final=null,conf=0,sources=[];
  if(tE&&eE){final=(tE*tC+eE*eC)/(tC+eC);conf=Math.round((tC+eC)/2);sources=['TCGPlayer','eBay'];}
  else if(tE){final=tE;conf=tC;sources=['TCGPlayer'];}
  else if(eE){final=eE;conf=eC;sources=['eBay'];}
  if(!final)return null;
  const r=final<1?Math.round(final*100)/100:final<10?Math.round(final*10)/10:Math.round(final);
  const t=tcg?.[vk];const trend=t?.market&&t?.mid?(t.market>t.mid*1.05?'up':t.market<t.mid*0.95?'down':'stable'):null;
  return{price:r,currency:'EUR',confidence:conf,sources,breakdown:{tcgplayer:tE?Math.round(tE*100)/100:null,ebay:eE?Math.round(eE*100)/100:null},trend};
}

app.get('/price/:id',async(req,res)=>{
  const{id}=req.params;const{variant='N',cardName='',setName=''}=req.query;
  const ck='price_'+id+'_'+variant;const c=cache.get(ck);if(c)return res.json(c);
  try{
    const[tcg,ebay,eur]=await Promise.all([getTcg(id,cardName),getEbay(cardName,setName,variant),getEurRate()]);
    const result=calcPrice(tcg,ebay,variant,eur);
    if(!result)return res.status(404).json({error:'Prix non disponible'});
    cache.set(ck,result,1800);res.json(result);
  }catch(e){res.status(500).json({error:'Erreur serveur'});}
});

app.post('/prices',async(req,res)=>{
  const{cards}=req.body;
  if(!Array.isArray(cards)||!cards.length)return res.status(400).json({error:'Tableau requis'});
  const eur=await getEurRate();const results={};
  await Promise.allSettled(cards.slice(0,20).map(async({cardId,variant='N',cardName='',setName=''})=>{
    const ck='price_'+cardId+'_'+variant;const c=cache.get(ck);
    if(c){results[cardId+'_'+variant]=c;return;}
    const[tcg,ebay]=await Promise.all([getTcg(cardId,cardName),getEbay(cardName,setName,variant)]);
    const r=calcPrice(tcg,ebay,variant,eur);
    if(r){results[cardId+'_'+variant]=r;cache.set(ck,r,1800);}
  }));
  res.json(results);
});

app.get('/health',(req,res)=>{
  res.json({status:'ok',ebay:!!EBAY_ID,tcg:!!TCG_KEY,supabase:useSB,cacheSize:cache.keys().length});
});

app.listen(PORT,()=>{
  console.log('\n🎴 Pokédex Binks — http://localhost:'+PORT);
  console.log('   eBay: '+(EBAY_ID?'✅':'⚠️'));
  console.log('   TCG:  '+(TCG_KEY?'✅':'⚠️'));
  console.log('   SB:   '+(useSB?'✅':'⚠️ mode local')+'\n');
});
