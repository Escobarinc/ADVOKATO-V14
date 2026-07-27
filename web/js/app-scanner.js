/* ============ SCANNER ============ */
let scanCaseId=null, scanPages=[], scanCurrentImg=null, scanCorners=[[],[],[],[]], scanDragging=-1, scanOffset={x:0,y:0};
let scanAutoContinue=true; // plynulé skenování — po přijetí stránky se foťák otevře sám

function openScanner(caseId){
  if(typeof hasModule==='function'&&!hasModule('scanner')){ toast('Modul Sken spisu není pro váš účet aktivní.'); return; }
  scanCaseId=caseId; scanPages=[]; scanCurrentImg=null;
  document.getElementById('scannerModal').style.display='flex';
  document.getElementById('scanPhase1').style.display='flex';
  document.getElementById('scanPhase2').style.display='none';
  document.getElementById('scanThumbs').style.display='none';
  document.getElementById('scanThumbList').innerHTML='';
  const done=document.getElementById('scanDoneBtn');
  done.style.display='none'; done.disabled=false; done.textContent='Vytvořit PDF →';
  document.getElementById('scanPageCount').textContent='';
  document.getElementById('scanTitle').textContent='Skenovat spis';
  document.body.style.overflow='hidden';
}
function closeScanner(){
  document.getElementById('scannerModal').style.display='none';
  document.body.style.overflow='';
}
function triggerCamera(){ document.getElementById('scanInput').click(); }

function onScanPhoto(inp){
  const file=inp.files[0]; if(!file) return; inp.value='';
  const img=new Image();
  img.onload=()=>{ scanCurrentImg=img; showCropEditor(img); };
  img.src=URL.createObjectURL(file);
}

function showCropEditor(img){
  document.getElementById('scanPhase1').style.display='none';
  const phase2=document.getElementById('scanPhase2');
  phase2.style.display='flex';
  const wrap=document.getElementById('scanCanvasWrap');
  const canvas=document.getElementById('scanCanvas');
  // fit image into viewport
  const maxW=wrap.clientWidth||window.innerWidth, maxH=(wrap.clientHeight||window.innerHeight*0.7);
  const scale=Math.min(maxW/img.width, maxH/img.height, 1);
  canvas.width=img.width; canvas.height=img.height;
  canvas.style.width=Math.round(img.width*scale)+'px';
  canvas.style.height=Math.round(img.height*scale)+'px';
  const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0);
  // auto-detect corners
  scanCorners=autoDetectCorners(ctx, img.width, img.height);
  positionCornerHandles(img.width, img.height, scale);
  updateOverlay(img.width, img.height, scale);
}

function autoDetectCorners(ctx, w, h){
  // Sample image at reduced resolution for speed
  const sw=Math.min(w,400), sh=Math.min(h,400);
  const tmp=document.createElement('canvas'); tmp.width=sw; tmp.height=sh;
  const tc=tmp.getContext('2d'); tc.drawImage(ctx.canvas,0,0,sw,sh);
  const data=tc.getImageData(0,0,sw,sh).data;
  // Find bright region (document on dark background) using simple threshold
  const thr=160; let top=sh,left=sw,bottom=0,right=0, found=false;
  for(let y=0;y<sh;y++) for(let x=0;x<sw;x++){
    const i=(y*sw+x)*4;
    const brightness=(data[i]+data[i+1]+data[i+2])/3;
    if(brightness>thr){ found=true; if(x<left)left=x; if(x>right)right=x; if(y<top)top=y; if(y>bottom)bottom=y; }
  }
  if(!found || (right-left)<sw*0.15 || (bottom-top)<sh*0.15){
    // fallback: 8% inset
    const p=0.08; return [[w*p,h*p],[w*(1-p),h*p],[w*(1-p),h*(1-p)],[w*p,h*(1-p)]];
  }
  // Scale back to original
  const sx=w/sw, sy=h/sh;
  const pad=6;
  return [
    [(left-pad)*sx,(top-pad)*sy],
    [(right+pad)*sx,(top-pad)*sy],
    [(right+pad)*sx,(bottom+pad)*sy],
    [(left-pad)*sx,(bottom+pad)*sy]
  ].map(([x,y])=>[Math.max(0,Math.min(w,x)),Math.max(0,Math.min(h,y))]);
}

function positionCornerHandles(imgW, imgH, scale){
  const wrap=document.getElementById('scanCanvasWrap');
  const canvas=document.getElementById('scanCanvas');
  const cr=canvas.getBoundingClientRect(), wr=wrap.getBoundingClientRect();
  const ox=cr.left-wr.left, oy=cr.top-wr.top;
  scanCorners.forEach(([ix,iy],i)=>{
    const el=document.getElementById('scanCorner'+i);
    el.style.left=(ox+ix*scale)+'px';
    el.style.top=(oy+iy*scale)+'px';
  });
  updateOverlay(imgW, imgH, scale);
}

function updateOverlay(imgW, imgH, scale){
  const wrap=document.getElementById('scanCanvasWrap');
  const canvas=document.getElementById('scanCanvas');
  const cr=canvas.getBoundingClientRect(), wr=wrap.getBoundingClientRect();
  const ox=cr.left-wr.left, oy=cr.top-wr.top;
  const pts=scanCorners.map(([ix,iy])=>(ox+ix*scale)+','+(oy+iy*scale));
  document.getElementById('scanPoly').setAttribute('points',pts.join(' '));
}

function getScale(){
  const canvas=document.getElementById('scanCanvas');
  return parseFloat(canvas.style.width)/canvas.width;
}

function startDrag(e,idx){
  scanDragging=idx;
  const pos=getEventPos(e);
  const wrap=document.getElementById('scanCanvasWrap');
  const canvas=document.getElementById('scanCanvas');
  const cr=canvas.getBoundingClientRect(), wr=wrap.getBoundingClientRect();
  const scale=getScale();
  scanOffset={x: pos.x-(cr.left-wr.left)-scanCorners[idx][0]*scale,
              y: pos.y-(cr.top-wr.top)-scanCorners[idx][1]*scale};
  e.preventDefault();
  document.addEventListener('mousemove',onDrag);
  document.addEventListener('mouseup',endDrag);
  document.addEventListener('touchmove',onDrag,{passive:false});
  document.addEventListener('touchend',endDrag);
}
function getEventPos(e){ const t=e.touches?e.touches[0]:e; return {x:t.clientX,y:t.clientY}; }
function onDrag(e){
  if(scanDragging<0) return; e.preventDefault();
  const pos=getEventPos(e);
  const wrap=document.getElementById('scanCanvasWrap');
  const canvas=document.getElementById('scanCanvas');
  const cr=canvas.getBoundingClientRect(), wr=wrap.getBoundingClientRect();
  const scale=getScale();
  const nx=(pos.x-(cr.left-wr.left)-scanOffset.x)/scale;
  const ny=(pos.y-(cr.top-wr.top)-scanOffset.y)/scale;
  scanCorners[scanDragging]=[Math.max(0,Math.min(canvas.width,nx)),Math.max(0,Math.min(canvas.height,ny))];
  const el=document.getElementById('scanCorner'+scanDragging);
  el.style.left=(cr.left-wr.left+scanCorners[scanDragging][0]*scale)+'px';
  el.style.top=(cr.top-wr.top+scanCorners[scanDragging][1]*scale)+'px';
  updateOverlay(canvas.width, canvas.height, scale);
}
function endDrag(){ scanDragging=-1; document.removeEventListener('mousemove',onDrag); document.removeEventListener('mouseup',endDrag); document.removeEventListener('touchmove',onDrag); document.removeEventListener('touchend',endDrag); }

function rejectScanPhoto(){
  document.getElementById('scanPhase2').style.display='none';
  document.getElementById('scanPhase1').style.display='flex';
  scanCurrentImg=null;
}

const SCAN_MAX_PAGES=50;
function acceptScanPhoto(){
  if(scanPages.length>=SCAN_MAX_PAGES){
    toast('Limit '+SCAN_MAX_PAGES+' stran na jednu dávku. Ulož tuto a nafoť další.');
    return;
  }
  // Apply perspective transform + enhance
  const processed=perspectiveCrop(scanCurrentImg, scanCorners);
  scanPages.push(processed);
  document.getElementById('scanPhase2').style.display='none';
  document.getElementById('scanPhase1').style.display='flex';
  renderScanThumbs();
  // Plynulé skenování — otevři foťák hned na další stránku (bez extra ťuknutí)
  if(scanAutoContinue && scanPages.length<SCAN_MAX_PAGES){
    setTimeout(()=>triggerCamera(), 250);
  }
}
function toggleAutoContinue(){
  scanAutoContinue=!scanAutoContinue;
  const el=document.getElementById('autoContToggle');
  if(el) el.classList.toggle('on',scanAutoContinue);
}

// Smaže stránku z dávky a přečísluje
function deleteScanPage(i){
  scanPages.splice(i,1);
  renderScanThumbs();
}
// Přehodí stránku o jednu pozici (dir -1 vlevo / +1 vpravo)
function moveScanPage(i,dir){
  const j=i+dir; if(j<0||j>=scanPages.length) return;
  const t=scanPages[i]; scanPages[i]=scanPages[j]; scanPages[j]=t;
  renderScanThumbs();
}
function reorderScanPage(from,to){
  if(from===to||from<0||to<0||from>=scanPages.length||to>=scanPages.length) return;
  const item=scanPages.splice(from,1)[0];
  scanPages.splice(to,0,item);
  renderScanThumbs();
  toast('Stránka '+(to+1)+' · pořadí upraveno');
}
function bindThumbReorder(thumb,idx,list){
  let dragFrom=null, startX=0, moved=false;
  const reset=()=>{
    thumb.style.transform=''; thumb.style.zIndex=''; thumb.classList.remove('thumb-grab');
    list.querySelectorAll('.scan-thumb').forEach(t=>t.classList.remove('thumb-drop-target'));
    dragFrom=null; moved=false;
  };
  thumb.addEventListener('pointerdown',e=>{
    if(e.target.closest('button')) return;
    dragFrom=idx; startX=e.clientX; moved=false;
    thumb.classList.add('thumb-grab');
    try{ thumb.setPointerCapture(e.pointerId); }catch(_){}
  });
  thumb.addEventListener('pointermove',e=>{
    if(dragFrom!==idx) return;
    const dx=e.clientX-startX;
    if(Math.abs(dx)>6) moved=true;
    thumb.style.transform='translateX('+dx+'px)';
    thumb.style.zIndex='5';
    list.querySelectorAll('.scan-thumb').forEach((t,j)=>{
      const r=t.getBoundingClientRect();
      const over=e.clientX>=r.left&&e.clientX<=r.right;
      t.classList.toggle('thumb-drop-target',over&&j!==idx);
    });
  });
  const finish=e=>{
    if(dragFrom!==idx) return;
    let toIdx=idx;
    if(moved){
      list.querySelectorAll('.scan-thumb').forEach((t,j)=>{
        const r=t.getBoundingClientRect();
        if(e.clientX>=r.left&&e.clientX<=r.right) toIdx=j;
      });
      reset();
      if(toIdx!==idx) reorderScanPage(idx,toIdx);
      return;
    }
    reset();
  };
  thumb.addEventListener('pointerup',finish);
  thumb.addEventListener('pointercancel',reset);
  // Rychlý swipe vlevo/vpravo = posun o 1
  let sx=0,sy=0,swipeTrack=false;
  thumb.addEventListener('touchstart',e=>{
    if(e.target.closest('button')) return;
    sx=e.touches[0].clientX; sy=e.touches[0].clientY; swipeTrack=true;
  },{passive:true});
  thumb.addEventListener('touchend',e=>{
    if(!swipeTrack||moved) return;
    swipeTrack=false;
    const t=e.changedTouches[0], dx=t.clientX-sx, dy=t.clientY-sy;
    if(Math.abs(dx)<36||Math.abs(dx)<Math.abs(dy)) return;
    if(dx>0) moveScanPage(idx,-1);
    else moveScanPage(idx,1);
  },{passive:true});
}
// Překreslí celý pruh náhledů z scanPages — s mazáním a přehazováním
function renderScanThumbs(){
  const thumbs=document.getElementById('scanThumbs');
  const list=document.getElementById('scanThumbList');
  const hint=document.getElementById('scanThumbHint');
  list.innerHTML='';
  if(!scanPages.length){
    thumbs.style.display='none';
    if(hint) hint.style.display='none';
    document.getElementById('scanDoneBtn').style.display='none';
    document.getElementById('scanPageCount').textContent='';
    document.getElementById('scanTitle').textContent='Skenovat spis';
    return;
  }
  thumbs.style.display='flex';
  if(hint) hint.style.display='block';
  scanPages.forEach((canvas,i)=>{
    const thumb=document.createElement('div');
    thumb.className='scan-thumb';
    thumb.setAttribute('draggable','false');
    const img=document.createElement('img');
    img.src=canvas.toDataURL('image/jpeg',.6);
    img.className='scan-thumb-img';
    img.draggable=false;
    const num=document.createElement('div'); num.className='scan-thumb-num'; num.textContent=i+1;
    const ctr=document.createElement('div'); ctr.className='scan-thumb-ctr';
    const mkBtn=(svg,title,fn,dis)=>{ const b=document.createElement('button'); b.type='button'; b.className='scan-thumb-btn'+(dis?' dis':''); b.title=title; b.innerHTML=svg; if(!dis) b.onclick=(ev)=>{ev.stopPropagation();fn();}; return b; };
    ctr.appendChild(mkBtn('<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>','Posunout vlevo',()=>moveScanPage(i,-1),i===0));
    ctr.appendChild(mkBtn('<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>','Posunout vpravo',()=>moveScanPage(i,1),i===scanPages.length-1));
    const del=document.createElement('button'); del.type='button'; del.className='scan-thumb-del'; del.title='Smazat stránku'; del.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'; del.onclick=(ev)=>{ev.stopPropagation();deleteScanPage(i);};
    thumb.appendChild(img); thumb.appendChild(num); thumb.appendChild(ctr); thumb.appendChild(del);
    list.appendChild(thumb);
    bindThumbReorder(thumb,i,list);
  });
  const cnt=document.getElementById('scanPageCount');
  cnt.textContent=scanPages.length+' / '+SCAN_MAX_PAGES+' str.';
  cnt.style.color=scanPages.length>=SCAN_MAX_PAGES?'#f45959':(scanPages.length>=40?'#d4af37':'rgba(255,255,255,.6)');
  document.getElementById('scanDoneBtn').style.display='block';
  document.getElementById('scanTitle').textContent=scanPages.length>=SCAN_MAX_PAGES?'Limit dávky — ulož PDF':'Přidej další stránky';
}

function perspectiveCrop(img, corners){
  // Compute output dimensions from corner bounding box
  const xs=corners.map(c=>c[0]), ys=corners.map(c=>c[1]);
  const w=Math.round(Math.max(...xs)-Math.min(...xs));
  const h=Math.round(Math.max(...ys)-Math.min(...ys));
  // Output canvas (A4-ish ratio, at most 1800px wide)
  const outW=Math.min(w,1800), outH=Math.round(outW*(h/w));
  const dst=[[0,0],[outW,0],[outW,outH],[0,outH]];
  const H=computeHomography(corners, dst);
  const out=document.createElement('canvas'); out.width=outW; out.height=outH;
  const ctx=out.getContext('2d');
  // Inverse map each output pixel to source
  const HI=invertMatrix3(H);
  const srcData=(() => { const c=document.createElement('canvas'); c.width=img.width; c.height=img.height; c.getContext('2d').drawImage(img,0,0); return c.getContext('2d').getImageData(0,0,img.width,img.height); })();
  const dstData=ctx.createImageData(outW,outH);
  const sw=img.width, sh=img.height;
  for(let y=0;y<outH;y++) for(let x=0;x<outW;x++){
    const [sx,sy,sw2]=mulH(HI,[x,y,1]);
    const px=Math.round(sx/sw2), py=Math.round(sy/sw2);
    const di=(y*outW+x)*4;
    if(px>=0&&px<sw&&py>=0&&py<sh){
      const si=(py*sw+px)*4;
      dstData.data[di]=srcData.data[si]; dstData.data[di+1]=srcData.data[si+1];
      dstData.data[di+2]=srcData.data[si+2]; dstData.data[di+3]=255;
    }
  }
  ctx.putImageData(dstData,0,0);
  enhanceCanvas(ctx, outW, outH);
  return out;
}

function computeHomography(src, dst){
  // Direct Linear Transform for homography
  const A=[], b=[];
  for(let i=0;i<4;i++){
    const [x,y]=[src[i][0],src[i][1]], [u,v]=[dst[i][0],dst[i][1]];
    A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
    A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v);
  }
  const h=solveLinear8(A,b);
  return [[h[0],h[1],h[2]],[h[3],h[4],h[5]],[h[6],h[7],1]];
}

function solveLinear8(A,b){
  // Gaussian elimination
  const n=8;
  const M=A.map((row,i)=>[...row,b[i]]);
  for(let col=0;col<n;col++){
    let pivot=col;
    for(let row=col+1;row<n;row++) if(Math.abs(M[row][col])>Math.abs(M[pivot][col])) pivot=row;
    [M[col],M[pivot]]=[M[pivot],M[col]];
    for(let row=col+1;row<n;row++){
      const f=M[row][col]/M[col][col]; if(!isFinite(f)) continue;
      for(let j=col;j<=n;j++) M[row][j]-=f*M[col][j];
    }
  }
  const x=new Array(n).fill(0);
  for(let i=n-1;i>=0;i--){
    x[i]=M[i][n]; for(let j=i+1;j<n;j++) x[i]-=M[i][j]*x[j]; x[i]/=M[i][i];
  }
  return x;
}

function invertMatrix3(m){
  const [a,b,c]=[m[0][0],m[0][1],m[0][2]];
  const [d,e,f]=[m[1][0],m[1][1],m[1][2]];
  const [g,h,k]=[m[2][0],m[2][1],m[2][2]];
  const det=a*(e*k-f*h)-b*(d*k-f*g)+c*(d*h-e*g);
  const inv=(i,j)=>[[e*k-f*h,c*h-b*k,b*f-c*e],[f*g-d*k,a*k-c*g,c*d-a*f],[d*h-e*g,b*g-a*h,a*e-b*d]][i][j]/det;
  return [[inv(0,0),inv(0,1),inv(0,2)],[inv(1,0),inv(1,1),inv(1,2)],[inv(2,0),inv(2,1),inv(2,2)]];
}
function mulH(M,[x,y,w]){ return [M[0][0]*x+M[0][1]*y+M[0][2]*w,M[1][0]*x+M[1][1]*y+M[1][2]*w,M[2][0]*x+M[2][1]*y+M[2][2]*w]; }

function enhanceCanvas(ctx, w, h){
  const d=ctx.getImageData(0,0,w,h);
  // Auto-levels: stretch min-max per channel
  let rMin=255,rMax=0,gMin=255,gMax=0,bMin=255,bMax=0;
  for(let i=0;i<d.data.length;i+=4){
    rMin=Math.min(rMin,d.data[i]); rMax=Math.max(rMax,d.data[i]);
    gMin=Math.min(gMin,d.data[i+1]); gMax=Math.max(gMax,d.data[i+1]);
    bMin=Math.min(bMin,d.data[i+2]); bMax=Math.max(bMax,d.data[i+2]);
  }
  for(let i=0;i<d.data.length;i+=4){
    d.data[i]=rMax>rMin?Math.round((d.data[i]-rMin)/(rMax-rMin)*255):d.data[i];
    d.data[i+1]=gMax>gMin?Math.round((d.data[i+1]-gMin)/(gMax-gMin)*255):d.data[i+1];
    d.data[i+2]=bMax>bMin?Math.round((d.data[i+2]-bMin)/(bMax-bMin)*255):d.data[i+2];
  }
  ctx.putImageData(d,0,0);
}

async function finalizeScan(){
  if(!scanPages.length){ toast('Žádné stránky ke zpracování.'); return; }
  const btn=document.getElementById('scanDoneBtn');
  const resetBtn=()=>{ btn.textContent='Vytvořit PDF →'; btn.disabled=false; };
  btn.textContent='Generuji PDF…'; btn.disabled=true;
  try{
    const {jsPDF}=window.jspdf;
    const firstPage=scanPages[0];
    const pdf=new jsPDF({orientation:firstPage.width>firstPage.height?'landscape':'portrait',unit:'px',format:[firstPage.width,firstPage.height]});
    scanPages.forEach((canvas,i)=>{
      if(i>0) pdf.addPage([canvas.width,canvas.height], canvas.width>canvas.height?'landscape':'portrait');
      pdf.addImage(canvas.toDataURL('image/jpeg',.88),'JPEG',0,0,canvas.width,canvas.height);
    });
    const blob=pdf.output('blob');
    const date=new Date().toLocaleDateString('cs-CZ').replace(/\.\s*/g,'-').replace(/-$/,'');
    const file=new File([blob],`Spis-sken-${date}.pdf`,{type:'application/pdf'});
    closeScanner();
    if(scanCaseId){
      // Switch to case detail + dokumenty tab
      const c=getCaseById(scanCaseId);
      if(c){ openCaseDetail(scanCaseId); setTimeout(()=>{ switchDetailTab('dokumenty'); setTimeout(()=>addDocToCase(file),200); },100); }
    } else {
      // Pokud bez případu, trigger standardní upload
      toast('PDF vytvořeno — vyberte případ pro uložení.');
    }
    resetBtn(); // tlačítko zpět do funkčního stavu (PDF hotové, OCR běží/proběhlo zvlášť)
  } catch(e){ toast('Chyba: '+e.message); resetBtn(); }
}