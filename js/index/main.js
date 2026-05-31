import { initRouter } from '../router.js';
import {
  getConfig, fetchTeams, fetchBaseSlots, fetchExceptions, mergeSchedule,
  fetchRequests, createRequest, rejectRequest,
  createException, deleteException, fetchNotices,
  fetchContacts, createVacancyReport
} from '../schedule.js';
import { initTheme, toggleTheme } from '../utils/theme.js';
import { escapeHtml as esc } from '../utils/html.js';
import { DAYS, HOURS, GRAY, korSort, teamClr, timeStr, errMsg, getWeekDates, weekLabel } from '../utils/common.js';

window.toggleTheme = toggleTheme;

// ── GLOBAL TOAST (used by all SPA views) ─────────────────────────────
let _globalToastTimer;
window.toast = function(msg, type='') {
  let el = document.getElementById('toast');
  if(!el) return;
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.style.cssText = 'display:block;opacity:1;animation:none;';
  clearTimeout(_globalToastTimer);
  _globalToastTimer = setTimeout(() => { if(el) el.style.display='none'; }, 2800);
};

const fmtTime = ts => { if(!ts) return ''; const d=new Date(ts); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };

// ── STATE ─────────────────────────────────────────────────────────────
let weekOff=0, season='1학기';
let _rtChannel=null, _rtSupa=null, weekChangeSeq=0;
let teams=[], baseSlots=[], exceptions=[], requests=[], notices=[], contacts=[];
let merged=[];
let activeRound=null, activeEnsemble=null, activeSchoolRound=null;
let collapsed=new Set();
let mobileDayIdx=(new Date().getDay()+6)%7; // 모바일 선택 요일 (기본=오늘)
let _lastClaimTs=0, _lastAbsenceTs=0, _lastVacancyTs=0;
const isMobile=()=>window.innerWidth<=700;

async function init(){
  initTheme();
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') window.closeModal?.(); });
  season = await getConfig('current_season').catch(()=>'1학기');
  await loadAll();
  showStatus();
  setInterval(()=>{ if(weekOff===0) updateNowLine(); },60000);
}

async function loadAll(){
  const ldEl = document.getElementById('ld');
  ldEl.style.display='flex';
  try{
    const [t,bs,ex,rq,nt,ct,roundRes,ensRes,schoolRes] = await Promise.all([
      fetchTeams(), fetchBaseSlots(season), fetchExceptions(weekOff),
      fetchRequests(weekOff), fetchNotices(), fetchContacts(),
      import('../supabase.js').then(({supabase})=>supabase.from('application_rounds').select('*').in('status',['open','closed']).order('created_at',{ascending:false}).limit(1).maybeSingle()),
      import('../supabase.js').then(({supabase})=>supabase.from('ensemble_rounds').select('*').not('phase','eq','closed').order('created_at',{ascending:false}).limit(1).maybeSingle()),
      import('../supabase.js').then(({supabase})=>supabase.from('school_rounds').select('*').in('status',['draft','open']).order('created_at',{ascending:false}).limit(1).maybeSingle())
    ]);
    [teams,baseSlots,exceptions,requests,notices,contacts]=[t,bs,ex,rq,nt,ct];
    activeRound=roundRes.data||null;
    activeEnsemble=ensRes.data||null;
    activeSchoolRound=schoolRes.data||null;
    teams=korSort(teams,'name');
    merged=mergeSchedule(baseSlots,exceptions);
    ldEl.style.display='none';
    render();
    // realtime — remove stale subscription before (re)creating
    import('../supabase.js').then(({supabase})=>{
      if(_rtChannel) _rtSupa?.removeChannel(_rtChannel);
      _rtSupa=supabase;
      _rtChannel=supabase.channel('rt')
        .on('postgres_changes',{event:'*',schema:'public',table:'base_slots'},async()=>{
          baseSlots=await fetchBaseSlots(season); merged=mergeSchedule(baseSlots,exceptions); renderSchedule();
        })
        .on('postgres_changes',{event:'*',schema:'public',table:'slot_exceptions'},async()=>{
          exceptions=await fetchExceptions(weekOff); merged=mergeSchedule(baseSlots,exceptions); renderSchedule();
        })
        .on('postgres_changes',{event:'*',schema:'public',table:'requests'},async()=>{
          requests=await fetchRequests(weekOff); renderStats();
        })
        .subscribe();
    });
  } catch(e){
    ldEl.innerHTML=`
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <div style="font-size:14px;color:var(--danger)">데이터를 불러오지 못했습니다</div>
        <div style="font-size:12px;color:var(--text2)">${e.message||'네트워크 오류'}</div>
        <button class="btn btn-p" onclick="loadAll()">다시 시도</button>
      </div>`;
  }
}

window.loadAll=loadAll;

// ── PAGE SWITCH ───────────────────────────────────────────────────────
function showPage(pg){
  document.getElementById('pgSchedule')?.classList.toggle('active',pg==='schedule');
  document.getElementById('weekNavEl').style.display = pg==='schedule'?'':'none';
  const teamPanel=document.getElementById('mobileTeamPanel');
  if(pg==='teams'){ teamPanel.classList.add('active'); renderMobileTeams(); }
  else teamPanel.classList.remove('active');
}
window._showSchedulePage = showPage;

// ── RENDER ────────────────────────────────────────────────────────────
function render(){
  const wl=weekLabel(weekOff);
  document.getElementById('weekLbl').textContent=wl;
  document.getElementById('seasonChip').textContent=season;
  document.getElementById('schTitle').innerHTML=`${wl} 시간표 `+(weekOff===0?`<span class="week-now-badge">이번주</span>`:`<span class="week-goto-badge" onclick="goToThisWeek()">이번주로 이동 →</span>`);
  document.getElementById('schSeason').textContent=season;
  renderTeams();
  renderNotice();
  renderStats();
  renderSchedule();
}

function teamListHTML(){
  const groups=[{k:'합주'},{k:'스쿨'},{k:'이외'}];
  return groups.map(g=>{
    let list=korSort(teams.filter(t=>t.type===g.k),'name');
    if(!list.length) return '';
    const open=!collapsed.has(g.k);
    return `<div>
      <div class="tg-label" onclick="toggleGroup('${g.k}')">
        <span>${g.k} <span style="color:var(--text3);font-weight:400">(${list.length})</span></span>
        <span class="tg-arrow ${open?'open':''}">›</span>
      </div>
      <div style="display:${open?'flex':'none'};flex-direction:column;gap:0">
        ${list.map(t=>`<div class="t-item">
          <div class="t-dot" style="background:${teamClr(t)}"></div>
          <div style="flex:1;min-width:0">
            <div class="t-name">${esc(t.name)}</div>
            ${t.info?`<div class="t-info">${esc(t.info)}</div>`:''}
            ${t.members&&t.members.length?`<div class="t-members">${t.members.map(m=>`<div class="t-member">${esc(m.name)}(${esc(m.student_id_last3)}) ${esc(m.sessions.join('·'))}</div>`).join('')}</div>`:''}
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderTeams(){
  const html=teamListHTML();
  document.getElementById('teamListEl').innerHTML=html;
}

function renderMobileTeams(){
  document.getElementById('mobileTeamListEl').innerHTML=teamListHTML();
}

window.toggleGroup=function(k){
  collapsed.has(k)?collapsed.delete(k):collapsed.add(k);
  renderTeams();
};

function renderNotice(){
  const el=document.getElementById('noticeBarEl');
  if(!notices.length){ el.innerHTML=''; return; }
  el.innerHTML=`<div class="notice-bar">
    <span class="notice-bar-icon">📢</span>
    <div class="notice-bar-text">${notices.map(n=>esc(n.content)).join(' &nbsp;·&nbsp; ')}</div>
  </div>`;
}

function renderStats(){
  const absent=merged.filter(s=>s.status==='absent').length;
  const extra=exceptions.filter(e=>e.exception_type==='extra').length;
  const pend=requests.filter(r=>r.status==='pending').length;
  document.getElementById('statsEl').innerHTML=`
    <button class="stat stat-btn" onclick="openTeamAbsentModal()"><div style="font-size:18px">🙏</div><div style="font-size:12px;font-weight:700;color:var(--accent2)">미사용 보고하기</div></button>
    <button class="stat stat-btn" onclick="openVacancyReportModal()"><div style="font-size:18px">🚨</div><div style="font-size:12px;font-weight:700;color:var(--danger)">시간표 불일치 신고</div></button>
    <div class="stat"><div class="stat-ico">🔕</div><div class="stat-txt"><div class="stat-lbl">이번 주 미사용</div><div class="stat-val" style="color:var(--danger)">${absent}</div></div></div>
    <div class="stat"><div class="stat-ico">➕</div><div class="stat-txt"><div class="stat-lbl">이번 주 추가</div><div class="stat-val" style="color:var(--accent2)">${extra}</div></div></div>`;
}

function renderSchedule(){
  const todayDow=(new Date().getDay()+6)%7;
  const nowH=new Date().getHours(), nowM=new Date().getMinutes();
  const isNow=weekOff===0;
  const mobile=isMobile();

  const wdates=getWeekDates(weekOff);

  // 요일 탭바 (모바일)
  const dayTabBar=document.getElementById('dayTabBar');
  if(dayTabBar){
    if(mobile){
      dayTabBar.innerHTML=DAYS.map((d,i)=>`
        <button class="day-tab${i===mobileDayIdx?' active':''}${isNow&&i===todayDow?' has-today':''}"
          onclick="selectMobileDay(${i})">${d}<br><span style="font-size:9px;font-weight:400">${wdates[i]}${isNow&&i===todayDow?' · 오늘':''}</span></button>`).join('');
    } else {
      dayTabBar.innerHTML='';
    }
  }
  document.getElementById('schHdr').innerHTML='<div class="sch-day"></div>'+
    DAYS.map((d,i)=>`<div class="sch-day${isNow&&i===todayDow?' today':''}">${d}<br><span class="sch-day-date">${wdates[i]}</span></div>`).join('');
  document.getElementById('schTimes').innerHTML=HOURS.map(h=>
    `<div class="sch-time"><span>${timeStr(h)}</span>${h>=24?`<span class="sch-time-next">익일</span>`:''}</div>`).join('');
  const grid=document.getElementById('schGrid');
  grid.innerHTML='';
  const mm=new Map(merged.map(s=>[`${s.day}-${s.hour}`,s]));
  const pm=new Map(requests.filter(r=>r.type==='extra'&&r.status==='pending').map(r=>[`${r.day}-${r.hour}`,r]));
  for(let d=0;d<7;d++){
    const col=document.createElement('div');
    // 모바일: 선택된 요일만 표시
    col.className='sch-col'
      +(isNow&&d===todayDow?' today':'')
      +(mobile?(d===mobileDayIdx?' mobile-active':''):'');
    if(isNow&&d===todayDow&&nowH>=HOURS[0]&&nowH<=HOURS[HOURS.length-1]){
      const slotH=mobile?64:62;
      const line=document.createElement('div'); line.className='now-line';
      line.style.top=((nowH-HOURS[0])*slotH+(nowM/60)*slotH)+'px';
      col.appendChild(line);
    }
    for(const h of HOURS){
      const cell=document.createElement('div'); cell.className='sch-slot';
      const s=mm.get(`${d}-${h}`), pe=pm.get(`${d}-${h}`);
      if(s){
        const t=s.teams, absent=s.status==='absent', isExtra=s.source==='extra';
        const c=teamClr(t);
        const blk=document.createElement('div');
        blk.className=`blk${absent?' absent':''}${isExtra?' extra':''}`;
        if(absent){
          blk.style.cssText=`background:repeating-linear-gradient(45deg,${c}18,${c}18 3px,transparent 3px,transparent 9px);border:1.5px dashed ${c}55;`;
          blk.innerHTML=`<div class="blk-top"><span class="blk-name" style="color:${c}88">${esc(t.name)}</span><span class="blk-tag" style="color:${c}88">미사용</span></div><div class="blk-bot"><span class="blk-info" style="color:${c}66">${esc(t.info||'')}</span></div>`;
        } else {
          blk.style.background=c;
          if(isExtra) blk.style.borderLeft='4px solid var(--accent2)';
          const tagStyle=isExtra?'background:var(--accent2);color:#000':'color:#000';
          blk.innerHTML=`<div class="blk-top"><span class="blk-name" style="color:#000">${esc(t.name)}</span><span class="blk-tag" style="${tagStyle}">${isExtra?'추가':esc(t.type)}</span></div><div class="blk-div"></div><div class="blk-bot"><span class="blk-info" style="color:#000">${esc(t.info||'')}</span></div>`;
        }
        blk.onclick=()=>openSlotModal(s);
        cell.appendChild(blk);
      } else if(pe){
        const t=pe.teams, c=teamClr(t);
        const blk=document.createElement('div');
        blk.className='blk pending';
        blk.style.cssText=`background:${c}20;border:1.5px dashed ${c}77;`;
        blk.innerHTML=`<div class="blk-top"><span class="blk-name" style="color:${c}">${esc(t.name)}</span><span class="blk-tag" style="color:${c}">대기</span></div><div class="blk-bot"><span class="blk-info" style="color:${c}99">${esc(t.info||'')}</span></div>`;
        blk.onclick=()=>openReqDetail(pe);
        cell.appendChild(blk);
      } else {
        const ind=document.createElement('div'); ind.className='blk-empty';
        ind.textContent='신청';
        ind.onclick=()=>openClaimModal(d,h);
        cell.appendChild(ind);
      }
      col.appendChild(cell);
    }
    grid.appendChild(col);
  }
}

window.selectMobileDay=function(idx){
  mobileDayIdx=idx;
  // 탭 active 상태만 변경
  document.querySelectorAll('.day-tab').forEach((btn,i)=>btn.classList.toggle('active',i===idx));
  // 컬럼 표시 전환
  document.querySelectorAll('.sch-col').forEach((col,i)=>col.classList.toggle('mobile-active',i===idx));
};

// 현재 시각 라인만 갱신 (전체 재렌더 없이)
function updateNowLine(){
  const nowH=new Date().getHours(), nowM=new Date().getMinutes();
  const slotH=isMobile()?64:62;
  const line=document.querySelector('.now-line');
  if(line) line.style.top=((nowH-HOURS[0])*slotH+(nowM/60)*slotH)+'px';
}

// ── WEEK NAV ─────────────────────────────────────────────────────────
window.changeWeek=async function(delta){
  weekOff+=delta;
  const seq=++weekChangeSeq;
  const [ex,rq]=await Promise.all([fetchExceptions(weekOff),fetchRequests(weekOff)]);
  if(seq!==weekChangeSeq) return;
  [exceptions,requests]=[ex,rq];
  merged=mergeSchedule(baseSlots,exceptions); render();
};
window.goToThisWeek=async function(){
  weekOff=0;
  const seq=++weekChangeSeq;
  const [ex,rq]=await Promise.all([fetchExceptions(0),fetchRequests(0)]);
  if(seq!==weekChangeSeq) return;
  [exceptions,requests]=[ex,rq];
  merged=mergeSchedule(baseSlots,exceptions); render();
};

// ── SLOT MODAL ───────────────────────────────────────────────────────
function openSlotModal(s){
  const t=s.teams, absent=s.status==='absent', isExtra=s.source==='extra', c=teamClr(t);
  let foot;
  if(!absent&&s.source==='base'){
    if(t.type==='스쿨'){
      foot=`<button class="btn btn-s" onclick="closeModal()">닫기</button>
            <button class="btn btn-s" onclick="openSchoolHolidayModal(${s.id},${s.day},${s.hour},${s.team_id})">이번주 휴강</button>
            <button class="btn btn-d" onclick="openAbsenceModal(${s.id},${s.day},${s.hour},${s.team_id},'종강 신고')">종강 신고</button>`;
    } else {
      foot=`<button class="btn btn-s" onclick="closeModal()">닫기</button>
            <button class="btn btn-d" onclick="openAbsenceModal(${s.id},${s.day},${s.hour},${s.team_id})">미사용 보고</button>`;
    }
  } else {
    foot=`<button class="btn btn-s" onclick="closeModal()">닫기</button>`;
  }
  showModal(`${esc(t.name)} · ${DAYS[s.day]} ${s.hour}:00`,
    `<div class="irow"><span class="ik">팀</span><span style="color:${c};font-weight:700">${esc(t.name)}</span></div>
     <div class="irow"><span class="ik">시간</span><span>${DAYS[s.day]} ${s.hour}:00</span></div>
     <div class="irow"><span class="ik">종류</span><span>${isExtra?'추가 사용 (이번 주)':'기본 시간표'}</span></div>
     <div class="irow"><span class="ik">상태</span><span>${absent?'⛔ 이번 주 미사용':'✅ 정상'}</span></div>
     ${t.info?`<div class="irow"><span class="ik">${t.type==='스쿨'?'선생님':'정보'}</span><span>${esc(t.info)}</span></div>`:''}`,
    foot
  );
}

window.openAbsenceModal=function(slotId,day,hour,teamId,label){
  const t=teams.find(t=>t.id===teamId);
  const modalLabel=label||'미사용 보고';
  const isSchool=t?.type==='스쿨';
  if(isSchool){
    // 종강 신고: 이미 대기 중인 신청이 있는지 확인
    const existing=requests.find(r=>r.status==='pending'&&r.type==='absent'&&r.team_id===teamId&&r.day===day&&r.hour===hour&&r.week_offset===weekOff);
    if(existing){
      showModal(modalLabel,
        `<div class="irow"><span class="ik">팀</span><span style="font-weight:700">${esc(t.name)}</span></div>
         <div class="irow"><span class="ik">상태</span><span style="color:var(--warn)">승인 대기 중</span></div>
         <div class="irow"><span class="ik">사유</span><span>${esc(existing.reason)}</span></div>`,
        `<button class="btn btn-s" onclick="closeModal()">닫기</button>
         <button class="btn btn-d" id="cancelBtn" onclick="cancelRequest(${existing.id})">신고 취소</button>`
      );
      return;
    }
  }
  showModal(modalLabel,
    `<div class="irow"><span class="ik">팀</span><span style="font-weight:700">${esc(t.name)}</span></div>
     <div class="irow"><span class="ik">시간</span><span>${DAYS[day]} ${hour}:00</span></div>
     <div><div class="fl">신청자 성명</div><input class="fi" id="absName" placeholder="성명" maxlength="20"/></div>
     <div><div class="fl">사유</div><input class="fi" id="absReason" placeholder="${isSchool?'예: 학기가 끝났습니다':'예: 팀원 시험 기간'}" maxlength="100"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-d" id="absBtn" onclick="submitAbsence(${teamId},${day},${hour})">신고 제출</button>`
  );
}
window.submitAbsence=async function(teamId,day,hour){
  const reason=document.getElementById('absReason').value.trim();
  if(!reason){toast('사유를 입력해주세요','err');return;}
  const _now=Date.now();
  if(_now-_lastAbsenceTs<3000){toast('잠시 후 다시 시도해주세요','err');return;}
  _lastAbsenceTs=_now;
  const btn=document.getElementById('absBtn'); btn.disabled=true; btn.textContent='제출 중...';
  const t=teams.find(t=>t.id===teamId);
  try{
    if(t?.type==='스쿨'){
      // 종강 신고: 관리자 승인 필요
      await createRequest({type:'absent',team_id:teamId,day,hour,week_offset:weekOff,reason,requester_name:document.getElementById('absName').value.trim()});
      closeModal(); toast('종강 신고가 제출됐습니다. 관리자 승인을 기다려주세요');
      requests=await fetchRequests(weekOff); renderStats();
    } else {
      // 합주/이외: 승인 없이 바로 처리
      await createException({team_id:teamId,day,hour,week_offset:weekOff,exception_type:'absent'});
      exceptions=await fetchExceptions(weekOff);
      merged=mergeSchedule(baseSlots,exceptions);
      closeModal(); toast('미사용 보고가 완료됐습니다');
      renderStats(); renderSchedule();
    }
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;btn.textContent='신고 제출';}
};

window.openSchoolHolidayModal=function(slotId,day,hour,teamId){
  const t=teams.find(t=>t.id===teamId);
  showModal('이번주 휴강',
    `<div class="irow"><span class="ik">팀</span><span style="font-weight:700">${esc(t.name)}</span></div>
     <div class="irow"><span class="ik">시간</span><span>${DAYS[day]} ${hour}:00</span></div>
     <div><div class="fl">신청자 성명</div><input class="fi" id="shName" placeholder="성명" maxlength="20"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="shBtn" onclick="submitSchoolHoliday(${teamId},${day},${hour})">휴강 신고</button>`
  );
};
window.submitSchoolHoliday=async function(teamId,day,hour){
  const btn=document.getElementById('shBtn'); btn.disabled=true; btn.textContent='제출 중...';
  try{
    await createException({team_id:teamId,day,hour,week_offset:weekOff,exception_type:'absent'});
    exceptions=await fetchExceptions(weekOff);
    merged=mergeSchedule(baseSlots,exceptions);
    closeModal(); toast('이번주 휴강이 신고됐습니다');
    renderStats(); renderSchedule();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;btn.textContent='휴강 신고';}
};

window.openTeamAbsentModal=function(){
  const teamsWithSlots=korSort(teams.filter(t=>
    merged.some(s=>s.team_id===t.id&&s.status!=='absent'&&s.source==='base')
  ),'name');
  if(!teamsWithSlots.length){toast('이번 주에 신고 가능한 팀이 없습니다','err');return;}
  const teamOpts=teamsWithSlots.map(t=>`<option value="${t.id}">${esc(t.name)} (${esc(t.type)})</option>`).join('');
  showModal('동방 미사용 보고',
    `<div><div class="fl">팀 선택 *</div><select class="fs" id="taTeam" onchange="onTeamAbsentTeamChange()">${teamOpts}</select></div>
     <div id="taSlotWrap" style="margin-top:4px"></div>
     <div><div class="fl">사유 (선택)</div><input class="fi" id="taReason" placeholder="예: 이번 주 쉽니다" maxlength="100"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-d" id="taBtn" onclick="submitTeamAbsent()">미사용 보고</button>`
  );
  window.onTeamAbsentTeamChange();
};
window.onTeamAbsentTeamChange=function(){
  const teamId=parseInt(document.getElementById('taTeam').value);
  const slots=merged.filter(s=>s.team_id===teamId&&s.status!=='absent'&&s.source==='base');
  const wrap=document.getElementById('taSlotWrap');
  if(!slots.length){
    wrap.innerHTML='<div style="color:var(--text3);font-size:12px;padding:4px 0">이번 주 사용 예정 슬롯이 없습니다.</div>';
    return;
  }
  if(slots.length===1){
    wrap.innerHTML=`<div class="irow" style="padding:7px 0"><span class="ik">슬롯</span><span>${DAYS[slots[0].day]} ${slots[0].hour}:00</span></div><input type="hidden" id="taSlot" value="${slots[0].day}-${slots[0].hour}"/>`;
  } else {
    const opts=slots.map(s=>`<option value="${s.day}-${s.hour}">${DAYS[s.day]} ${s.hour}:00</option>`).join('');
    wrap.innerHTML=`<div><div class="fl">슬롯 선택 *</div><select class="fs" id="taSlot">${opts}</select></div>`;
  }
};
window.submitTeamAbsent=async function(){
  const teamId=parseInt(document.getElementById('taTeam').value);
  const slotEl=document.getElementById('taSlot');
  if(!slotEl){toast('슬롯을 선택해주세요','err');return;}
  const [day,hour]=slotEl.value.split('-').map(Number);
  const btn=document.getElementById('taBtn'); btn.disabled=true; btn.textContent='제출 중...';
  try{
    await createException({team_id:teamId,day,hour,week_offset:weekOff,exception_type:'absent'});
    exceptions=await fetchExceptions(weekOff);
    merged=mergeSchedule(baseSlots,exceptions);
    closeModal(); toast('미사용 보고가 완료됐습니다');
    renderStats(); renderSchedule();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;btn.textContent='미사용 보고';}
};

window.openVacancyReportModal=function(){
  const now=new Date();
  showModal('시간표 불일치 신고',
    `<div style="font-size:13px;color:var(--text2);margin-bottom:12px;line-height:1.5">시간표에 사용 중으로 표시된 팀이 동방을 비워뒀던 경우에 신고해주세요.</div>
     <div style="font-size:13px;margin-bottom:10px;color:var(--text)">발생 일시를 입력해주세요.</div>
     <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">
       <div><div class="fl">월</div><input class="fi" id="vrMonth" type="number" min="1" max="12" value="${now.getMonth()+1}"/></div>
       <div><div class="fl">일</div><input class="fi" id="vrDay" type="number" min="1" max="31" value="${now.getDate()}"/></div>
       <div><div class="fl">시</div><input class="fi" id="vrHour" type="number" min="0" max="23" value="${now.getHours()}"/></div>
       <div><div class="fl">분</div><input class="fi" id="vrMinute" type="number" min="0" max="59" value="${now.getMinutes()}"/></div>
     </div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-d" id="vrBtn" onclick="submitVacancyReport()">신고 제출</button>`
  );
};
window.submitVacancyReport=async function(){
  const _now=Date.now();
  if(_now-_lastVacancyTs<5000){toast('잠시 후 다시 시도해주세요','err');return;}
  _lastVacancyTs=_now;
  const mo=parseInt(document.getElementById('vrMonth').value);
  const d=parseInt(document.getElementById('vrDay').value);
  const hh=parseInt(document.getElementById('vrHour').value);
  const mm=parseInt(document.getElementById('vrMinute').value);
  if(!mo||!d||isNaN(hh)||isNaN(mm)){toast('모든 항목을 입력해주세요','err');return;}
  const btn=document.getElementById('vrBtn'); btn.disabled=true; btn.textContent='제출 중...';
  try{
    await createVacancyReport({incident_month:mo,incident_day:d,incident_hour:hh,incident_minute:mm});
    closeModal(); toast('신고 접수 완료');
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;btn.textContent='신고 제출';}
};

function openClaimModal(day,hour){
  const opts=korSort(teams,'name').map(t=>`<option value="${t.id}">${esc(t.name)} (${esc(t.type)})</option>`).join('');
  showModal(`추가 사용 신청 · ${DAYS[day]} ${hour}:00`,
    `<div style="background:rgba(255,170,71,.1);border:1px solid rgba(255,170,71,.3);border-radius:6px;padding:10px 12px;font-size:13px;color:var(--warn);line-height:1.5;">
       ⚠️ 합주는 <strong>1주 1회</strong>가 원칙입니다.<br>추가 합주 신청 전, 기존 배정 시간에 <strong>미사용 보고</strong>를 먼저 해주세요.
     </div>
     <div><div class="fl">팀 선택</div><select class="fs" id="clTeam">${opts}</select></div>
     <div><div class="fl">신청자 성명</div><input class="fi" id="clName" placeholder="성명" maxlength="20"/></div>
     <div><div class="fl">사유</div><input class="fi" id="clReason" placeholder="예: 이번주 합주 시간 변경" maxlength="100"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="clBtn" onclick="submitClaim(${day},${hour})">신청 제출</button>`
  );
}

window.cancelRequest=async function(reqId){
  const btn=document.getElementById('cancelBtn'); btn.disabled=true; btn.textContent='취소 중...';
  try{
    const {supabase}=await import('../supabase.js');
    // Only delete if still pending — prevents TOCTOU race on approved requests
    await supabase.from('requests').delete().eq('id',reqId).eq('status','pending');
    requests=requests.filter(r=>r.id!==reqId);
    closeModal(); toast('신청이 취소됐습니다'); renderStats(); renderSchedule();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;btn.textContent='신고 취소';}
};
window.submitClaim=async function(day,hour){
  const reason=document.getElementById('clReason').value.trim();
  if(!reason){toast('사유를 입력해주세요','err');return;}
  const _now=Date.now();
  if(_now-_lastClaimTs<3000){toast('잠시 후 다시 시도해주세요','err');return;}
  _lastClaimTs=_now;
  const btn=document.getElementById('clBtn'); btn.disabled=true; btn.textContent='제출 중...';
  try{
    await createRequest({type:'extra',team_id:parseInt(document.getElementById('clTeam').value),day,hour,week_offset:weekOff,reason,requester_name:document.getElementById('clName').value.trim()});
    closeModal(); toast('추가 사용 신청이 제출됐습니다');
    requests=await fetchRequests(weekOff); renderStats();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;btn.textContent='신청 제출';}
};

function openReqDetail(req){
  const t=req.teams;
  showModal('추가 사용 신청 대기 중',
    `<div class="irow"><span class="ik">팀</span><span style="font-weight:700">${esc(t.name)}</span></div>
     <div class="irow"><span class="ik">시간</span><span>${DAYS[req.day]} ${req.hour}:00</span></div>
     <div class="irow"><span class="ik">사유</span><span>${esc(req.reason)}</span></div>
     <div class="irow"><span class="ik">신청자</span><span>${esc(req.requester_name||'미기입')}</span></div>
     <div class="irow"><span class="ik">제출 시각</span><span style="color:var(--text2)">${fmtTime(req.created_at)}</span></div>
     <div class="irow"><span class="ik">상태</span><span style="color:var(--warn)">관리자 승인 대기 중</span></div>`,
    `<button class="btn btn-s" onclick="closeModal()">닫기</button>
     <button class="btn btn-d" id="cancelBtn" onclick="cancelRequest(${req.id})">신청 취소</button>`
  );
}

// ── CONTACTS MODAL ────────────────────────────────────────────────────
window.openContactsModal=async function(){
  let ct=contacts;
  if(!ct.length){
    showModal('회장단 연락처','<div style="color:var(--text2);font-size:13px;padding:8px 0">등록된 연락처가 없습니다.</div>','<button class="btn btn-s" onclick="closeModal()">닫기</button>');
    return;
  }
  showModal('📞 연락처',
    ct.map(c=>`
      <div class="irow">
        <span class="ik">${esc(c.role)}</span>
        <span style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">
          <span style="font-weight:600">${esc(c.name)}</span>
          ${c.phone?`<span style="font-size:11px;color:var(--text2)">${esc(c.phone)}</span>`:''}
        </span>
      </div>`).join(''),
    `<button class="btn btn-s" onclick="closeModal()">닫기</button>`
  );
};

// ── MODAL ─────────────────────────────────────────────────────────────
function showModal(title,body,foot){
  document.getElementById('modalTtl').textContent=title;
  document.getElementById('modalBody').innerHTML=body;
  document.getElementById('modalFoot').innerHTML=foot;
  // transform 초기화 (이전 스와이프 잔여 상태 제거)
  const modal=document.querySelector('#modalBd .modal');
  if(modal){ modal.style.transform=''; modal.style.transition=''; }
  document.getElementById('modalBd').style.display='flex';
  document.body.style.overflow='hidden';
  if(isMobile()) initSwipeToClose();
}
window.closeModal=()=>{
  document.getElementById('modalBd').style.display='none';
  document.body.style.overflow='';
};

function initSwipeToClose(){
  const modal=document.querySelector('#modalBd .modal');
  if(!modal||modal._swipeInit) return; // 중복 등록 방지
  modal._swipeInit=true;
  let startY=0, isDragging=false;
  modal.addEventListener('touchstart',e=>{
    if(document.getElementById('modalBd').style.display==='none') return;
    startY=e.touches[0].clientY; isDragging=true;
    modal.style.transition='none';
  },{passive:true});
  modal.addEventListener('touchmove',e=>{
    if(!isDragging) return;
    const dy=e.touches[0].clientY-startY;
    if(dy>0) modal.style.transform=`translateY(${dy}px)`;
  },{passive:true});
  modal.addEventListener('touchend',e=>{
    if(!isDragging) return; isDragging=false;
    const dy=e.changedTouches[0].clientY-startY;
    modal.style.transition='transform .2s';
    if(dy>100){ modal.style.transform=`translateY(100%)`; setTimeout(closeModal,200); }
    else { modal.style.transform=''; }
  });
}
window.onMBd=e=>{ if(e.target===document.getElementById('modalBd')) closeModal(); };

// ── STATUS POPUP ──────────────────────────────────────────────────────
function showStatus(){
  const suppressed = localStorage.getItem('statusSuppressUntil');
  if(suppressed && Date.now() < parseInt(suppressed)) return;
  const now = new Date();
  const dow = (now.getDay()+6)%7; // 0=월
  const h   = now.getHours();
  // 현재 시간에 해당하는 슬롯 찾기 (정각 기준, 1시간 블록)
  const slot = merged.find(s => s.day===dow && s.hour===h && s.status!=='absent');
  const el = document.getElementById('statusMain');
  const bd = document.getElementById('statusBd');
  if(!el||!bd) return;

  // 신청 알림 배너
  const notifs=[];
  if(activeRound){
    const isOpen=activeRound.status==='open'&&(!activeRound.open_at||new Date(activeRound.open_at)<=now);
    if(isOpen){
      notifs.push(`<div class="notif-item"><span class="notif-txt">⏱ 시간 신청 진행 중</span><button class="btn btn-s" style="font-size:11px;padding:4px 10px;white-space:nowrap;min-width:fit-content" onclick="closeStatus();navigate('timeassign')">이동</button></div>`);
    }
  }
  if(activeSchoolRound){
    const label=activeSchoolRound.status==='draft'?'스쿨 신청 준비 중':'스쿨 신청 진행 중';
    notifs.push(`<div class="notif-item"><span class="notif-txt">🏫 ${label}</span><button class="btn btn-s" style="font-size:11px;padding:4px 10px;" onclick="closeStatus();navigate('school')">이동</button></div>`);
  }
  if(activeEnsemble){
    const phase=activeEnsemble.phase;
    const isSongSched=phase==='draft'&&activeEnsemble.song_scheduled_at&&new Date(activeEnsemble.song_scheduled_at)>now;
    const isSessSched=phase==='song'&&activeEnsemble.session_scheduled_at&&new Date(activeEnsemble.session_scheduled_at)>now;
    if(phase==='song'||phase==='session'||isSongSched||isSessSched){
      const label=isSongSched?'합주 곡 신청 예약됨':isSessSched?'합주 세션 신청 예약됨':phase==='song'?'합주 곡 신청 진행 중':'합주 세션 신청 진행 중';
      notifs.push(`<div class="notif-item"><span class="notif-txt">🎵 ${label}</span><button class="btn btn-s" style="font-size:11px;padding:4px 10px;white-space:nowrap;min-width:fit-content" onclick="closeStatus();navigate('ensemble')">이동</button></div>`);
    }
  }
  const notifBar=notifs.length?`<div class="notif-bar">${notifs.join('')}</div>`:'';

  if(slot){
    const t = slot.teams;
    const c = teamClr(t);
    el.innerHTML=notifBar+`
      <div style="width:52px;height:52px;border-radius:50%;background:${c}22;border:2px solid ${c};display:flex;align-items:center;justify-content:center;font-size:22px">🎸</div>
      <div>
        <div class="status-label busy">현재 동아리방 사용 중</div>
        <div class="status-team" style="color:${c}">${esc(t.name)}</div>
        ${t.info?`<div class="status-sub">${esc(t.info)}</div>`:''}
        <div class="status-sub" style="margin-top:4px">${['월','화','수','목','금','토','일'][dow]} ${h}:00 — ${h+1}:00</div>
      </div>`;
  } else {
    el.innerHTML=notifBar+`
      <div style="width:52px;height:52px;border-radius:50%;background:rgba(232,255,71,.1);border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:22px">✅</div>
      <div>
        <div class="status-label empty">현재 동아리방 비어 있음</div>
        <div class="status-team">사용 가능</div>
        <div class="status-sub" style="margin-top:4px">${['월','화','수','목','금','토','일'][dow]} ${h}:00 기준</div>
      </div>`;
  }
  bd.style.display='flex';
  document.body.style.overflow='hidden';
}
window.closeStatus=function(){
  const chk = document.getElementById('statusSuppressChk');
  if(chk?.checked) localStorage.setItem('statusSuppressUntil', Date.now() + 1800000);
  document.getElementById('statusBd').style.display='none';
  document.body.style.overflow='';
};

function toast(msg,type=''){ window.toast(msg,type); }

init();
initRouter();
