import { supabase } from '../supabase.js';
import {
  getConfig, fetchTeams, fetchBaseSlots, fetchExceptions, mergeSchedule,
  fetchActiveRound, fetchApplications, submitApplication
} from '../schedule.js';
import { initTheme, toggleTheme } from '../utils/theme.js';
import { diffToHMS } from '../utils/time.js';

const DAYS  = ['월','화','수','목','금','토','일'];
const HOURS = Array.from({length:18},(_,i)=>i+8);
const GRAY  = '#888888';
const korSort = (a,k) => [...a].sort((x,y)=>x[k].localeCompare(y[k],'ko-KR',{numeric:true}));
const teamClr = t => t.type==='합주'?GRAY:(t.color||GRAY);
const timeStr = h => h<24?h+':00':'0'+(h-24)+':00';
const fmtTime = ts => {
  if(!ts) return '';
  const d=new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
};
const errMsg = e => {
  const m = e?.message||'';
  if(m.includes('unique')||m.includes('duplicate')) return '이미 해당 시간에 신청이 존재합니다';
  if(m.includes('network')||m.includes('fetch')) return '네트워크 오류가 발생했습니다. 다시 시도해주세요';
  return m || '오류가 발생했습니다';
};

// ── THEME ─────────────────────────────────────────────────────────────
initTheme();
window.toggleTheme = toggleTheme;

function fmtScheduled(ts){
  const d=new Date(ts),pad=n=>String(n).padStart(2,'0');
  return `${String(d.getFullYear()).slice(2)}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── STATE ─────────────────────────────────────────────────────────────
let season='1학기';
let teams=[], baseSlots=[], exceptions=[], merged=[];
let round=null, applications=[];
let applyPrefs={}, applyTeamId=null, applyTeamName='';
let taCountdownTimer=null;

// ── INIT ──────────────────────────────────────────────────────────────
async function init(){
  try{
    season = await getConfig('current_season').catch(()=>'1학기');
    [teams, baseSlots, exceptions] = await Promise.all([
      fetchTeams(), fetchBaseSlots(season), fetchExceptions(0)
    ]);
    teams=korSort(teams,'name');
    merged=mergeSchedule(baseSlots,exceptions);
    round=await fetchActiveRound(season);
    if(round) applications=await fetchApplications(round.id);
    document.getElementById('ld').style.display='none';
    render();

    // ── REALTIME ──────────────────────────────────────────────────────
    supabase.channel('ta-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'time_applications'},async()=>{
        if(round){
          applications=await fetchApplications(round.id);
          renderList();
        }
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'application_rounds'},async()=>{
        round=await fetchActiveRound(season);
        if(round) applications=await fetchApplications(round.id);
        render();
      })
      .subscribe();
  } catch(e){
    document.getElementById('ld').innerHTML=`
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <div style="font-size:14px;color:var(--danger)">데이터를 불러오지 못했습니다</div>
        <div style="font-size:12px;color:var(--text2)">${e.message||'네트워크 오류'}</div>
        <button class="btn btn-p" onclick="location.reload()">다시 시도</button>
      </div>`;
  }
}

// ── RENDER ────────────────────────────────────────────────────────────
function render(){
  // clear any existing countdown
  if(taCountdownTimer){ clearInterval(taCountdownTimer); taCountdownTimer=null; }

  const isScheduled=round&&round.status==='open'&&round.open_at&&new Date(round.open_at)>new Date();
  const isOpen=round&&round.status==='open'&&(!round.open_at||new Date(round.open_at)<=new Date());
  const isFin=round&&(round.status==='finished'||round.draft_approved);
  const teamOpts=korSort(teams,'name').map(t=>`<option value="${t.id}">${t.name}</option>`).join('');
  const occMap=new Map(merged.filter(s=>s.status!=='absent').map(s=>[`${s.day}-${s.hour}`,s.teams.name]));

  let html=`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <h2 style="font-size:15px;font-weight:700">📅 시간 배정 신청</h2>
      <span class="rt-badge"><span class="rt-dot"></span>실시간</span>
    </div>`;

  if(isScheduled){
    const targetDate=round.open_at;
    const diff=new Date(targetDate)-Date.now();
    html+=`<div class="apply-status closed">
      <div class="apply-status-icon">⏳</div>
      <div class="apply-status-texts">
        <div class="apply-status-title">신청 기간이 아닙니다</div>
        <div class="apply-status-sub">${fmtScheduled(targetDate)}에 신청이 열립니다</div>
        <div class="cd-num cd-open" id="ta-cd">${diffToHMS(diff)}</div>
      </div>
    </div>`;
    document.getElementById('applyContent').innerHTML=html;
    renderList();
    taCountdownTimer=setInterval(()=>{
      const d2=new Date(targetDate)-Date.now();
      const el=document.getElementById('ta-cd');
      if(el) el.textContent=diffToHMS(d2);
      if(d2<=0){
        clearInterval(taCountdownTimer); taCountdownTimer=null;
        render();
      }
    },1000);
    return;
  }

  const closeTs=isOpen&&round.close_at&&new Date(round.close_at)>new Date()?round.close_at:null;
  const closeDiff=closeTs?new Date(closeTs)-Date.now():0;
  html+=`<div class="apply-status ${isOpen?'open':isFin?'finished':'closed'}">
      <div class="apply-status-icon">${isOpen?'🟢':isFin?'🔵':'⭕'}</div>
      <div class="apply-status-texts">
        <div class="apply-status-title">${isOpen?'신청 진행 중':isFin?'신청 마감 — 배정 완료':'신청 기간이 아닙니다'}</div>
        ${closeTs?`<div class="apply-status-sub" style="color:var(--warn)">⏰ 마감: ${fmtScheduled(closeTs)}</div>`
          :isOpen&&round.close_at?''
          :!isOpen&&!isFin?`<div class="apply-status-sub">관리자가 신청을 열면 여기서 신청할 수 있습니다.</div>`:''}
        ${closeTs?`<div class="cd-num cd-close" id="ta-close-cd">${diffToHMS(closeDiff)}</div>`:''}
      </div>
    </div>`;
  if(closeTs){
    taCountdownTimer=setInterval(()=>{
      const d2=new Date(closeTs)-Date.now();
      const el=document.getElementById('ta-close-cd');
      if(el) el.textContent=diffToHMS(d2);
      if(d2<=0){ clearInterval(taCountdownTimer); taCountdownTimer=null; render(); }
    },1000);
  }

  if(isOpen){
    const p1=applyPrefs[1], p2=applyPrefs[2], p3=applyPrefs[3];

    function prefFormRow(n,cls,label,optional,p){
      const dayOptsN=`<option value="">요일 선택</option>${DAYS.map((d,i)=>`<option value="${i}" ${i===p?.day?'selected':''}>${d}</option>`).join('')}`;
      let hourOptsN=`<option value="">시간 선택</option>`;
      if(p){
        hourOptsN=`<option value="">시간 선택</option>${HOURS.map(h=>{
          const occ=occMap.get(`${p.day}-${h}`);
          return `<option value="${h}" ${h===p.hour?'selected':''}>${occ?timeStr(h)+' '+occ+'이(가) 사용 중':timeStr(h)}</option>`;
        }).join('')}`;
      }
      return `<div class="pref-form-row">
        <div class="pref-form-label ${cls}">${label}${optional?'':' *'}</div>
        <div class="pref-form-selects">
          <select class="fs" id="apD${n}" onchange="onApplyDayChange(${n})">${dayOptsN}</select>
          <select class="fs" id="apH${n}"${!p?' disabled':''}>${hourOptsN}</select>
        </div>
      </div>`;
    }

    html+=`
    <div class="apply-card">
      <div class="apply-card-title">시간 신청</div>
      <div style="margin-bottom:14px">
        <div class="fl">팀 선택 *</div>
        <div style="display:flex;gap:10px;align-items:center">
          <input class="fi" type="text" id="apTeamInput" placeholder="팀명 입력"
            oninput="onApplyTeamInput(this.value)"
            value="${applyTeamName}" style="width:160px;flex-shrink:0"/>
          <div id="apTeamInfo" style="font-size:12px;min-width:80px;flex-shrink:0">${(()=>{
            if(!applyTeamName) return '';
            const _t=teams.find(t=>normTeam(t.name)===normTeam(applyTeamName));
            return _t
              ? `<span style="color:var(--accent)">${_t.info||'—'}</span>`
              : `<span style="color:var(--danger)">없는 팀입니다. 팀명을 확인해주세요.</span>`;
          })()}</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
        ${prefFormRow(1,'p1-txt','1지망',false,p1)}
        ${prefFormRow(2,'p2-txt','2지망',true,p2)}
        ${prefFormRow(3,'p3-txt','3지망',true,p3)}
      </div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:12px">요일을 선택하면 시간 드롭다운에 현재 배정된 팀 정보가 함께 표시됩니다.</div>
      <div style="display:flex;justify-content:flex-end;">
        <button class="btn btn-p" onclick="submitApply()">신청 제출</button>
      </div>
    </div>`;
  }

  document.getElementById('applyContent').innerHTML=html;
  const sel=document.getElementById('apTeam');
  renderList();
}

function renderList(){
  const isFin=round&&(round.status==='finished'||round.draft_approved);
  const pc=p=>p===1?'p1':p===2?'p2':p===3?'p3':'none';
  const pl=p=>p?p+'지망':'미배정';

  const old=document.getElementById('taListCard');
  if(old) old.remove();

  if(!round||!applications.length) return;

  // applications is already sorted by submitted_at asc (fetchApplications uses .order('submitted_at'))
  // latest entry per team_id is valid; earlier entries are void
  const latestIdByTeam=new Map();
  for(const a of applications) latestIdByTeam.set(a.team_id,a.id);
  const isVoid=a=>latestIdByTeam.get(a.team_id)!==a.id;

  // count valid (non-void) entries
  const validCount=applications.filter(a=>!isVoid(a)).length;

  const div=document.createElement('div');
  div.id='taListCard';
  div.className='apply-card';
  div.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div class="apply-card-title" style="margin-bottom:0">${isFin?'배정 결과':'신청 현황'} (${validCount}팀)</div>
    </div>
    <div style="overflow-x:auto">
      <table class="apply-tbl">
        <thead><tr><th>#</th><th>팀</th><th>1지망</th><th>2지망</th><th>3지망</th>${isFin?'<th>결과</th>':''}<th>제출 시각</th></tr></thead>
        <tbody>
          ${applications.map((a,i)=>{
            const void_=isVoid(a);
            return `<tr style="${void_?'opacity:.32;':''}">
              <td style="color:var(--text3);font-family:'Space Mono',monospace">${String(i+1).padStart(2,'0')}</td>
              <td style="font-weight:600${void_?';text-decoration:line-through':''}">${a.teams.name}${void_?` <span class="pbadge none" style="font-size:9px">무효</span>`:''}</td>
              <td>${DAYS[a.pref1_day]} ${a.pref1_hour}:00</td>
              <td>${a.pref2_day!=null?DAYS[a.pref2_day]+' '+a.pref2_hour+':00':'—'}</td>
              <td>${a.pref3_day!=null?DAYS[a.pref3_day]+' '+a.pref3_hour+':00':'—'}</td>
              ${isFin?`<td>${!void_&&a.assigned_day!=null?`<span class="pbadge ${pc(a.assigned_pref)}">${pl(a.assigned_pref)}</span> ${DAYS[a.assigned_day]} ${a.assigned_hour}:00`:`<span class="pbadge none">${void_?'무효':'미배정'}</span>`}</td>`:''}
              <td style="font-size:11px;color:var(--text3);font-family:'Space Mono',monospace">${fmtTime(a.submitted_at)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  document.getElementById('applyContent').appendChild(div);
}

// ── INTERACTIONS ──────────────────────────────────────────────────────
const normTeam=s=>s.replace(/\s/g,'');
window.onApplyTeamInput=function(val){
  applyTeamName=val;
  const norm=normTeam(val);
  const infoEl=document.getElementById('apTeamInfo');
  if(!infoEl) return;
  if(!norm){ applyTeamId=null; infoEl.innerHTML=''; return; }
  const t=teams.find(t=>normTeam(t.name)===norm);
  if(t){
    applyTeamId=t.id;
    infoEl.innerHTML=`<span style="color:var(--accent)">${t.info||'—'}</span>`;
  } else {
    applyTeamId=null;
    infoEl.innerHTML=`<span style="color:var(--danger)">없는 팀입니다. 팀명을 확인해주세요.</span>`;
  }
};

window.onApplyDayChange=function(n){
  const dayEl=document.getElementById(`apD${n}`);
  const hourEl=document.getElementById(`apH${n}`);
  if(!dayEl||!hourEl) return;
  const dayVal=dayEl.value;
  if(!dayVal){
    hourEl.innerHTML='<option value="">시간 선택</option>';
    hourEl.disabled=true;
    return;
  }
  const d=parseInt(dayVal);
  const occMap=new Map(merged.filter(s=>s.status!=='absent').map(s=>[`${s.day}-${s.hour}`,s.teams.name]));
  hourEl.innerHTML=`<option value="">시간 선택</option>`+HOURS.map(h=>{
    const occ=occMap.get(`${d}-${h}`);
    return `<option value="${h}">${occ?timeStr(h)+' '+occ+'이(가) 사용 중':timeStr(h)}</option>`;
  }).join('');
  hourEl.disabled=false;
  if(applyPrefs[n]&&applyPrefs[n].day!==d) delete applyPrefs[n];
};

window.submitApply=async function(){
  const _sched=round&&round.status==='open'&&round.open_at&&new Date(round.open_at)>new Date();
  if(!round||round.status!=='open'||_sched){toast('현재 신청 기간이 아닙니다','err');return;}
  if(!applyTeamId){toast('팀을 선택해주세요','err');return;}
  const d1=document.getElementById('apD1')?.value;
  const h1=document.getElementById('apH1')?.value;
  if(!d1||!h1){toast('1지망 요일과 시간을 선택해주세요','err');return;}
  const d2=document.getElementById('apD2')?.value, h2=document.getElementById('apH2')?.value;
  const d3=document.getElementById('apD3')?.value, h3=document.getElementById('apH3')?.value;
  try{
    await submitApplication({round_id:round.id,team_id:applyTeamId,
      pref1_day:parseInt(d1),pref1_hour:parseInt(h1),
      pref2_day:d2&&h2?parseInt(d2):null,pref2_hour:d2&&h2?parseInt(h2):null,
      pref3_day:d3&&h3?parseInt(d3):null,pref3_hour:d3&&h3?parseInt(h3):null});
    applyPrefs={}; applyTeamId=null; applyTeamName='';
    toast('신청이 제출됐습니다','ok');
    // 최신 목록은 realtime이 자동으로 받아옴 — 폼만 리렌더
    render();
  }catch(e){toast(errMsg(e),'err');}
};

// ── TOAST ─────────────────────────────────────────────────────────────
let toastT;
function toast(msg,type=''){
  const el=document.getElementById('toast');
  el.className='toast'+(type?' '+type:'');
  el.textContent=msg; el.style.display='block';
  clearTimeout(toastT); toastT=setTimeout(()=>el.style.display='none',2800);
}

init();
