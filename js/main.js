pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const DAYS = ['LUNDI','MARDI','MERCREDI','JEUDI','VENDREDI','SAMEDI','DIMANCHE'];
const DEFAULT_BOUNDS = [
  ['SERVICES', 0,    434],
  ['LUNDI',    434,  689],
  ['MARDI',    689,  943],
  ['MERCREDI', 943,  1198],
  ['JEUDI',    1198, 1453],
  ['VENDREDI', 1453, 1708],
  ['SAMEDI',   1708, 1963],
  ['DIMANCHE', 1963, 9999],
];
const SKIP_SVC = new Set(['SERVICES','EFFECTIF','SEMAINE',
  'LUNDI','MARDI','MERCREDI','JEUDI','VENDREDI','SAMEDI','DIMANCHE']);
const CONGES_KEYWORDS = ['conges', 'administratifs', 'exceptionnels','conge','ferie','repos','journee','recuperation','recup'];
const ARRET_KEYWORDS = ['personnels', 'indisponibles'];

const SINGLE_LINE_SERVICES = new Set([
  'GRADE MONEGHETTI', 'GRADE CASERNE DU PALAIS', 'FACTOTUM',
  'POLICE N°1', 'POLICE N°2', 'POLICE N1', 'POLICE N2',
]);
function isSingleLineService(text){
  const norm = text.toUpperCase().replace(/\s+/g,' ').trim();
  return SINGLE_LINE_SERVICES.has(norm);
}

let nameIndex = null;
let dayDates  = [];
let weekNum   = '?';

const uploadZone = document.getElementById('uploadZone');
const fileInput  = document.getElementById('fileInput');
const fileBadge  = document.getElementById('fileBadge');
const fileNameEl = document.getElementById('fileName');
const nameInput  = document.getElementById('nameInput');
const searchBtn  = document.getElementById('searchBtn');
const spinner    = document.getElementById('spinner');
const statusMsg  = document.getElementById('statusMsg');
const statusEl   = document.getElementById('status');
const resultsEl  = document.getElementById('results');
const weekInfo   = document.getElementById('weekInfo');
const weekLabel  = document.getElementById('weekLabel');

function setStatus(msg, type=''){
  statusMsg.textContent = msg;
  statusEl.className = type;
  spinner.classList.toggle('active', type==='loading');
}

uploadZone.addEventListener('dragover', e=>{e.preventDefault();uploadZone.classList.add('drag')});
uploadZone.addEventListener('dragleave', ()=>uploadZone.classList.remove('drag'));
uploadZone.addEventListener('drop', e=>{
  e.preventDefault(); uploadZone.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if(f && f.type==='application/pdf') handleFile(f);
  else setStatus('Seuls les fichiers PDF sont acceptés.','error');
});
fileInput.addEventListener('change', ()=>{ if(fileInput.files[0]) handleFile(fileInput.files[0]) });
nameInput.addEventListener('keydown', e=>{ if(e.key==='Enter' && !searchBtn.disabled) doSearch() });
searchBtn.addEventListener('click', doSearch);

function getCol(x, bounds){
  for(const [name,lo,hi] of bounds) if(x>=lo && x<hi) return name;
  return '?';
}

function normalizeService(svc){
  const low = svc.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(CONGES_KEYWORDS.some(k => low.includes(k))) return 'CONGES';
  if(ARRET_KEYWORDS.some(k => low.includes(k))) return 'ARRET';
  return svc;
}

async function extractPageData(page, yOffset){
  const opList = await page.getOperatorList();
  const OPS    = pdfjsLib.OPS;
  const vp     = page.getViewport({scale:1});
  const H      = vp.height;

  let fillColor  = [0,0,0];
  let colorStack = [];
  let textMatrix = [1,0,0,1,0,0];
  let pathSegs   = [];

  const fragments = [];
  const rects     = [];

  function applyMatrix(m, x, y){
    return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
  }

  for(let i=0; i<opList.fnArray.length; i++){
    const fn   = opList.fnArray[i];
    const args = opList.argsArray[i];

    if(fn === OPS.save){
      colorStack.push(fillColor);
    } else if(fn === OPS.restore){
      if(colorStack.length) fillColor = colorStack.pop();
    } else if(fn === OPS.setFillRGBColor){
      fillColor = [args[0]/255, args[1]/255, args[2]/255].map(v=>Math.round(v*1000)/1000);
    } else if(fn === OPS.setTextMatrix){
      textMatrix = args;
    } else if(fn === OPS.showText){
      const glyphs = args[0];
      let text = '';
      let totalGlyphWidth = 0;
      for(const g of glyphs){
        if(typeof g === 'object' && g.unicode !== undefined){
          text += g.unicode;
          totalGlyphWidth += (g.width || 0);
        }
      }
      if(text.trim()){
        const [px, py] = applyMatrix(textMatrix, 0, 0);
        const pxWidth = totalGlyphWidth * Math.abs(textMatrix[0]) / 1000;
        fragments.push({ text, x: px, y: (H - py) + yOffset, pxWidth });
      }
    } else if(fn === OPS.constructPath){
      const [pathOps, pathArgs] = args;
      let idx = 0;
      for(const pOp of pathOps){
        if(pOp === OPS.rectangle){
          const [x,y,w,h] = pathArgs.slice(idx, idx+4);
          idx += 4;
          pathSegs.push({type:'rect', x, y, w, h});
        } else if(pOp === OPS.moveTo || pOp === OPS.lineTo){
          idx += 2;
        }
      }
    } else if(fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke){
      for(const seg of pathSegs){
        if(seg.type === 'rect'){
          const y0 = (H - (seg.y + seg.h)) + yOffset;
          const y1 = (H - seg.y) + yOffset;
          rects.push({x0: seg.x, x1: seg.x+seg.w, y0, y1, color: fillColor.join(',')});
        }
      }
      pathSegs = [];
    } else if(fn === OPS.stroke){
      pathSegs = [];
    }
  }
  return { fragments, rects };
}

function splitFragmentIntoWords(frag){
  const parts = frag.text.split(/(\s+)/).filter(s=>s.length);
  if(parts.length<=1) return [{text:frag.text.trim(), x:frag.x}];
  // Use real pixel width if available, fall back to a reasonable approximation
  const charW = frag.pxWidth && frag.text.length > 0
    ? frag.pxWidth / frag.text.length
    : 9;
  let cx = frag.x;
  const out = [];
  for(const part of parts){
    if(part.trim()) out.push({text:part, x:cx});
    cx += part.length * charW;
  }
  return out;
}

function extractNames(wordList){
  const results=[];
  let i=0;
  while(i<wordList.length){
    const w = wordList[i];
    const t = w.text.trim();
    if(/^[A-ZÉÀÈÊÎÏÔÙÛÜ][A-ZÉÀÈÊÎÏÔÙÛÜa-zéàèêîïôùûü\-]+$/.test(t) && t.length>=2){
      const next = wordList[i+1];
      if(next && /^[A-Z]\.$/.test(next.text.trim())){
        results.push({name: t+' '+next.text.trim()});
        i+=2; continue;
      }
    }
    i++;
  }
  return results;
}

async function handleFile(file){
  setStatus('Lecture du PDF…','loading');
  fileNameEl.textContent = file.name;
  fileBadge.classList.add('visible');
  weekInfo.classList.remove('visible');
  resultsEl.innerHTML = '';
  nameIndex = null; dayDates = []; weekNum = '?';
  searchBtn.disabled = true;

  try{
    const ab  = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data: ab}).promise;

    const PAGE_GAP = 50;
    let yCursor = 0;
    let allFragments = [];
    let allRects = [];
    for(let p=1; p<=pdf.numPages; p++){
      const page = await pdf.getPage(p);
      const vp   = page.getViewport({scale:1});
      const { fragments, rects } = await extractPageData(page, yCursor);
      allFragments.push(...fragments);
      allRects.push(...rects);
      yCursor += vp.height + PAGE_GAP;
    }

    if(!allFragments.length) throw new Error('Aucun texte trouvé dans le PDF.');

    let bounds = DEFAULT_BOUNDS;
    const headerFrags = allFragments.filter(f=>DAYS.includes(f.text.trim().toUpperCase()));
    if(headerFrags.length >= 5){
      const seen = new Map();
      for(const w of headerFrags.sort((a,b)=>a.x-b.x)){
        const t = w.text.trim().toUpperCase();
        if(!seen.has(t)) seen.set(t, w.x);
      }
      if(seen.size >= 5){
        const dayXs = DAYS.map(d=>seen.get(d)).filter(x=>x!=null);
        const gap   = (dayXs[dayXs.length-1]-dayXs[0]) / (dayXs.length-1) * 0.5;
        bounds = [['SERVICES', 0, dayXs[0]-gap]];
        for(let i=0;i<DAYS.length;i++){
          const lo = dayXs[i]   != null ? dayXs[i]-gap   : bounds[bounds.length-1][2];
          const hi = dayXs[i+1] != null ? dayXs[i+1]-gap : 99999;
          bounds.push([DAYS[i], lo, hi]);
        }
      }
    }

    function isRealServiceColor(c){
      return c !== '0,0,0' && c !== '1,1,1';
    }
    const colorBlocks = allRects.filter(r =>
      r.x0 >= 210 && r.x0 <= 230 &&
      r.x1 >= 424 && r.x1 <= 444 &&
      (r.y1 - r.y0) > 8 && (r.y1 - r.y0) < 1000 &&
      isRealServiceColor(r.color)
    );
    colorBlocks.sort((a,b)=>a.y0-b.y0);

    function colorBlockForY(y){
      for(const b of colorBlocks){
        if(y >= b.y0 - 2 && y <= b.y1 + 2) return b;
      }
      return null;
    }

    const rowMap = {};
    for(const f of allFragments){
      const yb = Math.round(f.y/3)*3;
      (rowMap[yb]=rowMap[yb]||[]).push(f);
    }
    const structured = Object.entries(rowMap)
      .sort((a,b)=>+a[0]-+b[0])
      .map(([y, frags])=>{
        const cols = {};
        const sorted = frags.sort((a,b)=>a.x-b.x);
        for(const frag of sorted){
          const words = splitFragmentIntoWords(frag);
          for(const w of words){
            const col = getCol(w.x, bounds);
            (cols[col]=cols[col]||[]).push(w);
          }
        }
        return {y:+y, cols};
      });

    // ── Week metadata ──
    const fullText = allFragments.map(f=>f.text).join(' ');
    const wkMatch  = fullText.match(/SEMAINE\s*:?\s*(\d+)/i);
    weekNum = wkMatch ? wkMatch[1] : '?';
    const allDates = [...new Set([...fullText.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)].map(m=>m[1]))];
    dayDates = allDates.slice(0,7);
    if(weekNum !== '?'){
      weekLabel.textContent = `Semaine ${weekNum}  ·  ${dayDates[0]||''} → ${dayDates[dayDates.length-1]||''}`;
      weekInfo.classList.add('visible');
    }


    const svcLabelEntries = [];
    for(const {y, cols} of structured){
      if(!cols['SERVICES']) continue;
      const rowText = cols['SERVICES'].map(w=>w.text.trim()).filter(Boolean).join(' ');
      if(rowText && !SKIP_SVC.has(rowText) && rowText.length > 1){
        const block = colorBlockForY(y);
        svcLabelEntries.push({
          y, text: rowText,
          blockColor: block ? block.color : null,
          blockYRef:  block ? Math.round(block.y0) : y,
        });
      }
    }
    svcLabelEntries.sort((a,b)=>a.y-b.y);

    const labelGroups = [];
    let cur = null;
    for(const e of svcLabelEntries){
      const sameBlock = cur && e.blockColor === cur.blockColor && e.blockYRef === cur.blockYRef;      const closeGap  = cur && (e.y - cur.yEnd) < 20;
      const curIsSingleLine = cur && isSingleLineService(cur.texts[cur.texts.length-1]);
      const eIsSingleLine   = isSingleLineService(e.text);
      if(cur && sameBlock && closeGap && !curIsSingleLine && !eIsSingleLine){
        cur.texts.push(e.text);
        cur.yEnd = e.y;
      } else {
        if(cur) labelGroups.push(cur);
        cur = {blockColor: e.blockColor, blockYRef: e.blockYRef, yStart: e.y, yEnd: e.y, texts:[e.text]};
      }
    }
    if(cur) labelGroups.push(cur);
    for(const g of labelGroups) g.label = normalizeService(g.texts.join(' '));

    for(let i=1; i<labelGroups.length; i++){
      const prev = labelGroups[i-1], curG = labelGroups[i];
      if(prev.label === 'Congés' && curG.blockColor === prev.blockColor && (curG.yStart - prev.yEnd) < 30){
        curG.label = 'Congés';
      }
    }
/// condition sur le montante suivi d'un descendante et vice versa
    let palaisGardeNextIsDescendante = false;
    for(let i=0; i<labelGroups.length; i++){
      const g = labelGroups[i];
      const norm = g.label.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      const isPalaisGarde = norm.includes('PALAIS') && norm.includes('GARDE');
      const hasQualifier   = norm.includes('MONTANTE') || norm.includes('DESCENDANTE');
      if(isPalaisGarde && hasQualifier){
        palaisGardeNextIsDescendante = norm.includes('MONTANTE');
      } else if(isPalaisGarde && !hasQualifier){
        g.label = palaisGardeNextIsDescendante ? 'PALAIS Garde Descendante' : 'PALAIS Garde Montante';
        palaisGardeNextIsDescendante = !palaisGardeNextIsDescendante;
      }
    }

    function findServiceForName(nameY){
      const block = colorBlockForY(nameY);
      const blockColor = block ? block.color : null;
      const blockYRef  = block ? Math.round(block.y0) : null;
      let candidates = labelGroups.filter(g => g.blockColor === blockColor && g.blockYRef === blockYRef);
      if(!candidates.length) candidates = labelGroups;
      if(!candidates.length) return null;
      let best=null, bestDist=Infinity;
      for(const g of candidates){
        const d = (g.yStart<=nameY && nameY<=g.yEnd) ? 0
                  : Math.min(Math.abs(nameY-g.yStart), Math.abs(nameY-g.yEnd));
        if(d<bestDist){ bestDist=d; best=g; }
      }
      return best ? best.label : null;
    }

    nameIndex = new Map();
    for(const {y, cols} of structured){
      for(const day of DAYS){
        if(!cols[day]) continue;
        const names = extractNames(cols[day]);
        for(const n of names){
          const svc = findServiceForName(y);
          if(!svc) continue;
          const key = n.name.toUpperCase();
          if(!nameIndex.has(key)) nameIndex.set(key, new Map());
          const dm = nameIndex.get(key);
          if(!dm.has(day)) dm.set(day, new Set());
          dm.get(day).add(svc);
        }
      }
    }
/// condition sur le montante suivi d'un descendante et vice versa
    const MONTANTE_LABEL    = 'PALAIS Garde Montante';
    const DESCENDANTE_LABEL = 'PALAIS Garde Descendante';
    for(const dayMap of nameIndex.values()){
      for(let i=0; i<DAYS.length-1; i++){
        const dayToday    = DAYS[i];
        const dayTomorrow = DAYS[i+1];
        const todaySet    = dayMap.get(dayToday);
        const tomorrowSet = dayMap.get(dayTomorrow);

        const hasMontanteToday      = todaySet    && todaySet.has(MONTANTE_LABEL);
        const hasDescendanteTomorrow= tomorrowSet && tomorrowSet.has(DESCENDANTE_LABEL);

        if(hasMontanteToday && !hasDescendanteTomorrow){
          dayMap.set(dayTomorrow, new Set([DESCENDANTE_LABEL]));
        }
        if(hasDescendanteTomorrow && !hasMontanteToday){
          dayMap.set(dayToday, new Set([MONTANTE_LABEL]));
        }
      }
    }

    setStatus(`PDF chargé — ${nameIndex.size} noms indexés.`, 'success');
    searchBtn.disabled = false;
    nameInput.focus();

  } catch(err){
    setStatus('Erreur : '+(err.message||'Impossible de lire ce PDF.'),'error');
    console.error(err);
  }
}

function normalizeSearchText(s){
  return s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function doSearch(){
  if(!nameIndex) return;
  const raw   = nameInput.value.trim();
  const query = normalizeSearchText(raw);
  if(!query){ setStatus('Entre un nom à rechercher.','error'); return; }

  const byDay = {};
  for(const day of DAYS) byDay[day] = new Set();

  for(const [storedName, dayMap] of nameIndex){
    if(!normalizeSearchText(storedName).includes(query)) continue;
    for(const [day, svcSet] of dayMap){
      for(const svc of svcSet) byDay[day].add(svc);
    }
  }

  const hasAny = DAYS.some(d=>byDay[d].size>0);
  resultsEl.innerHTML='';

  if(!hasAny){
    resultsEl.innerHTML=`
      <div class="no-result">
        <div class="big">🔍</div>
        <p>Aucun résultat pour <strong>"${esc(raw)}"</strong>.<br/>
        Vérifie l'orthographe stp.</p>
      </div>`;
    return;
  }

  const total = DAYS.reduce((s,d)=>s+byDay[d].size, 0);
  resultsEl.innerHTML=`
    <div class="result-header">
      <div class="result-name">${esc(raw)}</div>
      <div class="result-count">${total} affectation${total>1?'s':''} cette semaine</div>
    </div>
    <div class="week-grid" id="weekGrid"></div>`;

  const grid = document.getElementById('weekGrid');
  DAYS.forEach((day,i)=>{
    const svcs    = [...byDay[day]].sort();
    const dateStr = dayDates[i]||'';
    const col     = document.createElement('div');
    col.className = 'day-col';
    col.innerHTML = `
      <div class="day-header">
        ${esc(day)}
        ${dateStr?`<span class="day-date">${esc(dateStr)}</span>`:''}
      </div>
      <div class="day-body">
        ${svcs.length
          ? svcs.map(s=>`<div class="svc-pill">${esc(s)}</div>`).join('')
          : '<span class="empty-day">—</span>'}
      </div>`;
    grid.appendChild(col);
  });
}

function esc(s){
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
