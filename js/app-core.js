/* ============ DATA ============ */
const USERS = [
  { username:'advokat',  password:'123456', name:'JUDr. Martin Novák' },
  { username:'advokat2', password:'123456', name:'JUDr. Jana Dvořáková' },
  { username:'advokat3', password:'123456', name:'JUDr. Petr Svoboda' },
  { username:'advokat4', password:'123456', name:'JUDr. Eva Procházková' },
  { username:'advokat5', password:'123456', name:'Mgr. Tomáš Veselý' }
];
const STORAGE_KEY = 'nonstopAdvokat_v1';
const DATA_VERSION = 13;                          // při změně struktury dat zvyš + přidej migraci
// Hlavní model + záložní řetězec. Při přetížení („high demand") se appka přepne na další.
const GEMINI_MODELS = ['gemini-3.5-flash','gemini-2.5-flash','gemini-2.0-flash','gemini-1.5-flash'];
let geminiModelIdx = 0;
function activeGeminiModel(){ return GEMINI_MODELS[geminiModelIdx]; }
const _sleep = ms => new Promise(res=>setTimeout(res,ms));
const GEMINI_KEY_LS = 'na_gemini_key';          // klíč jen v localStorage, NIKDY v HTML
let appData = { cases: [], clients: [], settings: { salutation:'doktor', salutationCustom:'' }, version: DATA_VERSION };
let extractedData = null;                        // dočasná data z poslední OCR
let lastCaseExtractRecap = null;               // souhrn po nahrání do případu
let tlFilterChip = 'all';
let tlSearchQ = '';
let currentUser = null;
let currentPage = 'dashboard';
let currentClientId = null;
let currentClientTab = 'cprehled';

function esc(s){ if(s==null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function uid(){ return 'c'+Date.now()+Math.random().toString(36).slice(2,7); }

// Migrace dat: každá změna struktury = nová položka + zvýšení DATA_VERSION.
// Před první migrací se uloží záloha staré verze (STORAGE_KEY + '_backup_vN').
const migrations = {
  // 1 → 2: zajisti, že každý případ má pole documents/analyses/timeline a obvineni je pole
  1: function(d){
    d.cases = d.cases || [];
    d.cases.forEach(function(c){
      c.documents = c.documents || [];
      c.analyses  = c.analyses  || [];
      c.timeline  = c.timeline  || [];
      if(!Array.isArray(c.obvineni)) c.obvineni = c.obvineni ? [c.obvineni] : [];
    });
    d.version = 2;
    return d;
  }
  // 2 → 3: nová pole pro lhůtoměr (data doručení + ruční lhůty)
  ,2: function(d){
    d.cases = d.cases || [];
    d.cases.forEach(function(c){
      if(c.judgmentDeliveryDate===undefined) c.judgmentDeliveryDate='';
      if(c.orderDeliveryDate===undefined)    c.orderDeliveryDate='';
      if(c.rulingNoticeDate===undefined)      c.rulingNoticeDate='';
      if(!Array.isArray(c.manualDeadlines))   c.manualDeadlines=[];
    });
    d.version = 3;
    return d;
  }
  // 3 → 4: klient jako samostatný záznam; případy se propojí přes clientId
  ,3: function(d){
    d.cases = d.cases || [];
    d.clients = d.clients || [];
    const byKey = {};
    d.clients.forEach(function(cl){ if(cl.key) byKey[cl.key]=cl; });
    d.cases.forEach(function(c){
      const key = (c.rodneCislo && c.rodneCislo.trim()) || normEv(c.clientName||'');
      if(!key) return;
      let cl = byKey[key];
      if(!cl){
        cl = { id: uid(), key: key, name: c.clientName||'Nejmenovaný',
          birthDate: c.birthDate||'', rodneCislo: c.rodneCislo||'', idNumber: c.idNumber||'',
          phone:'', email:'', address: c.address||'', datovaSchranka: c.datovaSchranka||'',
          label:'aktivni', notes:'', createdAt: Date.now() };
        d.clients.push(cl); byKey[key]=cl;
      } else {
        ['birthDate','rodneCislo','idNumber','address','datovaSchranka'].forEach(function(f){ if(!cl[f] && c[f]) cl[f]=c[f]; });
        if((!cl.name || cl.name==='Nejmenovaný') && c.clientName) cl.name=c.clientName;
      }
      c.clientId = cl.id;
    });
    d.version = 4;
    return d;
  }
  // 4 → 5: finance na klientovi (honorář, platby, náklady)
  ,4: function(d){
    d.clients = d.clients || [];
    d.clients.forEach(function(cl){
      if(!cl.finance) cl.finance = { agreed:0, hourlyRate:0, payments:[], expenses:[] };
    });
    d.version = 5;
    return d;
  }
  // 5 → 6: konzultace (čas advokát + klient)
  ,5: function(d){
    d.clients = d.clients || [];
    d.clients.forEach(function(cl){ if(!Array.isArray(cl.consultations)) cl.consultations=[]; });
    d.version = 6;
    return d;
  }
  // 6 → 7: poznámky na klientovi
  ,6: function(d){
    d.clients = d.clients || [];
    d.clients.forEach(function(cl){ if(!Array.isArray(cl.clientNotes)) cl.clientNotes=[]; });
    d.version = 7;
    return d;
  }
  // 7 → 8: checklist před soudem + poznámka na případu
  ,7: function(d){
    d.cases = d.cases || [];
    d.cases.forEach(function(c){
      if(!Array.isArray(c.checklist)) c.checklist = defaultChecklist();
      if(typeof c.checklistNote !== 'string') c.checklistNote = '';
    });
    d.version = 8;
    return d;
  }
  // 8 → 9: nastavení aplikace (oslovení)
  ,8: function(d){
    if(!d.settings || typeof d.settings!=='object') d.settings={};
    if(!d.settings.salutation) d.settings.salutation='doktor';
    if(typeof d.settings.salutationCustom!=='string') d.settings.salutationCustom='';
    d.version = 9;
    return d;
  }
  // 9 → 10: soudní jednání na případu
  ,9: function(d){
    d.cases = d.cases || [];
    d.cases.forEach(function(c){ if(!Array.isArray(c.hearings)) c.hearings=[]; });
    d.version = 10;
    return d;
  }
  // 10 → 11: vazba (info) + zajištění majetku
  ,10: function(d){
    d.cases = d.cases || [];
    d.cases.forEach(function(c){
      if(!c.custody || typeof c.custody!=='object') c.custody={inCustody:false,fromDate:'',fromTime:'',reason:'',note:''};
      if(!Array.isArray(c.seizures)) c.seizures=[];
    });
    d.version = 11;
    return d;
  }
  // 11 → 12: zúčastněné osoby + výslechy
  ,11: function(d){
    d.cases = d.cases || [];
    d.cases.forEach(function(c){
      if(!Array.isArray(c.persons)) c.persons=[];
      if(!Array.isArray(c.interrogations)) c.interrogations=[];
    });
    d.version = 12;
    return d;
  }
  // 12 → 13: schůzky s klienty (pro přehled — ne časová osa ze spisu)
  ,12: function(d){
    d.cases = d.cases || [];
    d.cases.forEach(function(c){ if(!Array.isArray(c.meetings)) c.meetings=[]; });
    d.version = 13;
    return d;
  }
};

function loadData(){
  const s = localStorage.getItem(STORAGE_KEY);
  if(s){
    try{
      let d = JSON.parse(s);
      if(typeof d.version !== 'number') d.version = 1;   // starší data bez verze
      while(d.version < DATA_VERSION){
        const m = migrations[d.version];
        if(!m){ console.warn('Chybí migrace z verze '+d.version); break; }
        try{ localStorage.setItem(STORAGE_KEY+'_backup_v'+d.version, JSON.stringify(d)); }catch(e){}
        d = m(d);
      }
      appData = d;
    }catch(e){ appData = { cases: [], version: DATA_VERSION }; }
  }
  if(!appData.cases) appData.cases = [];
  if(!appData.clients) appData.clients = [];
  if(!appData.settings) appData.settings = { salutation:'doktor', salutationCustom:'' };
  if(typeof appData.version !== 'number') appData.version = DATA_VERSION;
  trashPurge();
}
function saveData(){ appData.version = DATA_VERSION; localStorage.setItem(STORAGE_KEY, JSON.stringify(appData)); }

/* ============ IndexedDB — úložiště velkých souborů (skeny, PDF) ============
   localStorage drží jen metadata + text (max ~5 MB). Samotné PDF/skeny
   (i 100+ stran) jdou sem — IndexedDB unese stovky MB. */
const IDB_NAME='advokat-files', IDB_STORE='files';
let _idbPromise=null;
function idb(){
  if(_idbPromise) return _idbPromise;
  _idbPromise=new Promise((resolve,reject)=>{
    const req=indexedDB.open(IDB_NAME,1);
    req.onupgradeneeded=()=>{ const db=req.result; if(!db.objectStoreNames.contains(IDB_STORE)){ const os=db.createObjectStore(IDB_STORE,{keyPath:'id'}); os.createIndex('caseId','caseId',{unique:false}); } };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  return _idbPromise;
}
async function idbPut(rec){ const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,'readwrite'); tx.objectStore(IDB_STORE).put(rec); tx.oncomplete=()=>res(rec.id); tx.onerror=()=>rej(tx.error); }); }
async function idbGet(id){ const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,'readonly'); const r=tx.objectStore(IDB_STORE).get(id); r.onsuccess=()=>res(r.result||null); r.onerror=()=>rej(r.error); }); }
async function idbDelete(id){ const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,'readwrite'); tx.objectStore(IDB_STORE).delete(id); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function idbGetAll(){ const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,'readonly'); const r=tx.objectStore(IDB_STORE).getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }
async function idbUsage(){ // přibližný součet velikostí (z metadat v localStorage)
  let total=0; liveCases().forEach(c=>(c.documents||[]).forEach(d=>{ if(d.fileSize) total+=d.fileSize; })); return total; }
// Smaže originál souboru z IndexedDB (text v případu zůstane)
async function deleteCaseDoc(caseId, docIndex){
  const c=appData.cases.find(x=>x.id===caseId); if(!c||!c.documents||!c.documents[docIndex]) return;
  const d=c.documents[docIndex];
  if(!confirm('Smazat originál „'+(d.name||'soubor')+'"?\n\nVytažený text a osa zůstanou v případu — smaže se jen naskenované PDF z úložiště.')) return;
  if(d.fileId){ try{ await idbDelete(d.fileId); }catch(e){} }
  // ponech metadata, jen odeber vazbu na soubor
  delete d.fileId; delete d.fileSize;
  saveData();
  openCaseDetail(caseId); setTimeout(()=>switchDetailTab('dokumenty'),60);
  toast('Originál smazán — text zůstal.');
}
// Otevře uložené PDF v nové záložce
async function openStoredFile(fileId){
  const rec=await idbGet(fileId);
  if(!rec||!rec.blob){ toast('Soubor nenalezen v úložišti.'); return; }
  const url=URL.createObjectURL(rec.blob);
  window.open(url,'_blank');
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}

// ===== Měkké mazání / koš =====
const TRASH_MS = 96*3600*1000; // 96 hodin
function liveCases(){ return appData.cases.filter(c=>!c.deletedAt); }
function trashPurge(){
  const cut=Date.now()-TRASH_MS; let changed=false;
  const before=appData.cases.length;
  appData.cases = appData.cases.filter(c=>!(c.deletedAt && c.deletedAt<cut));
  if(appData.cases.length!==before) changed=true;
  appData.cases.forEach(c=>{
    if(Array.isArray(c.timeline)){ const b=c.timeline.length; c.timeline=c.timeline.filter(t=>!(t.deletedAt && t.deletedAt<cut)); if(c.timeline.length!==b) changed=true; }
    if(Array.isArray(c.documents)){ const b=c.documents.length; c.documents=c.documents.filter(d=>!(d.deletedAt && d.deletedAt<cut)); if(c.documents.length!==b) changed=true; }
  });
  if(changed) saveData();
}

/* ============ LHŮTY ENGINE (§ 60 tr. ř.) ============ */
// Velikonoční neděle (Meeusův/anonymní gregoriánský algoritmus)
function easterSunday(y){
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,
        f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),
        h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,
        l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
        mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;
  return new Date(y,mo-1,da);
}
const _holCache={};
function czHolidays(y){           // Set 'M-D' státních svátků a dnů pracovního klidu (zák. 245/2000 Sb.)
  if(_holCache[y]) return _holCache[y];
  const set=new Set(['1-1','5-1','5-8','7-5','7-6','9-28','10-28','11-17','12-24','12-25','12-26']);
  const es=easterSunday(y);
  const gf=new Date(es); gf.setDate(es.getDate()-2); // Velký pátek
  const em=new Date(es); em.setDate(es.getDate()+1); // Velikonoční pondělí
  set.add((gf.getMonth()+1)+'-'+gf.getDate());
  set.add((em.getMonth()+1)+'-'+em.getDate());
  _holCache[y]=set; return set;
}
function isWorkday(dt){
  const dow=dt.getDay(); if(dow===0||dow===6) return false;           // ne/so
  return !czHolidays(dt.getFullYear()).has((dt.getMonth()+1)+'-'+dt.getDate());
}
function nextWorkday(dt){ const d=new Date(dt.getFullYear(),dt.getMonth(),dt.getDate()); while(!isWorkday(d)) d.setDate(d.getDate()+1); return d; }

// Lhůta ve dnech: den události se nepočítá (§ 60/1) → +N dní, pak posun konce (§ 60/3)
function deadlineDays(start, days){
  const s=parseCzDate(start); if(!s) return null;
  const raw=new Date(s.getFullYear(),s.getMonth(),s.getDate()); raw.setDate(raw.getDate()+days);
  const shifted=nextWorkday(raw);
  return { raw, deadline:shifted, shifted: shifted.getTime()!==raw.getTime() };
}
// Lhůta v měsících: končí dnem stejného označení (§ 60/2); kratší měsíc → poslední den; pak posun (§ 60/3)
function deadlineMonths(start, months){
  const s=parseCzDate(start); if(!s) return null;
  const day=s.getDate();
  const raw=new Date(s.getFullYear(), s.getMonth()+months, 1);
  const dim=new Date(raw.getFullYear(), raw.getMonth()+1, 0).getDate();
  raw.setDate(Math.min(day, dim));
  const shifted=nextWorkday(raw);
  return { raw, deadline:shifted, shifted: shifted.getTime()!==raw.getTime() };
}

function calculateDeadlines(c){
  if(!c) return [];
  const now=new Date(); const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const dd=a=>Math.round((new Date(a.getFullYear(),a.getMonth(),a.getDate())-today)/86400000);
  const out=[];
  const add=(type,label,short,res,extra)=>{ if(!res) return;
    out.push(Object.assign({type,label,short,deadline:res.deadline,raw:res.raw,shifted:res.shifted,daysLeft:dd(res.deadline),caseId:c.id,caseName:c.clientName},extra||{}));
  };
  // Rozsudek → odvolání 8 dní, dovolání 2 měsíce (od DORUČENÍ opisu; fallback na vyhlášení s varováním)
  const judgStart = c.judgmentDeliveryDate || c.judgmentDate;
  const fromVyhl  = !c.judgmentDeliveryDate && !!c.judgmentDate;
  if(judgStart){
    add('odvolani','Odvolání','Odvolání · 8 dní od doručení opisu rozsudku (§ 248)', deadlineDays(judgStart,8), {fromVyhlaseni:fromVyhl});
    add('dovolani','Dovolání','Dovolání · 2 měsíce od doručení rozhodnutí (§ 265e)', deadlineMonths(judgStart,2), {fromVyhlaseni:fromVyhl});
  }
  if(c.orderDeliveryDate)  add('odpor','Odpor proti tr. příkazu','Odpor · 8 dní od doručení trestního příkazu (§ 314g)', deadlineDays(c.orderDeliveryDate,8));
  if(c.rulingNoticeDate)   add('stiznost','Stížnost','Stížnost · 3 dny od oznámení usnesení (§ 143)', deadlineDays(c.rulingNoticeDate,3));
  if(c.custodyDate)        add('vazba','Přezkum vazby','Připomínka přezkumu vazby (§ 72) · ověř konkrétní lhůtu dle důvodu', deadlineMonths(c.custodyDate,2));
  // Ruční lhůty — zadané datum je přímo poslední den; engine neposouvá
  (c.manualDeadlines||[]).forEach(md=>{
    if(!md || !md.date) return;
    const s=parseCzDate(md.date); if(!s) return;
    const raw=new Date(s.getFullYear(),s.getMonth(),s.getDate());
    out.push({type:'manual',label:md.label||'Vlastní lhůta',short:md.note||'Zadáno ručně',deadline:raw,raw:raw,shifted:false,daysLeft:dd(raw),caseId:c.id,caseName:c.clientName,manual:true,mid:md.id});
  });
  return out;
}
function getAllDeadlines(){
  let all=[]; liveCases().forEach(c=>{ all=all.concat(calculateDeadlines(c)); });
  return all.sort((a,b)=>a.daysLeft-b.daysLeft);
}

/* ============ MODULY / OPRÁVNĚNÍ ============ */
const NA_MODULE_PAGES = {
  dashboard: 'dashboard',
  cases: 'cases',
  clients: 'clients',
  deadlines: 'deadlines',
  documents: 'documents',
  ai: 'analysis',
  zakony: 'zakony'
};

function hasModule(mod){
  if(!currentUser) return false;
  if(currentUser.role==='admin') return true;
  const mods=currentUser.modules||window.NA_RUNTIME&&window.NA_RUNTIME.modules;
  if(!mods) return true;
  return mods.indexOf(mod)>=0;
}

function applyUserModules(modules){
  if(!modules && currentUser){
    if(currentUser.role==='admin') modules=null;
    else modules=currentUser.modules||(window.NA_RUNTIME&&window.NA_RUNTIME.modules);
  }
  const pageToMod={};
  Object.keys(NA_MODULE_PAGES).forEach(k=>{ pageToMod[NA_MODULE_PAGES[k]]=k; });
  document.querySelectorAll('.snav-item[data-page]').forEach(el=>{
    const page=el.dataset.page;
    const mod=pageToMod[page];
    if(!mod){ el.style.display=''; return; }
    if(!modules || modules.indexOf(mod)>=0) el.style.display='';
    else el.style.display='none';
  });
  document.querySelectorAll('#topNav a[data-page]').forEach(el=>{
    const page=el.dataset.page;
    const mod=pageToMod[page];
    if(!mod){ el.style.display=''; return; }
    if(!modules || modules.indexOf(mod)>=0) el.style.display='';
    else el.style.display='none';
  });
  if(currentPage && pageToMod[currentPage] && modules && modules.indexOf(pageToMod[currentPage])<0){
    const fallback=modules.indexOf('dashboard')>=0?'dashboard':(NA_MODULE_PAGES[modules[0]]||'dashboard');
    showPage(fallback);
  }
}

/* ============ LOGIN ============ */
function handleLogin(){
  const u=document.getElementById('loginUsername').value.trim();
  const p=document.getElementById('loginPassword').value.trim();
  const err=document.getElementById('loginError');
  const found=USERS.find(x=>x.username===u && x.password===p);
  if(!found){ err.textContent='Nesprávné jméno nebo heslo.'; return; }
  currentUser=found; err.textContent='';
  currentUser.modules=['dashboard','cases','clients','deadlines','documents','ai','zakony','scanner'];
  const initials=found.name.split(' ').slice(-2).map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('avatar').textContent=initials;
  const sun=document.getElementById('sidebarUserName'); if(sun) sun.textContent=found.name.replace(/^JUDr\.?\s*/,'');
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appWrap').classList.remove('app-hidden');
  document.getElementById('vzhledWrap').style.display='';
  applyUserModules(currentUser.modules);
  renderAll();
  renderSubrail('dashboard');
  maybeShowConfidentialityGate();
}
function handleLogout(){
  currentUser=null;
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('appWrap').classList.add('app-hidden');
  document.getElementById('vzhledWrap').style.display='none';
}
/* ====== Zámek na mlčenlivost (jednorázový souhlas) ====== */
const CONFIDENTIAL_LS='na_confidential_ack';
function maybeShowConfidentialityGate(){
  if(localStorage.getItem(CONFIDENTIAL_LS)){ maybeShowOnboarding(); return; } // už potvrzeno → případně průvodce
  const m=document.getElementById('confidentialModal');
  if(m){ m.style.display='flex'; const cb=document.getElementById('confCheck'); if(cb) cb.checked=false; const b=document.getElementById('confAccept'); if(b) b.disabled=true; }
}
function confCheckChanged(){ const b=document.getElementById('confAccept'); if(b) b.disabled=!document.getElementById('confCheck').checked; }
function acceptConfidentiality(){
  if(!document.getElementById('confCheck').checked) return;
  localStorage.setItem(CONFIDENTIAL_LS, new Date().toISOString());
  document.getElementById('confidentialModal').style.display='none';
  toast('Děkujeme — pravidlo mlčenlivosti potvrzeno.');
  maybeShowOnboarding();
}

/* ====== ONBOARDING — průvodce prvním spuštěním (3 kroky) ====== */
const ONBOARD_LS='na_onboarded';
let obStep=1;
function maybeShowOnboarding(){ if(localStorage.getItem(ONBOARD_LS)) return; startOnboarding(); }
function startOnboarding(){
  obStep=1; renderObStep();
  const m=document.getElementById('onboardModal'); if(m) m.style.display='flex';
  updateObKeyStat();
}
function renderObStep(){
  [1,2,3].forEach(n=>{ const s=document.getElementById('obStep'+n); if(s) s.style.display=(n===obStep?'block':'none'); });
  document.querySelectorAll('.ob-dot').forEach((d,i)=>d.classList.toggle('on', i<obStep));
  const back=document.getElementById('obBack'); if(back) back.style.visibility=obStep>1?'visible':'hidden';
  const next=document.getElementById('obNext'); if(next) next.textContent = obStep<3 ? 'Pokračovat →' : 'Začít pracovat';
}
function obNext(){ if(obStep<3){ obStep++; renderObStep(); } else finishOnboarding(); }
function obPrev(){ if(obStep>1){ obStep--; renderObStep(); } }
function finishOnboarding(){ localStorage.setItem(ONBOARD_LS, new Date().toISOString()); const m=document.getElementById('onboardModal'); if(m) m.style.display='none'; }
function obSaveKey(){
  const inp=document.getElementById('obKeyInput'); const v=(inp&&inp.value||'').trim();
  if(!v){ toast('Vlož klíč do pole.'); return; }
  localStorage.setItem(GEMINI_KEY_LS, v); if(inp) inp.value='';
  if(typeof updateKeyPill==='function') updateKeyPill();
  updateObKeyStat(); toast('Gemini klíč uložen');
}
function updateObKeyStat(){
  const el=document.getElementById('obKeyStat'); if(!el) return;
  const k=getGeminiKey();
  el.innerHTML = k
    ? '<span style="color:var(--green)">✓ Klíč je uložený ('+esc(k.slice(0,4))+'…'+esc(k.slice(-3))+') — máš hotovo, pokračuj.</span>'
    : '<span style="color:var(--dim)">Klíč zatím nemáš — můžeš ho doplnit i později na stránce Dokumenty.</span>';
}
function obNewCase(){ finishOnboarding(); if(typeof openNewCase==='function') openNewCase(); }
function togglePin(){ const a=document.getElementById('pinArea'); a.style.display = a.style.display==='none'?'block':'none'; }
function handlePinLogin(){ const v=document.getElementById('pinInput').value; const saved=localStorage.getItem('na_pin'); if(saved && v===saved){ currentUser=USERS[0]; document.getElementById('loginScreen').classList.add('hidden'); document.getElementById('appWrap').classList.remove('app-hidden'); renderAll(); maybeShowConfidentialityGate(); } else { document.getElementById('loginError').textContent='Nesprávný PIN.'; } }

/* ============ NAVIGACE ============ */
function resetAppScroll(){
  const mc = document.querySelector('.main-content');
  if(mc) mc.scrollTop = 0;
  const main = document.querySelector('.main');
  if(main) main.scrollTop = 0;
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}
function showPage(id){
  closeMobileSidebar();
  currentPage=id;
  ['dashboard','cases','clients','clientdetail','deadlines','documents','analysis','detail','settings','zakony'].forEach(p=>{
    const el=document.getElementById('page-'+p); if(el) el.style.display = (p===id)?'block':'none';
  });
  resetAppScroll();
  document.querySelectorAll('#topNav a').forEach(a=>a.classList.toggle('on', a.dataset.page===id));
  document.querySelectorAll('#sidebarNav .snav-item').forEach(a=>{ var p=a.dataset.page; a.classList.toggle('on', p===id || (id==='detail'&&p==='cases') || (id==='clientdetail'&&p==='clients')); });
  document.querySelectorAll('.dock .di').forEach(d=>d.classList.toggle('on', d.dataset.page===id));
  const titles={dashboard:'Přehled',cases:'Případy',clients:'Klienti',clientdetail:'Klient',deadlines:'Lhůty',documents:'Dokumenty',analysis:'Analýzy',detail:'Detail případu',settings:'Nastavení',zakony:'Zákony'};
  const tb=document.getElementById('topbarTitle'); if(tb) tb.textContent=titles[id]||'Advokato';
  if(id!=='dashboard' && id!=='detail') renderSubPage(id);
  renderSubrail(id);
}
/* [label, targetPage, iconKey] — iconKey = klíč do dicon() */
const SUBMENUS={
  dashboard:[['Souhrn','','prehled'],['Moje lhůty','deadlines','lhuty'],['Dnešní jednání','','jednani'],['Nedávné případy','cases','pripady'],['Klienti','clients','osoby']],
  cases:[['Aktivní případy','','pripady'],['Archiv','','sablony'],['Koš','','zajisteni']],
  clients:[['Seznam klientů','','osoby']],
  deadlines:[['Všechny lhůty','','lhuty'],['Kritické','','vazba'],['Časová osa','','osa']],
  documents:[['Všechny dokumenty','','dokumenty']],
  analysis:[['Katalog analýz','','analyzy']],
  zakony:[['Trestní zákon','','sablony'],['Trestní řád','','sablony'],['Další předpisy','','dokumenty']],
  settings:[['Vzhled','','edit'],['Účet','','osoby'],['Zálohy','','zajisteni']]
};
/* Záložky detailu případu — v subrailu (nahrazují starou béžovou .dtabs) */
const DETAIL_TABS=[['prehled','Přehled'],['dokumenty','Dokumenty'],['analyzy','Analýzy'],['chat','Chat nad spisem'],['lhuty','Lhůty'],['osa','Časová osa'],['jednani','Jednání'],['vazba','Vazba'],['zajisteni','Zajištění'],['osoby','Osoby'],['vyslechy','Výslechy'],['sablony','Šablony'],['checklist','Checklist']];
function renderSubrail(page){
  const el=document.getElementById('subrailNav'); const app=document.getElementById('appWrap'); if(!el||!app) return;
  const titles={dashboard:'Přehled',cases:'Případy',clients:'Klienti',deadlines:'Lhůty',documents:'Dokumenty',analysis:'Analýzy',zakony:'Zákony',settings:'Nastavení',detail:'Případ',clientdetail:'Klient'};
  app.classList.remove('subrail-hidden');
  if(page==='detail'||page==='clientdetail'){
    // Lex Corvus: žádný svislý subrail — navigace tabů je vodorovná řada pills v detailu (.dtabs)
    el.innerHTML=''; app.classList.add('subrail-hidden'); return;
  }
  const list=SUBMENUS[page];
  if(!list){ el.innerHTML=''; app.classList.add('subrail-hidden'); return; }
  el.innerHTML='<div class="subrail-lbl">'+esc(titles[page]||'')+'</div>'+list.map(function(it,i){
    return '<div class="sr-item'+(i===0?' on':'')+'" onclick="subGo(this,\''+(it[1]||'')+'\')">'+dicon(it[2]||'prehled')+'<span class="srt">'+esc(it[0])+'</span></div>';
  }).join('');
}
function subGo(elm,target){ const p=elm.parentNode; p.querySelectorAll('.sr-item').forEach(function(x){x.classList.remove('on');}); elm.classList.add('on'); if(target) showPage(target); }
function subDetailGo(elm,tab){ const p=elm.parentNode; p.querySelectorAll('.sr-item').forEach(function(x){x.classList.remove('on');}); elm.classList.add('on'); if(typeof switchDetailTab==='function') switchDetailTab(tab); }
function toggleSubrail(){ const app=document.getElementById('appWrap'); if(app) app.classList.toggle('subrail-collapsed'); }
const SIDEBAR_COLLAPSED_LS='na_sidebar_collapsed';
function isMobileSidebar(){ return window.innerWidth<=900; }
function toggleSidebarCollapse(){
  if(isMobileSidebar()) return;
  const app=document.getElementById('appWrap');
  const collapsed=app.classList.toggle('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_COLLAPSED_LS,collapsed?'1':'');
  const btn=document.getElementById('sidebarCollapseBtn');
  if(btn){ btn.title=collapsed?'Rozbalit menu':'Sbalit menu';
    const t=btn.querySelector('.sidebar-collapse-txt'); if(t) t.textContent=collapsed?'Rozbalit menu':'Sbalit menu'; }
}
function initSidebarCollapse(){
  if(isMobileSidebar()) return;
  const app=document.getElementById('appWrap');
  const collapsed=localStorage.getItem(SIDEBAR_COLLAPSED_LS)==='1';
  app.classList.toggle('sidebar-collapsed',collapsed);
  const btn=document.getElementById('sidebarCollapseBtn');
  if(btn){ btn.title=collapsed?'Rozbalit menu':'Sbalit menu';
    const t=btn.querySelector('.sidebar-collapse-txt'); if(t) t.textContent=collapsed?'Rozbalit menu':'Sbalit menu'; }
}
function setMobileSidebarOpen(open){
  const app=document.getElementById('appWrap');
  if(!app) return;
  const on=!!open;
  app.classList.toggle('sidebar-open', on);
  document.body.classList.toggle('sidebar-menu-open', on);
  document.documentElement.classList.toggle('sidebar-menu-open', on);
  const bd=document.getElementById('sidebarBackdrop');
  if(bd){ bd.setAttribute('aria-hidden', on?'false':'true'); }
  const tg=document.querySelector('.sidebar-toggle');
  if(tg){
    tg.setAttribute('aria-expanded', on?'true':'false');
    tg.setAttribute('aria-label', on?'Zavřít menu':'Otevřít menu');
  }
  if(on){
    document.body.classList.remove('vzhled-open');
    const vw=document.getElementById('vzhledWrap');
    if(vw) vw.classList.remove('open');
  }
}
function closeMobileSidebar(){
  if(!isMobileSidebar()) return;
  setMobileSidebarOpen(false);
}
function toggleSidebar(){
  if(isMobileSidebar()){
    const app=document.getElementById('appWrap');
    setMobileSidebarOpen(!app.classList.contains('sidebar-open'));
  } else toggleSidebarCollapse();
}
function initMobileSidebarBackdrop(){
  const bd=document.getElementById('sidebarBackdrop');
  if(!bd) return;
  const close=(e)=>{
    if(e.target!==bd) return;
    e.preventDefault();
    closeMobileSidebar();
  };
  bd.addEventListener('click', close);
  bd.addEventListener('touchend', close, {passive:false});
  const sb=document.getElementById('sidebar');
  if(sb){
    sb.addEventListener('click', e=>e.stopPropagation());
    sb.addEventListener('touchend', e=>e.stopPropagation(), {passive:true});
  }
}
window.addEventListener('keydown',(e)=>{
  if(e.key==='Escape') closeMobileSidebar();
});
window.addEventListener('resize',()=>{
  if(isMobileSidebar()) document.getElementById('appWrap').classList.remove('sidebar-collapsed');
  else initSidebarCollapse();
});
function nav(id,el){
  // Případy/Klienti → rovnou workspace (seznam vlevo + detail vpravo), ne staré složky
  if(id==='cases'){ var fc=(typeof liveCases==='function'?liveCases():appData.cases)[0]; if(fc){ openCaseDetail(fc.id); closeMobileSidebar(); return; } }
  if(id==='clients'){ var fcl=(appData.clients||[])[0]; if(fcl){ openClientDetail(fcl.id); closeMobileSidebar(); return; } }
  showPage(id); closeMobileSidebar();
}
function navDock(id,el){ showPage(id); closeMobileSidebar(); }

/* ============ RENDER ============ */
function renderAll(){
  const now=new Date();
  const greetH = now.getHours();
  const greetWord = greetH<10?'Dobré ráno':(greetH<18?'Dobrý den':'Dobrý večer');
  document.getElementById('greetTitle').textContent = greetWord+', '+buildSalutation();
  const all=getAllDeadlines();
  const running=all.filter(d=>d.daysLeft>=0).length;
  const dateStr = now.toLocaleDateString('cs-CZ',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  document.getElementById('greetSub').textContent = dateStr+' · '+running+' běžících lhůt · '+liveCases().length+' aktivních případů';
  // badge
  const crit=all.filter(d=>d.daysLeft>=0 && d.daysLeft<=3).length;
  const badge=document.getElementById('navDeadlineBadge'); badge.textContent=crit; badge.style.display=crit>0?'inline-block':'none';
  const sbBadge=document.getElementById('sidebarDeadlineBadge'); if(sbBadge){ sbBadge.textContent=crit; sbBadge.style.display=crit>0?'inline-flex':'none'; }
  // stat karty
  const nCases = liveCases().length;
  document.getElementById('statCases').textContent = nCases;
  document.getElementById('statCasesD').innerHTML = nCases ? (nCases===1?'aktivní případ':'aktivních případů') : '<span style="color:var(--dim)">žádné případy</span>';
  const nAI = liveCases().reduce((a,c)=>a+((c.analyses||[]).length),0);
  document.getElementById('statAnalyses').textContent = nAI||'—';
  document.getElementById('statAnalysesD').innerHTML = nAI ? (nAI===1?'uložená analýza':'uložených analýz') : '<span style="color:var(--dim)">zatím bez analýz</span>';
  const backupDays = appData.lastBackup ? Math.floor((Date.now()-appData.lastBackup)/86400000) : null;
  document.getElementById('statBackup').textContent = backupDays !== null ? backupDays : '—';
  document.getElementById('statBackupD').innerHTML = backupDays !== null
    ? (backupDays===0?'<span style="color:var(--green)">zálohováno dnes</span>'
      : backupDays<=7?'<span style="color:var(--am)">před '+backupDays+' '+dayWord(backupDays)+'</span>'
      : '<span style="color:var(--red)">před '+backupDays+' '+dayWord(backupDays)+' — zálohuj</span>')
    : '<span style="color:var(--dim)">zatím bez zálohy</span>';
  // 4. KPI karta — blížící se lhůty (reálná data)
  var nDL = all.filter(function(d){return d.daysLeft>=0;}).length;
  var elDL=document.getElementById('statDeadlines'); if(elDL) elDL.textContent=nDL;
  var elDLD=document.getElementById('statDeadlinesD'); if(elDLD) elDLD.innerHTML = crit>0 ? '<span style="color:var(--red)">'+crit+' kritických</span>' : (nDL?(nDL===1?'blížící se lhůta':'blížících se lhůt'):'<span style="color:var(--dim)">žádné lhůty</span>');
  renderHero(all);
  if(typeof renderHorizon==='function') renderHorizon();
  else renderMeter(all);
  renderCaseTable();
  renderDashDeadlines();
  renderDashActivity();
  if(currentPage==='cases') renderCasesFolders();
  else if(currentPage==='clients') renderClientsFolders();
}

function dayWord(n){ const a=Math.abs(n); if(a===1)return'den'; if(a>=2&&a<=4)return'dny'; return'dní'; }

// Prázdné stavy — ikona + nadpis + výzva (volitelně tlačítko). small=kompaktní pro panely.
const ES_ICONS={
  doc:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  timeline:'<circle cx="6" cy="7" r="2"/><circle cx="6" cy="17" r="2"/><path d="M6 9v6M10 7h9M10 17h6"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a5 5 0 0 0-4-5"/>',
  gavel:'<path d="M14 3l7 7M11 6l7 7M5 21l7-7M3 19l4-4M9 11l4 4"/>',
  money:'<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  note:'<path d="M5 3h14v18l-7-4-7 4z"/>',
  chat:'<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-5A8 8 0 1 1 21 12z"/>',
  box:'<path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
};
function emptyState(icon,title,sub,opts){
  opts=opts||{};
  return '<div class="empty-state'+(opts.small?' es-sm':'')+'">'+
    '<div class="es-ic"><svg viewBox="0 0 24 24">'+(ES_ICONS[icon]||ES_ICONS.doc)+'</svg></div>'+
    '<div class="es-t">'+esc(title)+'</div>'+
    (sub?'<div class="es-s">'+sub+'</div>':'')+
    (opts.cta?'<div class="es-cta"><button class="btn gold sm" onclick="'+opts.cta.fn+'">'+esc(opts.cta.label)+'</button></div>':'')+
    '</div>';
}

function renderHero(all){
  const t=document.getElementById('heroTile');
  const next = all.find(d=>d.daysLeft>=0) || all[0];
  if(!next){
    t.innerHTML = '<div class="tl">Nejbližší lhůta</div><div class="label" style="color:var(--muted)">Žádné aktivní lhůty</div><div class="case">Přidej rozsudek nebo vazbu k případu — lhůty se spočítají samy.</div><div class="bignum"><span class="n" style="font-size:3rem;color:var(--muted)">—</span></div>';
    return;
  }
  const d=next.daysLeft;
  const pct=Math.max(0,Math.min(1,d/14));
  const R=26,C=2*Math.PI*R, off=(C*(1-pct)).toFixed(0);
  const overdue=d<0;
  const ringPct=Math.round(pct*100);
  t.innerHTML =
    '<div class="ring"><svg width="64" height="64"><circle class="bgc" cx="32" cy="32" r="26"/><circle class="fgc" cx="32" cy="32" r="26" stroke-dasharray="'+C.toFixed(0)+'" stroke-dashoffset="'+off+'"/></svg><div class="txt">'+(overdue?'!':ringPct+' %')+'</div></div>'+
    '<div class="tl">Nejbližší lhůta</div>'+
    '<div class="label">'+esc(next.label)+'</div>'+
    '<div class="case">'+esc(next.caseName||'Případ')+' · <span class="fn">'+esc(getCaseSpis(next.caseId))+'</span></div>'+
    '<div class="bignum"><span class="n'+(overdue?' crit':(d<=3?' crit':d<=7?' warn':''))+'">'+(overdue?'PO':d)+'</span><span class="u">'+(overdue?'lhůtě':dayWord(d)+'<br>zbývají')+'</span></div>'+
    '<div class="end">Poslední den: <b>'+next.deadline.toLocaleDateString('cs-CZ',{weekday:'long',day:'numeric',month:'numeric',year:'numeric'})+'</b></div>'+
    '<div class="calcrow">Lhůta typu <span class="law">'+esc(next.short)+'</span>'+
      (next.shifted?' · <span style="color:var(--am2)">konec posunut z víkendu/svátku</span>':'')+
      (next.fromVyhlaseni?' · <span style="color:var(--red)">počítáno od vyhlášení — doplň datum doručení</span>':'')+
      ' · <i>Ověř dle spisu</i></div>';
}
function getCaseById(id){ return appData.cases.find(x=>x.id===id)||null; }
function getCaseSpis(id){ const c=appData.cases.find(x=>x.id===id); return c?(c.spisZnacka||'bez zn.'):''; }
function showCaseToast(id){ const c=appData.cases.find(x=>x.id===id); toast((c?c.clientName:'Případ')+' — detail napojíme v dalším kroku'); }

function renderMeter(all){
  const ax=document.getElementById('meterAxis');
  const horizon=60;
  const pts=all.filter(d=>d.daysLeft<=horizon).sort((a,b)=>a.daysLeft-b.daysLeft).slice(0,8);
  let rail='<div class="today"></div><div class="rail"></div>';
  [15,30,45,60].forEach(t=>{ const left=(t/horizon)*100; rail+='<div class="tick" style="left:'+(t===60?99:left)+'%">+'+t+' d</div>'; });
  if(!pts.length){
    ax.innerHTML='<div class="axis-rail is-empty">'+rail+'</div><div class="meter-empty">Žádné lhůty v příštích '+horizon+' dnech.</div>';
    return;
  }
  const clsOf=x=>x.daysLeft<=3?'crit':(x.daysLeft<=14?'warn':'ok');
  // pozice teček + minimální rozestup, ať se neslepí
  const lefts=pts.map(x=>Math.min(97,Math.max(2,(Math.max(0,x.daysLeft)/horizon)*100)));
  for(let i=1;i<lefts.length;i++){ if(lefts[i]<lefts[i-1]+4) lefts[i]=Math.min(98,lefts[i-1]+4); }
  pts.forEach((x,i)=>{ rail+='<div class="dlpt '+clsOf(x)+'" style="left:'+lefts[i]+'%" title="'+esc(x.caseName||'')+' — '+esc(x.label)+'"><span class="dlpt-n">'+(i+1)+'</span></div>'; });
  // čitelný seznam pod osou (nikdy se nepřekryje)
  let leg='<div class="meter-leg">';
  pts.forEach((x,i)=>{
    const dd=x.daysLeft<0?'propadlo':(x.daysLeft===0?'dnes':x.daysLeft+' d');
    leg+='<div class="leg-row" onclick="openCaseDetail(\''+x.caseId+'\')">'+
      '<span class="leg-n '+clsOf(x)+'">'+(i+1)+'</span>'+
      '<span class="leg-main"><b>'+esc(x.caseName||'—')+'</b> · '+esc(x.label)+'</span>'+
      '<span class="leg-dd '+clsOf(x)+'">'+dd+'</span></div>';
  });
  leg+='</div>';
  ax.innerHTML='<div class="axis-rail">'+rail+'</div>'+leg;
}

function phaseTag(status){
  const m={odvolani:['odvo','Odvolání'],hlavni:['soud','Hlavní líčení'],pripravne:['prip','Přípravné'],dovolani:['soud','Dovolací'],urgent:['odvo','Urgentní']};
  const k=(status||'').toLowerCase();
  let cls='prip',lbl=status||'Přípravné';
  if(k.includes('odvol')){cls='odvo';lbl='Odvolání';}
  else if(k.includes('líč')||k.includes('lic')||k.includes('soud')){cls='soud';lbl='Hlavní líčení';}
  else if(k.includes('dovol')){cls='soud';lbl='Dovolací';}
  else if(k.includes('přípr')||k.includes('pripr')){cls='prip';lbl='Přípravné';}
  return '<span class="st '+cls+'"><i></i>'+esc(lbl)+'</span>';
}

function renderCaseTable(){
  const tb=document.getElementById('caseTableBody');
  if(!liveCases().length){
    tb.innerHTML='<tr class="empty-row"><td colspan="5">Zatím žádné případy. Klikni na „+ Nový případ".</td></tr>';
    return;
  }
  var cases=liveCases().slice().sort(function(a,b){return caseRiskScore(b)-caseRiskScore(a);});
  tb.innerHTML = cases.slice(0,8).map(function(c){
    var isOb=(c.kategorie==='obchodni');
    var chip='<span class="lc-tag '+(isOb?'lc-tag-ob':'lc-tag-tr')+'" style="margin-right:8px">'+(isOb?'OBCHODNÍ':'TRESTNÍ')+'</span>';
    var badge;
    if(!caseHasContent(c)) badge='<span class="lc-risk lc-risk-empty">Doplň spis</span>';
    else { var sc=caseRiskScore(c), lv=caseRiskLevel(sc); badge='<span class="lc-risk '+lv.cls+'">Riziko '+lv.t+' · '+sc+'</span>'; }
    return '<tr onclick="openCaseDetail(\''+c.id+'\')">'+
    '<td class="fn2">'+chip+esc(c.spisZnacka||'—')+'</td>'+
    '<td class="cl"><b>'+esc(c.clientName||'Nejmenovaný')+'</b><span>'+esc(c.soud||c.court||'—')+'</span></td>'+
    '<td class="par">'+((c.obvineni&&c.obvineni.length)?'§ '+esc(c.obvineni[0]):esc(c.pravniKvalifikace||'—'))+'</td>'+
    '<td>'+phaseTag(c.faze||c.status)+'</td>'+
    '<td style="text-align:right">'+badge+'</td></tr>';
  }).join('');
}

/* Dashboard — navy panel „Blížící se lhůty" (reálná data napříč případy) */
function renderDashDeadlines(){
  var el=document.getElementById('dashLhutyPanel'); if(!el) return;
  var items=[];
  liveCases().forEach(function(c){ try{(calculateDeadlines(c)||[]).forEach(function(d){ if(d.daysLeft>=0) items.push({d:d,c:c}); });}catch(e){} });
  items.sort(function(a,b){return a.d.daysLeft-b.d.daysLeft;});
  items=items.slice(0,6);
  var rows = items.length ? items.map(function(x){
    var dl=x.d, c=x.c;
    var urg = dl.daysLeft<=3?{cls:'lc-risk-high',t:'Vysoké'}:(dl.daysLeft<=14?{cls:'lc-risk-mid',t:'Střední'}:{cls:'lc-risk-low',t:'Nízké'});
    var dd = dl.deadline||dl.raw; var day = dd?new Date(dd):null;
    var dnum = (day&&!isNaN(day))?(day.getDate()+'.'):'—';
    return '<div class="lc-dl-row" onclick="openCaseDetail(\''+c.id+'\')">'+
      '<div class="lc-dl-date">'+dnum+'</div>'+
      '<div class="lc-dl-main"><div class="lc-dl-label">'+esc(dl.label||dl.short||'Lhůta')+'</div><div class="lc-dl-case">'+esc(c.spisZnacka||c.clientName||'—')+'</div></div>'+
      '<span class="lc-risk '+urg.cls+'">'+urg.t+'</span></div>';
  }).join('') : '<div class="lc-dl-empty">Žádné blížící se lhůty.</div>';
  el.innerHTML = '<div class="lc-dl-head">Blížící se lhůty</div><div class="lc-dl-list">'+rows+'</div>';
}
/* Dashboard — „Poslední aktivita" (poslední dokumenty a analýzy) */
function renderDashActivity(){
  var el=document.getElementById('dashActivity'); if(!el) return;
  var acts=[];
  liveCases().forEach(function(c){
    (c.analyses||[]).forEach(function(a){ acts.push({when:a.when||0, txt:'AI analýza — '+(a.label||'analýza'), c:c, ic:'analyzy'}); });
    (c.documents||[]).filter(function(d){return d&&!d.deletedAt;}).forEach(function(d){ acts.push({when:d.when||0, txt:'Dokument — '+(d.name||'spis.pdf'), c:c, ic:'dokumenty'}); });
  });
  acts.sort(function(a,b){return b.when-a.when;});
  acts=acts.slice(0,5);
  var rel=function(ts){ if(!ts) return ''; var diff=Date.now()-ts,day=864e5; if(diff<36e5)return 'před '+Math.max(1,Math.round(diff/6e4))+' min'; if(diff<day)return 'před '+Math.round(diff/36e5)+' h'; if(diff<2*day)return 'včera'; if(diff<7*day)return 'před '+Math.round(diff/day)+' dny'; return new Date(ts).toLocaleDateString('cs-CZ'); };
  var rows=acts.length? acts.map(function(a){ return '<div class="lc-act-row" onclick="openCaseDetail(\''+a.c.id+'\')"><div class="lc-act-ic">'+dicon(a.ic)+'</div><div class="lc-act-main"><div class="lc-act-txt">'+esc(a.txt)+'</div><div class="lc-act-case">'+esc(a.c.spisZnacka||a.c.clientName||'')+'</div></div><div class="lc-act-time">'+rel(a.when)+'</div></div>'; }).join('') : '<div class="lc-dl-empty">Zatím žádná aktivita.</div>';
  el.innerHTML='<div class="tl">Poslední aktivita</div><div class="lc-act-list">'+rows+'</div>';
}

/* ============ SKLENĚNÉ SLOŽKY ============ */
function normFold(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }
function matchFold(q,fields){
  if(!q) return true;
  const n=normFold(q);
  const digits=q.replace(/\D/g,'');
  return fields.some(f=>{
    const t=normFold(String(f));
    if(t.includes(n)) return true;
    if(digits.length>=2 && String(f).replace(/\D/g,'').includes(digits)) return true;
    return false;
  });
}
function folderInitials(name){ return (name||'?').split(' ').filter(Boolean).map(w=>w[0]).join('').slice(0,2).toUpperCase(); }
function nearestDeadlineDays(c){
  let nd=null;
  calculateDeadlines(c).forEach(d=>{ if(d.daysLeft>=0 && (nd===null || d.daysLeft<nd)) nd=d.daysLeft; });
  return nd;
}
function caseHasContent(c){
  const docs=(c.documents||[]).filter(d=>!d.deletedAt).length;
  const ai=(c.analyses||[]).length;
  const txt=(c.analysisText||'').trim();
  return docs>0||ai>0||!!txt;
}
function caseFolderClass(c,dl){
  if(!caseHasContent(c)) return 'empty';
  return 'filled'+(dl!==null&&dl!==undefined&&dl<=3?' urgent':'');
}
function casePillHtml(c,dl){
  if(!caseHasContent(c)) return '<span class="gf-pill p-empty">Doplň spis</span>';
  if(dl===null||dl===undefined) return '<span class="gf-pill p-phase">—</span>';
  if(dl<=3) return '<span class="gf-pill p-crit">'+(dl===0?'dnes':dl+' d')+'</span>';
  if(dl<=14) return '<span class="gf-pill p-warn">'+dl+' d</span>';
  return '<span class="gf-pill p-ok">'+dl+' d</span>';
}
function clientFolderClass(cl){
  return casesOfClient(cl).length>0?'filled':'empty';
}
function clientPillHtml(cl,nd){
  if(!casesOfClient(cl).length) return '<span class="gf-pill p-empty">Bez případu</span>';
  if(nd===null||nd===undefined) return '<span class="gf-pill p-phase">—</span>';
  if(nd<=3) return '<span class="gf-pill p-crit">'+(nd===0?'dnes':nd+' d')+'</span>';
  if(nd<=14) return '<span class="gf-pill p-warn">'+nd+' d</span>';
  return '<span class="gf-pill p-ok">'+nd+' d</span>';
}
function glassFolderHtml(st,icon,title,sub1,sub2,foot,onclick,isNew){
  const inner=isNew
    ?'<div class="gf-inner"><div class="gf-icon">'+icon+'</div><div class="gf-title">'+esc(title)+'</div>'+(sub1?'<div class="gf-sub">'+esc(sub1)+'</div>':'')+'</div><div class="gf-foot">'+foot+'</div>'
    :'<div class="gf-inner"><div class="gf-icon">'+icon+'</div><div class="gf-title">'+esc(title)+'</div><div class="gf-sub">'+esc(sub1)+'</div>'+(sub2?'<div class="gf-sub">'+esc(sub2)+'</div>':'')+'</div><div class="gf-foot">'+foot+'</div>';
  return '<div class="gf '+st+'" onclick="'+onclick+'"><div class="gf-tab"></div><div class="gf-body">'+inner+'</div></div>';
}
/* Sdílená Lex Corvus karta případu (seznam i workspace) */
/* Reálné rizikové skóre 5–99 z faktických signálů (ne vymyšlené): blízkost lhůt, prošlé lhůty, vazba, počet analýz */
function caseRiskScore(c){
  var s=18;
  try{
    var dls=(calculateDeadlines(c)||[]);
    var future=dls.filter(function(d){return d.daysLeft>=0;});
    var overdue=dls.filter(function(d){return d.daysLeft<0;}).length;
    if(future.length){ var nn=Math.min.apply(null,future.map(function(d){return d.daysLeft;})); s+=(nn<=3?55:(nn<=7?46:(nn<=14?36:(nn<=30?24:12)))); }
    s+=overdue*12;
    var cust=null; try{ cust=(typeof custodyOf==='function')?custodyOf(c):null; }catch(e){}
    if(cust&&cust.inCustody) s+=16;
    s+=Math.min(10,(c.analyses||[]).length*2);
  }catch(e){}
  return Math.max(5,Math.min(99,Math.round(s)));
}
function caseRiskLevel(score){ return score>=65?{cls:'lc-risk-high',t:'Vysoké'}:(score>=40?{cls:'lc-risk-mid',t:'Střední'}:{cls:'lc-risk-low',t:'Nízké'}); }
function lcCaseCard(c, activeId){
  const dl=nearestDeadlineDays(c);
  const docs=(c.documents||[]).filter(d=>!d.deletedAt).length;
  const ai=(c.analyses||[]).length;
  const isOb=(c.kategorie==='obchodni');
  const kat=isOb?{t:'OBCHODNÍ',cls:'lc-tag-ob'}:{t:'TRESTNÍ',cls:'lc-tag-tr'};
  const sub=c.soud||c.court||(caseHasContent(c)?(docs+' dok.'+(ai?' · '+ai+' AI':'')):'bez spisu');
  let badge;
  if(!caseHasContent(c)){ badge='<span class="lc-risk lc-risk-empty">Doplň spis</span>'; }
  else { var _sc=caseRiskScore(c), _lv=caseRiskLevel(_sc); badge='<span class="lc-risk '+_lv.cls+'">Riziko '+_lv.t+' · '+_sc+'</span>'; }
  return '<div class="lc-case'+(c.id===activeId?' active':'')+'" data-kat="'+(isOb?'obchodni':'trestni')+'" onclick="openCaseDetail(\''+c.id+'\')">'+
    '<div class="lc-case-top"><span class="lc-tag '+kat.cls+'">'+kat.t+'</span><span class="lc-case-spis">'+esc(c.spisZnacka||'bez zn.')+'</span></div>'+
    '<div class="lc-case-title">'+esc(c.clientName||'Případ')+'</div>'+
    '<div class="lc-case-client">'+dicon('pripady')+'<span>'+esc(sub)+'</span></div>'+
    '<div class="lc-case-bottom"><span class="lc-status">'+esc(c.faze||c.status||'Aktivní')+'</span>'+badge+'</div>'+
  '</div>';
}
function caseCountWord(n){ return n===1?'aktivní spis':((n>=2&&n<=4)?'aktivní spisy':'aktivních spisů'); }
function wsCaseListHtml(current){
  const all=liveCases();
  let h='<div class="lc-ws-head"><div class="lc-ws-htxt"><span class="lc-ws-title">Případy</span><span class="lc-ws-sub">'+all.length+' '+caseCountWord(all.length)+'</span></div><button class="lc-ws-new" onclick="event.stopPropagation();openNewCase()" title="Nový případ">+</button></div>';
  h+='<div class="lc-seg" id="wsSeg"><button class="lc-seg-b on" onclick="wsSegFilter(this,\'all\')">Vše</button><button class="lc-seg-b" onclick="wsSegFilter(this,\'trestni\')">Trestní</button><button class="lc-seg-b" onclick="wsSegFilter(this,\'obchodni\')">Obchodní</button></div>';
  h+='<div class="lc-ws-cards" id="wsCards">';
  all.forEach(function(c){ h+=lcCaseCard(c, current&&current.id); });
  h+='</div>';
  return h;
}
function wsSegFilter(btn,kat){
  var seg=btn.parentNode; seg.querySelectorAll('.lc-seg-b').forEach(function(b){b.classList.remove('on');}); btn.classList.add('on');
  document.querySelectorAll('#wsCards .lc-case').forEach(function(el){ el.style.display=(kat==='all'||el.getAttribute('data-kat')===kat)?'':'none'; });
}
/* Panel spisu — mřížka navy dlaždic (Lex Corvus Přehled), reálná data, odkaz do sekce */
function panelSpisuHtml(c){
  const docs=(c.documents||[]).filter(function(d){return d&&!d.deletedAt;});
  const anals=(c.analyses||[]);
  const chat=(c.ragChat||[]);
  var dls=[]; try{ dls=(calculateDeadlines(c)||[]).slice().sort(function(a,b){return a.daysLeft-b.daysLeft;}); }catch(e){}
  const tl=(c.timeline||[]).filter(function(t){return t&&t.date&&!t.deletedAt;});
  var cust=null; try{ cust=(typeof custodyOf==='function')?custodyOf(c):null; }catch(e){}
  const hrs=(c.hearings||[]).filter(function(h){return h&&!h.deletedAt;});
  const pers=(c.persons||[]).filter(function(p){return p&&!p.deletedAt;});
  var seiz=[]; try{ seiz=(typeof seizures==='function')?seizures(c):(c.seizures||[]); }catch(e){}
  const intr=(c.interrogations||[]);
  const ckl=(c.checklist||[]);
  const ckDone=ckl.filter(function(i){return i&&i.done;}).length;

  const rel=function(ts){ if(!ts) return ''; var d=(typeof ts==='number')?ts:Date.parse(ts); if(isNaN(d)) return ''; var diff=Date.now()-d, day=864e5; if(diff<36e5) return 'před '+Math.max(1,Math.round(diff/6e4))+' min'; if(diff<day) return 'před '+Math.round(diff/36e5)+' h'; if(diff<2*day) return 'včera'; if(diff<7*day) return 'před '+Math.round(diff/day)+' dny'; return new Date(d).toLocaleDateString('cs-CZ'); };
  const dstr=function(x){ if(!x) return ''; var d=(x instanceof Date)?x:new Date(x); return isNaN(d)?esc(String(x)):d.toLocaleDateString('cs-CZ',{day:'numeric',month:'numeric'}); };
  const ini=function(n){ n=(n||'').trim(); if(!n) return '?'; var p=n.split(/\s+/); return (((p[0]||'')[0]||'')+((p[1]||'')[0]||'')).toUpperCase(); };
  const ln=function(l,r,rc){ return '<div class="ps-line"><span class="ps-l">'+l+'</span>'+((r!=null&&r!=='')?'<span class="ps-r '+(rc||'')+'">'+r+'</span>':'')+'</div>'; };
  const emp=function(x){ return '<div class="ps-empty">'+x+'</div>'; };

  var lDocs = docs.length ? docs.slice(0,3).map(function(d){return ln('<span class="ps-ell">'+esc(d.name||'spis.pdf')+'</span>', rel(d.when));}).join('') : emp('Zatím žádné dokumenty');
  var lAnal = anals.length ? ('<div class="ps-txt">'+esc(anals[0].label||'Analýza')+'</div>'+ln('Poslední', rel(anals[0].when))) : emp('Zatím bez analýz');
  var lastU=null; for(var i=chat.length-1;i>=0;i--){ if(chat[i].role==='user'){ lastU=chat[i]; break; } }
  var lChat = lastU ? ('<div class="ps-quote">„'+esc((lastU.text||'').slice(0,90))+'"</div>') : emp('Zeptej se AI na cokoliv ve spisu');
  var lLhu = dls.length ? dls.slice(0,2).map(function(d){ var col=(d.daysLeft<0||d.daysLeft<=3)?'r-red':(d.daysLeft<=14?'r-gold':'r-green'); return ln('<span class="ps-ell">'+esc(d.label||d.short||'Lhůta')+'</span>', dstr(d.deadline||d.raw), col); }).join('') : emp('Žádné běžící lhůty');
  var lOsa = tl.length ? ('<div class="ps-txt">Poslední: '+esc((tl[tl.length-1].event||'').slice(0,60))+'</div>') : emp('Zatím prázdná osa');
  var nextH = hrs.slice().filter(function(h){return h.date;}).sort(function(a,b){return Date.parse(a.date)-Date.parse(b.date);})[0];
  var lJed = nextH ? (ln('<span class="ps-ell">'+esc(nextH.subject||'Jednání')+'</span>')+ln('Termín', dstr(nextH.date)+(nextH.time?(' '+esc(nextH.time)):''),'r-gold')) : emp('Žádné naplánované jednání');
  var lVaz = (cust&&cust.inCustody) ? (ln('Stav','ve vazbě','r-red')+(cust.reason?ln('Důvod','<span class="ps-ell">'+esc(cust.reason)+'</span>'):'')) : emp('Klient není ve vazbě');
  var lZaj = seiz.length ? seiz.slice(0,2).map(function(s){return ln('<span class="ps-ell">'+esc(s.by||s.item||'Zajištění')+'</span>', dstr(s.date));}).join('') : emp('Nic zajištěno');
  var lOso = pers.length ? ('<div class="ps-avs">'+pers.slice(0,5).map(function(p){return '<span class="ps-av">'+esc(ini(p.name))+'</span>';}).join('')+(pers.length>5?'<span class="ps-av more">+'+(pers.length-5)+'</span>':'')+'</div>') : emp('Žádné osoby');
  var lVys = intr.length ? ln('Záznamů', String(intr.length)) : emp('Žádné výslechy');
  var lSab = emp('Vzory podání a návrhů');
  var lChk = ckl.length ? ln('Hotovo', ckDone+' / '+ckl.length, (ckDone===ckl.length?'r-green':'r-gold')) : emp('Prázdný checklist');

  const vVaz=(cust&&cust.inCustody)?'ve vazbě':'—';
  const vJed=nextH?dstr(nextH.date):'—';
  const vChk=ckl.length?(ckDone+'/'+ckl.length):'0';

  const t=function(sect,icon,cls,val,title,sub,lines){
    return '<div class="ps-tile" onclick="switchDetailTab(\''+sect+'\')">'+
      '<div class="ps-top"><div class="ps-ic '+cls+'">'+dicon(icon)+'</div><span class="ps-val">'+val+'</span></div>'+
      '<div class="ps-title">'+title+'</div><div class="ps-sub">'+sub+'</div>'+
      '<div class="ps-div"></div><div class="ps-lines">'+lines+'</div>'+
      '<span class="ps-arrow">↗</span></div>';
  };
  return '<div class="ps-head"><span>Panel spisu</span><span class="ps-hint">Klikni na kartu pro detail</span></div>'+
    '<div class="ps-grid">'+
      t('dokumenty','dokumenty','m-gold',docs.length,'Dokumenty','Spis, přílohy, důkazy',lDocs)+
      t('analyzy','analyzy','m-red',anals.length,'Analýzy','AI shrnutí, argumentace',lAnal)+
      t('chat','chat','m-gold',chat.length,'Chat nad spisem','Corvus AI asistent',lChat)+
      t('lhuty','lhuty','m-red',dls.length,'Lhůty','Termíny podání a úkonů',lLhu)+
      t('osa','osa','m-slate',tl.length,'Časová osa','Chronologie řízení',lOsa)+
      t('jednani','jednani','m-gold',vJed,'Jednání','Soudní roky a přípravy',lJed)+
      t('vazba','vazba','m-gold',vVaz,'Vazba','Důvody a trvání',lVaz)+
      t('zajisteni','zajisteni','m-red',seiz.length,'Zajištění','Věci, prostředky, data',lZaj)+
      t('osoby','osoby','m-slate',pers.length,'Osoby','Účastníci a role',lOso)+
      t('vyslechy','vyslechy','m-gold',intr.length,'Výslechy','Přepisy a audio',lVys)+
      t('sablony','sablony','m-slate','—','Šablony','Vzory podání',lSab)+
      t('checklist','checklist','m-gold',vChk,'Checklist','Úkony do jednání',lChk)+
    '</div>';
}
function renderCasesFolders(){
  const inp=document.getElementById('casesSearch');
  const q=(inp&&inp.value||'').trim();
  const el=document.getElementById('casesFull');
  const info=document.getElementById('casesInfo');
  const clr=document.getElementById('casesSearchClear');
  if(!el) return;
  const all=liveCases();
  if(!all.length){
    el.innerHTML='<div class="cabinet-empty">Zatím žádné případy.<br><b>Klikni na + Nový případ</b> nahoře.</div>';
    if(info) info.innerHTML='';
    if(clr) clr.style.display='none';
    return;
  }
  const filtered=all.filter(c=>matchFold(q,[c.clientName,c.spisZnacka,c.soud,c.court,c.faze,c.status]));
  let html='';
  filtered.forEach(function(c){ html+=lcCaseCard(c, currentDetailId); });
  if(!html){
    el.innerHTML='<div class="cabinet-empty">Nic nenalezeno pro <b>'+esc(q)+'</b><br>Zkus jméno klienta nebo část spisové značky.</div>';
  }else{
    html+='<button class="lc-case-new" onclick="openNewCase()"><span class="lc-case-new-plus">+</span> Nový případ</button>';
    el.innerHTML=html;
  }
  if(info){
    info.innerHTML=q
      ?'<span>Zobrazeno <b>'+filtered.length+'</b> z '+all.length+'</span><span>Filtrováno</span>'
      :'<span><b>'+all.length+'</b> složek v kartotéce</span><span>Klik = detail případu</span>';
  }
  if(clr) clr.style.display=q?'':'none';
}
function renderClientsFolders(){
  const inp=document.getElementById('clientsSearch');
  const q=(inp&&inp.value||'').trim();
  const el=document.getElementById('clientsFull');
  const info=document.getElementById('clientsInfo');
  const clr=document.getElementById('clientsSearchClear');
  if(!el) return;
  const all=(appData.clients||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'','cs'));
  if(!all.length){
    el.innerHTML='<div class="cabinet-empty">Zatím žádní klienti.<br><b>Klikni na + Nový klient</b> nahoře.</div>';
    if(info) info.innerHTML='';
    if(clr) clr.style.display='none';
    return;
  }
  const filtered=all.filter(cl=>matchFold(q,[cl.name,cl.phone,cl.email]));
  let html='';
  filtered.forEach(cl=>{
    const cases=casesOfClient(cl);
    const docs=cases.reduce((a,c)=>a+(c.documents||[]).filter(d=>!d.deletedAt).length,0);
    let nd=null;
    cases.forEach(c=>calculateDeadlines(c).forEach(d=>{ if(d.daysLeft>=0 && (nd===null||d.daysLeft<nd)) nd=d.daysLeft; }));
    const st=clientFolderClass(cl)+(cases.length&&nd!==null&&nd!==undefined&&nd<=3?' urgent':'');
    const meta=[cl.phone?cl.phone:'',cl.email?cl.email:''].filter(Boolean).join(' · ')||'bez kontaktu';
    const sub2=cases.length?cases.length+' '+caseWord(cases.length)+' · '+docs+' dok.':'0 případů';
    const foot='<div class="gf-avs"><div class="gf-av">'+esc(folderInitials(cl.name))+'</div>'+
      (cases.length>1?'<div class="gf-more">+'+(cases.length-1)+'</div>':'')+
      '</div>'+clientPillHtml(cl,nd);
    html+=glassFolderHtml(st,folderInitials(cl.name),cl.name||'Nejmenovaný',meta,sub2,foot,"openClientDetail('"+cl.id+"')",false);
  });
  if(!html){
    el.innerHTML='<div class="cabinet-empty">Nic nenalezeno pro <b>'+esc(q)+'</b><br>Zkus jméno nebo část telefonního čísla.</div>';
  }else{
    html+=glassFolderHtml('new-folder','+','Nový klient','Založit kartu','','<span class="gf-pill p-add">Přidat</span>','openNewClient()',true);
    el.innerHTML=html;
  }
  if(info){
    info.innerHTML=q
      ?'<span>Zobrazeno <b>'+filtered.length+'</b> z '+all.length+'</span><span>Filtrováno</span>'
      :'<span><b>'+all.length+'</b> klientů v kartotéce</span><span>Klik = detail klienta</span>';
  }
  if(clr) clr.style.display=q?'':'none';
}
function clearCasesSearch(){ const i=document.getElementById('casesSearch'); if(i){ i.value=''; renderCasesFolders(); i.focus(); } }
function clearClientsSearch(){ const i=document.getElementById('clientsSearch'); if(i){ i.value=''; renderClientsFolders(); i.focus(); } }

/* ============ KLIENTI ============ */
function caseWord(n){ return n===1?'případ':(n>=2&&n<=4?'případy':'případů'); }
function clientKeyOf(c){ return (c.rodneCislo&&c.rodneCislo.trim())||normEv(c.clientName||''); }
function casesOfClient(cl){ return liveCases().filter(c=> (c.clientId&&c.clientId===cl.id) || (!c.clientId && cl.key && clientKeyOf(c)===cl.key)); }
function clientLabelBadge(l){
  const m={aktivni:['Aktivní','var(--green)','var(--green-soft)'],urgentni:['Urgentní','var(--red)','var(--red-soft)'],archiv:['Archiv','var(--muted)','var(--surface2)']};
  const x=m[l]||m.aktivni;
  return '<span class="cl-badge" style="color:'+x[1]+';background:'+x[2]+';border-color:'+x[1]+'">'+x[0]+'</span>';
}

/* ----- Finance klienta ----- */
function blankFinance(){ return { agreed:0, hourlyRate:0, payments:[], expenses:[] }; }
function fin(cl){
  if(!cl.finance) cl.finance=blankFinance();
  const f=cl.finance;
  f.agreed=f.agreed||0; f.hourlyRate=f.hourlyRate||0;
  f.payments=f.payments||[]; f.expenses=f.expenses||[];
  return f;
}
function czk(n){ return (Math.round(+n||0)).toLocaleString('cs-CZ')+' Kč'; }
function parseAmount(s){ s=String(s==null?'':s).replace(/\s/g,'').replace(/kč/i,'').replace(',','.'); const n=parseFloat(s); return isNaN(n)?0:n; }
function todayISO(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

function finStat(k,v,col){ return '<div class="fin-stat"><div class="k">'+k+'</div><div class="v"'+(col?' style="color:'+col+'"':'')+'>'+v+'</div></div>'; }
function finItemRow(cid,kind,it){
  const fn=kind==='pay'?'finUpdPayment':'finUpdExpense';
  const del=(kind==='pay'?'finDelPayment':'finDelExpense')+'(\''+cid+'\',\''+it.id+'\')';
  const tf=kind==='pay'?'note':'desc';
  const ph=kind==='pay'?'poznámka':'popis (soudní poplatek, znalečné…)';
  const u=(field)=>fn+'(\''+cid+'\',\''+it.id+'\',\''+field+'\',this.value)';
  return '<div class="fin-row">'+
    '<input class="fin-date" type="date" value="'+esc(it.date||'')+'" onchange="'+u('date')+'">'+
    '<input class="fin-note" type="text" value="'+esc(it[tf]||'')+'" placeholder="'+ph+'" onchange="'+u(tf)+'">'+
    '<input class="fin-amt" type="text" inputmode="numeric" value="'+esc(it.amount||'')+'" placeholder="0" onchange="'+u('amount')+'">'+
    '<button class="fin-x" title="Smazat" onclick="'+del+'">×</button>'+
  '</div>';
}
function financePanelHtml(cl){
  const f=fin(cl), cid=cl.id;
  const paid=f.payments.reduce((a,p)=>a+(+p.amount||0),0);
  const exp=f.expenses.reduce((a,e)=>a+(+e.amount||0),0);
  // Propojení s konzultacemi: odpracovaný čas × hodinová taxa
  const consMin=consults(cl).reduce((a,c)=>a+(+c.minutes||0),0);
  const workedVal=consultValue(consMin, f.hourlyRate);
  // Základ k fakturaci: pevná dohodnutá částka, jinak odpracovaný čas
  const basis=(+f.agreed>0)?(+f.agreed):workedVal;
  const remain=basis-paid;
  const sum='<div class="fin-sum">'+
    finStat((+f.agreed>0)?'Dohodnuto':'Odpracováno', (+f.agreed>0)?czk(f.agreed):czk(workedVal))+
    finStat('Zaplaceno',czk(paid))+
    finStat('Zbývá doplatit',czk(remain), remain>0?'var(--red)':'var(--green)')+
    finStat('Náklady',czk(exp))+
  '</div>';
  const workedLine = f.hourlyRate>0
    ? '<div style="font-size:.74rem;color:var(--muted);margin-top:10px">⏱ Odpracováno v Konzultacích: <b>'+fmtDur(consMin)+'</b> × '+czk(f.hourlyRate)+'/h = <b style="color:var(--am)">'+czk(workedVal)+'</b>'+((+f.agreed>0)?' <span style="color:var(--dim)">(máš pevnou dohodnutou částku — odpracováno je jen orientační)</span>':' <span style="color:var(--dim)">(bez pevné částky → toto je základ k doplacení)</span>')+'</div>'
    : '<div style="font-size:.72rem;color:var(--dim);margin-top:10px">Zadej hodinovou taxu — propojí se s odpracovaným časem v Konzultacích a spočítá částku.</div>';
  const honorar='<div class="tile rev" style="margin-bottom:14px"><div class="tl">Honorář</div><div class="fin-h">'+
    '<div class="frow"><label>Dohodnutá částka</label><input type="text" inputmode="numeric" value="'+esc(f.agreed||'')+'" placeholder="0 Kč" onchange="finSetAgreed(\''+cid+'\',this.value)"></div>'+
    '<div class="frow"><label>Hodinová taxa (Kč/h)</label><input type="text" inputmode="numeric" value="'+esc(f.hourlyRate||'')+'" placeholder="0" onchange="finSetRate(\''+cid+'\',this.value)"></div>'+
  '</div>'+workedLine+'</div>';
  const payRows=f.payments.length?f.payments.map(p=>finItemRow(cid,'pay',p)).join(''):'<p style="color:var(--muted);padding:4px 2px">Zatím žádné platby. Klient nosí po částech — každou přidej zvlášť.</p>';
  const platby='<div class="tile rev" style="margin-bottom:14px"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px"><div class="tl" style="margin:0">Platby od klienta</div><button class="btn gold sm" onclick="finAddPayment(\''+cid+'\')">+ Platba</button></div>'+payRows+'</div>';
  const expRows=f.expenses.length?f.expenses.map(e=>finItemRow(cid,'exp',e)).join(''):'<p style="color:var(--muted);padding:4px 2px">Zatím žádné náklady.</p>';
  const naklady='<div class="tile rev"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px"><div class="tl" style="margin:0">Náklady a výdaje</div><button class="btn gold sm" onclick="finAddExpense(\''+cid+'\')">+ Náklad</button></div>'+expRows+'</div>';
  return sum+honorar+platby+naklady;
}
function renderFinancePanel(cid){ const cl=appData.clients.find(x=>x.id===cid); if(!cl) return; const p=document.getElementById('cpanel-cfinance'); if(p) p.innerHTML=financePanelHtml(cl); }

function finSetAgreed(cid,val){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; fin(cl).agreed=parseAmount(val); saveData(); renderFinancePanel(cid); }
function finSetRate(cid,val){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; fin(cl).hourlyRate=parseAmount(val); saveData(); renderFinancePanel(cid); }
function finAddPayment(cid){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; fin(cl).payments.push({id:uid(),date:todayISO(),amount:0,note:''}); saveData(); renderFinancePanel(cid); }
function finUpdPayment(cid,pid,field,val){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; const p=fin(cl).payments.find(x=>x.id===pid); if(!p)return; p[field]=field==='amount'?parseAmount(val):val; saveData(); renderFinancePanel(cid); }
function finDelPayment(cid,pid){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; const p=fin(cl).payments.find(x=>x.id===pid); uiConfirm('Smazat platbu?',(p?czk(p.amount):'')+(p&&p.date?(' · '+fmtD(p.date)):''),()=>{ fin(cl).payments=fin(cl).payments.filter(x=>x.id!==pid); saveData(); renderFinancePanel(cid); toast('Platba smazána'); }); }
function finAddExpense(cid){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; fin(cl).expenses.push({id:uid(),date:todayISO(),amount:0,desc:''}); saveData(); renderFinancePanel(cid); }
function finUpdExpense(cid,eid,field,val){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; const e=fin(cl).expenses.find(x=>x.id===eid); if(!e)return; e[field]=field==='amount'?parseAmount(val):val; saveData(); renderFinancePanel(cid); }
function finDelExpense(cid,eid){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; const e=fin(cl).expenses.find(x=>x.id===eid); uiConfirm('Smazat náklad?',(e?czk(e.amount):'')+(e&&e.desc?(' · '+e.desc):''),()=>{ fin(cl).expenses=fin(cl).expenses.filter(x=>x.id!==eid); saveData(); renderFinancePanel(cid); toast('Náklad smazán'); }); }

/* ----- Konzultace (čas) ----- */
let consultTimer = null; // {clientId, start, tick}
function consults(cl){ if(!Array.isArray(cl.consultations)) cl.consultations=[]; return cl.consultations; }
function fmtDur(min){ min=Math.max(0,Math.round(min||0)); const h=Math.floor(min/60), m=min%60; return (h?h+' h':'')+(h&&m?' ':'')+(m||!h?m+' min':''); }
function consultValue(min,rate){ return Math.round((min/60)*(+rate||0)); }

function consultPanelHtml(cl){
  const cid=cl.id, list=consults(cl), rate=fin(cl).hourlyRate||0;
  const totalMin=list.reduce((a,c)=>a+(+c.minutes||0),0);
  const totalVal=consultValue(totalMin,rate);
  const running = consultTimer && consultTimer.clientId===cid;
  const timer='<div class="tile rev" style="margin-bottom:14px"><div class="tl">Stopky</div>'+
    '<div class="con-timer">'+
      '<div class="con-disp" id="consultTimerDisp">'+(running?'00:00':'00:00')+'</div>'+
      (running
        ? '<button class="btn gold" onclick="stopTimer(\''+cid+'\')">Zastavit a uložit</button>'
        : '<button class="btn gold" onclick="startTimer(\''+cid+'\')">Spustit</button>')+
    '</div>'+
    '<div style="font-size:.72rem;color:var(--dim);margin-top:8px">Dobrovolné. Nechceš stopky? Přidej čas ručně níže.</div></div>';
  const sumLine = rate>0
    ? 'Odpracováno celkem: <b>'+fmtDur(totalMin)+'</b> · <b style="color:var(--am)">'+czk(totalVal)+'</b> <span style="color:var(--dim)">(taxa '+czk(rate)+'/h)</span>'
    : 'Odpracováno celkem: <b>'+fmtDur(totalMin)+'</b> <span style="color:var(--dim)">· nastav hodinovou taxu ve Financích, doplní se částka</span>';
  const rows = list.length ? list.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map(c=>{
    const h=Math.floor((+c.minutes||0)/60), m=(+c.minutes||0)%60;
    const val=rate>0?'<span class="con-val">'+czk(consultValue(c.minutes,rate))+'</span>':'';
    return '<div class="fin-row">'+
      '<input class="fin-date" type="date" value="'+esc(c.date||'')+'" onchange="conUpd(\''+cid+'\',\''+c.id+'\',\'date\',this.value)">'+
      '<input class="fin-note" type="text" value="'+esc(c.desc||'')+'" placeholder="co se řešilo" onchange="conUpd(\''+cid+'\',\''+c.id+'\',\'desc\',this.value)">'+
      '<input class="con-num" type="text" inputmode="numeric" value="'+h+'" onchange="conUpd(\''+cid+'\',\''+c.id+'\',\'h\',this.value)" title="hodiny"><span class="con-u">h</span>'+
      '<input class="con-num" type="text" inputmode="numeric" value="'+m+'" onchange="conUpd(\''+cid+'\',\''+c.id+'\',\'m\',this.value)" title="minuty"><span class="con-u">m</span>'+
      val+
      '<button class="fin-x" title="Smazat" onclick="conDel(\''+cid+'\',\''+c.id+'\')">×</button>'+
    '</div>';
  }).join('') : '<p style="color:var(--muted);padding:4px 2px">Zatím žádné konzultace.</p>';
  const listTile='<div class="tile rev"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px"><div class="tl" style="margin:0">Konzultace</div><button class="btn gold sm" onclick="conAdd(\''+cid+'\')">+ Ručně</button></div>'+
    '<div class="con-sum">'+sumLine+'</div>'+rows+'</div>';
  return timer+listTile;
}
function renderConsultPanel(cid){ const cl=appData.clients.find(x=>x.id===cid); if(!cl) return; const p=document.getElementById('cpanel-ckonzultace'); if(p) p.innerHTML=consultPanelHtml(cl); }

function timerElapsedStr(){ if(!consultTimer) return '00:00'; const s=Math.floor((Date.now()-consultTimer.start)/1000); const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60; return (h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0'); }
function tickTimer(){ if(!consultTimer || currentClientId!==consultTimer.clientId) return; const d=document.getElementById('consultTimerDisp'); if(d) d.textContent=timerElapsedStr(); }
function startTimer(cid){
  if(consultTimer){ toast(consultTimer.clientId===cid?'Stopky už běží':'Stopky běží u jiného klienta'); return; }
  consultTimer={clientId:cid,start:Date.now(),tick:setInterval(tickTimer,1000)};
  renderConsultPanel(cid); tickTimer();
}
function stopTimer(cid){
  if(!consultTimer || consultTimer.clientId!==cid) return;
  const mins=Math.max(1,Math.round((Date.now()-consultTimer.start)/60000));
  clearInterval(consultTimer.tick); consultTimer=null;
  const cl=appData.clients.find(x=>x.id===cid); if(cl){ consults(cl).push({id:uid(),date:todayISO(),minutes:mins,desc:''}); saveData(); }
  renderConsultPanel(cid); toast('Konzultace uložena · '+fmtDur(mins));
}
function conAdd(cid){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; consults(cl).push({id:uid(),date:todayISO(),minutes:0,desc:''}); saveData(); renderConsultPanel(cid); }
function conUpd(cid,id,field,val){
  const cl=appData.clients.find(x=>x.id===cid); if(!cl)return;
  const c=consults(cl).find(x=>x.id===id); if(!c)return;
  if(field==='h'){ const h=Math.max(0,parseInt(val,10)||0); const m=(+c.minutes||0)%60; c.minutes=h*60+m; }
  else if(field==='m'){ const m=Math.max(0,parseInt(val,10)||0); const h=Math.floor((+c.minutes||0)/60); c.minutes=h*60+m; }
  else c[field]=val;
  saveData(); renderConsultPanel(cid);
}
function conDel(cid,id){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; const c=consults(cl).find(x=>x.id===id); uiConfirm('Smazat konzultaci?',(c?fmtDur(c.minutes):'')+(c&&c.desc?(' · '+c.desc):''),()=>{ cl.consultations=consults(cl).filter(x=>x.id!==id); saveData(); renderConsultPanel(cid); toast('Konzultace smazána'); }); }

/* ----- Poznámky klienta ----- */
function cnotes(cl){ if(!Array.isArray(cl.clientNotes)) cl.clientNotes=[]; return cl.clientNotes; }
function notesPanelHtml(cl){
  const cid=cl.id, list=cnotes(cl);
  const rows = list.length ? list.slice().sort((a,b)=>(b.when||0)-(a.when||0)).map(n=>
    '<div class="note-card"><div class="note-head"><span class="note-date">'+esc(new Date(n.when||Date.now()).toLocaleString('cs-CZ',{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'}))+'</span>'+
      '<button class="fin-x" title="Smazat" onclick="noteDel(\''+cid+'\',\''+n.id+'\')">×</button></div>'+
    '<textarea class="note-text" onchange="noteUpd(\''+cid+'\',\''+n.id+'\',this.value)" placeholder="Text poznámky…">'+esc(n.text||'')+'</textarea></div>'
  ).join('') : '<p style="color:var(--muted);padding:4px 2px">Zatím žádné poznámky.</p>';
  return '<div class="tile rev"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px"><div class="tl" style="margin:0">Poznámky</div><button class="btn gold sm" onclick="noteAdd(\''+cid+'\')">+ Poznámka</button></div>'+rows+'</div>';
}
function renderNotesPanel(cid){ const cl=appData.clients.find(x=>x.id===cid); if(!cl) return; const p=document.getElementById('cpanel-cpoznamky'); if(p) p.innerHTML=notesPanelHtml(cl); }
function noteAdd(cid){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; cnotes(cl).unshift({id:uid(),when:Date.now(),text:''}); saveData(); renderNotesPanel(cid); }
function noteUpd(cid,id,val){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; const n=cnotes(cl).find(x=>x.id===id); if(!n)return; n.text=val; saveData(); }
function noteDel(cid,id){ const cl=appData.clients.find(x=>x.id===cid); if(!cl)return; const n=cnotes(cl).find(x=>x.id===id); uiConfirm('Smazat poznámku?', n&&n.text?(n.text.slice(0,60)):'', ()=>{ cl.clientNotes=cnotes(cl).filter(x=>x.id!==id); saveData(); renderNotesPanel(cid); toast('Poznámka smazána'); }); }

/* Karta klienta (stejný styl jako lc-case) + seznam do workspace */
function lcClientCard(cl, activeId){
  const cases=casesOfClient(cl);
  const nCases=cases.length;
  const docs=cases.reduce(function(a,c){return a+(c.documents||[]).filter(function(d){return !d.deletedAt;}).length;},0);
  const meta=[cl.phone,cl.email].filter(Boolean).join(' · ')||'bez kontaktu';
  const lbl=(cl.label||'aktivni');
  const badgeCls=lbl==='urgentni'?'lc-risk-high':(lbl==='archiv'?'lc-risk-none':'lc-risk-low');
  const badgeTxt=lbl==='urgentni'?'Urgentní':(lbl==='archiv'?'Archiv':'Aktivní');
  return '<div class="lc-case lc-client'+(cl.id===activeId?' active':'')+'" onclick="openClientDetail(\''+cl.id+'\')">'+
    '<div class="lc-case-top"><span class="lc-cl-av">'+esc(folderInitials(cl.name))+'</span><span class="lc-case-spis">'+esc(nCases+' '+caseWord(nCases))+'</span></div>'+
    '<div class="lc-case-title">'+esc(cl.name||'Nejmenovaný')+'</div>'+
    '<div class="lc-case-client">'+dicon('phone')+'<span>'+esc(meta)+'</span></div>'+
    '<div class="lc-case-bottom"><span class="lc-status">'+esc(docs+' dok.')+'</span><span class="lc-risk '+badgeCls+'">'+badgeTxt+'</span></div>'+
  '</div>';
}
function clientCountWord(n){ return n===1?'klient':((n>=2&&n<=4)?'klienti':'klientů'); }
function wsClientListHtml(current){
  const all=(appData.clients||[]).slice().sort(function(a,b){return (a.name||'').localeCompare(b.name||'','cs');});
  let h='<div class="lc-ws-head"><div class="lc-ws-htxt"><span class="lc-ws-title">Klienti</span><span class="lc-ws-sub">'+all.length+' '+clientCountWord(all.length)+'</span></div><button class="lc-ws-new" onclick="event.stopPropagation();openNewClient()" title="Nový klient">+</button></div>';
  h+='<div class="lc-ws-cards" id="wsClCards">';
  all.forEach(function(cl){ h+=lcClientCard(cl, current&&current.id); });
  h+='</div>';
  return h;
}
function openClientDetail(id){
  const cl=appData.clients.find(x=>x.id===id); if(!cl) return;
  currentClientId=id;
  const cases=casesOfClient(cl);
  const initial=((cl.name||'?').trim().charAt(0)||'?').toUpperCase();
  const contact=[
    cl.phone?'<span class="cl-h-item">'+dicon('phone')+esc(cl.phone)+'</span>':'',
    cl.email?'<span class="cl-h-item">'+dicon('mail')+esc(cl.email)+'</span>':''
  ].filter(Boolean).join('');

  const ICN={cprehled:'prehled',cpripady:'pripady',cfinance:'finance',ckonzultace:'konzultace',cpoznamky:'poznamky'};
  const ctab=(tid,label)=>'<span class="dtab'+(currentClientTab===tid?' on':'')+'" data-ctab="'+tid+'" onclick="switchClientTab(\''+tid+'\')">'+dicon(ICN[tid]||'prehled')+label+'</span>';

  const labelSel='<div class="frow"><label>Štítek</label><select id="cl_label">'+
    ['aktivni|Aktivní','urgentni|Urgentní','archiv|Archiv'].map(o=>{const[v,t]=o.split('|');return '<option value="'+v+'"'+((cl.label||'aktivni')===v?' selected':'')+'>'+t+'</option>';}).join('')+
    '</select></div>';

  const casesHtml = cases.length ? cases.map(c=>{
    const dls=calculateDeadlines(c).filter(d=>d.daysLeft>=0).sort((a,b)=>a.daysLeft-b.daysLeft);
    const near=dls.length?'<span class="cl-dl">'+(dls[0].daysLeft===0?'dnes':dls[0].daysLeft+' d')+'</span>':'';
    const kval=(c.obvineni&&c.obvineni[0])?'§ '+esc(c.obvineni[0]):esc(c.pravniKvalifikace||'—');
    return '<div class="cl-case" onclick="openCaseDetail(\''+c.id+'\')">'+
      '<div><b>'+esc(c.spisZnacka||'bez spis. zn.')+'</b> <span style="color:var(--muted)">'+kval+'</span></div>'+
      '<div style="display:flex;align-items:center;gap:10px">'+near+phaseTag(c.faze||c.status)+'</div></div>';
  }).join('') : '<p style="color:var(--muted);padding:6px 2px">Žádné případy. Klikni na „+ Nový případ".</p>';

  document.getElementById('page-clientdetail').innerHTML =
    '<div class="lc-workspace"><aside class="lc-ws-list">'+wsClientListHtml(cl)+'</aside><div class="lc-ws-main">'+
    '<div class="lc-hero rev">'+
      '<div class="lc-hero-top">'+
        '<span class="backbtn" onclick="showPage(\'clients\')">'+dicon('back')+'Klienti</span>'+
        '<div class="lc-hero-actions"><button class="btn ghost sm" onclick="askDeleteClient(\''+cl.id+'\')" title="Smazat">Smazat</button><span class="btn gold" onclick="saveClientDetail()">Uložit změny</span></div>'+
      '</div>'+
      '<div class="lc-eyebrow">KLIENT <i>•</i> '+esc(cl.label==='urgentni'?'URGENTNÍ':(cl.label==='archiv'?'ARCHIV':'AKTIVNÍ'))+' <i>•</i> '+cases.length+' '+esc(caseWord(cases.length))+'</div>'+
      '<h1 class="lc-hero-title">'+esc(cl.name||'Klient')+'</h1>'+
      '<div class="lc-meta-grid">'+
        '<div class="lc-meta"><div class="lc-meta-l">Telefon</div><div class="lc-meta-v">'+esc(cl.phone||'—')+'</div></div>'+
        '<div class="lc-meta"><div class="lc-meta-l">E-mail</div><div class="lc-meta-v">'+esc(cl.email||'—')+'</div></div>'+
        '<div class="lc-meta"><div class="lc-meta-l">Případů</div><div class="lc-meta-v gold">'+cases.length+'</div></div>'+
        '<div class="lc-meta"><div class="lc-meta-l">Štítek</div><div class="lc-meta-v">'+esc(cl.label==='urgentni'?'Urgentní':(cl.label==='archiv'?'Archiv':'Aktivní'))+'</div></div>'+
      '</div>'+
    '</div>'+

    '<div class="dtabs rev">'+ctab('cprehled','Přehled')+ctab('cpripady','Případy ('+cases.length+')')+ctab('cpoznamky','Poznámky')+ctab('ckonzultace','Konzultace')+ctab('cfinance','Finance')+'</div>'+

    '<div class="dpanel" id="cpanel-cprehled"><div class="tile rev"><div class="tl">Základní informace</div>'+
      frow('Jméno a příjmení','cl_name',cl.name)+
      frow('Datum narození','cl_birthDate',cl.birthDate,'date')+
      frow('Rodné číslo','cl_rodneCislo',cl.rodneCislo)+
      frow('Číslo OP / pasu','cl_idNumber',cl.idNumber)+
      frow('Telefon','cl_phone',cl.phone)+
      frow('E-mail','cl_email',cl.email)+
      frow('Adresa','cl_address',cl.address)+
      frow('Datová schránka','cl_datovaSchranka',cl.datovaSchranka)+
      labelSel+
      '<div class="frow full"><label>Poznámky</label><textarea id="cl_notes">'+esc(cl.notes||'')+'</textarea></div>'+
    '</div></div>'+

    '<div class="dpanel" id="cpanel-cpripady" style="display:none"><div class="tile rev">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px"><div class="tl" style="margin:0">Případy klienta</div>'+
      '<button class="btn gold sm" onclick="newCaseForClient(\''+cl.id+'\')">+ Nový případ</button></div>'+
      casesHtml+'</div></div>'+

    '<div class="dpanel" id="cpanel-cpoznamky" style="display:none">'+notesPanelHtml(cl)+'</div>'+

    '<div class="dpanel" id="cpanel-ckonzultace" style="display:none">'+consultPanelHtml(cl)+'</div>'+

    '<div class="dpanel" id="cpanel-cfinance" style="display:none">'+financePanelHtml(cl)+'</div>'+
    '</div></div>';

  switchClientTab(currentClientTab);
  showPage('clientdetail');
  window.scrollTo({top:0,behavior:'smooth'});
}

function switchClientTab(id){
  currentClientTab=id;
  document.querySelectorAll('#page-clientdetail .dtab').forEach(t=>t.classList.toggle('on', t.dataset.ctab===id));
  document.querySelectorAll('#page-clientdetail .dpanel').forEach(p=>p.style.display='none');
  const pan=document.getElementById('cpanel-'+id); if(pan) pan.style.display='block';
}

function saveClientDetail(){
  const cl=appData.clients.find(x=>x.id===currentClientId); if(!cl) return;
  const v=id=>{ const el=document.getElementById(id); return el?el.value.trim():''; };
  cl.name=v('cl_name')||'Nejmenovaný';
  cl.birthDate=v('cl_birthDate'); cl.rodneCislo=v('cl_rodneCislo'); cl.idNumber=v('cl_idNumber');
  cl.phone=v('cl_phone'); cl.email=v('cl_email'); cl.address=v('cl_address'); cl.datovaSchranka=v('cl_datovaSchranka');
  const ls=document.getElementById('cl_label'); cl.label=ls?ls.value:'aktivni';
  cl.notes=v('cl_notes');
  cl.key=(cl.rodneCislo&&cl.rodneCislo.trim())||normEv(cl.name);
  appData.cases.forEach(c=>{ if(c.clientId===cl.id) c.clientName=cl.name; });
  saveData(); renderAll();
  toast('Změny uloženy');
  openClientDetail(currentClientId);
}

function openNewClient(){
  const cl={ id:uid(), key:'', name:'', birthDate:'', rodneCislo:'', idNumber:'',
    phone:'', email:'', address:'', datovaSchranka:'', label:'aktivni', notes:'', createdAt:Date.now() };
  appData.clients.unshift(cl); saveData(); renderAll();
  currentClientTab='cprehled';
  openClientDetail(cl.id);
  toast('Nový klient — vyplň údaje');
}

function newCaseForClient(clientId){
  const cl=appData.clients.find(x=>x.id===clientId);
  const c=blankCase({ clientId:clientId,
    clientName:cl?cl.name:'', birthDate:cl?cl.birthDate:'', rodneCislo:cl?cl.rodneCislo:'',
    idNumber:cl?cl.idNumber:'', address:cl?cl.address:'', datovaSchranka:cl?cl.datovaSchranka:'',
    lastActivity:'Vytvořeno pod klientem' });
  appData.cases.unshift(c); saveData(); renderAll();
  openCaseDetail(c.id); toast('Nový případ pod klientem');
}

function askDeleteClient(id){
  const cl=appData.clients.find(x=>x.id===id); if(!cl) return;
  const n=casesOfClient(cl).length;
  uiConfirm('Smazat klienta?', (cl.name||'Klient')+(n?(' · jeho '+n+' '+caseWord(n)+' zůstanou zachovány'):''), ()=>{
    appData.clients=appData.clients.filter(x=>x.id!==id);
    saveData(); renderAll(); showPage('clients'); toast('Klient smazán');
  });
}

function clientOfCase(c){
  if(c.clientId){ const cl=appData.clients.find(x=>x.id===c.clientId); if(cl) return cl; }
  const k=clientKeyOf(c);
  return k ? (appData.clients.find(x=>x.key===k)||null) : null;
}
function rrow(label,val){ return '<div class="frow"><label>'+label+'</label><div class="rval">'+(val?esc(val):'<span style="color:var(--dim)">—</span>')+'</div></div>'; }
function fmtD(s){ const d=parseCzDate(s); return d?d.toLocaleDateString('cs-CZ'):(s||''); }

function linkCaseClient(caseId){
  const c=appData.cases.find(x=>x.id===caseId); if(!c) return;
  openClientPicker(function(clientId){
    const cl=appData.clients.find(x=>x.id===clientId);
    c.clientId=clientId; if(cl) c.clientName=cl.name;
    saveData(); renderAll(); openCaseDetail(caseId); toast('Případ propojen s klientem');
  });
}
function createClientFromCase(caseId){
  const c=appData.cases.find(x=>x.id===caseId); if(!c) return;
  const cl={ id:uid(), key:'', name:c.clientName||'Nejmenovaný',
    birthDate:c.birthDate||'', rodneCislo:c.rodneCislo||'', idNumber:c.idNumber||'',
    phone:'', email:'', address:c.address||'', datovaSchranka:c.datovaSchranka||'',
    label:'aktivni', notes:'', createdAt:Date.now() };
  cl.key=(cl.rodneCislo&&cl.rodneCislo.trim())||normEv(cl.name);
  appData.clients.unshift(cl);
  c.clientId=cl.id;
  saveData(); renderAll(); openCaseDetail(caseId); toast('Klient založen z případu');
}

function openClientPicker(onPick){
  const cls=(appData.clients||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'','cs'));
  const ov=document.createElement('div'); ov.className='cfm-ov';
  const rows=cls.map(cl=>{
    const n=casesOfClient(cl).length;
    return '<div class="pick-row" data-name="'+esc((cl.name||'').toLowerCase())+'" data-id="'+cl.id+'">'+
      '<div class="cl-av" style="width:34px;height:34px;font-size:.9rem">'+esc(((cl.name||'?').trim().charAt(0)||'?').toUpperCase())+'</div>'+
      '<div style="flex:1;min-width:0"><div style="font-weight:600">'+esc(cl.name||'Nejmenovaný')+'</div>'+
      '<div style="font-size:.74rem;color:var(--muted)">'+(cl.phone?esc(cl.phone)+' · ':'')+n+' '+caseWord(n)+'</div></div>'+
      clientLabelBadge(cl.label)+'</div>';
  }).join('');
  ov.innerHTML='<div class="cfm rev pick"><div class="cfm-t">Nový případ — vyber klienta</div>'+
    '<input class="pick-search" id="pickSearch" placeholder="Hledat klienta…" autocomplete="off">'+
    '<div class="pick-list" id="pickList">'+(rows||'<div style="color:var(--muted);padding:10px">Zatím žádní klienti — založ nového níže.</div>')+'</div>'+
    '<div class="pick-new"><input id="pickNewName" placeholder="…nebo jméno nového klienta"><button class="btn gold sm" id="pickNewBtn">Založit a pokračovat</button></div>'+
    '<div class="cfm-b"><button class="btn ghost sm" data-no>Zrušit</button></div></div>';
  document.body.appendChild(ov);
  const close=()=>{ ov.remove(); document.removeEventListener('keydown',onKey); };
  const onKey=e=>{ if(e.key==='Escape') close(); };
  document.addEventListener('keydown',onKey);
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  ov.querySelector('[data-no]').onclick=close;
  ov.querySelector('#pickSearch').oninput=function(){ const q=normEv(this.value); ov.querySelectorAll('.pick-row').forEach(r=>{ r.style.display=normEv(r.dataset.name).includes(q)?'flex':'none'; }); };
  ov.querySelectorAll('.pick-row').forEach(r=>{ r.onclick=()=>{ close(); onPick(r.dataset.id); }; });
  const newIn=ov.querySelector('#pickNewName');
  const doNew=()=>{ const nm=newIn.value.trim();
    const cl={ id:uid(), key:'', name:nm||'', birthDate:'', rodneCislo:'', idNumber:'', phone:'', email:'', address:'', datovaSchranka:'', label:'aktivni', notes:'', createdAt:Date.now() };
    cl.key=normEv(cl.name); appData.clients.unshift(cl); saveData(); close(); onPick(cl.id);
  };
  ov.querySelector('#pickNewBtn').onclick=doNew;
  newIn.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); doNew(); } };
  setTimeout(()=>{ const s=ov.querySelector('#pickSearch'); if(s) s.focus(); },50);
}

function isFemaleUser(){ const n=(currentUser&&currentUser.name)||''; const last=n.split(' ').slice(-1)[0]||''; return /ová$|ská$/.test(last); }
function userLastName(){ const n=(currentUser&&currentUser.name)||''; return n.split(' ').slice(-1)[0]||''; }
function buildSalutation(){
  const s=appData.settings||{};
  if(s.salutation==='vlastni'){ const c=(s.salutationCustom||'').trim(); return c||(isFemaleUser()?'doktorko':'doktore'); }
  if(s.salutation==='paneDoktor') return isFemaleUser()?'paní doktorko':'pane doktore';
  return (isFemaleUser()?'doktorko ':'doktore ')+userLastName();
}
function greetNow(){ const h=new Date().getHours(); return h<10?'Dobré ráno':(h<18?'Dobrý den':'Dobrý večer'); }
// Export ZIP: data.json (text/metadata) + files/<id> (naskenované PDF z IndexedDB).
async function exportBackup(){
  const btn=document.getElementById('backupExportBtn');
  if(typeof JSZip==='undefined'){ toast('Chyba: knihovna ZIP se nenačetla (zkontroluj připojení).'); return; }
  try{
    if(btn){ btn.classList.add('dis'); btn.dataset.lbl=btn.textContent; btn.textContent='Balím zálohu…'; }
    appData.lastBackup = Date.now();
    saveData();
    const zip=new JSZip();
    zip.file('data.json', JSON.stringify(appData, null, 2));
    zip.file('zaloha.txt', 'Advokato — záloha dat\nVytvořeno: '+new Date().toLocaleString('cs-CZ')+'\nObsahuje data případů (data.json) i naskenované spisy (složka files/).\nObnovení: v aplikaci Nastavení → Importovat zálohu.');
    // přibal originály z IndexedDB
    const files=await idbGetAll();
    let nFiles=0;
    if(files.length){
      const folder=zip.folder('files');
      const manifest={};
      files.forEach(rec=>{ if(rec&&rec.blob){ folder.file(rec.id, rec.blob); manifest[rec.id]={name:rec.name||'',caseId:rec.caseId||'',when:rec.when||0}; nFiles++; } });
      zip.file('files-manifest.json', JSON.stringify(manifest));
    }
    const blob=await zip.generateAsync({type:'blob', compression:'DEFLATE', compressionOptions:{level:6}});
    const d=new Date();
    const name='advokato-zaloha-'+d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+'.zip';
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=name; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    renderAll(); renderSettings();
    toast('Záloha hotová — '+appData.cases.length+' případů, '+nFiles+' spisů ('+fmtBytes(blob.size)+')');
  }catch(err){ toast('Chyba zálohy: '+err.message); }
  finally{ if(btn){ btn.classList.remove('dis'); if(btn.dataset.lbl) btn.textContent=btn.dataset.lbl; } }
}
function fmtBytes(b){ return b>1048576?(b/1048576).toFixed(1)+' MB':Math.round(b/1024)+' kB'; }

// Import: .zip (data + PDF) i starší .json (jen text) — zpětně kompatibilní.
async function importBackup(input){
  const file=input.files[0]; if(!file){ return; }
  const isZip = /\.zip$/i.test(file.name) || file.type==='application/zip' || file.type==='application/x-zip-compressed';
  try{
    if(isZip){
      if(typeof JSZip==='undefined'){ toast('Chyba: knihovna ZIP se nenačetla.'); input.value=''; return; }
      const zip=await JSZip.loadAsync(file);
      const dataFile=zip.file('data.json');
      if(!dataFile) throw new Error('ZIP neobsahuje data.json — není to záloha aplikace.');
      const d=JSON.parse(await dataFile.async('string'));
      if(!d.cases || !d.clients) throw new Error('Neplatná data zálohy.');
      Object.assign(appData, d);
      saveData();
      // obnov soubory do IndexedDB
      const folder=zip.folder('files');
      let manifest={};
      const mf=zip.file('files-manifest.json'); if(mf){ try{ manifest=JSON.parse(await mf.async('string')); }catch(e){} }
      let nFiles=0;
      const entries=[];
      zip.forEach((path,entry)=>{ if(path.indexOf('files/')===0 && !entry.dir) entries.push(entry); });
      for(const entry of entries){
        const id=entry.name.replace(/^files\//,'');
        const blob=await entry.async('blob');
        const meta=manifest[id]||{};
        await idbPut({id, caseId:meta.caseId||'', name:meta.name||'', blob, when:meta.when||Date.now()});
        nFiles++;
      }
      renderAll(); renderSettings();
      toast('Záloha obnovena — '+d.cases.length+' případů, '+nFiles+' spisů');
    } else {
      // legacy JSON (jen text)
      const text=await file.text();
      const d=JSON.parse(text);
      if(!d.cases || !d.clients) throw new Error('Neplatný soubor zálohy.');
      Object.assign(appData, d);
      saveData(); renderAll(); renderSettings();
      toast('Záloha importována — '+d.cases.length+' případů (jen text, bez PDF)');
    }
  }catch(err){ toast('Chyba: '+err.message); }
  finally{ input.value=''; }
}
function setSalutation(val){ appData.settings.salutation=val; saveData(); renderAll(); renderSettings(); }
function setSalutationCustom(val){ appData.settings.salutationCustom=val; saveData(); renderAll(); const p=document.getElementById('setPreview'); if(p) p.textContent='Náhled: „'+greetNow()+', '+buildSalutation()+'"'; }
function renderSettings(){
  const s=appData.settings||{};
  const gw=greetNow();
  const opt=(val,label,sample)=>'<label class="set-opt'+(s.salutation===val?' on':'')+'"><input type="radio" name="salut" value="'+val+'"'+(s.salutation===val?' checked':'')+' onchange="setSalutation(this.value)"><div class="set-opt-tx"><div class="set-opt-t">'+label+'</div><div class="set-opt-s">'+esc(sample)+'</div></div></label>';
  const gkey=getGeminiKey();
  document.getElementById('settingsFull').innerHTML =
    '<div class="tile rev" style="margin-bottom:16px"><div class="tl">AI klíč (Gemini)</div>'+
    '<p style="color:var(--muted);font-size:.84rem;margin:-6px 0 14px;line-height:1.6">Nutný pro AI analýzy a chat nad spisem. Klíč získáš v <b>Google AI Studio</b>. Ukládá se <b>jen v tomto prohlížeči</b>, nikam se neodesílá.</p>'+
    (gkey?'<div class="keylock" style="margin-bottom:12px;color:var(--green)"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>Klíč je uložený ('+esc(gkey.slice(0,4))+'…'+esc(gkey.slice(-3))+').</div>':'')+
    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">'+
    '<input class="set-input" id="geminiKeyInputSet" type="password" placeholder="Vlož Gemini API klíč (AIza…)" style="flex:1;min-width:230px">'+
    '<button class="btn gold" onclick="saveGeminiKeySet()">Uložit klíč</button>'+
    (gkey?'<button class="btn" onclick="clearGeminiKeySet()">Smazat</button>':'')+
    '</div>'+
    '<div id="geminiKeyStatSet" style="margin-top:10px;font-size:.8rem;color:var(--muted)"></div>'+
    '<div class="keylock" style="margin-top:14px"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 4l-7 12A2 2 0 0 0 5 19h14a2 2 0 0 0 1.7-3l-7-12a2 2 0 0 0-3.4 0z"/></svg>Reálné spisy klientů jen s <b>placeným</b> klíčem (advokátní mlčenlivost) — free klíč posílá data Googlu na trénink. Free klíč jen na cvičné / anonymizované dokumenty.</div>'+
    '</div>'+
    '<div class="tile rev" style="margin-bottom:16px"><div class="tl">Oslovení na úvodní stránce</div>'+
    '<div style="font-size:.8rem;color:var(--muted);margin:-6px 0 14px">Jak tě má appka oslovovat v pozdravu na dashboardu.</div>'+
    '<div class="set-opts">'+
      opt('doktor','Doktore / doktorko + příjmení', gw+', '+(isFemaleUser()?'doktorko ':'doktore ')+userLastName())+
      opt('paneDoktor','Pane doktore / paní doktorko', gw+', '+(isFemaleUser()?'paní doktorko':'pane doktore'))+
      opt('vlastni','Vlastní oslovení', gw+', …')+
    '</div>'+
    (s.salutation==='vlastni'?'<div style="margin-top:12px"><input class="set-input" type="text" value="'+esc(s.salutationCustom||'')+'" placeholder="např. pane Nováku" oninput="setSalutationCustom(this.value)"></div>':'')+
    '<div class="set-preview" id="setPreview">Náhled: „'+gw+', '+esc(buildSalutation())+'"</div>'+
    '</div>'+
    '<div class="tile rev"><div class="tl">Záloha dat</div>'+
    '<p style="color:var(--muted);font-size:.84rem;margin-bottom:14px;line-height:1.6">Data jsou jen v tomto prohlížeči. Pravidelně exportuj zálohu jako <b>ZIP</b> — obsahuje případy, klienty <b>i naskenované spisy (PDF)</b>. Ochrana před výmazem prohlížeče nebo přechodem na jiné zařízení.</p>'+
    '<div class="keylock" style="margin-bottom:16px"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>Záloha zůstává u tebe — ukládá se do tvého počítače, nikam se neodesílá.</div>'+
    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">'+
    '<button class="btn gold" id="backupExportBtn" onclick="exportBackup()">↓ Exportovat zálohu (ZIP)</button>'+
    '<label class="btn" style="cursor:pointer">↑ Importovat zálohu<input type="file" accept=".zip,application/zip,application/json" style="display:none" onchange="importBackup(this)"></label>'+
    '</div>'+
    '<div id="backupStat" style="margin-top:12px;font-size:.78rem;color:var(--muted)">'+
    (appData.lastBackup ? '✓ Poslední záloha: '+new Date(appData.lastBackup).toLocaleDateString("cs-CZ") : 'Záloha ještě nebyla provedena.')+'</div>'+
    '</div>'+
    '<div class="tile rev" style="margin-top:16px"><div class="tl">Nápověda</div>'+
    '<p style="color:var(--muted);font-size:.84rem;margin-bottom:14px;line-height:1.6">Úvodní průvodce prvním spuštěním — jak nastavit AI klíč a nafotit první spis.</p>'+
    '<button class="btn" onclick="startOnboarding()">Spustit průvodce znovu</button>'+
    '</div>';
}

/* ----- Zákony (offline, data z eSbírky) ----- */
let lawData=null; let currentLawZ='vse';
const LAW_META={tz:{name:'Trestní zákoník',cite:'40/2009 Sb.',tag:'TZ'},tr:{name:'Trestní řád',cite:'141/1961 Sb.',tag:'TŘ'}};
function loadLaws(){
  if(lawData) return lawData;
  lawData={tz:[],tr:[]};
  try{ lawData.tz=JSON.parse(document.getElementById('law-tz').textContent)||[]; }catch(e){}
  try{ lawData.tr=JSON.parse(document.getElementById('law-tr').textContent)||[]; }catch(e){}
  return lawData;
}
function lawSetZ(z){ currentLawZ=z; document.querySelectorAll('.law-tg').forEach(b=>b.classList.toggle('on',b.dataset.z===z)); lawSearch(); }
function lawCardHtml(p){
  const tag=LAW_META[p._z].tag;
  return '<div class="law-card"><div class="law-h"><span class="law-tag law-tag-'+p._z+'">'+tag+'</span><span class="law-num">§ '+esc(p.num)+'</span>'+(p.title?'<b>'+esc(p.title)+'</b>':'')+'</div><div class="law-text">'+esc(p.text)+'</div></div>';
}
function lawSearch(){
  const all=loadLaws();
  const zlist = currentLawZ==='vse' ? ['tz','tr'] : [currentLawZ];
  const pool=[]; zlist.forEach(z=>(all[z]||[]).forEach(p=>pool.push(Object.assign({_z:z},p))));
  const res=document.getElementById('lawResults'); if(!res) return;
  const q=((document.getElementById('lawQ')||{}).value||'').trim();
  if(!q){
    const quick=[
      ['209','Podvod'],['205','Krádež'],['206','Zpronevěra'],['173','Loupež'],
      ['175','Vydírání'],['145','Těžké ublížení'],['274','Řízení pod vlivem'],['283','Drogy'],
      ['337','Maření výkonu úř. rozhodnutí'],['67','Důvody vazby (TŘ)']
    ];
    res.innerHTML=
      '<div class="law-empty">'+
        '<div class="es-ic"><svg viewBox="0 0 24 24" fill="none" stroke="var(--am)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M9 8h5M9 12h7M9 16h7"/></svg></div>'+
        '<div class="es-t">Vyhledávání v zákonech</div>'+
        '<div class="es-s">Napiš číslo paragrafu (např. <b>209</b>) nebo slovo (<b>podvod</b>, <b>vazba</b>). Hledá v trestním zákoníku i řádu.</div>'+
        '<div class="law-quick-lbl">Časté paragrafy</div>'+
        '<div class="law-quick">'+quick.map(p=>'<button class="law-chip" onclick="lawQuick(\''+p[0]+'\')"><b>§ '+p[0]+'</b> '+p[1]+'</button>').join('')+'</div>'+
      '</div>';
    return;
  }
  let hits=[];
  const numM=q.match(/^\s*§?\s*(\d+[a-z]?)\s*$/i);
  if(numM){
    const n=numM[1].toLowerCase();
    hits=pool.filter(p=>p.num.toLowerCase()===n);
    if(!hits.length) hits=pool.filter(p=>p.num.toLowerCase().indexOf(n)===0);
  } else {
    const nq=normEv(q), inT=[],inX=[];
    pool.forEach(p=>{ if(normEv(p.title||'').indexOf(nq)>=0) inT.push(p); else if(normEv(p.text||'').indexOf(nq)>=0) inX.push(p); });
    hits=inT.concat(inX).slice(0,50);
  }
  if(!hits.length){ res.innerHTML='<p style="color:var(--muted);padding:8px 2px">Nic nenalezeno. Zkus jiné slovo nebo číslo §.</p>'; return; }
  res.innerHTML='<div class="law-count">'+hits.length+' '+(hits.length===1?'výsledek':(hits.length<=4?'výsledky':'výsledků'))+'</div>'+hits.map(lawCardHtml).join('');
}
function lawQuick(num){ const i=document.getElementById('lawQ'); if(i){ i.value=num; lawSearch(); i.focus(); } }
function renderZakony(){
  loadLaws();
  document.getElementById('zakonyFull').innerHTML=
    '<div class="tile rev"><div class="law-bar">'+
      '<div class="law-toggle">'+
        '<button class="law-tg'+(currentLawZ==='vse'?' on':'')+'" data-z="vse" onclick="lawSetZ(\'vse\')">Vše</button>'+
        '<button class="law-tg'+(currentLawZ==='tz'?' on':'')+'" data-z="tz" onclick="lawSetZ(\'tz\')">Trestní zákoník</button>'+
        '<button class="law-tg'+(currentLawZ==='tr'?' on':'')+'" data-z="tr" onclick="lawSetZ(\'tr\')">Trestní řád</button>'+
      '</div>'+
      '<input id="lawQ" class="law-input" placeholder="Hledej § nebo slovo…" autocomplete="off" oninput="lawSearch()">'+
    '</div>'+
    '<div class="law-hint">Znění z eSbírky k 1. 1. 2026 · funguje offline · orientační — vždy ověř platné znění</div>'+
    '<div id="lawResults"></div></div>';
  lawSearch();
}

function renderSubPage(id){
  // jednoduché napojení dat; plné stránky přijdou v dalším kroku
  if(id==='settings'){ renderSettings(); return; }
  if(id==='zakony'){ renderZakony(); return; }
  if(id==='deadlines'){    const all=getAllDeadlines();
    const warn='<div class="dl-warn" style="margin:0 0 14px">⚠︎ Orientační výpočet. Vždy ověř datum doručení a konečnou lhůtu dle spisu — odpovědnost je na advokátovi.</div>';
    document.getElementById('deadlinesFull').innerHTML = warn + (all.length ?
      '<table><thead><tr><th>Případ</th><th>Typ</th><th>Konec lhůty</th><th>Zbývá</th></tr></thead><tbody>'+
      all.map(d=>{
        const col=d.daysLeft<0?'var(--red)':(d.daysLeft<=3?'var(--red)':(d.daysLeft<=14?'var(--am)':'var(--green)'));
        const note=(d.shifted?'<div style="font-size:.7rem;color:var(--am2)">posunuto z '+d.raw.toLocaleDateString('cs-CZ',{day:'numeric',month:'numeric'})+'</div>':'')+(d.fromVyhlaseni?'<div style="font-size:.7rem;color:var(--red)">od vyhlášení — doplň doručení</div>':'');
        return '<tr><td class="cl"><b>'+esc(d.caseName)+'</b></td><td>'+esc(d.short)+'</td><td class="par">'+d.deadline.toLocaleDateString('cs-CZ')+note+'</td><td class="par" style="color:'+col+'">'+(d.daysLeft<0?'propadlo':(d.daysLeft===0?'dnes':d.daysLeft+' '+dayWord(d.daysLeft)))+'</td></tr>';
      }).join('')+
      '</tbody></table>' : '<p style="color:var(--muted);padding:10px">Žádné lhůty. Doplň datum doručení rozsudku/příkazu/usnesení nebo přidej vlastní lhůtu.</p>');
  } else if(id==='cases'){
    renderCasesFolders();
  } else if(id==='clients'){
    renderClientsFolders();
  } else if(id==='documents'){
    // stav klíče (klíč samotný neukazujeme)
    updateKeyPill();
    const st=document.getElementById('geminiKeyStat');
    if(st && getGeminiKey()){ st.textContent='✓ Klíč je uložen v tomto prohlížeči.'; st.style.color='var(--green)'; }
    const docs=liveCases().flatMap(c=>(c.documents||[]).filter(d=>!d.deletedAt).map(d=>({c:c.clientName,cid:c.id,n:(d.name||d),t:d.type,when:d.when})));
    document.getElementById('documentsFull').innerHTML =
      '<div class="tl">Nahrané spisy</div>'+
      (docs.length ?
      '<table><thead><tr><th>Dokument</th><th>Typ</th><th>Klient</th><th>Nahráno</th></tr></thead><tbody>'+
      docs.map(d=>'<tr onclick="openCaseDetail(\''+d.cid+'\')"><td class="cl"><b>'+esc(d.n)+'</b></td><td class="par">'+esc(d.t||'—')+'</td><td>'+esc(d.c||'—')+'</td><td class="par">'+(d.when?new Date(d.when).toLocaleDateString('cs-CZ'):'—')+'</td></tr>').join('')+
      '</tbody></table>'
      : '<p style="color:var(--muted);padding:10px">Zatím žádné dokumenty. Nahraj spis výše — Gemini ho přečte a vytáhne data.</p>');
  } else if(id==='analysis'){
    const acases = liveCases();
    if(!acases.length){
      document.getElementById('analysisFull').innerHTML =
        '<div class="empty-state"><div class="es-icon">🔍</div>'+
        '<div class="es-t">Žádné případy</div>'+
        '<div class="es-s">Nejprve přidej případ — pak tu spustíš AI analýzy nad přepisem spisu.</div></div>';
    } else {
      document.getElementById('analysisFull').innerHTML =
        '<div class="tl" style="margin-bottom:6px">Vyber případ pro AI analýzu</div>'+
        '<p style="font-size:.8rem;color:var(--muted);margin-bottom:16px;line-height:1.5">Gemini AI prochází přepis spisu a generuje obrannou analýzu. Každý výstup vyžaduje kontrolu advokáta.</p>'+
        acases.map(function(c){
          const aC=(c.analyses||[]).length;
          const hasTr=!!(c.analysisText||'').trim();
          return '<div class="acase-pick" onclick="openCaseDetail(\''+c.id+'\');setTimeout(function(){switchDetailTab(\'analyzy\')},60)">'+
            '<div class="acp-l">'+
              '<div class="acp-name">'+esc(c.clientName||'Bez jména')+'</div>'+
              '<div class="acp-meta">'+esc(c.spisZnacka||'bez spis. zn.')+' · '+esc(c.faze||'—')+(hasTr?' · <span style="color:var(--green)">spis nahrán</span>':'')+'</div>'+
            '</div>'+
            (aC?'<span class="acp-badge">'+aC+' '+(aC===1?'analýza':aC<=4?'analýzy':'analýz')+'</span>':'')+
            '<span class="acp-arr">→</span>'+
          '</div>';
        }).join('')+
        '<div style="margin-top:14px;padding:12px 14px;background:var(--am-soft);border:1px solid rgba(245,158,11,.2);border-radius:11px;font-size:.78rem;color:var(--muted)">'+
        '⚠ Analýzy AI vyžadují Gemini API klíč a nahrání přepisu spisu (záložka <b>Dokumenty</b>). Návrhy vždy podléhají kontrole advokáta.</div>';
    }
  }
}

function blankCase(extra){
  return Object.assign({
    id: uid(),
    clientId:'', clientName:'Nový klient',
    birthDate:'', rodneCislo:'', idNumber:'', datovaSchranka:'', address:'',
    spisZnacka:'', pravniKvalifikace:'', obvineni:[], faze:'Přípravné', status:'',
    soud:'', soudce:'', statniZastupce:'', obhajce:(currentUser&&currentUser.name)||'',
    vysetrovatel:'', judgmentDate:'', judgmentDeliveryDate:'', custodyDate:'', orderDeliveryDate:'', rulingNoticeDate:'', manualDeadlines:[], vyseSkody:'',
    timeline:[], documentType:'', lastActivity:'Vytvořeno ručně',
    checklist: defaultChecklist(), checklistNote:'', hearings:[], meetings:[], custody:{inCustody:false,fromDate:'',fromTime:'',reason:'',note:''}, seizures:[], persons:[], interrogations:[],
    analysisText:'', documents:[], analyses:[], createdAt: Date.now()
  }, extra||{});
}
function openNewCase(){
  openClientPicker(function(clientId){ newCaseForClient(clientId); });
}

/* ============ GEMINI / OCR (KROK 2) ============ */
// Jediné místo s URL. Přechod na proxy = přepiš návratovou hodnotu na vlastní endpoint.
function getGeminiUrl(stream){
  const key = localStorage.getItem(GEMINI_KEY_LS) || '';
  const method = stream ? 'streamGenerateContent?alt=sse&key=' : 'generateContent?key=';
  return 'https://generativelanguage.googleapis.com/v1beta/models/'+activeGeminiModel()+':'+method+key;
}
// Sdílený fetch na Gemini s opakováním + přepnutím modelu při přetížení. Vrací Response (pro JSON i stream).
async function geminiFetch(body, stream){
  const overloadWaits=[2500,5000,10000,18000,28000];
  let lastMsg='';
  for(let attempt=0; attempt<8; attempt++){
    let r;
    try{
      r=await fetch(getGeminiUrl(stream),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    }catch(netErr){
      lastMsg='Síť: '+netErr.message;
      if(attempt<7){ toast('Výpadek sítě — zkouším znovu…'); await _sleep(3000); continue; }
      throw new Error(lastMsg);
    }
    if(r.ok) return r;
    const e=await r.json().catch(()=>({}));
    const msg=(e.error&&e.error.message)||('HTTP '+r.status);
    lastMsg=msg;
    const overloaded = r.status===503 || r.status===500 || /high demand|overload|try again later|unavailable/i.test(msg);
    const notFound  = r.status===404 || /not found|not supported|does not exist/i.test(msg);
    const rateLimited = r.status===429 || /quota|rate limit/i.test(msg);
    // špatný/nedostupný model → hned zkus další v řetězci
    if(notFound && geminiModelIdx<GEMINI_MODELS.length-1){ geminiModelIdx++; toast('Model nedostupný → přepínám na '+activeGeminiModel()); continue; }
    if(rateLimited && attempt<7){ toast('Limit free klíče — čekám 60 s…'); await _sleep(60000); continue; }
    if(overloaded && attempt<7){
      // po 2 marných pokusech na hlavním modelu zkus záložní
      if(attempt>=2 && geminiModelIdx<GEMINI_MODELS.length-1){ geminiModelIdx++; toast('Přetížení → zkouším model '+activeGeminiModel()+'…'); continue; }
      const w=overloadWaits[Math.min(attempt,overloadWaits.length-1)];
      toast('Gemini přetížený — zkouším znovu za '+(w/1000)+' s…');
      await _sleep(w); continue;
    }
    throw new Error(msg);
  }
  throw new Error(lastMsg||'Gemini se nepodařilo zavolat.');
}
function geminiMissingHint(){
  if(window.NA_RUNTIME&&window.NA_RUNTIME.server) return 'Gemini klíč nastaví administrátor v /admin/ → API klíče.';
  return 'Nejdřív ulož Gemini klíč v Nastavení.';
}
// Uložení / smazání klíče ze stránky Nastavení (vlastní vstup, aby nekolidoval s Dokumenty)
function saveGeminiKeySet(){
  const inp=document.getElementById('geminiKeyInputSet'); if(!inp) return;
  const v=inp.value.trim(); const st=document.getElementById('geminiKeyStatSet');
  if(!v){ if(st){ st.textContent='Vlož klíč.'; st.style.color='var(--red)'; } return; }
  localStorage.setItem(GEMINI_KEY_LS, v);
  if(typeof updateKeyPill==='function') updateKeyPill();
  toast('Gemini klíč uložen'); renderSettings();
}
function clearGeminiKeySet(){
  localStorage.removeItem(GEMINI_KEY_LS);
  if(typeof updateKeyPill==='function') updateKeyPill();
  toast('Klíč smazán'); renderSettings();
}
function getGeminiKey(){ return localStorage.getItem(GEMINI_KEY_LS) || ''; }

function saveGeminiKey(){
  const v = document.getElementById('geminiKeyInput').value.trim();
  const st = document.getElementById('geminiKeyStat');
  if(!v){ st.textContent='Vlož klíč.'; st.style.color='var(--red)'; return; }
  localStorage.setItem(GEMINI_KEY_LS, v);
  st.textContent='✓ Klíč uložen v tomto prohlížeči.'; st.style.color='var(--green)';
  updateKeyPill();
  toast('Gemini klíč uložen');
}
// Přepne zobrazení klíče (heslo ↔ text)
function toggleKeyVisibility(){
  const inp=document.getElementById('geminiKeyInput'); if(!inp) return;
  inp.type = inp.type==='password' ? 'text' : 'password';
}
// Aktualizuje pilulku stavu klíče
function updateKeyPill(){
  const pill=document.getElementById('keyPill'); if(!pill) return;
  const k=getGeminiKey();
  if(k){ pill.textContent='nastaven · '+k.slice(0,4)+'…'+k.slice(-3); pill.classList.add('set'); }
  else { pill.textContent='není nastaven'; pill.classList.remove('set'); }
}
async function testGeminiKey(){
  const st = document.getElementById('geminiKeyStat');
  const inputVal = document.getElementById('geminiKeyInput').value.trim();
  if(inputVal) localStorage.setItem(GEMINI_KEY_LS, inputVal);
  if(!getGeminiKey()){ st.textContent='Nejdřív vlož a ulož klíč.'; st.style.color='var(--red)'; return; }
  st.textContent='Testuji…'; st.style.color='var(--muted)';
  try{
    const r = await fetch(getGeminiUrl(),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents:[{parts:[{text:'Odpověz jen: OK'}]}],generationConfig:{maxOutputTokens:10}})});
    if(r.ok){ st.textContent='✓ Klíč funguje.'; st.style.color='var(--green)'; toast('Klíč funguje'); }
    else{ const e=await r.json(); st.textContent='✗ '+((e.error&&e.error.message)||('HTTP '+r.status)); st.style.color='var(--red)'; }
  }catch(e){ st.textContent='✗ '+e.message; st.style.color='var(--red)'; }
}

// Opakování při dočasných chybách Gemini:
//  • 503 / „high demand" / overloaded → přetížený server → krátké čekání, víc pokusů
//  • 429 → limit (free klíč) → dlouhé čekání (limit se resetuje po minutě)
//  • síťový výpadek → krátké čekání
// Tenký wrapper nad geminiFetch — vrací JSON. Opakování + přepnutí modelu řeší geminiFetch.
async function geminiCallWithRetry(body){
  const r=await geminiFetch(body, false);
  return r.json();
}

// progress
let ocrTimer=null;
function startOcrProgress(){
  const msgs=['Načítám dokument…','Čtu text a sken…','Hledám paragrafy a spisovou značku…','Identifikuji osoby a data…','Vytahuji strukturovaná data…','Finalizuji…'];
  const prog=document.getElementById('ocrProg'),fill=document.getElementById('ocrFill'),msg=document.getElementById('ocrMsg');
  prog.classList.add('on'); let i=0; fill.style.width='12%'; msg.textContent=msgs[0];
  ocrTimer=setInterval(()=>{ i=Math.min(i+1,msgs.length-1); fill.style.width=(12+i*14)+'%'; msg.textContent=msgs[i]; },3500);
}
function stopOcrProgress(){
  if(ocrTimer) clearInterval(ocrTimer);
  const prog=document.getElementById('ocrProg'),fill=document.getElementById('ocrFill');
  fill.style.width='100%'; setTimeout(()=>{ prog.classList.remove('on'); fill.style.width='0'; },500);
}

function fileToBase64(file){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(',')[1]); r.onerror=rej; r.readAsDataURL(file); });
}

const OCR_SCHEMA = {
  type:'OBJECT',
  properties:{
    documentType:{type:'STRING'},
    clientName:{type:'STRING'},
    birthDate:{type:'STRING'},
    rodneCislo:{type:'STRING'},
    idNumber:{type:'STRING'},
    datovaSchranka:{type:'STRING'},
    address:{type:'STRING'},
    spisZnacka:{type:'STRING'},
    pravniKvalifikace:{type:'STRING'},
    obvineni:{type:'ARRAY',items:{type:'STRING'}},
    faze:{type:'STRING'},
    status:{type:'STRING'},
    soud:{type:'STRING'},
    soudce:{type:'STRING'},
    statniZastupce:{type:'STRING'},
    vysetrovatel:{type:'STRING'},
    judgmentDate:{type:'STRING'},
    custodyDate:{type:'STRING'},
    vyseSkody:{type:'STRING'},
    timeline:{type:'ARRAY',items:{type:'OBJECT',properties:{date:{type:'STRING'},event:{type:'STRING'}},required:['date','event']}},
    persons:{type:'ARRAY',items:{type:'OBJECT',properties:{name:{type:'STRING'},role:{type:'STRING'},birthDate:{type:'STRING'},address:{type:'STRING'},phone:{type:'STRING'},email:{type:'STRING'},contact:{type:'STRING'},note:{type:'STRING'}}}},
    summary:{type:'STRING'},
    fullText:{type:'STRING'}
  }
};
const OCR_PROMPT =
'Jsi asistent českého trestního advokáta. Přečti CELÝ přiložený dokument (i naskenovaný) a vrať POUZE JSON dle schématu. '+
'Pravidla: '+
'documentType = typ (obžaloba, rozsudek, usnesení, trestní příkaz, protokol, jiné). '+
'KLIENT (obviněný/obžalovaný): clientName = celé jméno; birthDate = datum narození YYYY-MM-DD; rodneCislo = rodné číslo; idNumber = číslo OP nebo pasu; datovaSchranka = ID datové schránky; address = adresa trvalého bydliště. '+
'PŘÍPAD: spisZnacka = spisová značka (např. 2 T 45/2024); '+
'pravniKvalifikace = slovní právní kvalifikace skutku (např. "krádež dle § 205 odst. 1 TZ"); '+
'obvineni = pole čísel paragrafů TZ bez "§" (např. ["205","234"]); '+
'faze = fáze řízení (Přípravné, Hlavní líčení, Odvolání, Dovolací); '+
'status = stav (přípravné řízení, obžaloba, soud, odvolání, skončeno); '+
'soud = název soudu/orgánu; soudce = jméno soudce; statniZastupce = jméno státního zástupce; vysetrovatel = jméno a útvar vyšetřovatele/policejního orgánu; '+
'judgmentDate = datum vyhlášení rozsudku YYYY-MM-DD; custodyDate = datum vzetí do vazby YYYY-MM-DD; '+
'vyseSkody = výše způsobené škody i s měnou (např. "1 250 000 Kč"); '+
'timeline = pole VŠECH událostí s konkrétním datem ze spisu, každá {date:"YYYY-MM-DD", event:"krátký výstižný popis"}. Postupuj odshora dolů a vypiš KAŽDOU datovanou událost, kterou v textu najdeš — jedna událost = jeden záznam. Patří sem mj.: zahájení/rozšíření trestního stíhání, jednotlivé výslechy a podaná vysvětlení (s uvedením osoby), domovní prohlídky, zajištění věcí, výběry hotovosti, podání obžaloby, nařízená jednání, vydané dokumenty, vznik škody. Cílem je ÚPLNOST — raději uveď událost navíc než abys nějakou vynechal; případné duplicity vyřeším později sám. Vypisuj jen události, které mají v dokumentu konkrétní datum; '+
'persons = pole VŠECH osob zúčastněných na věci KROMĚ samotného klienta/obviněného (toho už vracíš v clientName), soudce, státního zástupce a vyšetřovatele (ty vracíš zvlášť výše). Sem patří: svědci, poškození, spoluobvinění/spolupachatelé, znalci, případně další. '+
'U KAŽDÉ osoby vytáhni VŠECHNY dostupné údaje, které o ní spis uvádí — toto je klíčové: '+
'{name:"celé jméno i s tituly", role:"jedno z: svedek, poskozeny, spolupachatel, obvineny, znalec, jine", '+
'birthDate:"datum narození YYYY-MM-DD pokud je uvedeno", '+
'address:"celá adresa bydliště pokud je uvedena", '+
'phone:"telefonní číslo pokud je uvedeno", '+
'email:"e-mail pokud je uveden", '+
'contact:"případný další kontaktní údaj (datová schránka, zaměstnavatel apod.)", '+
'note:"krátká poznámka — čeho se účast týká, např. co osoba viděla/jaká škoda jí vznikla"}. '+
'Procházej text PEČLIVĚ a u osoby přiřaď i údaje, které jsou uvedené o pár řádků dál (např. „svědek Jan Novák, nar. 1.2.1980, bytem Praha 5, tel. 777..."). Když některý údaj o osobě není, vrať u něj prázdný řetězec. Tutéž osobu uveď JEN JEDNOU se všemi posbíranými údaji, i když je v textu zmíněna vícekrát. role piš PŘESNĚ jednou z uvedených hodnot bez diakritiky; '+
'summary = 2–3 věty shrnutí; fullText = co nejvěrnější přepis textu dokumentu. '+
'POSTUP: Projdi dokument systematicky odshora dolů, nevynech žádnou stránku ani oddíl. Cílem je ÚPLNOST — u timeline a persons raději uveď záznam navíc než abys ho vynechal. '+
'Když údaj v dokumentu není, vrať prázdný řetězec nebo prázdné pole. Nic si nevymýšlej.';

async function handleOcrFile(file){
  if(!file) return;
  if(file.type!=='application/pdf'){ toast('Zatím jen PDF.'); return; }
  if(!getGeminiKey()){ toast(geminiMissingHint()); const inp=document.getElementById('geminiKeyInput'); if(inp) inp.focus(); return; }
  if(file.size>18*1024*1024){ toast('Soubor >18 MB — rozděl ho nebo zmenši.'); return; }
  startOcrProgress();
  try{
    const b64 = await fileToBase64(file);
    const data = await geminiCallWithRetry({
      contents:[{parts:[
        { inline_data:{ mime_type:'application/pdf', data:b64 } },
        { text:OCR_PROMPT }
      ]}],
      generationConfig:{ temperature:0, maxOutputTokens:16384, responseMimeType:'application/json', responseSchema:OCR_SCHEMA }
    });
    const raw = data.candidates && data.candidates[0] && data.candidates[0].content
              && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
              && data.candidates[0].content.parts[0].text;
    if(!raw) throw new Error('Prázdná odpověď od Gemini.');
    let ex; try{ ex=JSON.parse(raw); }catch(e){ throw new Error('Gemini nevrátil platný JSON.'); }
    ex._fileName = file.name;
    ex._when = Date.now();
    const pages = await pdfPageCount(file);
    ex._pageCount = pages || null;
    extractedData = ex;
    renderExtract(ex);
    toast('Dokument přečten — zkontroluj souhrn');
  }catch(e){
    toast('Chyba OCR: '+e.message);
  }finally{
    stopOcrProgress();
    document.getElementById('ocrFileInput').value='';
  }
}

function statsFromExtract(ex, pageCount, cBefore){
  const persons=(ex.persons||[]).filter(p=>p&&(p.name||'').trim()).length;
  const events=(ex.timeline||[]).filter(t=>t&&t.date).length;
  let deadlines=0;
  if(cBefore){
    const snap=JSON.parse(JSON.stringify(cBefore));
    applyExtractedToCase(snap, ex, 'preview');
    deadlines=Math.max(0, calculateDeadlines(snap).length-calculateDeadlines(cBefore).length);
  } else {
    const tmp={judgmentDate:ex.judgmentDate||'',custodyDate:ex.custodyDate||'',rulingNoticeDate:ex.rulingNoticeDate||'',judgmentDeliveryDate:ex.judgmentDeliveryDate||'',orderDeliveryDate:ex.orderDeliveryDate||''};
    deadlines=calculateDeadlines(tmp).length;
  }
  return {
    persons: persons||0,
    events: events||0,
    deadlines: deadlines||0,
    amount: (ex.vyseSkody||'').trim()||'—',
    spisZnacka: (ex.spisZnacka||'').trim()||'—',
    pages: pageCount||ex._pageCount||'—'
  };
}
function extractStatsHtml(st){
  const cell=(l,v)=>'<div class="extract-stat"><div class="extract-stat-l">'+l+'</div><div class="extract-stat-v">'+esc(String(v))+'</div></div>';
  return cell('Osoby',st.persons+' nalezeno')+cell('Události',st.events+' na timeline')+cell('Lhůty',st.deadlines+' nové')+
    cell('Částky',st.amount)+cell('Spis. zn.',st.spisZnacka)+cell('Stran',st.pages);
}
function showExtractRecapView(){
  const recap=document.getElementById('extractRecap'), edit=document.getElementById('extractEditWrap'), title=document.getElementById('extractTileTitle');
  if(recap) recap.style.display='block';
  if(edit) edit.style.display='none';
  if(title) title.textContent='Co se našlo';
}
function showExtractEdit(){
  const recap=document.getElementById('extractRecap'), edit=document.getElementById('extractEditWrap'), title=document.getElementById('extractTileTitle');
  if(recap) recap.style.display='none';
  if(edit) edit.style.display='block';
  if(title) title.textContent='Vytažená data — zkontroluj a uprav';
  document.getElementById('extractEditWrap').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function renderExtractEditFields(ex){
  const g=document.getElementById('extractGrid');
  if(!g) return;
  const fld=(id,label,val,full,area)=>
    '<div class="exfield'+(full?' full':'')+'"><label>'+label+'</label>'+
    (area?('<textarea id="'+id+'">'+esc(val||'')+'</textarea>')
         :('<input id="'+id+'" value="'+esc(val||'')+'">'))+'</div>';
  g.innerHTML =
    fld('exType','Typ dokumentu',ex.documentType)+
    fld('exClient','Klient / obviněný',ex.clientName)+
    fld('exSpis','Spisová značka',ex.spisZnacka)+
    fld('exSoud','Soud / orgán',ex.soud)+
    fld('exObv','Paragrafy (§, čárkou)',(ex.obvineni||[]).join(', '))+
    fld('exFaze','Fáze řízení',ex.faze)+
    fld('exJudg','Datum rozsudku (RRRR-MM-DD)',ex.judgmentDate)+
    fld('exCust','Vzetí do vazby (RRRR-MM-DD)',ex.custodyDate)+
    fld('exSum','Shrnutí',ex.summary,true,true)+
    '<div class="exfield full"><label>Zdroj: '+esc(ex._fileName||'')+' · přepis se uloží k případu pro pozdější AI analýzy</label></div>';
}
function renderExtract(ex){
  const st=statsFromExtract(ex, ex._pageCount||null, null);
  const grid=document.getElementById('extractStatsGrid');
  if(grid) grid.innerHTML=extractStatsHtml(st);
  renderExtractEditFields(ex);
  showExtractRecapView();
  document.getElementById('extractTile').style.display='block';
  document.getElementById('extractTile').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function caseExtractRecapHtml(st){
  return '<div class="tile rev case-extract-recap" id="caseExtractRecapTile">'+
    '<div class="tl">Co se našlo</div>'+
    '<div class="extract-stats">'+extractStatsHtml(st)+'</div>'+
    '<div class="extract-recap-btns">'+
    '<button class="btn gold sm" onclick="openCaseTimelineFromRecap()">Zobrazit v timeline</button>'+
    '<button class="btn ghost sm" onclick="showExtractEditForCase()">Opravit extrakci</button>'+
    '</div></div>';
}
function openCaseTimelineFromRecap(){
  lastCaseExtractRecap=null;
  const t=document.getElementById('caseExtractRecapTile'); if(t) t.remove();
  currentDetailTab='osa';
  switchDetailTab('osa');
  refreshTimeline();
}
function showExtractEditForCase(){
  currentDetailTab='prehled';
  switchDetailTab('prehled');
  toast('Uprav pole případu v záložce Přehled — spisová značka, data, osoby');
}

function cancelExtract(){ extractedData=null; document.getElementById('extractTile').style.display='none'; }

function normalizeExtractedPersons(arr){
  if(!Array.isArray(arr)) return [];
  const valid=['svedek','poskozeny','spolupachatel','obvineny','znalec','jine'];
  return arr.filter(p=>p&&(p.name||'').trim()).map(p=>{
    let role=String(p.role||'').toLowerCase().trim();
    if(valid.indexOf(role)<0) role='jine';
    return { id:uid(), name:(p.name||'').trim(), role:role,
      birthDate:(p.birthDate||'').trim(), address:(p.address||'').trim(),
      phone:(p.phone||'').trim(), email:(p.email||'').trim(),
      contact:(p.contact||'').trim(), note:(p.note||'').trim() };
  });
}

function saveExtractedAsCase(openTab){
  if(!extractedData){ return; }
  const ex=extractedData;
  const v=id=>{ const el=document.getElementById(id); return el?el.value.trim():''; };
  const obv = v('exObv').split(',').map(s=>s.replace(/§|\s/g,'')).filter(Boolean);
  const c={
    id: uid(),
    // KLIENT
    clientName: v('exClient')||ex.clientName||'Nejmenovaný',
    birthDate: ex.birthDate||'',
    rodneCislo: ex.rodneCislo||'',
    idNumber: ex.idNumber||'',
    datovaSchranka: ex.datovaSchranka||'',
    address: ex.address||'',
    // PŘÍPAD
    spisZnacka: v('exSpis')||ex.spisZnacka||'',
    pravniKvalifikace: ex.pravniKvalifikace||'',
    obvineni: obv.length?obv:(ex.obvineni||[]),
    faze: v('exFaze')||ex.faze||'Přípravné',
    status: ex.status||'',
    soud: v('exSoud')||ex.soud||'',
    soudce: ex.soudce||'',
    statniZastupce: ex.statniZastupce||'',
    obhajce: (currentUser&&currentUser.name)||'',
    vysetrovatel: ex.vysetrovatel||'',
    judgmentDate: v('exJudg')||ex.judgmentDate||'',
    custodyDate: v('exCust')||ex.custodyDate||'',
    vyseSkody: ex.vyseSkody||'',
    timeline: Array.isArray(ex.timeline)?ex.timeline.filter(t=>t&&t.date).map(t=>({date:t.date,event:t.event||'',sourceDoc:ex._fileName||'spis.pdf',id:uid()})):[],
    persons: normalizeExtractedPersons(ex.persons),
    documentType: v('exType')||ex.documentType||'',
    lastActivity: 'Spis nahrán',
    analysisText: ex.fullText||'',
    documents: [{ name: ex._fileName||'spis.pdf', type: v('exType')||ex.documentType||'', when: ex._when, summary: v('exSum')||ex.summary||'' }],
    analyses: []
  };
  appData.cases.unshift(c);
  saveData();
  extractedData=null;
  document.getElementById('extractTile').style.display='none';
  renderAll();
  toast('Případ vytvořen — otevírám detail');
  if(openTab==='osa'){ currentDetailTab='osa'; openCaseDetail(c.id); }
  else openCaseDetail(c.id);
}

// drag & drop
function initDrop(){
  const dz=document.getElementById('dropZone'); if(!dz) return;
  ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('over');}));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('over');}));
  dz.addEventListener('drop',e=>{ const f=e.dataTransfer.files[0]; if(f) handleOcrFile(f); });
}

/* ============ DETAIL PŘÍPADU (KROK 2) ============ */
let currentDetailId=null;
let currentDetailTab='prehled';
function frow(label,id,val,type){
  return '<div class="frow"><label>'+label+'</label><input id="'+id+'" type="'+(type||'text')+'" value="'+esc(val||'')+'"></div>';
}

// Tolerantní parser dat: zvládne YYYY-MM-DD, DD.MM.YYYY i "8. března 2021"
function parseCzDate(s){
  if(!s) return null;
  if(s instanceof Date) return isNaN(s)?null:s;
  s=String(s).trim();
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m) return new Date(+m[1],+m[2]-1,+m[3]);
  m=s.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if(m) return new Date(+m[3],+m[2]-1,+m[1]);
  const mes={'ledna':0,'února':1,'unora':1,'března':2,'brezna':2,'dubna':3,'května':4,'kvetna':4,'června':5,'cervna':5,'července':6,'cervence':6,'srpna':7,'září':8,'zari':8,'října':9,'rijna':9,'listopadu':10,'prosince':11};
  m=s.match(/(\d{1,2})\.\s*([a-zá-ž]+)\s*(\d{4})/i);
  if(m && mes[m[2].toLowerCase()]!==undefined) return new Date(+m[3],mes[m[2].toLowerCase()],+m[1]);
  const d=new Date(s); return isNaN(d)?null:d;
}

// normalizace pro porovnání (bez diakritiky, malá písmena, jen alfanumerika)
function normEv(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }
function levDist(a,b){
  const m=a.length,n=b.length; if(!m) return n; if(!n) return m;
  let prev=Array.from({length:n+1},(_,i)=>i);
  for(let i=1;i<=m;i++){ const cur=[i]; for(let j=1;j<=n;j++){ cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1)); } prev=cur; }
  return prev[n];
}
const EV_STOP=new Set(['a','i','k','o','s','u','v','z','na','ve','ze','se','do','od','po','za','pro','kdy','kde','kterem','ktere','ktery','ktera','byl','byla','bylo','dle','tez','jako','pri','pod','nad','mezi','jeho','jim','ji','si','to','ten','tato','toto','dne','roku']);
// množina kmenů významových slov (prvních 5 znaků) — „respiratory" i „respiratoru" → „respi"
function evStems(label){
  const set=new Set();
  normEv(label).split(' ').forEach(w=>{ if(w.length>=2 && !EV_STOP.has(w)) set.add(w.slice(0,5)); });
  return set;
}
function evOverlap(a,b){
  const A=evStems(a),B=evStems(b); if(!A.size||!B.size) return 0;
  let sh=0; A.forEach(x=>{ if(B.has(x)) sh++; });
  return sh/Math.min(A.size,B.size);
}
// sloučí jen záznamy SE STEJNÝM DATEM, které jsou totožné nebo silně překrývající. Různá jména/skutky nechá.
function dedupeTimeline(items){
  const byDate={};
  items.forEach(it=>{ const k=it.dt.getFullYear()+'-'+it.dt.getMonth()+'-'+it.dt.getDate(); (byDate[k]=byDate[k]||[]).push(it); });
  const out=[];
  Object.keys(byDate).forEach(k=>{
    const kept=[];
    byDate[k].forEach(it=>{
      const n=normEv(it.label); let dup=false;
      for(const ke of kept){
        const m=normEv(ke.label);
        const thr=Math.max(2,Math.floor(Math.min(n.length,m.length)*0.12));
        if(n===m || (n.length>6&&m.length>6&&(n.includes(m)||m.includes(n))) || levDist(n,m)<=thr || evOverlap(it.label,ke.label)>=0.6){
          dup=true; if(it.label.length>ke.label.length) ke.label=it.label; ke.src=(ke.src||[]).concat(it.src||[]); break;
        }
      }
      if(!dup) kept.push(it);
    });
    kept.forEach(x=>out.push(x));
  });
  return out.sort((a,b)=>a.dt-b.dt);
}

// Každá uložená událost má stabilní id (kvůli statusu/poznámce obhajoby).
function ensureEventIds(c){
  let changed=false;
  (c.timeline||[]).forEach(t=>{ if(t && !t.id){ t.id=uid(); changed=true; } });
  if(changed) saveData();
}
// Sestaví časovou osu z dat, co už v případu jsou — žádné volání API.
function buildTimeline(c){
  ensureEventIds(c);
  const items=[];
  const push=(d,label,kind,src,doc)=>{ const dt=parseCzDate(d); if(!dt) return; items.push({dt,label,kind,src:src||null,doc:doc||''}); };
  (c.timeline||[]).forEach(t=>{ if(t&&t.date&&!t.deletedAt) push(t.date,t.event||'Událost','event',[t],t.sourceDoc||''); });
  push(c.custodyDate,'Vzetí do vazby','custody');
  push(c.judgmentDate,'Vyhlášení rozsudku','judgment');
  calculateDeadlines(c).forEach(dl=>{ items.push({dt:dl.deadline,label:dl.label+' (lhůta)',kind:'deadline',src:null,doc:''}); });
  const now=new Date();
  const clean=dedupeTimeline(items);
  clean.forEach(i=>{ i.future = i.dt>now; });
  return clean;
}
let tlView=[];
function isoDate(dt){ const p=n=>String(n).padStart(2,'0'); return dt.getFullYear()+'-'+p(dt.getMonth()+1)+'-'+p(dt.getDate()); }
function refreshTimeline(){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const tile=document.getElementById('dpanel-osa') && document.getElementById('dpanel-osa').querySelector('.tile');
  if(tile) tile.innerHTML='<div class="tl">Časová osa · porovnání verzí</div>'+tlToolbarHtml()+renderTimeline(c);
}
function tlClassifyEvent(label, kind){
  if(kind==='deadline') return 'deadline';
  if(kind==='custody'||kind==='judgment') return 'court';
  const s=String(label||'').toLowerCase();
  if(/platb|kč|částk|peníz|hotovost|převod|úhrad/.test(s)) return 'pay';
  if(/dokument|usnesen|protokol|obžalob|předán|doručen|nahrán|spis/.test(s)) return 'doc';
  if(/soud|líčení|jednání|rozsudek|vyhlášen|vazb|stížnost|odvolán/.test(s)) return 'court';
  if(/výslech|svědek|poškozen|obviněn|osoba|znal/.test(s)) return 'person';
  return 'other';
}
function tlToolbarHtml(){
  const chips=[['all','Vše'],['pay','Platby'],['doc','Dokumenty'],['court','Soud'],['person','Osoby'],['deadline','Lhůty']];
  return '<div class="tl-toolbar">'+
    '<div class="tl-search-wrap"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>'+
    '<input type="search" placeholder="Hledat v timeline…" value="'+esc(tlSearchQ)+'" oninput="tlSetSearch(this.value)"></div>'+
    '<div class="tl-chips">'+chips.map(([k,l])=>'<button type="button" class="tl-chip'+(tlFilterChip===k?' on':'')+'" onclick="tlSetFilter(\''+k+'\')">'+l+'</button>').join('')+'</div>'+
    '<div class="tl-actions">'+
    '<button type="button" class="btn sm" onclick="tlAddEvent()">+ Přidat událost</button>'+
    '<button type="button" class="btn sm" onclick="exportTimelineWord()">Export timeline (Word)</button>'+
    '<button type="button" class="btn sm" onclick="exportTimelinePDF()">Export timeline (PDF)</button>'+
    '</div></div>';
}
function tlSetFilter(k){ tlFilterChip=k; refreshTimeline(); }
function tlSetSearch(q){ tlSearchQ=(q||'').trim(); refreshTimeline(); }
function tlFilterItems(items){
  const q=normFold(tlSearchQ);
  return items.filter(it=>{
    const cat=tlClassifyEvent(it.label, it.kind);
    if(tlFilterChip!=='all'){
      if(tlFilterChip==='deadline' && it.kind!=='deadline') return false;
      if(tlFilterChip!=='deadline' && tlFilterChip!=='all' && cat!==tlFilterChip && !(tlFilterChip==='court'&&it.kind==='custody')) return false;
    }
    if(!q) return true;
    const hay=normFold([it.label,it.doc,it.kind==='event'&&it.src&&it.src[0]?it.src[0].defNote:'',it.kind==='event'&&it.src&&it.src[0]?it.src[0].defEvent:''].filter(Boolean).join(' '));
    return hay.includes(q);
  });
}
function tlAddEvent(){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const ov=document.createElement('div'); ov.className='cfm-ov';
  ov.innerHTML='<div class="cfm rev"><div class="cfm-t">Nová událost</div>'+
    '<div class="frow"><label>Datum</label><input id="tlNewDate" type="date" value="'+isoDate(new Date())+'"></div>'+
    '<div class="frow"><label>Popis</label><input id="tlNewLabel" type="text" placeholder="Co se stalo…"></div>'+
    '<div class="cfm-b"><button class="btn ghost sm" data-no>Zrušit</button><button class="btn gold sm" data-yes>Přidat</button></div></div>';
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.querySelector('[data-no]').onclick=close;
  ov.querySelector('[data-yes]').onclick=()=>{
    const d=(document.getElementById('tlNewDate').value||'').trim();
    const l=(document.getElementById('tlNewLabel').value||'').trim();
    if(!d||!l){ toast('Vyplň datum i popis'); return; }
    c.timeline=c.timeline||[];
    c.timeline.push({id:uid(),date:d,event:l,sourceDoc:'ruční zadání'});
    saveData(); close(); refreshTimeline();
    toast('Událost přidána');
  };
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  setTimeout(()=>{ const i=document.getElementById('tlNewLabel'); if(i) i.focus(); },50);
}
function exportTimelineWord(){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const items=buildTimeline(c);
  if(!items.length){ toast('Timeline je prázdná'); return; }
  const rows=items.map(it=>'<tr><td>'+esc(it.dt.toLocaleDateString('cs-CZ'))+'</td><td>'+esc(it.label)+'</td><td>'+esc(it.doc||'')+'</td></tr>').join('');
  const html='<!DOCTYPE html><html><head><meta charset="utf-8"><title>Timeline — '+esc(c.clientName||'')+'</title></head><body>'+
    '<h1>Časová osa — '+esc(c.clientName||'')+'</h1><p>'+esc(c.spisZnacka||'')+'</p>'+
    '<table border="1" cellpadding="6" cellspacing="0"><tr><th>Datum</th><th>Událost</th><th>Zdroj</th></tr>'+rows+'</table></body></html>';
  const blob=new Blob([html],{type:'application/msword'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='timeline-'+(c.spisZnacka||c.id).replace(/[^\w.-]+/g,'_')+'.doc';
  a.click(); URL.revokeObjectURL(a.href);
  toast('Word export stažen');
}
function tlPdfKindMeta(it){
  if(it.kind==='deadline') return {rgb:[232,168,56], label:it.future?'Lhůta':'Lhůta (po termínu)'};
  if(it.kind==='custody') return {rgb:[240,113,113], label:'Vazba'};
  if(it.kind==='judgment') return {rgb:[107,163,232], label:'Rozsudek'};
  const cat=tlClassifyEvent(it.label,'event');
  if(cat==='pay') return {rgb:[78,207,154], label:'Platba'};
  if(cat==='doc') return {rgb:[107,163,232], label:'Dokument'};
  if(cat==='court') return {rgb:[232,168,56], label:'Soud'};
  if(cat==='person') return {rgb:[201,169,98], label:'Osoba'};
  return {rgb:[201,169,98], label:'Událost'};
}
function tlPdfFileName(c){
  return 'timeline-'+(c.spisZnacka||c.id).replace(/[^\w.-]+/g,'_')+'.pdf';
}
function exportTimelinePDF(){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const items=buildTimeline(c);
  if(!items.length){ toast('Timeline je prázdná'); return; }
  if(!window.jspdf||!window.jspdf.jsPDF){ toast('PDF knihovna není načtena'); return; }
  const {jsPDF}=window.jspdf;
  const pdf=new jsPDF({unit:'mm',format:'a4',compress:true});
  const W=210, H=297, M=16, CW=W-M*2, axisX=M+9;
  let page=1;
  const stamp=new Date().toLocaleDateString('cs-CZ',{day:'numeric',month:'long',year:'numeric'});
  const drawFooter=(p)=>{
    pdf.setDrawColor(220,215,200); pdf.setLineWidth(.2);
    pdf.line(M,H-14,W-M,H-14);
    pdf.setFontSize(7.5); pdf.setTextColor(120,115,105);
    pdf.text('Advokato · trestní agenda · vygenerováno '+stamp, M, H-9);
    pdf.text('Strana '+p, W-M, H-9, {align:'right'});
  };
  const drawPdfCoverBlock=(cas, evts, m, cw, w, when, cont)=>{
    pdf.setFillColor(10,14,22); pdf.rect(0,0,w,cont?18:42,'F');
    pdf.setFillColor(201,169,98); pdf.rect(0,cont?18:42,w,.9,'F');
    if(!cont){
      pdf.setTextColor(201,169,98); pdf.setFont('helvetica','bold'); pdf.setFontSize(20);
      pdf.text('§', m, 15);
      pdf.setTextColor(243,240,232); pdf.setFontSize(15);
      pdf.text('Advokato', m+9, 15);
      pdf.setFont('helvetica','normal'); pdf.setFontSize(8.5); pdf.setTextColor(154,150,140);
      pdf.text('Časová osa trestního spisu', m+9, 21);
      pdf.setFont('helvetica','bold'); pdf.setFontSize(13); pdf.setTextColor(232,200,96);
      pdf.text(cas.clientName||'Případ', w-m, 13, {align:'right'});
      pdf.setFont('helvetica','normal'); pdf.setFontSize(9); pdf.setTextColor(200,195,185);
      const meta=[cas.spisZnacka,cas.soud,cas.faze].filter(Boolean).join(' · ');
      if(meta) pdf.text(meta, w-m, 19, {align:'right'});
      pdf.setFillColor(248,246,240); pdf.rect(0,42,w,H-42,'F');
      pdf.setFillColor(255,255,255); pdf.roundedRect(m,48,cw,22,3,3,'F');
      pdf.setDrawColor(230,220,190); pdf.setLineWidth(.3); pdf.roundedRect(m,48,cw,22,3,3,'S');
      pdf.setFontSize(8); pdf.setTextColor(120,115,105);
      pdf.text('POČET UDÁLOSTÍ', m+6, 55);
      pdf.setFont('helvetica','bold'); pdf.setFontSize(18); pdf.setTextColor(30,28,24);
      pdf.text(String(evts.length), m+6, 63);
      pdf.setFont('helvetica','normal'); pdf.setFontSize(8); pdf.setTextColor(120,115,105);
      pdf.text('EXPORT', m+cw*0.38, 55);
      pdf.setFontSize(10); pdf.setTextColor(30,28,24);
      pdf.text(when, m+cw*0.38, 63);
      if(currentUser&&currentUser.name){
        pdf.setFontSize(8); pdf.setTextColor(120,115,105);
        pdf.text('ADVOKÁT', m+cw*0.72, 55);
        pdf.setFontSize(10); pdf.setTextColor(30,28,24);
        pdf.text(currentUser.name, m+cw*0.72, 63);
      }
      return 78;
    }
    pdf.setFillColor(248,246,240); pdf.rect(0,18,w,H-18,'F');
    pdf.setFont('helvetica','bold'); pdf.setFontSize(10); pdf.setTextColor(30,28,24);
    pdf.text('Časová osa — pokračování', m, 12);
    return 26;
  };
  const newPage=()=>{
    drawFooter(page); page++; pdf.addPage();
    return drawPdfCoverBlock(c, items, M, CW, W, stamp, true);
  };
  let y=drawPdfCoverBlock(c, items, M, CW, W, stamp, false);
  let curMonth='';
  items.forEach(it=>{
    const month=tlMonth(it.dt);
    if(month!==curMonth){
      curMonth=month;
      const need=14;
      if(y+need>H-20) y=newPage();
      pdf.setFont('helvetica','bold'); pdf.setFontSize(9); pdf.setTextColor(201,169,98);
      pdf.text(month.toUpperCase(), M+2, y+4);
      pdf.setDrawColor(201,169,98); pdf.setLineWidth(.4);
      pdf.line(M+28, y+2, W-M, y+2);
      y+=12;
    }
    const meta=tlPdfKindMeta(it);
    const dstr=it.dt.toLocaleDateString('cs-CZ',{day:'numeric',month:'long',year:'numeric'});
    const labelParts=pdf.splitTextToSize(it.label||'—', CW-34);
    const docLine=it.doc?pdf.splitTextToSize('Dokument: '+it.doc, CW-34):[];
    const defEv=it.kind==='event'&&it.src&&it.src[0]&&it.src[0].defEvent?pdf.splitTextToSize('Obhajoba: '+it.src[0].defEvent, CW-34):[];
    const cardH=10+labelParts.length*4.2+(docLine.length?docLine.length*3.6+2:0)+(defEv.length?defEv.length*3.6+2:0);
    if(y+cardH>H-20) y=newPage();
    pdf.setFillColor(255,255,255);
    pdf.roundedRect(M, y, CW, cardH, 2.5, 2.5, 'F');
    pdf.setDrawColor(235,230,220); pdf.setLineWidth(.25);
    pdf.roundedRect(M, y, CW, cardH, 2.5, 2.5, 'S');
    pdf.setFillColor(meta.rgb[0], meta.rgb[1], meta.rgb[2]);
    pdf.roundedRect(M, y, 3.2, cardH, 1.2, 1.2, 'F');
    pdf.setFillColor(meta.rgb[0], meta.rgb[1], meta.rgb[2]);
    pdf.circle(axisX, y+cardH/2, 1.8, 'F');
    pdf.setDrawColor(255,255,255); pdf.setLineWidth(.5);
    pdf.circle(axisX, y+cardH/2, 1.8, 'S');
    pdf.setFont('helvetica','bold'); pdf.setFontSize(7.5); pdf.setTextColor(meta.rgb[0], meta.rgb[1], meta.rgb[2]);
    pdf.text(meta.label.toUpperCase(), M+8, y+5.5);
    pdf.setFont('helvetica','bold'); pdf.setFontSize(9.5); pdf.setTextColor(30,28,24);
    pdf.text(dstr, W-M-4, y+5.5, {align:'right'});
    let ty=y+11;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(9.5); pdf.setTextColor(40,38,34);
    labelParts.forEach(ln=>{ pdf.text(ln, M+8, ty); ty+=4.2; });
    if(docLine.length){
      pdf.setFontSize(7.5); pdf.setTextColor(110,105,95);
      docLine.forEach(ln=>{ pdf.text(ln, M+8, ty); ty+=3.6; });
    }
    if(defEv.length){
      pdf.setFontSize(7.5); pdf.setTextColor(160,130,60);
      defEv.forEach(ln=>{ pdf.text(ln, M+8, ty); ty+=3.6; });
    }
    y+=cardH+4;
  });
  drawFooter(page);
  pdf.save(tlPdfFileName(c));
  toast('PDF export stažen');
}
const TL_DEL_ICON='<svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3"/></svg>';
const CS_MON=['Leden','Únor','Březen','Duben','Květen','Červen','Červenec','Srpen','Září','Říjen','Listopad','Prosinec'];
const TL_STATUS=[{k:'ok',l:'Bez problému',c:'var(--st-ok)'},{k:'spor',l:'Sporné',c:'var(--st-spor)'},{k:'krit',l:'Kritické',c:'var(--st-krit)'},{k:'nez',l:'Nezákonné',c:'var(--st-nez)'}];
function tlStatusColor(k){ const s=TL_STATUS.find(x=>x.k===k); return s?s.c:'var(--muted)'; }
function tlMonth(dt){ return CS_MON[dt.getMonth()]+' '+dt.getFullYear(); }
function tlDayKey(dt){ return dt.getFullYear()+'-'+dt.getMonth()+'-'+dt.getDate(); }
function tlDayShort(dt){ return dt.getDate()+'.'+(dt.getMonth()+1)+'.'; }
function tlKindColor(it){ return it.kind==='deadline'?(it.future?'var(--am)':'var(--red)'):(it.kind==='custody'?'var(--red)':(it.kind==='judgment'?'var(--blue)':'var(--am)')); }
let tlById={};
let tlExpanded=new Set();
// Seskupí položky podle měsíce a shlukne 3+ událostí ve stejný den.
function tlGroups(items){
  const groups=[]; let cur=null;
  items.forEach(it=>{ const m=tlMonth(it.dt); if(!cur||cur.month!==m){ cur={month:m,rows:[]}; groups.push(cur); } cur.rows.push(it); });
  groups.forEach(g=>{
    const out=[]; let i=0;
    while(i<g.rows.length){
      const it=g.rows[i];
      if(it.kind==='event'){
        const dk=tlDayKey(it.dt); const run=[]; let j=i;
        while(j<g.rows.length && g.rows[j].kind==='event' && tlDayKey(g.rows[j].dt)===dk){ run.push(g.rows[j]); j++; }
        if(run.length>=3 && !tlExpanded.has(dk)){ out.push({cluster:true,day:dk,dt:it.dt,n:run.length}); }
        else { if(run.length>=3) out.push({sbalit:true,day:dk,dt:it.dt,n:run.length}); run.forEach(r=>out.push({it:r})); }
        i=j;
      } else { out.push({it}); i++; }
    }
    g.rows=out;
  });
  return groups;
}
let tlEditL=new Set();
let tlEditR=new Set();
function renderTimeline(c){
  let items=buildTimeline(c);
  items=tlFilterItems(items);
  tlView=items; tlById={};
  items.forEach(it=>{ if(it.kind==='event' && it.src && it.src[0]) tlById[it.src[0].id]=it; });
  if(!items.length){
    const msg=tlSearchQ||tlFilterChip!=='all'?'Pro tento filtr nebo hledání nic není. Zkus jiný výraz nebo „Vše“.':'Nahraj spis přes OCR — události se z něj vytáhnou a seřadí samy chronologicky.';
    return emptyState('timeline',tlSearchQ||tlFilterChip!=='all'?'Nic nenalezeno':'Časová osa je prázdná',msg,{small:true});
  }
  const groups=tlGroups(items);
  const head='<div class="tl2hrow"><div class="tl2h tl2h-stat">Verze státu · soudy a policie</div><div class="tl2hmid"></div><div class="tl2h tl2h-obh">Naše verze · obhajoba</div></div>';
  const body=groups.map(g=>{
    const month='<div class="tl2monthrow"><span class="tl2month">'+esc(g.month)+'</span></div>';
    return month+g.rows.map(r=>tlRowFull(r)).join('');
  }).join('');
  return '<div class="tl2wrap">'+head+body+'</div>';
}
function tlRowFull(r){
  if(r.cluster){
    return '<div class="tl2midrow tl2clu" onclick="tlToggleCluster(\''+r.day+'\')"><span class="tl2clu-pill"><svg viewBox="0 0 24 24" class="tl2clu-ic"><path d="M4 7l8-4 8 4-8 4-8-4zM4 12l8 4 8-4M4 17l8 4 8-4"/></svg> '+tlDayShort(r.dt)+' · +'+r.n+' událostí <svg viewBox="0 0 24 24" class="tl2chev"><path d="M6 9l6 6 6-6"/></svg></span></div>';
  }
  if(r.sbalit){
    return '<div class="tl2midrow tl2sbalit" onclick="tlToggleCluster(\''+r.day+'\')"><span class="tl2sbalit-t">'+tlDayShort(r.dt)+' · '+r.n+' událostí — sbalit</span></div>';
  }
  const i=r.it;
  const dstr=i.dt.toLocaleDateString('cs-CZ',{day:'numeric',month:'numeric',year:'numeric'});
  if(i.kind!=='event'){
    return '<div class="tl2midrow"><span class="tl2kindpill" style="border-color:'+tlKindColor(i)+'"><span class="tl2stp-dot" style="background:'+tlKindColor(i)+'"></span>'+dstr+' · '+esc(i.label)+(i.future?' · budoucí':'')+'</span></div>';
  }
  const ev=i.src&&i.src[0]?i.src[0]:{};
  const id=ev.id||'';
  const st=ev.defStatus||'';
  const note=ev.defNote||'';
  const nodeCol=st?tlStatusColor(st):tlKindColor(i);
  // LEVÁ — fakt (klik = editace)
  let L;
  if(tlEditL.has(id)){
    L='<div class="tl2card tl2cardL on">'+
      '<div class="tl2editline"><input id="fd_'+id+'" class="tl2-date-in" type="date" value="'+isoDate(i.dt)+'" onchange="tlCommitFact(\''+id+'\')">'+
      '<button class="tl-del" title="Do koše" onclick="tlDelete(\''+id+'\')">'+TL_DEL_ICON+'</button></div>'+
      '<input id="fl_'+id+'" class="tl2-label-in" value="'+esc(i.label)+'" onchange="tlCommitFact(\''+id+'\')" onkeydown="if(event.key===\'Enter\')this.blur()">'+
      '<div class="tl2cardfoot"><span class="tl2done" onclick="tlToggleL(\''+id+'\')">hotovo</span></div></div>';
  } else {
    L='<div class="tl2card tl2cardL" onclick="tlToggleL(\''+id+'\')"><div class="tl2date">'+dstr+'</div><div class="tl2label">'+esc(i.label)+'</div>'+
      (i.doc?'<div class="tl2doc tl2docR"><svg viewBox="0 0 24 24" class="tl2doc-ic"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg> '+esc(i.doc)+'</div>':'')+'</div>';
  }
  // PRAVÁ — posouzení obhajoby (sbalené, dokud neklikneš)
  let R;
  const stCol=st?tlStatusColor(st):'';
  const cardRstyle=stCol?' style="border-color:'+stCol+'"':'';
  const defEv=ev.defEvent||i.label;
  if(tlEditR.has(id)){
    const dots=TL_STATUS.map(s=>'<span class="tl2dot'+(st===s.k?' on':'')+'" title="'+s.l+'" style="color:'+s.c+';background:'+s.c+'" onclick="tlSetStatus(\''+id+'\',\''+s.k+'\')"></span>').join('');
    R='<div class="tl2card tl2cardR on"'+cardRstyle+'><div class="tl2date">'+dstr+'</div>'+
      '<input id="de_'+id+'" class="tl2-label-in" style="text-align:left" value="'+esc(defEv)+'" placeholder="Naše verze události" onchange="tlCommitDefEvent(\''+id+'\')">'+
      '<div class="tl2dots">'+dots+'<span class="tl2done" onclick="tlToggleR(\''+id+'\')">hotovo</span></div>'+
      '<input id="nt_'+id+'" class="tl2-note-in" value="'+esc(note)+'" placeholder="Poznámka · co řešit u soudu" onchange="tlCommitNote(\''+id+'\')"></div>';
  } else if(st||note||ev.defEvent){
    const sLbl=(TL_STATUS.find(s=>s.k===st)||{}).l||'';
    R='<div class="tl2card tl2cardR"'+cardRstyle+' onclick="tlToggleR(\''+id+'\')"><div class="tl2date">'+dstr+'</div><div class="tl2label">'+esc(defEv)+'</div>'+
      (st?'<div class="tl2stpill" style="color:'+stCol+';border-color:'+stCol+'"><span class="tl2stp-dot" style="background:'+stCol+'"></span>'+esc(sLbl)+'</div>':'')+
      (note?'<div class="tl2notetxt">'+esc(note)+'</div>':'')+'</div>';
  } else {
    R='<div class="tl2card tl2cardR tl2cardEmpty" onclick="tlToggleR(\''+id+'\')"><div class="tl2date">'+dstr+'</div><div class="tl2label">'+esc(defEv)+'</div><div class="tl2posoudit">+ posoudit</div></div>';
  }
  return '<div class="tl2r"><div class="tl2L">'+L+'</div><div class="tl2M"><span class="tl2dot2" style="background:'+nodeCol+'"></span></div><div class="tl2R">'+R+'</div></div>';
}
function tlToggleL(id){ if(tlEditL.has(id)) tlEditL.delete(id); else tlEditL.add(id); refreshTimeline(); }
function tlToggleR(id){ if(tlEditR.has(id)) tlEditR.delete(id); else tlEditR.add(id); refreshTimeline(); }
function tlFindEv(id){ const it=tlById[id]; return it&&it.src&&it.src[0]?it:null; }
function tlCommitFact(id){
  const it=tlFindEv(id); if(!it) return;
  const d=document.getElementById('fd_'+id), t=document.getElementById('fl_'+id); if(!d||!t) return;
  const newDate=(d.value||'').trim()||isoDate(it.dt);
  const newLabel=(t.value||'').trim(); if(!newLabel) return;
  const ev=it.src[0]; ev.date=newDate; ev.event=newLabel;
  for(let k=1;k<it.src.length;k++){ it.src[k].deletedAt=Date.now(); } // sloučené dvojníky pryč
  saveData(); refreshTimeline();
}
function tlSetStatus(id,k){
  const it=tlFindEv(id); if(!it) return;
  const ev=it.src[0]; ev.defStatus=(ev.defStatus===k?'':k);
  saveData(); refreshTimeline();
}
function tlCommitNote(id){
  const it=tlFindEv(id); if(!it) return;
  const n=document.getElementById('nt_'+id); if(!n) return;
  it.src[0].defNote=(n.value||'').trim(); saveData(); refreshTimeline();
}
function tlCommitDefEvent(id){
  const it=tlFindEv(id); if(!it) return;
  const d=document.getElementById('de_'+id); if(!d) return;
  const v=(d.value||'').trim();
  if(v && v!==it.src[0].event) it.src[0].defEvent=v; else it.src[0].defEvent='';
  saveData(); refreshTimeline();
}
function tlToggleCluster(day){ if(tlExpanded.has(day)) tlExpanded.delete(day); else tlExpanded.add(day); refreshTimeline(); }
function tlDelete(id){
  const it=tlFindEv(id); if(!it) return;
  uiConfirm('Přesunout do koše?', it.label, ()=>{
    (it.src||[]).forEach(e=>{ e.deletedAt=Date.now(); });
    saveData(); renderAll(); refreshTimeline();
    toast('Přesunuto do koše · obnovit lze 96 h');
  });
}
// Vlastní potvrzovací panel ve vzhledu V6
function uiConfirm(title, detail, onYes){
  const ov=document.createElement('div'); ov.className='cfm-ov';
  ov.innerHTML='<div class="cfm rev"><div class="cfm-t">'+esc(title)+'</div>'+(detail?'<div class="cfm-d">„'+esc(detail)+'"</div>':'')+
    '<div class="cfm-b"><button class="btn ghost sm" data-no>Zrušit</button><button class="btn sm cfm-yes" data-yes>Odstranit</button></div></div>';
  document.body.appendChild(ov);
  const close=()=>{ ov.remove(); document.removeEventListener('keydown',onKey); };
  const onKey=e=>{ if(e.key==='Escape') close(); };
  document.addEventListener('keydown',onKey);
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  ov.querySelector('[data-no]').onclick=close;
  ov.querySelector('[data-yes]').onclick=()=>{ close(); onYes&&onYes(); };
}

// ===== Koš =====
function askDeleteCase(id){
  const c=appData.cases.find(x=>x.id===id); if(!c) return;
  uiConfirm('Přesunout případ do koše?', (c.clientName||'Případ')+' · '+(c.spisZnacka||''), ()=>{
    c.deletedAt=Date.now(); saveData(); renderAll();
    toast('Případ v koši · obnovit lze 96 h'); showPage('cases');
  });
}
let trashView={cases:[],tl:[]};
function openTrash(){
  trashView={cases:[],tl:[]};
  appData.cases.forEach(c=>{ if(c.deletedAt) trashView.cases.push(c); });
  appData.cases.forEach(c=>{ if(!c.deletedAt && Array.isArray(c.timeline)) c.timeline.forEach(t=>{ if(t.deletedAt) trashView.tl.push({c:c,t:t}); }); });
  const fmt=ts=>{ const h=Math.max(0,Math.round((TRASH_MS-(Date.now()-ts))/3600000)); return 'zbývá '+h+' h'; };
  let body='';
  if(!trashView.cases.length && !trashView.tl.length){
    body='<p style="color:var(--muted);padding:8px 2px">Koš je prázdný.</p>';
  } else {
    if(trashView.cases.length){
      body+='<div class="tl">Případy</div>'+trashView.cases.map((c,i)=>
        '<div class="trash-row"><span class="ll">'+esc(c.clientName||'Případ')+'<small>'+esc(c.spisZnacka||'')+' · '+fmt(c.deletedAt)+'</small></span><button class="btn ghost sm" onclick="restoreTrashCase('+i+')">Obnovit</button></div>').join('');
    }
    if(trashView.tl.length){
      body+='<div class="tl" style="margin-top:14px">Události časové osy</div>'+trashView.tl.map((r,i)=>
        '<div class="trash-row"><span class="ll">'+esc(r.t.event||'Událost')+'<small>'+esc(r.c.clientName||'')+' · '+fmt(r.t.deletedAt)+'</small></span><button class="btn ghost sm" onclick="restoreTrashTL('+i+')">Obnovit</button></div>').join('');
    }
  }
  const ov=document.createElement('div'); ov.className='cfm-ov'; ov.id='trashOv';
  ov.innerHTML='<div class="cfm rev" style="max-width:520px"><div class="cfm-t">Koš <span style="font-weight:400;color:var(--muted);font-size:.8rem">· automatické mazání po 96 h</span></div><div class="trash-list">'+body+'</div><div class="cfm-b"><button class="btn ghost sm" data-close>Zavřít</button></div></div>';
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  ov.querySelector('[data-close]').onclick=close;
}
function reopenTrash(){ const o=document.getElementById('trashOv'); if(o) o.remove(); openTrash(); }
function restoreTrashCase(i){ const c=trashView.cases[i]; if(c){ delete c.deletedAt; saveData(); renderAll(); toast('Případ obnoven'); } reopenTrash(); }
function restoreTrashTL(i){ const r=trashView.tl[i]; if(r){ delete r.t.deletedAt; saveData(); renderAll(); refreshTimeline(); toast('Událost obnovena'); } reopenTrash(); }

const TL_SCHEMA={type:'OBJECT',properties:{timeline:{type:'ARRAY',items:{type:'OBJECT',properties:{date:{type:'STRING'},event:{type:'STRING'}},required:['date','event']}}}};
// Vytáhne události z už uloženého přepisu spisu (1 volání na klik) a doplní je do osy.
async function extractTimelineFromText(){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const text=(c.analysisText||'').trim();
  if(!text){ toast('Případ nemá přepis spisu.'); return; }
  if(!getGeminiKey()){ toast(geminiMissingHint()); return; }
  const btn=document.getElementById('tlExtractBtn'); if(btn){ btn.classList.add('dis'); btn.textContent='Hledám události…'; }
  try{
    const data=await geminiCallWithRetry({
      contents:[{parts:[{text:'Z následujícího textu spisu vyber VŠECHNY události s konkrétním datem (zahájení/rozšíření trestního stíhání, jednotlivé výslechy a podaná vysvětlení s uvedením osoby, domovní prohlídky, zajištění věcí, výběry hotovosti, podání obžaloby, nařízená jednání, vydání dokumentu, vznik škody…). Projdi text systematicky odshora dolů, nevynech žádný oddíl ani stránku; vypiš KAŽDOU datovanou událost — jedna událost = jeden záznam. Cílem je ÚPLNOST: raději uveď událost navíc než abys nějakou vynechal; případné duplicity vyřeším později sám. Různé osoby a různé skutky téhož dne nechej jako samostatné záznamy. Vrať JSON dle schématu, date striktně ve formátu YYYY-MM-DD. Nic si nevymýšlej.\n\n'+text}]}],
      generationConfig:{temperature:0,responseMimeType:'application/json',responseSchema:TL_SCHEMA}
    });
    const raw=data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts&&data.candidates[0].content.parts[0]&&data.candidates[0].content.parts[0].text;
    let ev=[]; try{ const o=JSON.parse(raw); ev=Array.isArray(o.timeline)?o.timeline:[]; }catch(e){ throw new Error('Gemini nevrátil platný JSON.'); }
    ev=ev.filter(t=>t&&t.date);
    // přestavění osy z přepisu — nahradí dřívější vytažené události (žádné narůstání).
    // dedup uvnitř dávky podle normalizovaného data+popisu
    const seen=new Set(); const fresh=[];
    ev.forEach(t=>{ const k=(parseCzDate(t.date)?parseCzDate(t.date).getTime():t.date)+'|'+String(t.event||'').trim().toLowerCase(); if(!seen.has(k)){ seen.add(k); fresh.push({date:t.date,event:t.event||''}); } });
    c.timeline=fresh; saveData();
    refreshTimeline();
    toast('Osa sestavena z přepisu · událostí: '+fresh.length);
  }catch(e){
    toast('Chyba: '+e.message);
    const b=document.getElementById('tlExtractBtn'); if(b){ b.classList.remove('dis'); b.textContent='Vytáhnout události z dokumentu'; }
  }
}

/* ===== Dávkové OCR — pro velké spisy (desítky/stovky stran) ===== */
const OCR_BATCH_PAGES=12; // kolik stran pošleme Gemini na jedno volání

// Sloučí vytažená data (ex) do případu — bez duplicit, nikdy nepřepíše vyplněné pole.
function applyExtractedToCase(c, ex, sourceName){
  c.timeline=c.timeline||[];
  const seen=new Set(c.timeline.map(t=>t.date+'|'+(t.event||'')));
  (Array.isArray(ex.timeline)?ex.timeline:[]).filter(t=>t&&t.date).forEach(t=>{ const k=t.date+'|'+(t.event||''); if(!seen.has(k)){ c.timeline.push({date:t.date,event:t.event||'',sourceDoc:sourceName,id:uid()}); seen.add(k); } });
  c.persons=c.persons||[];
  const byName={}; c.persons.forEach(p=>{ const k=(p.name||'').trim().toLowerCase(); if(k) byName[k]=p; });
  normalizeExtractedPersons(ex.persons).forEach(p=>{
    const k=p.name.toLowerCase(); if(!k) return;
    const ex0=byName[k];
    if(!ex0){ c.persons.push(p); byName[k]=p; }
    else { // stejná osoba z jiné dávky/dokumentu → doplň POUZE prázdná pole, nepřepisuj
      ['birthDate','address','phone','email','contact','note'].forEach(f=>{ if(!(ex0[f]&&String(ex0[f]).trim()) && p[f]) ex0[f]=p[f]; });
      if((!ex0.role||ex0.role==='jine') && p.role && p.role!=='jine') ex0.role=p.role;
    }
  });
  if(ex.fullText) c.analysisText=((c.analysisText||'')+'\n\n=== '+sourceName+' ===\n'+ex.fullText).trim();
  const fillIfEmpty=(k,val)=>{ if(val && !(c[k]&&String(c[k]).trim())) c[k]=val; };
  fillIfEmpty('birthDate',ex.birthDate); fillIfEmpty('rodneCislo',ex.rodneCislo); fillIfEmpty('idNumber',ex.idNumber);
  fillIfEmpty('datovaSchranka',ex.datovaSchranka); fillIfEmpty('address',ex.address);
  fillIfEmpty('spisZnacka',ex.spisZnacka); fillIfEmpty('pravniKvalifikace',ex.pravniKvalifikace);
  fillIfEmpty('soud',ex.soud); fillIfEmpty('soudce',ex.soudce); fillIfEmpty('statniZastupce',ex.statniZastupce);
  fillIfEmpty('vysetrovatel',ex.vysetrovatel); fillIfEmpty('judgmentDate',ex.judgmentDate);
  fillIfEmpty('custodyDate',ex.custodyDate); fillIfEmpty('vyseSkody',ex.vyseSkody);
  if((!c.obvineni||!c.obvineni.length) && Array.isArray(ex.obvineni) && ex.obvineni.length) c.obvineni=ex.obvineni;
}

// Zjistí počet stran PDF (pdf.js). Vrací 0 při chybě.
async function pdfPageCount(file){
  try{
    if(!window.pdfjsLib) return 0;
    if(pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc)
      pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
    const buf=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:buf}).promise;
    return pdf.numPages;
  }catch(e){ console.warn('pdfPageCount',e); return 0; }
}

// Vyrenderuje stránky [start..end] PDF do pole base64 JPEG (pro dávkové OCR).
async function renderPdfPages(pdf, start, end){
  const out=[];
  for(let p=start;p<=end;p++){
    const page=await pdf.getPage(p);
    const vp=page.getViewport({scale:1.6});
    const cv=document.createElement('canvas'); cv.width=vp.width; cv.height=vp.height;
    await page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;
    out.push(cv.toDataURL('image/jpeg',.82).split(',')[1]);
  }
  return out;
}

// Hlavní dávkový průchod: rozseká velké PDF na dávky po OCR_BATCH_PAGES a postupně sloučí.
async function addLargeDocBatched(file, c, ui){
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
  const buf=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data:buf.slice(0)}).promise;
  const total=pdf.numPages;
  const batches=Math.ceil(total/OCR_BATCH_PAGES);
  let firstSummary='';
  for(let b=0;b<batches;b++){
    const start=b*OCR_BATCH_PAGES+1, end=Math.min(total,(b+1)*OCR_BATCH_PAGES);
    ui.set((b/batches)*90, 'Čtu dávku '+(b+1)+'/'+batches+' · strany '+start+'–'+end+'…');
    const imgs=await renderPdfPages(pdf, start, end);
    const parts=imgs.map(d=>({inline_data:{mime_type:'image/jpeg',data:d}}));
    parts.push({text:OCR_PROMPT});
    const data=await geminiCallWithRetry({
      contents:[{parts}],
      generationConfig:{temperature:0,maxOutputTokens:16384,responseMimeType:'application/json',responseSchema:OCR_SCHEMA}
    });
    const raw=data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts&&data.candidates[0].content.parts[0]&&data.candidates[0].content.parts[0].text;
    let ex; try{ ex=JSON.parse(raw); }catch(e){ console.warn('dávka '+(b+1)+' nevrátila JSON'); continue; }
    if(!firstSummary && ex.summary) firstSummary=ex.summary;
    applyExtractedToCase(c, ex, file.name+' (str. '+start+'–'+end+')');
    saveData(); // průběžně, ať se nic neztratí při výpadku
  }
  return {pageCount:total, summary:firstSummary};
}

// Přidá další dokument k existujícímu případu: připojí spis, doplní osu + příběh, vyplní jen prázdná pole. Nikdy nepřepisuje.
async function addDocToCase(file){
  if(!file) return;
  if(file.type!=='application/pdf'){ toast('Zatím jen PDF.'); return; }
  if(!getGeminiKey()){ toast(geminiMissingHint()); return; }
  if(file.size>60*1024*1024){ toast('Soubor >60 MB — rozděl spis na menší části.'); return; }
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const cBefore=JSON.parse(JSON.stringify(c));
  const btn=document.getElementById('addDocBtn'); if(btn) btn.classList.add('dis');
  const prog=document.getElementById('addDocProg'),fill=document.getElementById('addDocFill'),msg=document.getElementById('addDocMsg');
  const msgs=['Načítám dokument: '+file.name+'…','Čtu text a sken…','Hledám osoby, data a §…','Vytahuji události do osy…','Připojuji k případu…'];
  let mi=0,prTimer=null;
  if(prog){ prog.classList.add('on'); if(fill) fill.style.width='12%'; if(msg) msg.textContent=msgs[0];
    prTimer=setInterval(()=>{ mi=Math.min(mi+1,msgs.length-1); if(fill) fill.style.width=(12+mi*17)+'%'; if(msg) msg.textContent=msgs[mi]; },3000); }
  const stopProg=()=>{ if(prTimer) clearInterval(prTimer); if(fill) fill.style.width='100%'; setTimeout(()=>{ if(prog) prog.classList.remove('on'); if(fill) fill.style.width='0'; },400); };
  // UI helper pro dávkový režim (přepíše plynulou animaci konkrétním pokrokem)
  const ui={ set:(pct,text)=>{ if(prTimer){ clearInterval(prTimer); prTimer=null; } if(fill) fill.style.width=Math.round(pct)+'%'; if(msg) msg.textContent=text; } };
  try{
    // Zjisti počet stran — rozhodne single vs. dávkový režim
    const pages=await pdfPageCount(file);
    let summary='', pageCount=pages||null, lastEx=null;

    if(pages>OCR_BATCH_PAGES){
      // VELKÝ SPIS → dávkové OCR (postupně, průběžně ukládá)
      const res=await addLargeDocBatched(file, c, ui);
      summary=res.summary; pageCount=res.pageCount;
      ui.set(94,'Ukládám originál spisu…');
    } else {
      // MALÝ dokument → jedno volání s PDF napřímo
      const b64=await fileToBase64(file);
      const data=await geminiCallWithRetry({
        contents:[{parts:[{inline_data:{mime_type:'application/pdf',data:b64}},{text:OCR_PROMPT}]}],
        generationConfig:{temperature:0,maxOutputTokens:16384,responseMimeType:'application/json',responseSchema:OCR_SCHEMA}
      });
      const raw=data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts&&data.candidates[0].content.parts[0]&&data.candidates[0].content.parts[0].text;
      let ex; try{ ex=JSON.parse(raw); }catch(e){ throw new Error('Gemini nevrátil platný JSON.'); }
      lastEx=ex;
      applyExtractedToCase(c, ex, file.name);
      summary=ex.summary||''; if(!pageCount) pageCount=ex.pageCount||null;
    }

    // Ulož originál do IndexedDB, do případu jen metadata
    c.documents=c.documents||[];
    const fileId='f_'+uid();
    try{ await idbPut({id:fileId, caseId:c.id, name:file.name, blob:file, when:Date.now()}); }catch(err){ console.warn('IDB uložení selhalo',err); }
    c.documents.push({ name:file.name, type:'', when:Date.now(), summary:summary, fileId:fileId, fileSize:file.size, pages:pageCount });

    c.lastActivity='Přidán dokument';
    const st={
      persons: Math.max(0,(c.persons||[]).length-(cBefore.persons||[]).length),
      events: Math.max(0,(c.timeline||[]).filter(t=>!t.deletedAt).length-(cBefore.timeline||[]).filter(t=>!t.deletedAt).length),
      deadlines: Math.max(0,calculateDeadlines(c).length-calculateDeadlines(cBefore).length),
      amount: ((c.vyseSkody||(lastEx&&lastEx.vyseSkody)||'')).trim()||'—',
      spisZnacka: (c.spisZnacka||'').trim()||'—',
      pages: pageCount||'—'
    };
    lastCaseExtractRecap={caseId:c.id,stats:st,fileName:file.name};
    saveData(); renderAll();
    stopProg();
    toast(pages>OCR_BATCH_PAGES ? ('Spis přidán: '+file.name+' ('+pageCount+' str.)') : ('Dokument přidán: '+file.name));
    currentDetailTab='dokumenty';
    openCaseDetail(currentDetailId);
  }catch(e){
    stopProg();
    toast('Chyba: '+e.message);
    if(btn){ btn.classList.remove('dis'); }
  }
}

function dicon(name){
  const p={
    'prehled':'<path d="M3 12l9-8 9 8M5 10v10h14V10"/>',
    'lhuty':'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'osa':'<circle cx="6" cy="7" r="2"/><circle cx="6" cy="17" r="2"/><path d="M6 9v6M10 7h9M10 17h6"/>',
    'dokumenty':'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    'analyzy':'<path d="M12 3a3 3 0 0 0-3 3 2.6 2.6 0 0 0-1.1 5 2.3 2.3 0 0 0 1.1 4.3A2.3 2.3 0 0 0 12 20a2.3 2.3 0 0 0 3-1.7 2.3 2.3 0 0 0 1.1-4.3A2.6 2.6 0 0 0 15 6a3 3 0 0 0-3-3Z"/><path d="M12 3v17"/>',
    'back':'<path d="M15 18l-6-6 6-6"/>',
    'pripady':'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'phone':'<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    'mail':'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    'edit':'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    'finance':'<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    'konzultace':'<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5Z"/>',
    'poznamky':'<path d="M5 3h11l3 3v15H5z"/><path d="M16 3v4h4M9 12h6M9 16h4"/>',
    'checklist':'<path d="M4 7l1.5 1.5L8 6"/><path d="M4 17l1.5 1.5L8 16"/><path d="M11 7.5h9M11 16.5h9"/>',
    'jednani':'<path d="M3 21h18"/><path d="M4 9h16M12 3l8 6H4z"/><path d="M6 9v9M10 9v9M14 9v9M18 9v9"/>',
    'vazba':'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    'zajisteni':'<path d="M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/>',
    'osoby':'<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.8M17 19a5.5 5.5 0 0 0-3-4.9"/>',
    'vyslechy':'<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/>',
    'sablony':'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    'chat':'<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4V6a1 1 0 0 1 1-1z"/><path d="M8 9.5h8M8 12.5h5"/>'
  }[name]||'';
  return '<svg class="disvg" viewBox="0 0 24 24">'+p+'</svg>';
}
function dtab(id,label){
  const on=currentDetailTab===id;
  return '<span class="dtab'+(on?' on':'')+'" data-tab="'+id+'" onclick="switchDetailTab(\''+id+'\')">'+dicon(id)+label+'</span>';
}
function switchDetailTab(id){
  currentDetailTab=id;
  document.querySelectorAll('#page-detail .dtab').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('#page-detail .dpanel').forEach(p=>p.style.display='none');
  const tabEl=document.querySelector('#page-detail .dtab[data-tab="'+id+'"]');
  const panEl=document.getElementById('dpanel-'+id);
  if(tabEl) tabEl.classList.add('on');
  if(panEl) panEl.style.display='block';
  // sync navy subrail
  document.querySelectorAll('#subrailNav .sr-item[data-dtab]').forEach(function(x){ x.classList.toggle('on', x.getAttribute('data-dtab')===id); });
  if(id==='chat' && typeof renderChatLog==='function') renderChatLog();
}

function deadlinesPanelHtml(c){
  const dls=calculateDeadlines(c).sort((a,b)=>a.daysLeft-b.daysLeft);
  const warn='<div class="dl-warn">⚠︎ Lhůty jsou <b>orientační</b>. Zkontroluj zadaná data — především <b>datum doručení</b> (od něj se vše počítá). Konečné posouzení lhůty je vždy na advokátovi dle spisu.</div>';
  const cards = dls.length ? dls.map(d=>{
    const col=d.daysLeft<0?'var(--red)':(d.daysLeft<=3?'var(--red)':(d.daysLeft<=14?'var(--am)':'var(--green)'));
    const ddTxt=d.daysLeft<0?'PO lhůtě':(d.daysLeft===0?'dnes':d.daysLeft+' '+dayWord(d.daysLeft));
    if(d.manual){
      return '<div class="dl-card"><div class="ll" style="flex:1;min-width:0">'+
        '<input class="dl-edit" type="text" value="'+esc(d.label)+'" placeholder="Popis lhůty" onchange="updateManualDeadline(\''+c.id+'\',\''+d.mid+'\',\'label\',this.value)">'+
        '<div style="display:flex;align-items:center;gap:8px;margin-top:7px">'+
          '<input class="dl-edit dl-edit-date" type="date" value="'+esc(isoOf(d.raw))+'" onchange="updateManualDeadline(\''+c.id+'\',\''+d.mid+'\',\'date\',this.value)">'+
          '<span class="dl-tag">ruční</span></div></div>'+
        '<div style="display:flex;align-items:center;gap:10px"><div class="dd" style="color:'+col+'">'+ddTxt+'</div>'+
        '<button class="dl-x" title="Smazat lhůtu" onclick="removeManualDeadline(\''+c.id+'\',\''+d.mid+'\')">×</button></div></div>';
    }
    const notes=['konec: '+d.deadline.toLocaleDateString('cs-CZ',{weekday:'short',day:'numeric',month:'numeric',year:'numeric'})];
    if(d.shifted) notes.push('<span style="color:var(--am2)">posunuto z '+d.raw.toLocaleDateString('cs-CZ',{day:'numeric',month:'numeric'})+' (víkend/svátek)</span>');
    if(d.fromVyhlaseni) notes.push('<span style="color:var(--red)">počítáno od vyhlášení — doplň datum doručení</span>');
    return '<div class="dl-card"><div class="ll">'+esc(d.label)+'<small>'+esc(d.short)+'</small><small>'+notes.join(' · ')+'</small></div>'+
           '<div style="display:flex;align-items:center;gap:10px"><div class="dd" style="color:'+col+'">'+ddTxt+'</div></div></div>';
  }).join('') : emptyState('clock','Zatím žádné lhůty','Doplň v Přehledu datum doručení rozsudku, příkazu, usnesení nebo vzetí do vazby — lhůty se spočítají samy. Nebo přidej vlastní níže.',{small:true});
  const typeOpts=DL_TYPES.map(t=>'<option value="'+t[0]+'">'+t[1]+(t[0]!=='vlastni'?(' ('+(t[2]==='m'?t[3]+' měs.':t[3]+' dní')+')'):'')+'</option>').join('');
  const form='<div class="dl-add"><div class="tl" style="margin-top:0">Přidat lhůtu</div>'+
    '<div class="dl-add-row">'+
      '<select id="mdType" class="pp-role" style="min-width:210px" onchange="mdOnType(\''+c.id+'\')">'+typeOpts+'</select>'+
      '<input id="mdLabel" type="text" placeholder="Popis (např. doplnění odvolání)" style="display:none">'+
      '<input id="mdDate" type="date">'+
      '<button class="btn gold sm" onclick="addManualDeadline(\''+c.id+'\')">Přidat</button>'+
    '</div>'+
    '<div id="mdHint" style="font-size:.72rem;color:var(--dim);margin-top:6px"></div></div>';
  return warn+cards+form;
}
function isoOf(d){ if(!(d instanceof Date)||isNaN(d)) return ''; return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function refreshDeadlinesPanel(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c) return; const el=document.getElementById('dpanel-lhuty'); if(el){ el.innerHTML='<div class="tile rev"><div class="tl">Lhůty případu</div>'+deadlinesPanelHtml(c)+'</div>'; mdOnType(cid); } hzRefreshIfDashboard(); }
const DL_TYPES=[
  ['odvolani','Odvolání','d',8,'od doručení opisu rozsudku (§ 248 tr. ř.)'],
  ['stiznost','Stížnost','d',3,'od oznámení usnesení (§ 143 tr. ř.)'],
  ['dovolani','Dovolání','m',2,'od doručení rozhodnutí (§ 265e tr. ř.)'],
  ['odpor','Odpor proti tr. příkazu','d',8,'od doručení trestního příkazu (§ 314g tr. ř.)'],
  ['ustavni','Ústavní stížnost','m',2,'od doručení posledního rozhodnutí (§ 72 zák. 182/1993 Sb.)'],
  ['kasacni','Kasační stížnost','d',14,'od doručení rozhodnutí krajského soudu (§ 106 s. ř. s.)'],
  ['vlastni','Vlastní…','',0,'']
];
function mdOnType(cid){
  const sel=(document.getElementById('mdType')||{}).value||'vlastni';
  const t=DL_TYPES.find(x=>x[0]===sel)||DL_TYPES[DL_TYPES.length-1];
  const lbl=document.getElementById('mdLabel'), hint=document.getElementById('mdHint'), dt=document.getElementById('mdDate');
  if(sel==='vlastni'){
    if(lbl) lbl.style.display='';
    if(hint) hint.textContent='Zadej přímo poslední den lhůty. Vlastní lhůtu engine neposouvá z víkendu/svátku.';
    if(dt) dt.title='Datum lhůty';
  } else {
    if(lbl) lbl.style.display='none';
    if(hint) hint.textContent=t[1]+': '+(t[2]==='m'?t[3]+' měsíce':t[3]+' dní')+' '+t[4]+'. Zadej datum doručení/oznámení — konec spočítám vč. posunu přes víkend/svátek.';
    if(dt) dt.title='Datum doručení / oznámení';
  }
}
function addManualDeadline(cid){
  const c=appData.cases.find(x=>x.id===cid); if(!c) return;
  const sel=(document.getElementById('mdType')||{}).value||'vlastni';
  const dt=(document.getElementById('mdDate')||{}).value;
  if(!dt){ toast('Zadej datum'); return; }
  c.manualDeadlines=c.manualDeadlines||[];
  if(sel==='vlastni'){
    const lbl=(document.getElementById('mdLabel')||{}).value;
    c.manualDeadlines.push({id:uid(),label:(lbl||'').trim()||'Vlastní lhůta',date:dt,note:'Zadáno ručně'});
  } else {
    const t=DL_TYPES.find(x=>x[0]===sel);
    const res=t[2]==='m'?deadlineMonths(dt,t[3]):deadlineDays(dt,t[3]);
    if(!res){ toast('Neplatné datum'); return; }
    c.manualDeadlines.push({id:uid(),label:t[1],date:isoOf(res.deadline),note:(t[2]==='m'?t[3]+' měs.':t[3]+' dní')+' '+t[4]+' ('+fmtD(dt)+')'+(res.shifted?' · posunuto z víkendu/svátku':'')});
  }
  c.lastActivity='Přidána lhůta'; saveData(); renderAll(); refreshDeadlinesPanel(cid); toast('Lhůta přidána');
}
function updateManualDeadline(cid,mid,field,val){
  const c=appData.cases.find(x=>x.id===cid); if(!c) return;
  const m=(c.manualDeadlines||[]).find(x=>x.id===mid); if(!m) return;
  if(field==='label') m.label=(val||'').trim()||'Vlastní lhůta';
  else if(field==='date'){ if(!val){ toast('Datum nesmí být prázdné'); refreshDeadlinesPanel(cid); return; } m.date=val; }
  saveData(); renderAll(); refreshDeadlinesPanel(cid);
}
function removeManualDeadline(cid,mid){
  const c=appData.cases.find(x=>x.id===cid); if(!c) return;
  const m=(c.manualDeadlines||[]).find(x=>x.id===mid);
  uiConfirm('Smazat lhůtu?', m?(m.label+(m.date?(' · '+fmtD(m.date)):'')):'', ()=>{
    c.manualDeadlines=(c.manualDeadlines||[]).filter(x=>x.id!==mid);
    saveData(); renderAll(); refreshDeadlinesPanel(cid); toast('Lhůta smazána');
  });
}

/* ----- Checklist před soudem ----- */
function defaultChecklist(){
  return [
    'Prostudovat celý spis před jednáním',
    'Zkontrolovat totožnost klienta',
    'Připravit obhajobné námitky',
    'Připravit seznam důkazů k navržení',
    'Zkontrolovat lhůty — nejsou prošlé?',
    'Připravit otázky pro svědky',
    'Zkontrolovat znalecké posudky',
    'Připravit závěrečnou řeč',
    'Informovat klienta o průběhu',
    'Zkontrolovat spisovou značku',
    'Zajistit přítomnost klienta',
    'Připravit podání pro případ neúspěchu'
  ].map(t=>({id:uid(),text:t,done:false}));
}
function checklistPanelHtml(c){
  const cid=c.id; const list=Array.isArray(c.checklist)?c.checklist:[];
  const done=list.filter(i=>i.done).length;
  const rows=list.map(it=>
    '<div class="ck-row">'+
      '<div class="ck-box'+(it.done?' on':'')+'" onclick="ckToggle(\''+cid+'\',\''+it.id+'\')"><svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-11"/></svg></div>'+
      '<input class="ck-text'+(it.done?' done':'')+'" type="text" value="'+esc(it.text)+'" placeholder="Položka…" onchange="ckText(\''+cid+'\',\''+it.id+'\',this.value)">'+
      '<button class="fin-x" title="Smazat" onclick="ckDel(\''+cid+'\',\''+it.id+'\')">×</button>'+
    '</div>'
  ).join('');
  return '<div class="tile rev" style="margin-bottom:16px">'+
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px"><div class="tl" style="margin:0">Checklist před soudem</div>'+
    '<button class="btn gold sm" onclick="ckAdd(\''+cid+'\')">+ Položka</button></div>'+
    '<div class="ck-prog"><b>'+done+'</b> / '+list.length+' hotovo</div>'+
    (rows||'<p style="color:var(--muted);padding:4px 2px">Žádné položky.</p>')+'</div>'+
    '<div class="tile rev"><div class="tl">Vlastní poznámka před jednáním</div>'+
    '<textarea class="ck-note" onchange="ckNote(\''+cid+'\',this.value)" placeholder="Cokoli k tomuhle jednání…">'+esc(c.checklistNote||'')+'</textarea></div>';
}
function refreshChecklistPanel(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const el=document.getElementById('dpanel-checklist'); if(el) el.innerHTML=checklistPanelHtml(c); }
function ckToggle(cid,id){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const it=(c.checklist||[]).find(x=>x.id===id); if(!it)return; it.done=!it.done; saveData(); refreshChecklistPanel(cid); }
function ckText(cid,id,val){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const it=(c.checklist||[]).find(x=>x.id===id); if(!it)return; it.text=val; saveData(); }
function ckAdd(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; c.checklist=c.checklist||[]; c.checklist.push({id:uid(),text:'',done:false}); saveData(); refreshChecklistPanel(cid); }
function ckDel(cid,id){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const it=(c.checklist||[]).find(x=>x.id===id); uiConfirm('Smazat položku?', it?it.text:'', ()=>{ c.checklist=(c.checklist||[]).filter(x=>x.id!==id); saveData(); refreshChecklistPanel(cid); toast('Položka smazána'); }); }
function ckNote(cid,val){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; c.checklistNote=val; saveData(); }

/* ----- Soudní jednání ----- */
function hearings(c){ if(!Array.isArray(c.hearings)) c.hearings=[]; return c.hearings; }
function hearingsPanelHtml(c){
  const cid=c.id, list=hearings(c).slice().sort((a,b)=>((b.date||'')+ (b.time||'')).localeCompare((a.date||'')+(a.time||'')));
  const rows=list.length?list.map(h=>
    '<div class="hr-card">'+
      '<div class="hr-top">'+
        '<input class="hr-date" type="date" value="'+esc(h.date||'')+'" onchange="hrUpd(\''+cid+'\',\''+h.id+'\',\'date\',this.value)">'+
        '<input class="hr-time" type="time" value="'+esc(h.time||'')+'" onchange="hrUpd(\''+cid+'\',\''+h.id+'\',\'time\',this.value)">'+
        '<input class="hr-place" type="text" value="'+esc(h.place||'')+'" placeholder="místo / soud, jednací síň" onchange="hrUpd(\''+cid+'\',\''+h.id+'\',\'place\',this.value)">'+
        '<button class="fin-x" title="Smazat" onclick="hrDel(\''+cid+'\',\''+h.id+'\')">×</button>'+
      '</div>'+
      '<input class="hr-subj" type="text" value="'+esc(h.subject||'')+'" placeholder="co se projednává (předmět jednání)" onchange="hrUpd(\''+cid+'\',\''+h.id+'\',\'subject\',this.value)">'+
      '<textarea class="hr-out" placeholder="výsledek / výstup z jednání" onchange="hrUpd(\''+cid+'\',\''+h.id+'\',\'outcome\',this.value)">'+esc(h.outcome||'')+'</textarea>'+
    '</div>'
  ).join(''):emptyState('gavel','Zatím žádná jednání','Přidej soudní líčení tlačítkem výše — termíny a místa budeš mít na jednom místě.',{small:true});
  return '<div class="tile rev"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px"><div class="tl" style="margin:0">Soudní jednání</div><button class="btn gold sm" onclick="hrAdd(\''+cid+'\')">+ Jednání</button></div>'+rows+'</div>';
}
function meetings(c){ if(!Array.isArray(c.meetings)) c.meetings=[]; return c.meetings; }
function meetingsPanelHtml(c){
  const cid=c.id, list=meetings(c).slice().sort((a,b)=>((a.date||'')+(a.time||'')).localeCompare((b.date||'')+(b.time||'')));
  const rows=list.length?list.map(m=>
    '<div class="hr-card">'+
      '<div class="hr-top">'+
        '<input class="hr-date" type="date" value="'+esc(m.date||'')+'" onchange="mtUpd(\''+cid+'\',\''+m.id+'\',\'date\',this.value)">'+
        '<input class="hr-time" type="time" value="'+esc(m.time||'')+'" onchange="mtUpd(\''+cid+'\',\''+m.id+'\',\'time\',this.value)">'+
        '<input class="hr-place" type="text" value="'+esc(m.place||'')+'" placeholder="místo (kancelář, soud, online…)" onchange="mtUpd(\''+cid+'\',\''+m.id+'\',\'place\',this.value)">'+
        '<button class="fin-x" title="Smazat" onclick="mtDel(\''+cid+'\',\''+m.id+'\')">×</button>'+
      '</div>'+
      '<input class="hr-subj" type="text" value="'+esc(m.subject||'')+'" placeholder="téma schůzky" onchange="mtUpd(\''+cid+'\',\''+m.id+'\',\'subject\',this.value)">'+
      '<input class="hr-subj" type="text" value="'+esc(m.with||'')+'" placeholder="s kým (klient, svědek…)" onchange="mtUpd(\''+cid+'\',\''+m.id+'\',\'with\',this.value)">'+
      '<textarea class="hr-out" placeholder="poznámka" onchange="mtUpd(\''+cid+'\',\''+m.id+'\',\'note\',this.value)">'+esc(m.note||'')+'</textarea>'+
    '</div>'
  ).join(''):emptyState('chat','Zatím žádné schůzky','Přidej schůzku s klientem — zobrazí se na přehledu v blížících se událostech.',{small:true});
  return '<div class="tile rev" style="margin-top:14px"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px"><div class="tl" style="margin:0">Schůzky</div><button class="btn gold sm" onclick="mtAdd(\''+cid+'\')">+ Schůzka</button></div>'+rows+'</div>';
}
function jednaniPanelHtml(c){ return hearingsPanelHtml(c)+meetingsPanelHtml(c); }
function refreshHearings(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const el=document.getElementById('dpanel-jednani'); if(el) el.innerHTML=jednaniPanelHtml(c); hzRefreshIfDashboard(); }
function hzRefreshIfDashboard(){ if(typeof renderHorizon==='function' && currentPage==='dashboard') renderHorizon(); }
function hrAdd(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; hearings(c).push({id:uid(),date:'',time:'',place:'',subject:'',outcome:''}); saveData(); refreshHearings(cid); }
function hrUpd(cid,id,f,v){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const h=hearings(c).find(x=>x.id===id); if(!h)return; h[f]=v; saveData(); if(f==='date'||f==='time'||f==='subject'){ refreshHearings(cid); } }
function hrDel(cid,id){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const h=hearings(c).find(x=>x.id===id); uiConfirm('Smazat jednání?', h?((h.date?fmtD(h.date):'')+(h.subject?(' · '+h.subject):'')):'', ()=>{ c.hearings=hearings(c).filter(x=>x.id!==id); saveData(); refreshHearings(cid); toast('Jednání smazáno'); }); }
function mtAdd(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; meetings(c).push({id:uid(),date:'',time:'',place:'',subject:'',with:'',note:''}); saveData(); refreshHearings(cid); }
function mtUpd(cid,id,f,v){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const m=meetings(c).find(x=>x.id===id); if(!m)return; m[f]=v; saveData(); if(f==='date'||f==='time'||f==='subject') refreshHearings(cid); }
function mtDel(cid,id){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const m=meetings(c).find(x=>x.id===id); uiConfirm('Smazat schůzku?', m?((m.date?fmtD(m.date):'')+(m.subject?(' · '+m.subject):'')):'', ()=>{ c.meetings=meetings(c).filter(x=>x.id!==id); saveData(); refreshHearings(cid); toast('Schůzka smazána'); }); }

/* ----- Vazba + Zajištění ----- */
function custodyOf(c){ if(!c.custody||typeof c.custody!=='object') c.custody={inCustody:false,fromDate:'',fromTime:'',reason:'',note:''}; return c.custody; }
function custodyPanelHtml(c){
  const cid=c.id, cu=custodyOf(c);
  const body = cu.inCustody ?
    '<div class="hr-card" style="margin-top:12px">'+
      '<div class="hr-top">'+
        '<div class="frow" style="border:0;padding:0;flex:1;min-width:150px"><label>Datum vzetí do vazby</label><input class="hr-date" type="date" value="'+esc(cu.fromDate||'')+'" onchange="cuUpd(\''+cid+'\',\'fromDate\',this.value)"></div>'+
        '<div class="frow" style="border:0;padding:0;width:120px"><label>Čas</label><input class="hr-time" type="time" value="'+esc(cu.fromTime||'')+'" onchange="cuUpd(\''+cid+'\',\'fromTime\',this.value)"></div>'+
      '</div>'+
      '<input class="hr-subj" type="text" value="'+esc(cu.reason||'')+'" placeholder="důvod vazby (§ 67 a) / b) / c)…)" onchange="cuUpd(\''+cid+'\',\'reason\',this.value)">'+
      '<textarea class="hr-out" placeholder="poznámka (lhůty přezkumu, rozhodnutí…)" onchange="cuUpd(\''+cid+'\',\'note\',this.value)">'+esc(cu.note||'')+'</textarea>'+
    '</div>' : '<p style="color:var(--muted);padding:8px 2px 0">Obviněný není ve vazbě. Zapni přepínač, pokud byl vzat do vazby.</p>';
  return '<div class="tile rev"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><div class="tl" style="margin:0">Vazba</div>'+
    '<label class="sw"><input type="checkbox"'+(cu.inCustody?' checked':'')+' onchange="cuUpd(\''+cid+'\',\'inCustody\',this.checked)"><span>Ve vazbě</span></label></div>'+
    body+'</div>';
}
function cuUpd(cid,f,v){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; custodyOf(c)[f]=v; saveData(); if(f==='inCustody'){ const el=document.getElementById('dpanel-vazba'); if(el) el.innerHTML=custodyPanelHtml(c); } renderAll(); }

function seizures(c){ if(!Array.isArray(c.seizures)) c.seizures=[]; return c.seizures; }
function seizPanelHtml(c){
  const cid=c.id, list=seizures(c);
  const rows=list.length?list.map(s=>
    '<div class="hr-card">'+
      '<div class="hr-top">'+
        '<input class="hr-date" type="date" value="'+esc(s.date||'')+'" onchange="szUpd(\''+cid+'\',\''+s.id+'\',\'date\',this.value)">'+
        '<input class="hr-place" type="text" value="'+esc(s.by||'')+'" placeholder="kým zajištěno (orgán)" onchange="szUpd(\''+cid+'\',\''+s.id+'\',\'by\',this.value)">'+
        '<button class="fin-x" title="Smazat" onclick="szDel(\''+cid+'\',\''+s.id+'\')">×</button>'+
      '</div>'+
      '<input class="hr-subj" type="text" value="'+esc(s.what||'')+'" placeholder="co bylo zajištěno (majetek, věc)" onchange="szUpd(\''+cid+'\',\''+s.id+'\',\'what\',this.value)">'+
      '<textarea class="hr-out" placeholder="poznámka" onchange="szUpd(\''+cid+'\',\''+s.id+'\',\'note\',this.value)">'+esc(s.note||'')+'</textarea>'+
    '</div>'
  ).join(''):emptyState('box','Žádné zajištění','Pokud policie něco zajistila (věci, peníze, data), přidej záznam pro přehled.',{small:true});
  return '<div class="tile rev"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px"><div class="tl" style="margin:0">Zajištění majetku</div><button class="btn gold sm" onclick="szAdd(\''+cid+'\')">+ Zajištění</button></div>'+rows+'</div>';
}
function refreshSeiz(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const el=document.getElementById('dpanel-zajisteni'); if(el) el.innerHTML=seizPanelHtml(c); }
function szAdd(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; seizures(c).push({id:uid(),date:'',by:'',what:'',note:''}); saveData(); refreshSeiz(cid); }
function szUpd(cid,id,f,v){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const s=seizures(c).find(x=>x.id===id); if(!s)return; s[f]=v; saveData(); }
function szDel(cid,id){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const s=seizures(c).find(x=>x.id===id); uiConfirm('Smazat zajištění?', s?(s.what||''):'', ()=>{ c.seizures=seizures(c).filter(x=>x.id!==id); saveData(); refreshSeiz(cid); toast('Zajištění smazáno'); }); }

/* ----- Osoby + Výslechy ----- */
const ROLES=[['svedek','Svědek'],['poskozeny','Poškozený'],['spolupachatel','Spolupachatel'],['obvineny','Obviněný'],['znalec','Znalec'],['jine','Jiné']];
function roleLabel(r){ const x=ROLES.find(o=>o[0]===r); return x?x[1]:'Jiné'; }
function persons(c){ if(!Array.isArray(c.persons)) c.persons=[]; return c.persons; }
let ppOpen = {}; // id osoby -> true (rozbalená editace), drží se mezi překresleními
function personsPanelHtml(c){
  const cid=c.id, list=persons(c);
  const roleOpts=(sel)=>ROLES.map(o=>'<option value="'+o[0]+'"'+(sel===o[0]?' selected':'')+'>'+o[1]+'</option>').join('');
  let body='';
  if(!list.length){
    body=emptyState('users','Žádné osoby','Přidej zúčastněné — svědky, poškozené, spolupachatele. Vytáhnou se i samy z nahraného spisu.',{small:true});
  } else {
    // seskup podle pořadí rolí v ROLES
    body = ROLES.map(([rk,rlabel])=>{
      const grp=list.filter(p=>(p.role||'jine')===rk);
      if(!grp.length) return '';
      const rows=grp.map(p=>{
        const open=!!ppOpen[p.id];
        const nm=(p.name||'').trim();
        // náhled vytažených údajů v zavřeném řádku
        const bits=[];
        if(p.birthDate) bits.push('nar. '+esc(p.birthDate));
        if(p.phone) bits.push('☎ '+esc(p.phone));
        if(p.address) bits.push(esc(p.address));
        const sub = bits.length? '<span class="pp-sub">'+bits.join(' · ')+'</span>' : '';
        const rowHtml=
          '<div class="pp-row'+(open?' open':'')+'" onclick="ppToggle(\''+p.id+'\')">'+
            '<span class="pp-chev">▶</span>'+
            '<span class="pp-name'+(nm?'':' empty')+'">'+(nm?esc(nm):'(bez jména)')+sub+'</span>'+
          '</div>';
        const editHtml = open ? (
          '<div class="pp-edit" onclick="event.stopPropagation()">'+
            '<input type="text" value="'+esc(p.name||'')+'" placeholder="jméno a příjmení" onchange="ppUpd(\''+cid+'\',\''+p.id+'\',\'name\',this.value)">'+
            '<select onchange="ppRole(\''+cid+'\',\''+p.id+'\',this.value)">'+roleOpts(p.role||'jine')+'</select>'+
            '<div class="pp-grid">'+
              '<input type="text" value="'+esc(p.birthDate||'')+'" placeholder="datum narození" onchange="ppUpd(\''+cid+'\',\''+p.id+'\',\'birthDate\',this.value)">'+
              '<input type="text" value="'+esc(p.phone||'')+'" placeholder="telefon" onchange="ppUpd(\''+cid+'\',\''+p.id+'\',\'phone\',this.value)">'+
            '</div>'+
            '<input type="text" value="'+esc(p.address||'')+'" placeholder="adresa bydliště" onchange="ppUpd(\''+cid+'\',\''+p.id+'\',\'address\',this.value)">'+
            '<input type="text" value="'+esc(p.email||'')+'" placeholder="e-mail" onchange="ppUpd(\''+cid+'\',\''+p.id+'\',\'email\',this.value)">'+
            '<input type="text" value="'+esc(p.contact||'')+'" placeholder="další kontakt (datová schránka, zaměstnavatel…)" onchange="ppUpd(\''+cid+'\',\''+p.id+'\',\'contact\',this.value)">'+
            '<textarea placeholder="poznámka k osobě" onchange="ppUpd(\''+cid+'\',\''+p.id+'\',\'note\',this.value)">'+esc(p.note||'')+'</textarea>'+
            '<div class="pp-edit-foot"><button class="btn ghost sm" onclick="ppDel(\''+cid+'\',\''+p.id+'\')">Smazat osobu</button></div>'+
          '</div>'
        ) : '';
        return rowHtml+editHtml;
      }).join('');
      return '<div class="pp-group"><div class="pp-group-h">'+rlabel+'<span class="pp-count">'+grp.length+'</span></div>'+rows+'</div>';
    }).join('');
  }
  return '<div class="tile rev"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px"><div class="tl" style="margin:0">Zúčastněné osoby</div><button class="btn gold sm" onclick="ppAdd(\''+cid+'\')">+ Osoba</button></div>'+body+'</div>';
}
function refreshPersons(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const el=document.getElementById('dpanel-osoby'); if(el) el.innerHTML=personsPanelHtml(c); }
function ppToggle(id){ ppOpen[id]=!ppOpen[id]; refreshPersons(currentDetailId); }
function ppAdd(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const np={id:uid(),name:'',role:'svedek',contact:'',note:''}; persons(c).push(np); ppOpen[np.id]=true; saveData(); refreshPersons(cid); }
function ppUpd(cid,id,f,v){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const p=persons(c).find(x=>x.id===id); if(!p)return; p[f]=v; saveData(); }
function ppRole(cid,id,v){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const p=persons(c).find(x=>x.id===id); if(!p)return; p.role=v; saveData(); refreshPersons(cid); /* překreslí → osoba se přesune do správné skupiny, zůstane rozbalená */ }
function ppDel(cid,id){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const p=persons(c).find(x=>x.id===id); uiConfirm('Smazat osobu?', p?(p.name||roleLabel(p.role)):'', ()=>{ c.persons=persons(c).filter(x=>x.id!==id); delete ppOpen[id]; saveData(); refreshPersons(cid); toast('Osoba smazána'); }); }

function interrogs(c){ if(!Array.isArray(c.interrogations)) c.interrogations=[]; return c.interrogations; }
function chk(cid,id,f,val){ return '<label class="ig-chk"><input type="checkbox"'+(val?' checked':'')+' onchange="igUpd(\''+cid+'\',\''+id+'\',\''+f+'\',this.checked)"><span>'; }
function interrogPanelHtml(c){
  const cid=c.id, list=interrogs(c);
  const rows=list.length?list.map(i=>
    '<div class="hr-card"><div class="hr-top">'+
      '<input class="hr-date" type="date" value="'+esc(i.date||'')+'" onchange="igUpd(\''+cid+'\',\''+i.id+'\',\'date\',this.value)">'+
      '<input class="hr-place" type="text" value="'+esc(i.person||'')+'" placeholder="vyslýchaná osoba" onchange="igUpd(\''+cid+'\',\''+i.id+'\',\'person\',this.value)">'+
      '<button class="fin-x" title="Smazat" onclick="igDel(\''+cid+'\',\''+i.id+'\')">×</button>'+
    '</div>'+
    '<input class="hr-subj" type="text" value="'+esc(i.officer||'')+'" placeholder="vyšetřovatel (jméno a údaje)" onchange="igUpd(\''+cid+'\',\''+i.id+'\',\'officer\',this.value)">'+
    '<div class="ig-flags">'+
      chk(cid,i.id,'audio',i.audio)+'hlasový záznam</span></label>'+
      chk(cid,i.id,'house',i.house)+'domovní prohlídka</span></label>'+
      chk(cid,i.id,'tap',i.tap)+'odposlech</span></label>'+
      chk(cid,i.id,'watch',i.watch)+'sledování</span></label>'+
    '</div>'+
    '<textarea class="hr-out" placeholder="obsah / poznámka k výslechu" onchange="igUpd(\''+cid+'\',\''+i.id+'\',\'note\',this.value)">'+esc(i.note||'')+'</textarea>'+
  '</div>').join(''):emptyState('chat','Žádné výslechy','Přidej výslechy svědků, poškozených či obviněného. Později se vytáhnou i ze spisu.',{small:true});
  return '<div class="tile rev"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px"><div class="tl" style="margin:0">Výslechy</div><button class="btn gold sm" onclick="igAdd(\''+cid+'\')">+ Výslech</button></div>'+rows+'</div>';
}
function refreshInterrog(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const el=document.getElementById('dpanel-vyslechy'); if(el) el.innerHTML=interrogPanelHtml(c); }
function igAdd(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; interrogs(c).push({id:uid(),date:'',person:'',officer:'',audio:false,house:false,tap:false,watch:false,note:''}); saveData(); refreshInterrog(cid); }
function igUpd(cid,id,f,v){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const it=interrogs(c).find(x=>x.id===id); if(!it)return; it[f]=v; saveData(); }
function igDel(cid,id){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const it=interrogs(c).find(x=>x.id===id); uiConfirm('Smazat výslech?', it?(it.person||fmtD(it.date)):'', ()=>{ c.interrogations=interrogs(c).filter(x=>x.id!==id); saveData(); refreshInterrog(cid); toast('Výslech smazán'); }); }

/* ----- Generátor dokumentů ----- */
function genTemplates(c){
  const cl=clientOfCase(c)||{};
  const dnes=new Date().toLocaleDateString('cs-CZ');
  const kval=(c.obvineni&&c.obvineni[0])?('§ '+c.obvineni[0]):(c.pravniKvalifikace||'…');
  const klient=cl.name||'…';
  const nar=cl.birthDate?fmtD(cl.birthDate):'…';
  const rc=cl.rodneCislo||'…';
  const adr=cl.address||'…';
  const adv=c.obhajce||(currentUser&&currentUser.name)||'…';
  const soud=c.soud||'…';
  const spis=c.spisZnacka||'…';
  const L='__________';
  return {
'smlouva':
'PLNÁ MOC\n\n'+
'Zmocnitel:\n'+klient+', nar. '+nar+', r. č. '+rc+'\nbytem '+adr+'\n\n'+
'Zmocněnec (obhájce):\n'+adv+', advokát\n\n'+
'Zmocnitel uděluje zmocněnci plnou moc k zastupování a obhajobě ve věci\n'+
'vedené u: '+soud+', sp. zn. '+spis+', právní kvalifikace '+kval+'.\n\n'+
'Plná moc se vztahuje na všechny úkony trestního řízení ve všech stupních, '+
'včetně podávání opravných prostředků, nahlížení do spisu, účasti na úkonech a přebírání písemností.\n\n'+
'V '+L+' dne '+dnes+'\n\n'+
'_______________________            _______________________\n'+
'        zmocnitel                          zmocněnec',
'odvolani':
soud+'\nsp. zn. '+spis+'\n\n'+
'Obžalovaný: '+klient+', nar. '+nar+'\nObhájce: '+adv+'\n\n'+
'ODVOLÁNÍ\n'+
'proti rozsudku '+soud+' ze dne '+(c.judgmentDate?fmtD(c.judgmentDate):L)+', sp. zn. '+spis+'\n\n'+
'Proti shora uvedenému rozsudku podávám v zákonné lhůtě (§ 248 tr. ř.) odvolání, a to do výroku o vině i trestu.\n\n'+
'Odůvodnění:\n'+L+'\n'+L+'\n\n'+
'Navrhuji, aby odvolací soud napadený rozsudek zrušil a '+L+'.\n\n'+
'V '+L+' dne '+dnes+'\n\n'+adv+', obhájce',
'dovolani':
'Nejvyššímu soudu České republiky\nprostřednictvím '+soud+'\nsp. zn. '+spis+'\n\n'+
'Obviněný: '+klient+', nar. '+nar+'\nObhájce: '+adv+'\n\n'+
'DOVOLÁNÍ\n'+
'proti rozhodnutí ve věci sp. zn. '+spis+'\n\n'+
'Dovolání podávám v zákonné lhůtě (§ 265e tr. ř.) z dovolacího důvodu podle § 265b odst. 1 písm. '+L+' tr. ř.\n\n'+
'Odůvodnění:\n'+L+'\n'+L+'\n\n'+
'Navrhuji, aby Nejvyšší soud napadené rozhodnutí zrušil a věc vrátil k novému projednání.\n\n'+
'V '+L+' dne '+dnes+'\n\n'+adv+', obhájce',
'stiznost':
soud+'\nsp. zn. '+spis+'\n\n'+
'Obviněný: '+klient+', nar. '+nar+'\nObhájce: '+adv+'\n\n'+
'STÍŽNOST\n'+
'proti usnesení '+soud+' ze dne '+L+', sp. zn. '+spis+'\n\n'+
'Proti shora uvedenému usnesení podávám v zákonné lhůtě (§ 143 tr. ř.) stížnost.\n\n'+
'Odůvodnění:\n'+L+'\n'+L+'\n\n'+
'Navrhuji, aby bylo napadené usnesení zrušeno.\n\n'+
'V '+L+' dne '+dnes+'\n\n'+adv+', obhájce'
  };
}
function genPanelHtml(c){
  const cid=c.id;
  return '<div class="tile rev"><div class="tl">Generátor dokumentů</div>'+
    '<div style="font-size:.8rem;color:var(--muted);margin:-6px 0 12px">Vyplní se daty klienta a případu. Text uprav a zkopíruj. (AI návrh obsahu doplníme s Gemini.)</div>'+
    '<div class="gen-bar">'+
      '<select id="genType" class="pp-role" style="width:auto;min-width:200px" onchange="genMake(\''+cid+'\')">'+
        '<option value="smlouva">Smlouva / plná moc</option>'+
        '<option value="odvolani">Odvolání</option>'+
        '<option value="dovolani">Dovolání</option>'+
        '<option value="stiznost">Stížnost</option>'+
      '</select>'+
      '<button class="btn ghost sm" onclick="genCopy()">Kopírovat</button>'+
      '<button class="btn ghost sm" onclick="genPrint()">Tisk</button>'+
    '</div>'+
    '<textarea id="genOut" class="gen-out"></textarea></div>';
}
function genMake(cid){ const c=appData.cases.find(x=>x.id===cid); if(!c)return; const t=(document.getElementById('genType')||{}).value||'smlouva'; const out=document.getElementById('genOut'); if(out) out.value=genTemplates(c)[t]||''; }
function genCopy(){ const out=document.getElementById('genOut'); if(!out)return; out.select(); try{ navigator.clipboard.writeText(out.value); }catch(e){ try{document.execCommand('copy');}catch(_){} } toast('Zkopírováno'); }
function genPrint(){
  const out=document.getElementById('genOut'); if(!out)return;
  const text=out.value||'';
  const w=window.open('','_blank');
  if(!w){ toast('Povol vyskakovací okna pro tisk'); return; }
  const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  w.document.write('<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><title>Dokument</title>'+
    '<style>@page{margin:2.5cm}body{font-family:Georgia,\'Times New Roman\',serif;font-size:12pt;line-height:1.6;color:#000;white-space:pre-wrap;word-wrap:break-word}</style>'+
    '</head><body>'+esc(text)+'</body></html>');
  w.document.close();
  w.focus();
  setTimeout(function(){ w.print(); }, 250);
}

/* ====== KOMPLETNOST SPISU ======
   Každý trestní případ má stejnou kostru. Appka porovná, co je nahráno/vytaženo
   vs. co chybí — advokát hned vidí „na nic jsem nezapomněl" a co dohledat. */
// Fáze řízení → pořadí (1 přípravné → 4 dovolací). Určuje, které dokumenty už mají dávat smysl.
function casePhaseRank(c){
  const f=(c.faze||'').toLowerCase();
  if(/dovol/.test(f)) return 4;
  if(/odvol/.test(f)) return 3;
  if(/líčen|hlavní|soud/.test(f)) return 2;
  return 1; // přípravné (výchozí)
}
function caseCompleteness(c){
  // DOKUMENTY se počítají JEN podle skutečně nahraných souborů (ne podle zmínek v textu).
  const files=(c.documents||[]).map(d=>((d.type||'')+' '+(d.name||'')).toLowerCase());
  const hasFile=re=>files.some(f=>re.test(f));
  const persons=c.persons||[];
  const role=r=>persons.some(p=>(p.role||'')===r);
  const fld=v=>!!String(v||'').trim();
  const tlCount=(c.timeline||[]).filter(t=>t&&t.date&&!t.deletedAt).length;
  const rank=casePhaseRank(c);
  const all=[
    // ----- Dokumenty (nahraný soubor daného typu) · from = od jaké fáze je očekáván -----
    {g:'doc', from:1, label:'Usnesení o zahájení stíhání', ok: hasFile(/zaháj|usnesen|usn[\s._-]|§?\s*160/)},
    {g:'doc', from:1, label:'Protokoly o výslechu',        ok: hasFile(/výslech|vysvětlen|protokol/)},
    {g:'doc', from:1, label:'Znalecký posudek',            ok: hasFile(/znaleck|posudek|odborné vyjádř/)},
    {g:'doc', from:1, label:'Domovní prohlídka / zajištění', ok: hasFile(/prohlídk|zajištěn/) || (c.seizures||[]).length>0},
    {g:'doc', from:1, label:'Výpis z rejstříku trestů',    ok: hasFile(/rejstřík|opis.{0,4}rt|výpis.{0,6}rt|trestů/)},
    {g:'doc', from:1, label:'Listinné / bankovní důkazy',  ok: hasFile(/výpis|faktur|listin|smlouv|doklad|bankov/)},
    {g:'doc', from:2, label:'Obžaloba',                    ok: hasFile(/obžalob/)},
    {g:'doc', from:2, label:'Protokoly z hlavního líčení', ok: hasFile(/líčen/)},
    {g:'doc', from:3, label:'Rozsudek / trestní příkaz',   ok: hasFile(/rozsudek|trestní příkaz/) || fld(c.judgmentDate)},
    {g:'doc', from:3, label:'Odvolání',                    ok: hasFile(/odvolán/)},
    {g:'doc', from:4, label:'Dovolání',                    ok: hasFile(/dovolán/)},
    // ----- Vytažená data (z čehokoli nahraného) · vždy -----
    {g:'data', label:'Právní kvalifikace (§)',  ok: fld(c.pravniKvalifikace) || (c.obvineni&&c.obvineni.length>0)},
    {g:'data', label:'Poškození identifikováni', ok: role('poskozeny')},
    {g:'data', label:'Celková výše škody',       ok: fld(c.vyseSkody)},
    {g:'data', label:'Soud / SZ / vyšetřovatel', ok: fld(c.soud)||fld(c.statniZastupce)||fld(c.vysetrovatel)},
    {g:'data', label:'Časová osa událostí',      ok: tlCount>=3}
  ];
  // Dokument ukaž, jen když: je nahraný (ok) NEBO už ho fáze řízení očekává. Data vždy.
  return all.filter(i=> i.g==='data' || i.ok || (i.from||1)<=rank);
}
function completenessPanelHtml(c){
  const items=caseCompleteness(c);
  const chip=i=>'<span class="cmp-chip'+(i.ok?' ok':' miss')+'">'+
    (i.ok?'<svg viewBox="0 0 24 24" class="cmp-ic"><path d="M5 13l4 4L19 7"/></svg>'
         :'<svg viewBox="0 0 24 24" class="cmp-ic"><path d="M12 8v5M12 16v.5M12 3l9 16H3z"/></svg>')+
    esc(i.label)+'</span>';
  const grp=g=>items.filter(i=>i.g===g);
  const docs=grp('doc'), data=grp('data');
  const dDone=docs.filter(i=>i.ok).length, daDone=data.filter(i=>i.ok).length;
  const missDocs=docs.filter(i=>!i.ok);
  const score=(done,total)=>{ const p=done/total; return p>=0.8?'var(--green)':p>=0.5?'var(--am)':'var(--red)'; };
  return '<div class="tile rev cmp-tile">'+
    '<div class="cmp-head"><span class="tl" style="margin:0">Kompletnost spisu</span></div>'+
    // Dokumenty
    '<div class="cmp-grp"><div class="cmp-grp-h"><span>📄 Dokumenty ve spisu</span>'+
      '<span class="cmp-grp-n" style="color:'+score(dDone,docs.length)+'">'+dDone+'/'+docs.length+'</span></div>'+
      '<div class="cmp-chips">'+docs.map(chip).join('')+'</div></div>'+
    // Data
    '<div class="cmp-grp"><div class="cmp-grp-h"><span>🧩 Vytažená data</span>'+
      '<span class="cmp-grp-n" style="color:'+score(daDone,data.length)+'">'+daDone+'/'+data.length+'</span></div>'+
      '<div class="cmp-chips">'+data.map(chip).join('')+'</div></div>'+
    (missDocs.length
      ? '<div class="cmp-miss">Doporučené dokumenty, které ještě nemáš: <b>'+missDocs.map(m=>esc(m.label)).join(' · ')+'</b></div>'
      : '<div class="cmp-miss cmp-allok">✓ Všechny obvyklé dokumenty spisu jsou nahrané.</div>')+
  '</div>';
}

function openCaseDetail(id){
  const c=appData.cases.find(x=>x.id===id); if(!c) return;
  currentDetailId=id;

  const dlHtml = deadlinesPanelHtml(c);

  const clCli=clientOfCase(c);
  const clientTileHtml = clCli ?
    '<div class="tile rev">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px"><div class="tl" style="margin:0">Klient</div>'+
        '<button class="btn ghost sm" onclick="openClientDetail(\''+clCli.id+'\')">Otevřít kartu</button></div>'+
      rrow('Jméno',clCli.name)+
      rrow('Datum narození',fmtD(clCli.birthDate))+
      rrow('Rodné číslo',clCli.rodneCislo)+
      rrow('Číslo OP / pasu',clCli.idNumber)+
      rrow('Telefon',clCli.phone)+
      rrow('E-mail',clCli.email)+
      rrow('Datová schránka',clCli.datovaSchranka)+
      rrow('Trvalé bydliště',clCli.address)+
    '</div>' :
    '<div class="tile rev"><div class="tl">Klient</div>'+
      '<p style="color:var(--muted);padding:4px 2px 12px">Případ není propojený s klientem.</p>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
        '<button class="btn ghost sm" onclick="linkCaseClient(\''+c.id+'\')">Propojit s klientem</button>'+
        '<button class="btn gold sm" onclick="createClientFromCase(\''+c.id+'\')">Založit klienta z případu</button>'+
      '</div></div>';

  const fmtSize=b=>!b?'':(b>1048576?(b/1048576).toFixed(1)+' MB':Math.round(b/1024)+' kB');
  const docsHtml = (c.documents||[]).length ? (c.documents).map((d,di)=>
    '<div class="dl-card"><div class="ll">'+esc(d.name||'spis.pdf')+'<small>'+esc(d.type||'—')+(d.pages?(' · '+d.pages+' str.'):'')+(d.fileSize?(' · '+fmtSize(d.fileSize)):'')+(d.when?(' · '+new Date(d.when).toLocaleDateString('cs-CZ')):'')+'</small></div>'+
    '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">'+
    (d.fileId?'<button class="dl-open" onclick="openStoredFile(\''+d.fileId+'\')" title="Otevřít originál">'+
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg></button>'
      :'<span class="dl-noorig" title="Originál neuložen (starší dokument)">jen text</span>')+
    '<button class="dl-trash" onclick="deleteCaseDoc(\''+c.id+'\','+di+')" title="Smazat originál (text zůstane)"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3"/></svg></button>'+
    '</div></div>'
  ).join('') : emptyState('doc','Žádné spisy','Nafoť spis telefonem nebo nahraj PDF — Gemini ho přečte a vytáhne data.',{small:true});
  const totalBytes=(c.documents||[]).reduce((s,d)=>s+(d.fileSize||0),0);
  const fileCount=(c.documents||[]).filter(d=>d.fileId).length;
  const storageHtml = totalBytes? '<div class="storage-bar"><div class="storage-info"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--am)" stroke-width="1.7"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/></svg><span>'+fileCount+' originálů · <b>'+fmtSize(totalBytes)+'</b> v zařízení</span></div><span class="storage-hint">Originály v IndexedDB · text v záloze</span></div>' : '';

  const sum = (c.documents&&c.documents[0]&&c.documents[0].summary)||'';
  const transcript = c.analysisText||'';

  document.getElementById('page-detail').innerHTML =
    '<div class="lc-workspace"><aside class="lc-ws-list">'+wsCaseListHtml(c)+'</aside><div class="lc-ws-main">'+
    '<div class="lc-hero rev">'+
      '<div class="lc-hero-top">'+
        '<span class="backbtn" onclick="showPage(\'cases\')">'+dicon('back')+'Případy</span>'+
        '<div class="lc-hero-actions"><button class="btn ghost sm" onclick="askDeleteCase(\''+c.id+'\')" title="Přesunout do koše">Smazat</button><span class="btn gold" onclick="saveCaseDetail()">Uložit změny</span></div>'+
      '</div>'+
      '<div class="lc-eyebrow">'+esc(((c.obvineni&&c.obvineni[0])?('§ '+c.obvineni[0]):'TRESTNÍ AGENDA'))+' <i>•</i> '+esc(c.spisZnacka||'bez spis. zn.')+' <i>•</i> '+esc(c.faze||c.status||'—')+'</div>'+
      '<h1 class="lc-hero-title">'+esc(c.clientName||'Případ')+'</h1>'+
      '<div class="lc-meta-grid">'+
        '<div class="lc-meta"><div class="lc-meta-l">Klient</div><div class="lc-meta-v">'+esc(c.clientName||'—')+'</div></div>'+
        '<div class="lc-meta"><div class="lc-meta-l">Fáze řízení</div><div class="lc-meta-v">'+esc(c.faze||c.status||'—')+'</div></div>'+
        '<div class="lc-meta"><div class="lc-meta-l">Spisová značka</div><div class="lc-meta-v gold">'+esc(c.spisZnacka||'—')+'</div></div>'+
        '<div class="lc-meta"><div class="lc-meta-l">Právní kvalifikace</div><div class="lc-meta-v">'+esc(c.pravniKvalifikace||((c.obvineni&&c.obvineni.length)?('§ '+c.obvineni.join(', § ')):'—'))+'</div></div>'+
      '</div>'+
      '<div class="lc-hero-cta">'+
        '<button class="btn gold" onclick="switchDetailTab(\'analyzy\')">'+dicon('analyzy')+'Nová AI analýza</button>'+
        '<button class="btn ghost" onclick="switchDetailTab(\'dokumenty\')">'+dicon('dokumenty')+'Otevřít spis</button>'+
        '<button class="btn ghost" onclick="window.print()"><svg class="disvg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>Exportovat</button>'+
      '</div>'+
    '</div>'+

    '<div class="dtabs rev">'+
      dtab('prehled','Přehled')+
      dtab('dokumenty','Dokumenty')+
      dtab('analyzy','Analýzy')+
      dtab('chat','Chat nad spisem')+
      dtab('lhuty','Lhůty')+
      dtab('osa','Časová osa')+
      dtab('jednani','Jednání')+
      dtab('vazba','Vazba')+
      dtab('zajisteni','Zajištění')+
      dtab('osoby','Osoby')+
      dtab('vyslechy','Výslechy')+
      dtab('sablony','Šablony')+
      dtab('checklist','Checklist')+
    '</div>'+

    // PŘEHLED
    '<div class="dpanel" id="dpanel-prehled">'+
      panelSpisuHtml(c)+
      '<div class="dgrid">'+
      clientTileHtml+
      '<div class="tile rev">'+
        '<div class="tl">Případ</div>'+
        frow('Spisová značka','d_spisZnacka',c.spisZnacka)+
        frow('Právní kvalifikace','d_pravniKvalifikace',c.pravniKvalifikace||((c.obvineni&&c.obvineni.length)?('§ '+c.obvineni.join(', § ')):''))+
        frow('Fáze řízení','d_faze',c.faze)+
        frow('Status','d_status',c.status)+
        frow('Soud','d_soud',c.soud)+
        frow('Soudce','d_soudce',c.soudce)+
        frow('Státní zástupce','d_statniZastupce',c.statniZastupce)+
        frow('Obhájce','d_obhajce',c.obhajce||((currentUser&&currentUser.name)||''))+
        frow('Datum rozsudku (vyhlášení)','d_judgmentDate',c.judgmentDate,'date')+
        frow('Doručení opisu rozsudku','d_judgmentDeliveryDate',c.judgmentDeliveryDate,'date')+
        frow('Doručení trestního příkazu','d_orderDeliveryDate',c.orderDeliveryDate,'date')+
        frow('Oznámení usnesení (stížnost)','d_rulingNoticeDate',c.rulingNoticeDate,'date')+
        frow('Datum vzetí do vazby','d_custodyDate',c.custodyDate,'date')+
        frow('Typ dokumentu','d_documentType',c.documentType)+
        frow('Výše škody','d_vyseSkody',c.vyseSkody)+
        frow('Vyšetřovatel','d_vysetrovatel',c.vysetrovatel)+
      '</div>'+
    '</div></div>'+

    // LHŮTY
    '<div class="dpanel" id="dpanel-lhuty" style="display:none"><div class="tile rev"><div class="tl">Lhůty případu</div>'+dlHtml+'</div></div>'+

    // ČASOVÁ OSA
    '<div class="dpanel" id="dpanel-osa" style="display:none"><div class="tile rev"><div class="tl">Časová osa · automaticky z dokumentů</div>'+tlToolbarHtml()+renderTimeline(c)+'</div></div>'+

    // DOKUMENTY
    '<div class="dpanel" id="dpanel-dokumenty" style="display:none">'+
      completenessPanelHtml(c)+
      (lastCaseExtractRecap&&lastCaseExtractRecap.caseId===c.id?caseExtractRecapHtml(lastCaseExtractRecap.stats):'')+
      '<div class="tile rev" style="margin-bottom:16px">'+
        '<div class="tl">Nahrané spisy</div>'+
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">'+
          '<button class="btn gold sm" id="addDocBtn" onclick="document.getElementById(\'addDocInput\').click()"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-2px;margin-right:5px"><path d="M12 5v14M5 12h14"/></svg>Přidat PDF</button>'+
          '<button class="btn sm" style="background:var(--surface2);border:1px solid var(--line2)" onclick="openScanner(\''+c.id+'\')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--am)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>Fotit spis</button>'+
          '<span style="font-size:.74rem;color:var(--dim)">výpovědi, výslechy, posudky… připojí se k tomuto případu</span>'+
        '</div>'+
        '<input type="file" id="addDocInput" accept="application/pdf" style="display:none" onchange="addDocToCase(this.files[0]);this.value=\'\'">'+
        '<div class="ocrprog" id="addDocProg" style="margin-bottom:14px"><div class="ocrbar"><div class="ocrfill" id="addDocFill"></div></div><div class="ocrmsg"><span class="ocrdot"></span><span id="addDocMsg">Načítám dokument…</span></div></div>'+
        docsHtml+
        storageHtml+
      '</div>'+
      '<div class="tile rev"><div class="tl">Shrnutí spisu</div>'+
        '<div class="dsum">'+(sum?esc(sum):'<span style="color:var(--muted)">Bez shrnutí.</span>')+'</div>'+
        (transcript?('<div class="tl" style="margin-top:18px">Přepis spisu <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400">(podklad pro AI analýzy)</span></div><div class="dtext">'+esc(transcript)+'</div>'):'')+
      '</div>'+
    '</div>'+

    // ANALÝZY
    '<div class="dpanel" id="dpanel-analyzy" style="display:none">'+
      '<div id="analysisCatalog">'+
        (transcript? renderAnalysisCatalog() : emptyState('search','K případu není vložen žádný dokument','Nahraj primární data o případu v sekci <b>Dokumenty</b> — pak tu spustíš AI analýzy.',{small:true}))+
      '</div>'+
      '<div class="tile rev" id="analysisResult" style="display:none;margin:20px 0 16px"></div>'+
      '<div class="tile rev" id="analysisHistory"></div>'+
    '</div>'+

    // CHAT NAD SPISEM (RAG)
    '<div class="dpanel" id="dpanel-chat" style="display:none">'+chatPanelHtml(c)+'</div>'+

    // JEDNÁNÍ
    '<div class="dpanel" id="dpanel-jednani" style="display:none">'+jednaniPanelHtml(c)+'</div>'+

    // VAZBA + ZAJIŠTĚNÍ
    '<div class="dpanel" id="dpanel-vazba" style="display:none">'+custodyPanelHtml(c)+'</div>'+
    '<div class="dpanel" id="dpanel-zajisteni" style="display:none">'+seizPanelHtml(c)+'</div>'+

    // OSOBY + VÝSLECHY
    '<div class="dpanel" id="dpanel-osoby" style="display:none">'+personsPanelHtml(c)+'</div>'+
    '<div class="dpanel" id="dpanel-vyslechy" style="display:none">'+interrogPanelHtml(c)+'</div>'+

    // ŠABLONY
    '<div class="dpanel" id="dpanel-sablony" style="display:none">'+genPanelHtml(c)+'</div>'+

    // CHECKLIST
    '<div class="dpanel" id="dpanel-checklist" style="display:none">'+checklistPanelHtml(c)+'</div>'+
    '</div></div>';

  // data-tab atributy pro přepínání
  document.querySelectorAll('#page-detail .dtab').forEach((t,i)=>{ t.setAttribute('data-tab',['prehled','dokumenty','analyzy','chat','lhuty','osa','jednani','vazba','zajisteni','osoby','vyslechy','sablony','checklist'][i]); });
  genMake(c.id);
  mdOnType(c.id);
  renderAnalysisHistory(c);
  renderRagPanel();
  switchDetailTab(currentDetailTab);

  showPage('detail');
  requestAnimationFrame(resetAppScroll);
}
function saveCaseDetail(){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const v=id=>{ const el=document.getElementById(id); return el?el.value.trim():''; };
  c.spisZnacka=v('d_spisZnacka'); c.pravniKvalifikace=v('d_pravniKvalifikace');
  c.faze=v('d_faze'); c.status=v('d_status'); c.soud=v('d_soud'); c.soudce=v('d_soudce');
  c.statniZastupce=v('d_statniZastupce'); c.obhajce=v('d_obhajce');
  c.judgmentDate=v('d_judgmentDate'); c.custodyDate=v('d_custodyDate');
  c.judgmentDeliveryDate=v('d_judgmentDeliveryDate'); c.orderDeliveryDate=v('d_orderDeliveryDate'); c.rulingNoticeDate=v('d_rulingNoticeDate');
  c.documentType=v('d_documentType'); c.vyseSkody=v('d_vyseSkody'); c.vysetrovatel=v('d_vysetrovatel');
  const pars=(c.pravniKvalifikace.match(/\d+[a-z]?/g)||[]);
  if(pars.length) c.obvineni=pars;
  c.lastActivity='Upraveno';
  saveData(); renderAll();
  toast('Změny uloženy');
  openCaseDetail(currentDetailId); // refresh lhůt/osy, zachová aktivní záložku
}


/* ============ AI ANALÝZY (KROK 2) ============ */
const GEMINI_SYSTEM =
'Jsi zkušený český obhájce v trestních věcech s 20 lety praxe. Odpovídáš česky, věcně a prakticky, jako pracovní podklad pro advokáta. '+
'MANTINELY: Pokud informace ve spisu chybí, výslovně to uveď ("ze spisu nevyplývá…") a nic si nevymýšlej — žádná fakta, jména, čísla jednací. '+
'Judikaturu uváděj jen pokud si jsi jejím zněním jistý a KAŽDÝ odkaz označ na konci textem [K OVĚŘENÍ]. '+
'Tvůj výstup je NÁVRH pro advokáta ke kontrole, nikdy ne definitivní právní rada — o taktice nerozhoduješ ty, ale advokát. '+
'NIKDY neuváděj procentuální šanci na úspěch ani konkrétní číselnou predikci výše trestu — bez databáze rozsudků by šlo o halucinaci; používej jen slovní/kvalitativní hodnocení (např. „silná pozice", „důkazní nouze"). '+
'ZÁVAŽNOST: každou klíčovou vadu nebo zjištění uveď na začátku řádku štítkem podle dopadu na řízení — [FATÁLNÍ] (neplatnost úkonů, promlčení, absolutní překážky řízení), [VYSOKÁ] (zásahy do svobody a majetku — lhůty, vazba, zajištění, likvidační tresty), [STŘEDNÍ] (hmotněprávní deficity obžaloby — důkazní nouze, exces), [NÍZKÁ] (personální rozpory ve výpovědích). '+
'Formátuj: nadpisy "## ", odrážky "* ", důležité **tučně".';

// Katalog — přidání další analýzy = jeden řádek do items. Žádný zásah do logiky.
const ANALYSES = [
  {
    key:'m1', primary:true, label:'Modul 1 — Stručná prvotní analýza',
    what:'Triage: přesná extrakce objektivních dat z prvních dokumentů (obviněný, OČTŘ, kvalifikace, lhůty, fáze) — základ pro moduly 2–5. Nehodnotí vinu ani důkazy.',
    oddilyA:['Informace o obviněném','Identifikace OČTŘ + spis. značka','Spoluobvinění a účastníci','Právní kvalifikace','Aktuální stav klienta','Procesní a vazební lhůty','Fáze řízení + nutná obhajoba (§ 36)'],
    oddilyB:['Krátký přehled','Popis skutku','Aktuální stav','Poškození a škody','Svědci a svědecké výpovědi','Co zatím není zřejmé','Závěrečné shrnutí'],
    docs:['1× HLAVNÍ dokument','usnesení o zahájení TS','sdělení obvinění','obžaloba'],
    task:'Jsi analytický procesor pro TRIAGE trestního spisu (Modul 1). Tvým úkolem NENÍ hodnotit vinu ani pravdivost důkazů, ale provést přesnou extrakci a organizaci objektivních dat z primárních dokumentů (usnesení o zahájení stíhání, obžaloba, protokoly). Výstupem jsou čistá strukturovaná data pro navazující moduly 2–5. Zachovej presumpci neviny. Každý výstup je NÁVRH — kontrolu provádí advokát.\n\n'+
      'TVRDÁ ZÁKONNÁ DATA (použij je, needukuj vlastní): Nutná obhajoba § 36 TŘ — obviněný MUSÍ mít obhájce, je-li ve vazbě/výkonu trestu (§ 36/1a), při omezené svéprávnosti (§ 36/1b), v řízení proti uprchlému (§ 36/1c), nebo koná-li se řízení o TČ s horní hranicí trestu PŘEVYŠUJÍCÍ 5 let (§ 36/3). Promlčecí doby § 34/1 TZ dle horní hranice sazby: 30 let (u výjimečného trestu 20) · 15 let (horní hranice ≥ 10 let) · 10 let (≥ 5 let) · 5 let (≥ 3 léta) · 3 léta (ostatní). Hranice škody § 138/1 TZ: nikoli nepatrná ≥ 10 000 · nikoli malá ≥ 50 000 · větší ≥ 100 000 · značná ≥ 1 000 000 · velkého rozsahu ≥ 10 000 000 Kč.\n\n'+
      '# ZÁKLADNÍ PŘEHLED\n\n'+
      '## Informace o obviněném\nJméno a příjmení, datum narození, adresa.\n\n'+
      '## Identifikace OČTŘ + spisová značka\nKonkrétní vyšetřovatel, státní zástupce, soudce a útvary. Spisová značka / číslo jednací. (Důležité pro místní a věcnou příslušnost a podjatost.)\n\n'+
      '## Spoluobvinění a další účastníci\nJe klient stíhán sám, nebo jako součást skupiny? Kdo jsou spoluobvinění.\n\n'+
      '## Právní kvalifikace\nZ čeho je obviněn — paragraf(y), zda přečin nebo zločin, a HORNÍ HRANICE trestní sazby (vyčti ji z dokumentu).\n\n'+
      '## Aktuální stav klienta\nNa svobodě / zadržen / ve vazbě / obviněn.\n\n'+
      '## Procesní a vazební lhůty\nZ dokumentů (např. protokol o zadržení) vyextrahuj datum a čas zadržení a spočítej běžící zákonné lhůty (např. 48 hodin pro předání soudu).\n\n'+
      '## Fáze řízení a nutná obhajoba\nUrči procesní fázi. Poté KŘÍŽOVĚ podle horní hranice sazby zkontroluj § 36: pokud horní hranice PŘEVYŠUJE 5 let (nebo je dán jiný důvod § 36/1), UPOZORNI: „Vznikla povinnost mít obhájce (§ 36 TŘ) — nutno zrevidovat, zda všechny úkony proběhly za přítomnosti obhájce, případně zda se klient obhájce výslovně vzdal."\n\n'+
      '# ZÁKLADNÍ INFORMACE O PŘÍPADU\n\n'+
      '## Krátký přehled\nO co jde — dvě věty.\n\n'+
      '## Popis skutku\nChronologický popis, co se podle spisu stalo.\n\n'+
      '## Aktuální stav\nKde řízení stojí.\n\n'+
      '## Poškození a škody\nVypiš poškozené „Jméno – částka", na konec celková škoda a její kategorie dle § 138 (nepatrná / malá / větší / značná / velkého rozsahu).\n\n'+
      '## Svědci a svědecké výpovědi\nVypiš svědky a stručně co vypověděli. NEHODNOŤ, zda jsou pro nebo proti — jen popiš. (Označení PRO / PROTI / NEUTRÁLNÍ si dělá advokát ručně.)\n\n'+
      '## Co zatím není zřejmé\nCo nelze z nahraných dokumentů zjistit (možná málo vstupních dat).\n\n'+
      '## Závěrečné shrnutí\nObjektivně zhodnoť dostupné informace. NEDĚLEJ závěry o vině. Upozorni na nutnost doplnit dokumenty pro navazující detailní analýzy (moduly 2–5).' },
  {
    key:'m2', label:'Modul 2 — Hmotněprávní analýza',
    what:'Analytické zrcadlo obžaloby: subsumpce skutku, hledání děr ve znacích skutkové podstaty a „důkazní nouze" (jestli je tvrzení podložené). Nehodnotí důkazy — to dělá Modul 3.',
    oddily:['Oddíl 0 — přípustnost / promlčení (semafor)','Oddíl 1 — skutková podstata + forma trestné činnosti','Oddíl 2 — deficit znaků','Důkazní nouze (2 sloupce: tvrzení / důkaz)','Determinanty trestu (§ 41 / § 42)','Návrh alternativ (BETA)'],
    docs:['usnesení / obžaloba','+ vše ostatní'],
    task:'Jsi analytický procesor trestního práva hmotného (Modul 2 — subsumpce a testování obžaloby). Tvým úkolem NENÍ hodnotit pravdivost svědeckých výpovědí (to dělá Modul 3), ale zkoumat formální a materiální logiku obžaloby: extrahovat státem tvrzený skutkový stav, křížově jej podřadit pod znaky skutkové podstaty, najít chybějící prvky (deficity) a materiální korektivy, a vytvořit mapu „tvrzení vs. důkaz" (důkazní nouze). Presumpce neviny. Každý výstup je NÁVRH — kontroluje advokát.\n\n'+
      'TVRDÁ ZÁKONNÁ DATA (needukuj vlastní): Přípustnost § 11/1 TŘ (stíhání nelze zahájit / nutno zastavit — mj. promlčení, milost/amnestie, ne bis in idem, vynětí z pravomoci). Ultima ratio § 12/2 TZ (subsidiarita trestní represe). Zavinění § 15 TZ (úmysl přímý/nepřímý), § 16 TZ (nedbalost vědomá/nevědomá). Polehčující § 41 TZ, přitěžující § 42 TZ, ZÁKAZ DVOJÍHO PŘIČÍTÁNÍ § 39/4 TZ (k okolnosti, která je zákonným znakem TČ, nelze přihlédnout jako k polehčující či přitěžující). Moderace § 58/1 TZ (mimořádné snížení pod dolní hranici sazby). U právnických osob ZTOPO (zák. 418/2011): § 7 (negativní výčet činů, které PO spáchat nemůže), § 8 (přičitatelnost).\n\n'+
      '# ANALÝZA SKUTKOVÉ PODSTATY\n\n'+
      '## Oddíl 0 — Přípustnost stíhání (semafor promlčení)\nPorovnej datum spáchání skutku s datem zahájení stíhání a se zákonnou promlčecí dobou (§ 34/1 dle horní hranice sazby kvalifikace). Výstup:\n* 🟢 ZELENÁ — z časového a procesního hlediska nic nebrání stíhání.\n* 🔴 ČERVENÁ — „Detekováno možné uplynutí promlčecí doby (rozestup X let). NUTNÁ KONTROLA ADVOKÁTA." (výpočet dat je orientační.)\n\n'+
      '## Oddíl 1 — Skutková podstata dle spisu\nZ usnesení nebo obžaloby extrahuj tvrzení Policie / SZ a identifikuj: **Objekt** · **Objektivní stránka** (jednání – následek – kauzální nexus) · **Subjekt** · **Subjektivní stránka** (zavinění § 15 / § 16). Pátý bod **Forma trestné činnosti**: vyčti, zda kvalifikují jako dokonaný čin / pokus / přípravu a zda je klient hlavní pachatel / spolupachatel / návodce / pomocník.\n\n'+
      '## Oddíl 2 — Deficit znaků skutkové podstaty (analytické zrcadlo)\nČÁST PRVNÍ: Identifikuj „bílá místa" — který ze 4 pilířů státní zástupce neprokázal nebo dovodil chybně. (Pokud Oddíl 1 tvrdí „spolupachatel", zkontroluj, zda je tvrzen společný úmysl; pokud ne, vyhoď to jako deficit.)\nČÁST DRUHÁ: Materiálně-právní korektivy — okolnosti vylučující protiprávnost (nutná obrana, krajní nouze…) a subsidiarita / ultima ratio (§ 12/2 — nejde spíše o přestupek nebo občanskoprávní spor?).\n\n'+
      '# ANALÝZA DŮKAZNÍ SITUACE — hledání důkazní nouze\nPOZOR: NEHODNOTÍŠ, zda je důkaz pravdivý (to dělá Modul 3). Zjišťuješ pouze, zda je každé tvrzení obžaloby NĚČÍM PODLOŽENO. Výstup = 2sloupcová mapa: vlevo TVRZENÍ, vpravo DŮKAZ — nebo „důkaz chybí". Hledá se důkazní nouze.\n\n'+
      '# ANALÝZA DETERMINANTŮ TRESTU (§ 41 / § 42)\nDvousloupcová tabulka pro přípravu závěrečné řeči (nezkoumá vinu, jen budoucí trest):\n* Levý sloupec — objektivní POLEHČUJÍCÍ okolnosti prokazatelné ze spisu (§ 41: např. spáchal poprvé, projevil lítost, nahradil škodu, sám oznámil, věk blízko mladistvým).\n* Pravý sloupec — tvrzené PŘITĚŽUJÍCÍ okolnosti SZ (§ 42: např. s rozmyslem, ze ziskuchtivosti) s odkazem na stranu obžaloby.\nHlídej § 39/4 (zákaz dvojího přičítání).\n\n'+
      '# NÁVRH ALTERNATIV (BETA)\nPokud ze spisu vyplývá, že skutek se nepochybně stal a spáchal ho klient, nabídni „únikovou cestu" k mírnějšímu trestu. Doporučené procesní kroky: stížnost proti usnesení (chybí-li znak skutkové podstaty), návrh na zastavení stíhání, vytipovat důkazy k doplnění. (Toto je BETA — hrubý návrh.)' },
  {
    key:'m3', fav:true, wide:true, tag:'Technologické těžiště', label:'Modul 3 — Důkazní (forenzní) analýza',
    what:'Nelítostná dekonstrukce důkazní masy: procesní pochybení, rozpory ve výpovědích, konflikt s listinami, časová osa / alibi, meze posudků. Tady se důkazy ANALYZUJÍ natvrdo.',
    oddily:['Oddíl 1 — zákonnost důkazů (§ 89 / § 100 / § 88)','Oddíl 2 — matice rozporů ve výpovědích (§ 158 / § 164 / § 211)','Oddíl 3 — listinné a věcné důkazy (výpověď vs. výpis / lokace)','Oddíl 4 — časová osa a alibi','Oddíl 5 — znalecké posudky (BETA)'],
    docs:['protokoly o výsleších','úřední záznamy','listiny','znalecké posudky'],
    task:'Jsi expertní forenzní a procesní analyzátor (Modul 3 — důkazní analýza). Tvým úkolem není subsumovat skutek, ale podrobit nekompromisní kritice samotné nosiče informací — důkazní prostředky (výslechy, úřední záznamy, listiny, znalecké posudky). Hledej procesní nezákonnosti, rozpory a slabá místa. Cílem je znevěrohodnit a procesně izolovat vadné důkazy OČTŘ. Presumpce neviny. Každý výstup je NÁVRH — kontroluje advokát.\n\n'+
      'TVRDÁ ZÁKONNÁ DATA (needukuj vlastní): § 89/3 TŘ — důkaz získaný nezákonným donucením nesmí být použit. § 101/1 TŘ — před výslechem svědka zjistit totožnost, poměr k obviněnému a POUČIT o právu odepřít výpověď; chybí-li poučení v hlavičce protokolu, je důkaz potenciálně nezákonný. § 158/6 TŘ — úřední záznam o podaném vysvětlení ZÁSADNĚ nelze použít jako důkaz před soudem (zákaz konstatování), je-li osoba později vyslýchána jako svědek. § 211/1 a § 211/6 TŘ — protokol o výpovědi lze v hlavním líčení číst jen za striktních podmínek (souhlas SZ i obžalovaného); systém navrhne, aby advokát zvážil neudělení souhlasu u neprospěšných záznamů. § 105/1 TŘ — znalec se přibírá jen k odborným otázkám (ne právním). § 110a TŘ — posudek předložený obhajobou má stejnou váhu, má-li náležitosti. § 215/2,3 TŘ — právo klást vyslýchanému otázky (křížový výslech).\n\n'+
      '## Oddíl 1 — Analýza zákonnosti („plody z otráveného stromu", § 89 TŘ)\nProjdi hlavičky protokolů o výslechu: předcházelo zákonné poučení (§ 101; právo odepřít výpověď § 100 u příbuzných)? Byl odposlech pořízen zákonně (§ 88)? Vypiš, u kterých úkonů byly procesní chyby. Nezákonné důkazy NEškrtej paušálně — OZNAČ je s VAROVÁNÍM a návrhem na kontrolu advokátem (zásada volného hodnocení ponechává soudu prostor).\n\n'+
      '## Oddíl 2 — Analýza rozporů ve výpovědích\nPorovnej úřední záznamy (§ 158/6) s pozdějšími výpověďmi (§ 164) a před soudem. Vygeneruj MATICI ROZPORŮ — po dvojicích „dřívější tvrzení ↔ pozdější tvrzení" (rozpory v ději, čase, osobách) jako podklad pro křížový výslech a návrh na přečtení protokolu (§ 211/3).\n\n'+
      '## Oddíl 3 — Analýza listinných a věcných důkazů\nKonfrontuj výpovědi s objektivními listinami (výpis z účtu, lokalizace mobilního telefonu, smlouva). Detekuj rozpor mezi výpovědí a obsahem listinného důkazu.\n\n'+
      '## Oddíl 4 — Analýza časové osy (alibi)\nVyextrahuj všechny časy a data a seřaď je do přísné chronologie. Čistě analyticky (bez hodnocení) odhal fyzickou nemožnost (alibi) nebo nelogičnost sledu událostí.\n\n'+
      '## Oddíl 5 — Analýza znaleckých posudků (BETA)\nOvěř formální náležitosti a zejména zda znalec NEPŘEKROČIL kompetence — neodpovídá na právní otázky (např. konstatování viny, což přísluší jen soudu). NEHODNOTÍŠ, zda má pravdu, jen zda dodržel pravidla. Navrhni výslech znalce nebo revizní posudek.' },
  {
    key:'m4', label:'Modul 4 — Analýza omezení osobní svobody a vazby',
    what:'Aktivuje se při zadržení nebo vazbě. Hlídá ústavní a procesní lhůty (48 h, max. doba vazby dle § 72a) a vazební důvody (§ 67) a jejich odpadání. Chrání osobní svobodu.',
    oddily:['Oddíl 1 — kontrola zákonných lhůt vazby (48 h, § 72a)','Oddíl 2 — vazební důvody (§ 67) a jejich odpadání (propojení s M3)'],
    docs:['protokol o zadržení','usnesení o vzetí do vazby'],
    task:'Jsi nekompromisní analytik ústavních a procesních lhůt (Modul 4 — omezení osobní svobody a vazba). Aktivuje se, byl-li ve spisu zjištěn protokol o zadržení nebo usnesení o vzetí do vazby. Nezkoumáš vinu, ale výlučně chráníš právo klienta na osobní svobodu: extrahuješ přesné časy z protokolů, hlídáš neúprosné lhůty a zrcadlíš odpadání vazebních důvodů. Presumpce neviny. Každý výstup je NÁVRH — kontroluje advokát. Pokud ve spisu žádné omezení svobody není, jasně to uveď.\n\n'+
      'TVRDÁ ZÁKONNÁ DATA (needukuj vlastní): § 76/4 TŘ — policejní orgán musí zadrženou osobu odevzdat soudu do 48 hodin od zadržení, jinak propuštění. § 77/1 TŘ — soudce musí do 24 hodin od převzetí rozhodnout o vazbě, nebo propustit. Důvody vazby § 67 TŘ: a) útěková, b) koluzní (působení na dosud nevyslechnuté svědky / spoluobviněné), c) předstižná. MAXIMÁLNÍ DOBA VAZBY § 72a/1 TŘ: 1 rok (přečin) · 2 roky (zločin) · 3 roky (zvlášť závažný zločin) · 4 roky (za který lze uložit výjimečný trest). § 72a/2 — z toho 1/3 na přípravné řízení a 2/3 na řízení před soudem (lhůty nelze „přelévat"). § 72a/3 — KOLUZNÍ vazba (§ 67b) trvá nejdéle 3 měsíce (výjimka: prokázané reálné maření). § 71a — právo kdykoli žádat o propuštění, po zamítnutí opakovat po 30 dnech. § 72/1 — v přípravném řízení soudce přezkoumá trvání vazby nejméně každé 3 měsíce.\n\n'+
      '## Oddíl 1 — Kontrola zákonných lhůt vazby\nVyextrahuj datum a čas ze zadržovacího protokolu, spočítej exaktní vypršení 48 hodin pro odevzdání soudu. Zobraz odpočet a maximální termín trvání vazby pro danou kvalifikaci (§ 72a) a termín, do kterého musí soud vazbu přezkoumat (§ 72/1).\n\n'+
      '## Oddíl 2 — Analýza vazebních důvodů a jejich odpadávání\nUrči, z jakých důvodů (§ 67) soud klienta do vazby poslal. U KOLUZNÍ vazby vyhledej v usnesení konkrétní jména svědků, na které by mohl působit — a propoj s Modulem 3: jakmile jsou tito svědci vyslechnuti, notifikuj „Koluzní důvod objektivně pominul → indikována možnost podání žádosti o propuštění (§ 71a)." DISCLAIMER: samotný výslech neznamená automatický úspěch — výslechy mohly být vadné nebo mohou existovat další svědci. U útěkové / předstižné vazby VAROVÁNÍ, je-li odůvodněna jen teoretickou „hrozbou vysokého trestu" bez dalších konkrétních skutečností (ústavně neobstojí).' },
  {
    key:'m5', label:'Modul 5 — Majetková analytika a zajištění',
    what:'Štít proti ekonomické likvidaci: inventura zajištěného majetku, právní titul zajištění a křížový test proporcionality (hodnota blokace vs. tvrzená škoda).',
    oddily:['Oddíl 1 — majetková mapa a účel zajištění','Oddíl 2 — křížový test proporcionality (škoda vs. blokace)'],
    docs:['usnesení o zajištění (movité věci / účty / nemovitosti)'],
    task:'Jsi expertní finančně-právní analyzátor (Modul 5 — majetková analytika a proporcionalita). Nezkoumáš vinu, chráníš socioekonomickou existenci klienta proti nezákonným či neproporcionálním zásahům do vlastnictví. Provedeš inventuru zajištěného majetku, u každé položky klasifikuješ právní titul a provedeš matematický test proporcionality. Presumpce neviny. Každý výstup je NÁVRH — kontroluje advokát. Pokud žádné zajištění majetku ve spisu není, jasně to uveď.\n\n'+
      'TVRDÁ ZÁKONNÁ DATA (needukuj vlastní): § 47 TŘ — zajištění majetku pro nárok poškozeného. § 47a/1 — OČTŘ zajištění zruší, složí-li obviněný jistotu. § 48/1,4 — zajištění se zruší, pomine-li důvod; obviněný může žádat o zrušení nebo omezení, po zamítnutí opakovat po 30 dnech. § 79a/1,2 — zajištění věci jako nástroje nebo výnosu z TČ; jednání v rozporu se zákazem je absolutně neplatné. § 79g — zajištění náhradní hodnoty (legální majetek odpovídající hodnotě výnosu). § 143/1 — stížnost proti usnesení o zajištění do 3 dnů. § 141/4 — stížnost proti zajištění zpravidla NEMÁ odkladný účinek. Propadnutí majetku § 66/1 TZ — jen u výjimečného trestu nebo zvlášť závažného zločinu s majetkovým prospěchem; § 66/4 — propadnutím zaniká společné jmění manželů.\n\n'+
      '## Oddíl 1 — Majetková mapa a účel zajištění\nPřehledová inventura veškerého zajištěného majetku klienta. U každé položky urči PRÁVNÍ TITUL zajištění: věcný důkaz / zajištění výnosu z trestné činnosti / zajištění k úhradě škody. (Zajištění jako důkaz má přednost; prokáže-li se, že majetek už jako důkaz neslouží, advokát má data žádat o odblokování.)\n\n'+
      '## Oddíl 2 — Křížový test proporcionality\nSrovnej celkovou tvrzenou výši škody (z Modulu 1) se součtem hodnot zablokovaného majetku. Zjistíš-li výraznou disproporci (např. škoda 2 mil. vs. blokace nemovitostí 15 mil.), vygeneruj datový bod poukazující na porušení přiměřenosti zásahu státní moci (podklad pro stížnost nebo žádost o odblokování).' },
];
function findAnalysis(key){ return ANALYSES.find(x=>x.key===key)||null; }

function buildAnalysisContext(c){
  const L=[];
  L.push('KONTEXT PŘÍPADU (strukturovaná data vytažená ze spisu — ber je jako součást spisu, ne jako vnější informaci):');
  // Obviněný / klient
  const cl=[];
  if(c.clientName) cl.push(c.clientName);
  if(c.birthDate) cl.push('nar. '+c.birthDate);
  if(c.rodneCislo) cl.push('r.č. '+c.rodneCislo);
  if(c.address) cl.push('bytem '+c.address);
  if(cl.length) L.push('Obviněný/klient: '+cl.join(', '));
  if(c.pravniKvalifikace) L.push('Právní kvalifikace: '+c.pravniKvalifikace);
  else if(c.obvineni&&c.obvineni.length) L.push('Paragrafy: § '+c.obvineni.join(', § '));
  if(c.faze) L.push('Fáze řízení: '+c.faze);
  if(c.status) L.push('Status: '+c.status);
  if(c.spisZnacka) L.push('Spisová značka: '+c.spisZnacka);
  if(c.soud) L.push('Soud/orgán: '+c.soud);
  if(c.soudce) L.push('Soudce: '+c.soudce);
  if(c.statniZastupce) L.push('Státní zástupce: '+c.statniZastupce);
  if(c.vysetrovatel) L.push('Vyšetřovatel: '+c.vysetrovatel);
  if(c.vyseSkody) L.push('Celková výše škody: '+c.vyseSkody);
  if(c.judgmentDate) L.push('Datum rozsudku: '+c.judgmentDate);
  if(c.custodyDate) L.push('Vzetí do vazby: '+c.custodyDate);
  // Zúčastněné osoby (vč. poškozených/svědků) — s detaily
  const ps=(c.persons||[]).filter(p=>(p.name||'').trim());
  if(ps.length){
    L.push('\nZÚČASTNĚNÉ OSOBY ('+ps.length+'):');
    ps.forEach(p=>{
      const d=[];
      if(p.role) d.push(roleLabel(p.role));
      if(p.birthDate) d.push('nar. '+p.birthDate);
      if(p.phone) d.push('tel. '+p.phone);
      if(p.address) d.push(p.address);
      if(p.note) d.push(p.note);
      L.push('• '+p.name+(d.length?(' — '+d.join(', ')):''));
    });
  }
  // Časová osa událostí
  const tl=(c.timeline||[]).filter(t=>t&&t.date&&!t.deletedAt);
  if(tl.length){
    L.push('\nČASOVÁ OSA UDÁLOSTÍ ('+tl.length+'):');
    tl.slice().sort((a,b)=>String(a.date).localeCompare(String(b.date))).forEach(t=>{
      L.push('• '+t.date+' — '+(t.event||''));
    });
  }
  // Nahrané dokumenty
  const docs=(c.documents||[]).filter(d=>d&&!d.deletedAt);
  if(docs.length){
    L.push('\nNAHRANÉ DOKUMENTY: '+docs.map(d=>(d.name||'')+(d.type?(' ('+d.type+')'):'')).join('; '));
  }
  return L.join('\n');
}

// Streaming volání Gemini (SSE). onChunk dostává přírůstky textu.
async function geminiStream(body, onChunk){
  const r = await geminiFetch(body, true); // opakování + přepnutí modelu při přetížení
  const reader=r.body.getReader(), dec=new TextDecoder(); let buf='';
  while(true){
    const {value,done}=await reader.read(); if(done) break;
    buf+=dec.decode(value,{stream:true});
    let idx;
    while((idx=buf.indexOf('\n'))>=0){
      let line=buf.slice(0,idx).trim(); buf=buf.slice(idx+1);
      if(line.indexOf('data:')!==0) continue;
      const js=line.slice(5).trim(); if(!js||js==='[DONE]') continue;
      try{ const o=JSON.parse(js); const t=o.candidates&&o.candidates[0]&&o.candidates[0].content&&o.candidates[0].content.parts&&o.candidates[0].content.parts[0]&&o.candidates[0].content.parts[0].text; if(t) onChunk(t); }catch(e){}
    }
  }
}

function renderMarkdown(t){
  return esc(t)
    .replace(/\[K OVĚŘENÍ\]/g,'<span class="koveg">[K OVĚŘENÍ]</span>')
    .replace(/\[FATÁLNÍ\]/g,'<span class="sev sev-f">FATÁLNÍ</span>')
    .replace(/\[VYSOKÁ\]/g,'<span class="sev sev-h">VYSOKÁ</span>')
    .replace(/\[STŘEDNÍ\]/g,'<span class="sev sev-m">STŘEDNÍ</span>')
    .replace(/\[NÍZKÁ\]/g,'<span class="sev sev-l">NÍZKÁ</span>')
    .replace(/^### (.+)$/gm,'<h4 class="amd">$1</h4>')
    .replace(/^## (.+)$/gm,'<h3 class="amd">$1</h3>')
    .replace(/^# (.+)$/gm,'<h3 class="amd">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/^\* (.+)$/gm,'<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g,'<ul>$&</ul>')
    .replace(/\n{2,}/g,'</p><p>')
    .replace(/\n/g,'<br>');
}

let analysisRunning=false;
async function runAnalysis(key){
  if(analysisRunning) return;
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const item=findAnalysis(key); if(!item) return;
  const transcript=(c.analysisText||'').trim();
  if(!transcript){ toast('Případ nemá přepis spisu — nahraj spis přes OCR.'); return; }
  if(!getGeminiKey()){ toast(geminiMissingHint()); return; }

  analysisRunning=true;
  document.querySelectorAll('#page-detail .an-primary,#page-detail .an-file').forEach(b=>b.classList.add('dis'));
  const res=document.getElementById('analysisResult');
  res.style.display='block';
  res.innerHTML='<div class="ahead"><span class="adot"></span><b>'+esc(item.label)+'</b><span class="awhen">běží…</span></div><div class="abody" id="analysisLive"><span class="acaret">▌</span></div>';
  res.scrollIntoView({behavior:'smooth',block:'nearest'});
  const live=document.getElementById('analysisLive');

  // RAG: místo useknutí přepisu na 80k vybereme nejrelevantnější části celého spisu
  // (funguje jen když je spis „připravený" = zaindexovaný; jinak fallback na starý režim).
  let spisText=null, usedRag=false;
  try{
    if(window.RAG && (await window.RAG.status(c.id))>0){
      spisText=await window.RAG.retrieve(c.id, item.label+' '+(item.what||''), 70000);
      usedRag=!!spisText;
    }
  }catch(e){ spisText=null; }
  if(!spisText) spisText=transcript.slice(0,80000);
  const prompt = item.task+'\n\n'+buildAnalysisContext(c)+'\n\nPŘEPIS SPISU'+(usedRag?' (nejrelevantnější části celého spisu, u každé je uveden zdroj):':':')+'\n'+spisText;
  let full='';
  try{
    await geminiStream({
      system_instruction:{ parts:[{ text:GEMINI_SYSTEM }] },
      contents:[{ parts:[{ text:prompt }] }],
      generationConfig:{ temperature:0.1, maxOutputTokens:16384 }
    }, (chunk)=>{ full+=chunk; live.innerHTML='<p>'+renderMarkdown(full)+'</p><span class="acaret">▌</span>'; live.scrollIntoView&&0; });

    if(!full.trim()) throw new Error('Prázdná odpověď od Gemini.');
    const rec={ key:key, label:item.label, text:full, when:Date.now() };
    c.analyses=c.analyses||[]; c.analyses.unshift(rec); saveData(); renderAll();
    showAnalysisResult(rec);
    renderAnalysisHistory(c);
    toast('Analýza hotová — uložena k případu');
  }catch(e){
    res.innerHTML='<div class="ahead"><span class="adot" style="background:var(--red)"></span><b>'+esc(item.label)+'</b></div><div class="abody"><p style="color:var(--red)">Chyba: '+esc(e.message)+'</p></div>';
  }finally{
    analysisRunning=false;
    document.querySelectorAll('#page-detail .an-primary,#page-detail .an-file').forEach(b=>b.classList.remove('dis'));
  }
}

function showAnalysisResult(rec){
  const res=document.getElementById('analysisResult'); if(!res) return;
  res.style.display='block';
  res.innerHTML=
    '<div class="ahead"><span class="adot"></span><b>'+esc(rec.label)+'</b><span class="awhen">'+new Date(rec.when).toLocaleString('cs-CZ')+'</span></div>'+
    '<div class="abody"><p>'+renderMarkdown(rec.text)+'</p></div>'+
    '<div class="afoot"><span class="awarn">⚠ AI návrh — vyžaduje kontrolu advokáta</span>'+
      '<span class="arate">'+
      '<button class="an-pdf" onclick="analysisPdf(\''+rec.key+'\','+rec.when+')" title="Uložit analýzu jako PDF">PDF</button>'+
      '<button class="rbtn" onclick="rateAnalysis(\''+rec.key+'\','+rec.when+',1,this)" title="Užitečné"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M6 10.5V17M3 12v5h2L6 17M6 10.5l2.5-7A1.8 1.8 0 0110.3 5v3.5H14a1.5 1.5 0 011.4 1.8l-1.4 5A1.5 1.5 0 0112.6 17H6v-6.5z"/></svg></button>'+
      '<button class="rbtn" onclick="rateAnalysis(\''+rec.key+'\','+rec.when+',-1,this)" title="Nepomohlo"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M14 9.5V3M17 8V3h-2L14 3M14 9.5L11.5 16.5A1.8 1.8 0 019.7 15v-3.5H6a1.5 1.5 0 01-1.4-1.8l1.4-5A1.5 1.5 0 017.4 3H14v6.5z"/></svg></button>'+
      '</span></div>';
}
function rateAnalysis(key,when,val,el){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const rec=(c.analyses||[]).find(a=>a.key===key&&a.when===when); if(rec){ rec.rating=val; saveData(); }
  const wrap=el.parentNode; wrap.querySelectorAll('.rbtn').forEach(b=>b.classList.remove('on')); el.classList.add('on');
  toast(val>0?'Označeno jako užitečné':'Díky za zpětnou vazbu');
}
function analysisPdf(key,when){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c){ toast('Případ nenalezen'); return; }
  const rec=(c.analyses||[]).find(a=>a.key===key&&a.when===when); if(!rec){ toast('Analýza nenalezena'); return; }
  const client=esc(c.clientName||'—'), spis=esc(c.spisZnacka||'—');
  const dt=new Date(rec.when).toLocaleString('cs-CZ');
  const html='<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>'+esc(rec.label)+'</title>'+
    '<style>@page{size:A4;margin:18mm}*{box-sizing:border-box}'+
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#2c2616;line-height:1.5;margin:0}'+
    '.hd{background:#14203f;color:#f3ecd8;padding:16px 20px;border-radius:8px;margin-bottom:16px}'+
    '.hd .b{color:#e6cf86;font-size:20px;font-weight:700}.hd .s{font-size:11px;opacity:.75}'+
    '.meta{font-size:12px;color:#6f6752;margin-bottom:2px}'+
    'h1.tt{font-size:17px;color:#14203f;margin:8px 0 14px}'+
    '.body{font-size:12.5px}.body h1,.body h2,.body h3{color:#14203f}'+
    '.warn{margin-top:22px;padding:10px 12px;background:#f7f1e2;border-left:3px solid #b08a2e;font-size:11.5px;color:#5a5030;border-radius:4px}'+
    '.foot{margin-top:14px;font-size:10px;color:#a89b7e;text-align:center}</style></head><body>'+
    '<div class="hd"><div class="b">Advokato</div><div class="s">Trestní agenda — AI analýza</div></div>'+
    '<div class="meta">Klient: <b>'+client+'</b> &nbsp;·&nbsp; Spisová značka: <b>'+spis+'</b></div>'+
    '<div class="meta">Vytvořeno: '+esc(dt)+'</div>'+
    '<h1 class="tt">'+esc(rec.label)+'</h1>'+
    '<div class="body">'+renderMarkdown(rec.text||'')+'</div>'+
    '<div class="warn">⚠ Toto je návrh vytvořený umělou inteligencí a vyžaduje kontrolu advokáta. Neslouží jako právní rada.</div>'+
    '<div class="foot">Vygenerováno aplikací Advokato · '+new Date().toLocaleDateString('cs-CZ')+'</div>'+
    '</body></html>';
  const w=window.open('','_blank','width=820,height=1000');
  if(!w){ toast('Povolte prosím vyskakovací okna pro export PDF'); return; }
  w.document.open(); w.document.write(html); w.document.close(); w.focus();
  setTimeout(()=>{ try{ w.print(); }catch(e){} },400);
}

function isFavA(key){ try{ return JSON.parse(localStorage.getItem('na_fav_analyzy')||'[]').includes(key); }catch(e){ return false; } }
function toggleFavA(key){
  let f=[]; try{ f=JSON.parse(localStorage.getItem('na_fav_analyzy')||'[]'); }catch(e){}
  const i=f.indexOf(key); if(i>=0) f.splice(i,1); else f.push(key);
  localStorage.setItem('na_fav_analyzy',JSON.stringify(f));
  const el=document.getElementById('analysisCatalog'); if(el) el.innerHTML=renderAnalysisCatalog();
  renderRagPanel();
}
function anStar(key){ const on=isFavA(key); return '<button class="an-star'+(on?' on':'')+'" onclick="toggleFavA(\''+key+'\')" title="Oblíbené — připnout nahoru">'+(on?'★':'☆')+'</button>'; }
function anDocs(a){ return '<div class="an-docs"><span class="an-dl">Potřebuje:</span>'+(a.docs||[]).map((d,i)=>'<span class="an-chip'+(i===0?' main':'')+'">'+esc(d)+'</span>').join('')+'</div>'; }
function anButtons(key){ return '<div class="an-btns"><button class="an-file" onclick="pickFiles(\''+key+'\')">📎 Vybrat soubory</button><button class="an-file auto" onclick="runAnalysis(\''+key+'\')">✨ Vybrat automaticky</button></div><div class="an-picklist" id="pick-'+key+'"></div>'; }
function analysisCardHtml(a){
  return '<article class="an-card'+(a.wide?' wide':'')+'">'+anStar(a.key)+
    (a.tag?'<span class="an-tag">◆ '+esc(a.tag)+'</span>':'')+
    '<h3>'+esc(a.label)+'</h3>'+
    '<p class="an-what">'+esc(a.what)+'</p>'+
    '<ul class="an-oddily">'+(a.oddily||[]).map(o=>'<li>'+esc(o)+'</li>').join('')+'</ul>'+
    anDocs(a)+anButtons(a.key)+
  '</article>';
}
function caseMetricTiles(){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return '';
  const nDocs=(c.documents||[]).filter(d=>d&&!d.deletedAt).length;
  const nAnal=(c.analyses||[]).length;
  const nOsob=(c.persons||[]).filter(p=>(p.name||'').trim()).length;
  let nLhut=0; try{ nLhut=(calculateDeadlines(c)||[]).length; }catch(e){}
  const t=(icon,cls,label,val)=>'<div class="lc-metric"><div class="lc-metric-ic '+cls+'">'+dicon(icon)+'</div><div class="lc-metric-tx"><span class="lc-metric-l">'+label+'</span></div><span class="lc-metric-v">'+val+'</span></div>';
  return '<div class="lc-metrics">'+
    t('dokumenty','m-blue','Dokumenty',nDocs)+
    t('analyzy','m-gold','Uložené analýzy',nAnal)+
    t('osoby','m-green','Zúčastněné osoby',nOsob)+
    t('lhuty','m-red','Lhůty případu',nLhut)+
  '</div>';
}
function renderAnalysisCatalog(){
  const prim=ANALYSES.find(a=>a.primary);
  const rest=ANALYSES.filter(a=>!a.primary).sort((a,b)=>(isFavA(b.key)?1:0)-(isFavA(a.key)?1:0));
  let h='<div id="ragPanel" class="rag-panel"></div>'+caseMetricTiles();
  if(prim){
    h+='<div class="an-hero">'+anStar(prim.key)+
      '<span class="an-badge">★ Začni tady</span>'+
      '<h2>'+esc(prim.label)+'</h2>'+
      '<p class="an-lead">'+esc(prim.what)+'</p>'+
      '<div class="an-outputs">'+
        '<div class="an-obox"><div class="an-ot">Odborná část</div><ul>'+(prim.oddilyA||[]).map(o=>'<li>'+esc(o)+'</li>').join('')+'</ul></div>'+
        '<div class="an-obox"><div class="an-ot">Stručné shrnutí případu</div><ul>'+(prim.oddilyB||[]).map(o=>'<li>'+esc(o)+'</li>').join('')+'</ul></div>'+
      '</div>'+
      anDocs(prim)+
      '<div class="an-runrow"><button class="an-primary" onclick="runAnalysis(\''+prim.key+'\')">⚡ Udělat primární analýzu</button>'+
        '<span class="an-sep">se soubory:</span>'+
        '<button class="an-file" onclick="pickFiles(\''+prim.key+'\')">📎 Vybrat soubory</button>'+
        '<button class="an-file auto" onclick="runAnalysis(\''+prim.key+'\')">✨ Vybrat automaticky</button></div>'+
      '<div class="an-picklist" id="pick-'+prim.key+'"></div>'+
    '</div>';
  }
  h+='<div class="an-sectitle">Další analýzy</div><div class="an-cards">'+rest.map(analysisCardHtml).join('')+'</div>';
  return h;
}
function pickFiles(key){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const el=document.getElementById('pick-'+key); if(!el) return;
  if(el.classList.contains('show')){ el.classList.remove('show'); el.innerHTML=''; return; }
  el.classList.add('show');
  const docs=(c.documents||[]).filter(d=>d&&!d.deletedAt);
  if(!docs.length){ el.innerHTML='<div class="an-pl-t">Zatím nejsou nahrané žádné dokumenty. Nahraj je v sekci Dokumenty.</div>'; return; }
  el.innerHTML='<div class="an-pl-t">Vyber dokumenty pro analýzu</div>'+
    docs.map((d,i)=>'<label class="an-fitem"><input type="checkbox" checked> '+esc(d.name||('Dokument '+(i+1)))+'</label>').join('')+
    '<button class="an-primary sm" onclick="runAnalysis(\''+key+'\')">Spustit analýzu</button>';
}
function renderAnalysisHistory(c){
  const el=document.getElementById('analysisHistory'); if(!el) return;
  const a=c.analyses||[];
  el.innerHTML = a.length ?
    '<div class="tl">Již vytvořené analýzy</div>'+a.map((r,i)=>'<div class="hist-row" onclick="showStoredAnalysis('+i+')"><span class="ll">'+esc(r.label)+(r.rating?(' <em style="color:'+(r.rating>0?'var(--green)':'var(--red)')+'">'+(r.rating>0?'👍':'👎')+'</em>'):'')+'</span><button class="an-pdf" onclick="event.stopPropagation();analysisPdf(\''+r.key+'\','+r.when+')" title="Uložit analýzu jako PDF">PDF</button><span class="par">'+new Date(r.when).toLocaleDateString('cs-CZ')+'</span></div>').join('')
    : '';
}
/* ============ RAG panel (příprava spisu pro AI) ============ */
async function renderRagPanel(){
  const el=document.getElementById('ragPanel'); if(!el||!window.RAG) return;
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c){ el.innerHTML=''; return; }
  const chars=(c.analysisText||'').length;
  let n=0; try{ n=await window.RAG.status(c.id); }catch(e){}
  const big=chars>80000;
  if(n>0){
    el.innerHTML='<div class="rag-row rag-ok"><span class="rag-dot"></span>'+
      '<div class="rag-txt"><b>Spis připraven pro AI (RAG)</b> — '+n+' částí zaindexováno. AI teď hledá v <b>celém spisu</b>, ne jen v úvodu, a uvádí zdroj.</div>'+
      '<button class="rag-btn ghost" onclick="prepareRag(true)">Přeindexovat</button></div>';
  } else {
    el.innerHTML='<div class="rag-row'+(big?' rag-warn':'')+'"><span class="rag-dot"></span>'+
      '<div class="rag-txt"><b>Připravit spis pro AI (RAG)</b> — '+(big?'spis je velký (~'+Math.round(chars/1000)+' tis. znaků); bez přípravy AI vidí jen úvod. ':'')+'Zaindexuje spis, aby AI hledala v celém dokumentu a citovala zdroj.</div>'+
      '<button class="rag-btn" onclick="prepareRag()">Připravit spis</button></div>';
  }
}
let ragBusy=false;
async function prepareRag(force){
  if(ragBusy||!window.RAG) return;
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  if(!(c.analysisText||'').trim()){ toast('Případ nemá přepis spisu.'); return; }
  if(!getGeminiKey()){ toast(geminiMissingHint&&geminiMissingHint()||'Chybí Gemini klíč (Nastavení).'); return; }
  ragBusy=true;
  const el=document.getElementById('ragPanel');
  try{
    const n=await window.RAG.indexCase(c.id, c.analysisText, (done,total)=>{
      if(el) el.innerHTML='<div class="rag-row"><span class="rag-dot spin"></span><div class="rag-txt"><b>Připravuji spis…</b> '+done+' / '+total+' částí</div></div>';
    });
    toast('Spis připraven pro AI — '+n+' částí');
  }catch(e){ toast('RAG chyba: '+e.message); }
  finally{ ragBusy=false; renderRagPanel(); }
}
/* ============ CHAT NAD SPISEM (RAG) ============ */
const RAG_PILLS=[
  'Jaké jsou hlavní rozpory ve svědeckých výpovědích?',
  'Sestav přesný časový přehled událostí.',
  'Vypiš všechna obvinění a důkazy proti obžalovanému.',
  'Jaké finanční částky a transakce se ve spisu uvádějí?'
];
function chatPanelHtml(c){
  const has=(c.analysisText||'').trim().length>0;
  return '<div class="tile rev chat-head">'+
    '<div class="acat-h"><span class="dot"></span>Spisový AI chatbot (RAG)</div>'+
    '<p class="chat-lead">Ptej se na cokoliv v dokumentech spisu. AI vyhledá fakta a dodá přesné citace <b>[Zdroj: …]</b>.</p>'+
    '<div class="chat-tools">'+
      (has?'':'<span class="chat-warn">⚠ Spis nemá přepis. Nahraj dokumenty v sekci Dokumenty.</span>')+
      '<button class="rag-btn ghost" onclick="clearRagChat()">Vyčistit chat</button>'+
    '</div>'+
    '<div class="chat-pill-lbl">Doporučené dotazy pro tento spis:</div>'+
    '<div class="chat-pills">'+RAG_PILLS.map(function(q){ return '<button class="chat-pill" data-q="'+esc(q)+'" onclick="ragAsk(this.dataset.q)">'+esc(q)+'</button>'; }).join('')+'</div>'+
  '</div>'+
  '<div class="tile rev chat-conv">'+
    '<div class="acat-h chat-conv-h">Konverzace se spisem<span class="chat-cite">Citace ze spisu: <b>[Zdroj: …]</b></span></div>'+
    '<div class="chat-log" id="chatLog"></div>'+
    '<div class="chat-input"><input id="chatIn" placeholder="Zadej dotaz ke spisu (např. V kolik hodin byl svědek vyslechnut?)…" onkeydown="if(event.key===\'Enter\')ragAsk()"><button class="rag-btn" id="chatSend" onclick="ragAsk()">Položit dotaz</button></div>'+
  '</div>';
}
function renderChatLog(){
  const el=document.getElementById('chatLog'); if(!el) return;
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c){ el.innerHTML=''; return; }
  const msgs=c.ragChat||[];
  if(!msgs.length){ el.innerHTML='<div class="chat-empty"><svg viewBox="0 0 24 24" class="ce-ic" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><b>Žádné dotazy v historii</b><span>Vyber doporučený dotaz výše nebo napiš vlastní otázku ke spisu.</span></div>'; return; }
  el.innerHTML=msgs.map(function(m){
    if(m.role==='user') return '<div class="cm cm-u"><div class="cm-b">'+esc(m.text)+'</div></div>';
    return '<div class="cm cm-a"><div class="cm-b">'+renderMarkdown(m.text||'…')+'</div></div>';
  }).join('');
  el.scrollTop=el.scrollHeight;
}
function clearRagChat(){ const c=appData.cases.find(x=>x.id===currentDetailId); if(!c)return; c.ragChat=[]; saveData(); renderChatLog(); }
let ragChatBusy=false;
async function ragAsk(preset){
  if(ragChatBusy) return;
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const inp=document.getElementById('chatIn');
  const q=(preset||(inp?inp.value:'')||'').trim(); if(!q) return;
  if(!(c.analysisText||'').trim()){ toast('Spis nemá přepis — nahraj dokumenty.'); return; }
  if(!getGeminiKey()){ toast(geminiMissingHint&&geminiMissingHint()||'Chybí Gemini klíč.'); return; }
  if(inp) inp.value='';
  c.ragChat=c.ragChat||[];
  c.ragChat.push({role:'user',text:q,when:Date.now()});
  c.ragChat.push({role:'ai',text:'…',when:Date.now()});
  saveData(); renderChatLog();
  ragChatBusy=true; const sb=document.getElementById('chatSend'); if(sb) sb.classList.add('dis');
  try{
    // Vejde-li se spis (skoro vždy), pošli AI CELÝ spis — nic nevynecháváme.
    // Keyword retrieval (výběr pasáží) použij jen u obřích spisů, co se do AI nevejdou.
    let ctx=''; const _spis=(c.analysisText||'');
    if(_spis.length<=300000){ ctx=_spis; }
    else{
      try{ if(window.RAG && window.RAG.keywordRetrieve) ctx=window.RAG.keywordRetrieve(_spis, q, 16); }catch(e){}
      if(!ctx) ctx=_spis.slice(0,300000);
    }
    const sys='Jsi špičkový trestní advokát. Odpovídej POUZE na základě poskytnutých výňatků ze spisu. U každého konkrétního tvrzení uveď v závorce citaci zdroje ve tvaru [Zdroj: název_dokumentu]. Pokud informace ve výňatcích chybí, napiš [K OVĚŘENÍ]. Odpovídej česky a věcně; kde to dává smysl, použij odrážky.';
    const prompt='VÝŇATKY ZE SPISU KLIENTA:\n'+ctx+'\n\nDOTAZ ADVOKÁTA:\n'+q;
    let full='';
    await geminiStream({ system_instruction:{parts:[{text:sys}]}, contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.15,maxOutputTokens:4096} }, function(chunk){ full+=chunk; const last=c.ragChat[c.ragChat.length-1]; last.text=full; renderChatLog(); });
    const last=c.ragChat[c.ragChat.length-1]; last.text=(full.trim()||'(Prázdná odpověď.)'); saveData(); renderChatLog();
  }catch(e){ const last=c.ragChat[c.ragChat.length-1]; last.text='⚠ Chyba: '+e.message; saveData(); renderChatLog(); }
  finally{ ragChatBusy=false; const b=document.getElementById('chatSend'); if(b) b.classList.remove('dis'); }
}
function showStoredAnalysis(i){
  const c=appData.cases.find(x=>x.id===currentDetailId); if(!c) return;
  const rec=(c.analyses||[])[i]; if(rec){ showAnalysisResult(rec); document.getElementById('analysisResult').scrollIntoView({behavior:'smooth',block:'nearest'}); }
}

/* ============ COMMAND PALETTE ============ */
function palItems(){
  const items=[];
  liveCases().forEach(c=>items.push({g:'Případy',t:(c.clientName||'Případ')+' — '+(c.spisZnacka||''),tag:(c.obvineni&&c.obvineni[0])?'§ '+c.obvineni[0]:'',k:'↵'}));
  items.push({g:'Akce',t:'Nový případ',tag:'',k:'⌘N'});
  items.push({g:'Navigace',t:'Lhůty',tag:'',k:'G L'});
  items.push({g:'Navigace',t:'Dokumenty',tag:'',k:'G D'});
  return items;
}
function renderPal(l){ let h='',g=''; l.forEach(x=>{ if(x.g!==g){g=x.g;h+='<div class="grp">'+g+'</div>';} h+='<div class="it" onclick="closePal()"><span>'+esc(x.t)+'</span>'+(x.tag?'<span class="tag">'+esc(x.tag)+'</span>':'')+(x.k?'<span class="k">'+x.k+'</span>':'')+'</div>'; }); document.getElementById('palList').innerHTML=h||'<div class="none">Nic nenalezeno</div>'; }
function filt(){ const q=document.getElementById('palIn').value.toLowerCase(); renderPal(palItems().filter(x=>(x.t+x.g+x.tag).toLowerCase().includes(q))); }
function openPal(){ document.getElementById('ovl').classList.add('open'); document.getElementById('palIn').value=''; renderPal(palItems()); setTimeout(()=>document.getElementById('palIn').focus(),30); }
function closePal(){ document.getElementById('ovl').classList.remove('open'); }

/* ============ TOAST ============ */
let tt; function toast(msg){ const t=document.getElementById('toast'); t.innerHTML='<b>'+esc(msg||'Uloženo')+'</b>'; t.classList.add('show'); clearTimeout(tt); tt=setTimeout(()=>t.classList.remove('show'),2600); }

/* ============ PŘEPÍNAČ VZHLEDU ============ */
function setAccent(a){ document.body.setAttribute('data-ac',a); localStorage.setItem('na_ac',a); document.querySelectorAll('.acdot:not(.bgdot)').forEach(x=>x.classList.toggle('on',x.dataset.ac===a)); }
const FONTS={
  plex:"'IBM Plex Sans',-apple-system,sans-serif",
  inter:"'Inter',-apple-system,sans-serif",
  jakarta:"'Plus Jakarta Sans','Inter',sans-serif",
  grotesk:"'Space Grotesk','Inter',sans-serif",
  manrope:"'Manrope','Inter',sans-serif",
  serif:"'Source Serif 4',Georgia,serif",
  cormorant:"'Cormorant Garamond','Source Serif 4',Georgia,serif",
  sanfrancisco:"-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif",
  helvetica:"'Helvetica Neue',Helvetica,Arial,sans-serif",
  arial:"Arial,Helvetica,sans-serif",
  times:"'Times New Roman',Times,serif",
  calibri:"Calibri,'Segoe UI',sans-serif",
  comicsans:"'Comic Sans MS','Comic Sans',cursive",
  impact:"Impact,Haettenschweiler,'Arial Narrow Bold',sans-serif",
  garamond:"Garamond,'EB Garamond',Georgia,serif",
  georgia:"Georgia,'Times New Roman',serif",
  verdana:"Verdana,Geneva,sans-serif",
  heptaslab:"'Hepta Slab',Georgia,serif",
  gelasio:"'Gelasio',Georgia,serif",
  familjen:"'Familjen Grotesk','Inter',sans-serif",
  system:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
};
function setFont(f){
  document.body.style.setProperty('--sans', FONTS[f]||FONTS.plex);
  localStorage.setItem('na_font',f);
  document.querySelectorAll('.font-btn').forEach(x=>x.classList.toggle('on',x.dataset.font===f));
}
/* Font NADPISŮ (proměnná --display: „Dobrý večer", „Zákony", „Nastavení"…) */
const HEAD_FONTS=FONTS;
/* Jednotný seznam písem (obě kategorie berou z něj) — snadné pak trimnout na 5. */
const FONT_LIST=[
  ['plex','Plex'],['inter','Inter'],['jakarta','Jakarta'],['grotesk','Grotesk'],['manrope','Manrope'],
  ['serif','Source Serif'],['cormorant','Cormorant'],['sanfrancisco','San Francisco'],['helvetica','Helvetica'],
  ['arial','Arial'],['times','Times New Roman'],['calibri','Calibri'],['comicsans','Comic Sans'],['impact','Impact'],
  ['garamond','Garamond'],['georgia','Georgia'],['verdana','Verdana'],['heptaslab','Hepta Slab'],
  ['gelasio','Gelasio'],['familjen','Familjen Grotesk'],['system','Systém']
];
function renderFontPickers(){
  const cur=localStorage.getItem('na_font')||'plex';
  const curH=localStorage.getItem('na_headfont')||'cormorant';
  function btn(k,l,type,active){
    const cls=type==='head'?'headfont-btn':'font-btn';
    const attr=type==='head'?'data-headfont':'data-font';
    const fn=type==='head'?'setHeadFont':'setFont';
    return '<button class="mode-btn '+cls+(k===active?' on':'')+'" '+attr+'="'+k+'" onclick="'+fn+'(\''+k+'\')" style="font-family:'+FONTS[k]+'">'+l+'</button>';
  }
  const fr=document.getElementById('fontRow'); if(fr) fr.innerHTML=FONT_LIST.map(f=>btn(f[0],f[1],'text',cur)).join('');
  const hr=document.getElementById('headFontRow'); if(hr) hr.innerHTML=FONT_LIST.map(f=>btn(f[0],f[1],'head',curH)).join('');
}
function setHeadFont(f){
  document.body.style.setProperty('--display', HEAD_FONTS[f]||HEAD_FONTS.cormorant);
  localStorage.setItem('na_headfont',f);
  document.querySelectorAll('.headfont-btn').forEach(x=>x.classList.toggle('on',x.dataset.headfont===f));
}
const LIGHT_PANELS=['cream','beige','sand','greige','bluegrey','advokato'];
function setPanel(b){
  const isLight=LIGHT_PANELS.includes(b);
  document.body.setAttribute('data-bg',b);
  document.body.classList.toggle('light', isLight);
  localStorage.setItem('na_bg',b);
  localStorage.setItem('na_mode', isLight?'light':'dark');
  localStorage.setItem(isLight?'na_bg_light':'na_bg_dark', b);
  document.querySelectorAll('.bgdot').forEach(x=>x.classList.toggle('on',x.dataset.bg===b));
  document.querySelectorAll('.mode-btn[data-mode]').forEach(x=>x.classList.toggle('on',x.dataset.mode===(isLight?'light':'dark')));
  syncModeSeg();
}
function setGlass(g){ document.body.setAttribute('data-glass',g); localStorage.setItem('na_glass',g); document.querySelectorAll('.glass-btn').forEach(x=>x.classList.toggle('on',x.dataset.glass===g)); syncGlassSeg(); }
function setGlassSimple(on){ setGlass(on?'soft':'off'); }
function syncGlassSeg(){
  const g=document.body.getAttribute('data-glass')||'off';
  const on=g==='soft'||g==='vivid';
  document.querySelectorAll('.vz-glass-seg button').forEach(b=>b.classList.toggle('on',(b.dataset.gsimple==='on')===on));
}
function syncModeSeg(){
  const light=document.body.classList.contains('light');
  document.querySelectorAll('.vz-mode-seg button').forEach(b=>b.classList.toggle('on',(b.dataset.mode==='light')===light));
}
function toggleVzhledAdvanced(){
  const el=document.getElementById('vzAdvanced'),lnk=document.getElementById('vzAdvancedToggle');
  if(!el)return;
  const open=!el.classList.contains('open');
  el.classList.toggle('open',open);
  if(lnk){
    lnk.setAttribute('aria-expanded',open?'true':'false');
    const lbl=lnk.querySelector('.vz-adv-label');
    if(lbl)lbl.textContent=open?'Sbalit':'Rozbalit';
  }
}
function setVzhledOpen(open){
  const w=document.getElementById('vzhledWrap');
  if(!w) return;
  w.classList.toggle('open', open);
  document.body.classList.toggle('vzhled-open', open);
  const ic=document.getElementById('vzhledToggleBtn');
  if(ic) ic.classList.toggle('active', open);
}
function toggleVzhled(){
  const w=document.getElementById('vzhledWrap');
  setVzhledOpen(!w.classList.contains('open'));
}
// Zavři panel vzhledu klikem mimo / Esc
document.addEventListener('click',e=>{
  const w=document.getElementById('vzhledWrap');
  if(!w||!w.classList.contains('open')) return;
  if(w.contains(e.target) || (e.target.closest && (e.target.closest('#vzhledToggleBtn')||e.target.closest('[onclick*="toggleVzhled"]')||e.target.closest('#vzhledBackdrop')))) return;
  setVzhledOpen(false);
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape') setVzhledOpen(false); });

const PRESETS={
  'modra-zlata': {bg:'deep',     ac:'gold',  label:'Tmavě modrá zlatá', c1:'#05070c', c2:'#d4af37'},
  'cerna-zlata': {bg:'black',    ac:'gold',  label:'Černá zlatá',  c1:'#000003', c2:'#d4af37'},
  'seda-zlata':  {bg:'graphite', ac:'gold',  label:'Šedá zlatá',   c1:'#1c1c1f', c2:'#d4af37'},
  'zelena-zlata':{bg:'forest',   ac:'gold',  label:'Zelená zlatá', c1:'#101a10', c2:'#d4af37'},
  'filova-zlata':{bg:'plum',     ac:'gold',  label:'Fialová zlatá',c1:'#1a1024', c2:'#d4af37'},
  'cream-zlata': {bg:'cream',    ac:'gold',  label:'Cream zlatá',  c1:'#f3eee3', c2:'#a8801f', light:true},
  'singlecase':  {bg:'beige',    ac:'gold',  label:'SingleCase — teplá zlatá', c1:'#dccaa6', c2:'#d4af37', light:true},
  'advokato':    {bg:'advokato', ac:'gold',  label:'Advokato — navy · žlutá · bílé panely', c1:'#e8d5a8', c2:'#14203f', light:true},
};
function applyPreset(key){
  const p=PRESETS[key]; if(!p) return;
  setPanel(p.bg); setAccent(p.ac);
  localStorage.setItem('na_preset',key);
  document.querySelectorAll('.preset,.motif-card').forEach(x=>x.classList.toggle('on',x.dataset.preset===key));
}
function initPresets(){
  const saved=localStorage.getItem('na_preset')||'modra-zlata';
  document.querySelectorAll('.preset,.motif-card').forEach(x=>x.classList.toggle('on',x.dataset.preset===saved));
}
function setMode(m){
  // přepnutí režimu vybere poslední použitou paletu daného režimu
  const lastDark=localStorage.getItem('na_bg_dark')||'deep';
  const lastLight=localStorage.getItem('na_bg_light')||'cream';
  setPanel(m==='light'?lastLight:lastDark);
}

/* ============ INIT ============ */
function init(){
  loadData();
  const a=localStorage.getItem('na_ac'), b=localStorage.getItem('na_bg'), m=localStorage.getItem('na_mode');
  if(a) setAccent(a);
  else setAccent('gold');
  if(b) setPanel(b);
  else setPanel(m==='light' ? (localStorage.getItem('na_bg_light')||'advokato') : 'advokato');
  if(!localStorage.getItem('na_preset') && !a && !b) applyPreset('advokato');
  {let _g=localStorage.getItem('na_glass'); if(_g==='vivid')_g='soft'; setGlass(_g||'off');}
  setFont(localStorage.getItem('na_font')||'plex');
  setHeadFont(localStorage.getItem('na_headfont')||'cormorant');
  renderFontPickers();
  initPresets();
  syncModeSeg();
  syncGlassSeg();
  document.getElementById('loginBtn').addEventListener('click', handleLogin);
  document.getElementById('loginPassword').addEventListener('keypress',e=>{ if(e.key==='Enter') handleLogin(); });
  document.addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openPal();} if(e.key==='Escape')closePal(); });
  initDrop();
  initSidebarCollapse();
  initMobileSidebarBackdrop();
  document.getElementById('vzhledWrap').style.display='none';
}
document.addEventListener('DOMContentLoaded', init);