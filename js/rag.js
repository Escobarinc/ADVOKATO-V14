/* ═══════════════════════════════════════════════════════════════════════
   RAG (Retrieval-Augmented Generation) nad spisem — client-side.
   Řeší velké spisy: dřív se přepis usekával na 80 000 znaků (viz runAnalysis),
   takže 800stránkový spis AI z větší části neviděla. Teď: přepis rozsekáme na
   kousky, každý zvektorizujeme (Gemini text-embedding-004) a uložíme do
   IndexedDB. Při analýze/dotazu vybereme nejrelevantnější kousky (cosine)
   do rozpočtu tokenů — s citací zdrojového dokumentu [Zdroj: název].

   Veřejné API (window.RAG):
     indexCase(caseId, transcript, onProg) -> počet kousků
     retrieve(caseId, query, budgetChars)  -> text s [Zdroj: ...] nebo null
     status(caseId)                        -> počet uložených kousků
     clear(caseId)                         -> smaže index případu
   Pozn.: embeddings posílají text Googlu → reálné spisy jen s placeným klíčem.
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';
const EMBED_MODELS=['gemini-embedding-001','text-embedding-004','embedding-001']; // zkouší v pořadí
let EMBED_MODEL=null; // zapamatuje fungující
const CHUNK_CHARS=1400;     // ~ 350–450 tokenů na kousek
const CHUNK_OVERLAP=200;    // překryv kvůli kontextu na hranách
const DB_NAME='advokato_rag', STORE='chunks';

/* ---- IndexedDB ---- */
function idb(){
  return new Promise((res,rej)=>{
    const r=indexedDB.open(DB_NAME,1);
    r.onupgradeneeded=()=>{ const db=r.result;
      if(!db.objectStoreNames.contains(STORE)){ const s=db.createObjectStore(STORE,{keyPath:'id'}); s.createIndex('caseId','caseId',{unique:false}); } };
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
  });
}
async function idbPutMany(recs){ const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,'readwrite'),s=tx.objectStore(STORE); recs.forEach(x=>s.put(x)); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function idbGetByCase(caseId){ const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,'readonly'),idx=tx.objectStore(STORE).index('caseId'),out=[]; idx.openCursor(IDBKeyRange.only(caseId)).onsuccess=e=>{ const c=e.target.result; if(c){ out.push(c.value); c.continue(); } else res(out); }; tx.onerror=()=>rej(tx.error); }); }
async function idbDelByCase(caseId){ const recs=await idbGetByCase(caseId); const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,'readwrite'),s=tx.objectStore(STORE); recs.forEach(r=>s.delete(r.id)); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }

/* ---- Chunking: drží zdrojový dokument z markerů "=== název ===" ---- */
function chunkTranscript(text){
  const chunks=[]; if(!text) return chunks;
  const parts=text.split(/\n?===\s*(.+?)\s*===\n/); // [before, name1, body1, name2, body2, ...]
  const segments=[];
  if(parts.length<=1){ segments.push({doc:'Spis',body:text}); }
  else{
    if(parts[0]&&parts[0].trim()) segments.push({doc:'Spis',body:parts[0]});
    for(let i=1;i<parts.length;i+=2) segments.push({doc:(parts[i]||'Spis').trim(),body:parts[i+1]||''});
  }
  segments.forEach(seg=>{
    const b=seg.body; let i=0;
    while(i<b.length){
      let end=Math.min(i+CHUNK_CHARS,b.length);
      if(end<b.length){ const nl=b.lastIndexOf('\n',end),dot=b.lastIndexOf('. ',end),cut=Math.max(nl,dot); if(cut>i+CHUNK_CHARS*0.5) end=cut+1; }
      const t=b.slice(i,end).trim();
      if(t.length>40) chunks.push({doc:seg.doc,text:t});
      const nx=end-CHUNK_OVERLAP; i=(nx<=i||end>=b.length)?end:nx;
    }
  });
  return chunks;
}

/* ---- Embeddings (Gemini batchEmbedContents) ---- */
function batchUrl(model,key){ return 'https://generativelanguage.googleapis.com/v1beta/models/'+model+':batchEmbedContents?key='+encodeURIComponent(key); }
async function callBatch(model,slice,key){
  const body={ requests: slice.map(t=>({ model:'models/'+model, content:{ parts:[{text:t}] } })) };
  return fetch(batchUrl(model,key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
async function resolveModel(key){
  if(EMBED_MODEL) return EMBED_MODEL;
  let last='';
  for(const m of EMBED_MODELS){
    try{ const r=await callBatch(m,['test'],key); if(r.ok){ EMBED_MODEL=m; return m; } last=r.status+' '+(await r.text()).slice(0,110); }
    catch(e){ last=e.message; }
  }
  throw new Error('Žádný embedding model není dostupný pro tvůj klíč ('+last+')');
}
async function embedTexts(texts,onProg){
  const key=(window.getGeminiKey?window.getGeminiKey():'')||'';
  if(!key) throw new Error('Chybí Gemini klíč — nastav ho v Nastavení.');
  const model=await resolveModel(key);
  const out=[]; const B=50;
  for(let i=0;i<texts.length;i+=B){
    const slice=texts.slice(i,i+B);
    const r=await callBatch(model,slice,key);
    if(!r.ok){ throw new Error('Embedding API '+r.status+': '+(await r.text()).slice(0,180)); }
    const j=await r.json();
    (j.embeddings||[]).forEach(e=>out.push(e.values));
    if(onProg) onProg(Math.min(i+B,texts.length),texts.length);
  }
  return out;
}

function cosine(a,b){ let d=0,na=0,nb=0; const n=Math.min(a.length,b.length); for(let i=0;i<n;i++){ d+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; } return d/(Math.sqrt(na)*Math.sqrt(nb)+1e-9); }

/* ---- Veřejné API ---- */
async function indexCase(caseId,transcript,onProg){
  const chunks=chunkTranscript(transcript||'');
  if(!chunks.length) throw new Error('Prázdný přepis spisu.');
  const vecs=await embedTexts(chunks.map(c=>c.text),onProg);
  const recs=chunks.map((c,i)=>({ id:caseId+'#'+i, caseId:caseId, doc:c.doc, text:c.text, vec:vecs[i], at:Date.now() }));
  await idbDelByCase(caseId);
  await idbPutMany(recs);
  return recs.length;
}
async function status(caseId){ try{ return (await idbGetByCase(caseId)).length; }catch(e){ return 0; } }
async function clear(caseId){ return idbDelByCase(caseId); }
async function retrieve(caseId,query,budgetChars){
  budgetChars=budgetChars||70000;
  const recs=await idbGetByCase(caseId); if(!recs.length) return null;
  const qv=(await embedTexts([query]))[0];
  recs.forEach(r=>r._s=cosine(qv,r.vec||[]));
  recs.sort((a,b)=>b._s-a._s);
  const out=[]; let used=0;
  for(const r of recs){ const block='[Zdroj: '+r.doc+']\n'+r.text+'\n\n'; if(used+block.length>budgetChars) break; out.push(block); used+=block.length; }
  return out.join('');
}

/* ---- KEYWORD retrieval (Antigravity styl): funguje hned i na malém dokumentu,
   bez indexace a bez embedding API. Pro trestní spisy (jména, §, data, částky) často lepší. ---- */
const CZ_STOP=new Set(('a i v ve na na do od po za k ke ku s se si z ze o u je to ze že co jak kdo kde kdy proc proč '+
  'ktery ktera ktere který která které byl byla bylo byli jsou byt být ma má maji mají me mě my ty on ona ono jako '+
  'tak jen uz už jeste ještě take také teto této tento tato toto jsem jsi ale nebo pri při pod nad pro ze pak tim tím '+
  'the of and mi mu ho ji ji nej vsak však tedy proto').split(/\s+/));
function _dia(s){ return (s||'').normalize('NFD').replace(/[̀-ͯ]/g,''); }
function _norm(s){ return _dia(String(s||'').toLowerCase()); }
function _keywords(q){ return _norm(q).replace(/[^a-z0-9§]+/g,' ').split(/\s+/).filter(w=>w.length>1 && !CZ_STOP.has(w)); }
function _chunkByPara(transcript){
  const chunks=[]; const t=transcript||'';
  const parts=t.split(/\n?===\s*(.+?)\s*===\n/);
  const segs=[];
  if(parts.length<=1){ segs.push({doc:'spis',body:t}); }
  else{ if(parts[0]&&parts[0].trim())segs.push({doc:'spis',body:parts[0]}); for(let i=1;i<parts.length;i+=2)segs.push({doc:(parts[i]||'spis').trim(),body:parts[i+1]||''}); }
  segs.forEach(seg=>{
    let paras=(seg.body||'').split(/\n\s*\n/).map(p=>p.trim()).filter(p=>p.length>0);
    if(paras.length<=1 && (seg.body||'').length>1200){
      paras=[]; const b=seg.body; let i=0;
      while(i<b.length){ let end=Math.min(i+900,b.length); if(end<b.length){ const d=b.lastIndexOf('. ',end); if(d>i+400)end=d+1; } paras.push(b.slice(i,end).trim()); i=end; }
    }
    paras.forEach(p=>{ if(p.length>20) chunks.push({doc:seg.doc,text:p}); });
  });
  return chunks;
}
function keywordRetrieve(transcript, query, k){
  k=k||7;
  const chunks=_chunkByPara(transcript);
  if(!chunks.length) return '';
  const kws=_keywords(query);
  let pick;
  if(!kws.length){ pick=chunks.slice(0,k); }
  else{
    chunks.forEach((c,idx)=>{
      const nt=_norm(c.text); let sc=0;
      kws.forEach(w=>{ let pos=nt.indexOf(w),cnt=0; while(pos>=0){ cnt++; pos=nt.indexOf(w,pos+w.length); } sc+=cnt*3; });
      c._s=sc - idx*0.001; // při shodě mírně upřednostni dřívější pasáž
    });
    const scored=chunks.filter(c=>c._s>0).sort((a,b)=>b._s-a._s);
    pick=(scored.length?scored:chunks).slice(0,k);
  }
  return pick.map(c=>'--- ZDROJ: '+c.doc+' ---\n'+c.text).join('\n\n');
}

window.RAG={ indexCase, retrieve, status, clear, keywordRetrieve };
})();
