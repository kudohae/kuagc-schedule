import { supabase } from '../supabase.js';
import {
  getConfig, setConfig,
  fetchTeams, createTeam, updateTeam, deleteTeam,
  fetchBaseSlots, createBaseSlot, updateBaseSlot, deleteBaseSlot,
  fetchExceptions, createException, deleteException, mergeSchedule,
  fetchRequests, fetchAllPendingRequests, approveRequest, rejectRequest, approveTerminate,
  fetchNotices, createNotice, deleteNotice,
  fetchActiveRound, createRound, updateRound,
  fetchApplications, deleteApplication, runAssignment, approveDraft,
  fetchContacts, upsertContact, deleteContact,
  fetchVacancyReports, deleteVacancyReport
} from '../schedule.js';

import { initTheme, toggleTheme } from '../utils/theme.js';
import { escapeHtml as esc } from '../utils/html.js';
import { DAYS, HOURS, GRAY, korSort, teamClr, timeStr, errMsg, getWeekDates, weekLabel } from '../utils/common.js';
initTheme();
window.toggleTheme = toggleTheme;
document.addEventListener('keydown',e=>{ if(e.key==='Escape') window.closeModal?.(); });

const COLORS= ['#47c5ff','#ff6b6b','#6bffb8','#ffaa47','#c47fff','#ff47a0','#47ffea','#ffd447','#b4ff47','#ff9d47'];
const reqActualDate=(weekOffset,day)=>{const now=new Date(),mon=new Date(now);mon.setDate(now.getDate()-((now.getDay()+6)%7)+weekOffset*7);const d=new Date(mon);d.setDate(mon.getDate()+day);return `${d.getMonth()+1}/${d.getDate()}`;};
const fmtTime=ts=>{if(!ts)return'';const d=new Date(ts);return`${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;};
function weekLabelWithThis(off){
  return weekLabel(off)+(off===0?' (이번주)':'');
}

let weekOff=0, season='1학기';
let academicDates={summerStart:null,summerEnd:null,winterStart:null,winterEnd:null};
let seasonMode='auto';
let _adminInited=false, _adminChannels=[];
let _ensBroadcastCh=null, _taBcCh=null, _schoolBcCh=null;
let _applySchedTimer=null;
let _ensSchedTimers={regular:null,busking:null};
let mobileDayIdx=(new Date().getDay()+6)%7;
let teams=[], baseSlots=[], exceptions=[], requests=[], notices=[], contacts=[];
let pendingAll=[];
let selectedTeams=new Set();
let merged=[], round=null, applications=[];
let adminSchools=[], adminSchoolApps=[], adminSchoolRounds=[];
let schoolCdTimer=null;


// ── LOGIN ─────────────────────────────────────────────────────────────
function showAdminUI(){
  document.getElementById('loginWrap').style.display='none';
  document.getElementById('adminUI').style.display='block';
  document.getElementById('mobTabBar').style.display='';
  if(_adminInited) return;
  _adminInited=true;
  loadAll();
}

window.showForgotPwInfo=function(){
  const sql=`UPDATE auth.users\nSET encrypted_password = crypt('NEW_PASSWORD', gen_salt('bf'))\nWHERE email = 'kuagcku@gmail.com';`;
  showModal('비밀번호 재설정 안내',
    `<div style="font-size:13px;margin-bottom:10px">Supabase 관리자에게 아래의 SQL 명령어 실행을 요청하세요.</div>
     <div style="font-size:12px;color:var(--text2);margin-bottom:6px">현재 관리자: 영문 21 구도회 (010-3590-3730)</div>
     <pre style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-all">${sql}</pre>`,
    `<button class="btn btn-s" onclick="closeModal()">닫기</button>`
  );
};

window.doLogin=async function(){
  const email=document.getElementById('emailInput').value.trim();
  const pw=document.getElementById('pwInput').value;
  const err=document.getElementById('loginErr');
  const btn=document.getElementById('loginBtn');
  err.style.display='none';
  btn.disabled=true; btn.textContent='로그인 중...';
  const {error}=await supabase.auth.signInWithPassword({email,password:pw});
  btn.disabled=false; btn.textContent='로그인';
  if(error){
    err.style.display='block';
    document.getElementById('pwInput').value='';
    document.getElementById('pwInput').focus();
  }
};

window.doLogout=async function(){
  await supabase.auth.signOut();
};

// auth state listener
supabase.auth.onAuthStateChange((_event,session)=>{
  if(session){
    showAdminUI();
  } else {
    _adminInited=false;
    if(_applySchedTimer){clearTimeout(_applySchedTimer);_applySchedTimer=null;}
    ['regular','busking'].forEach(k=>{if(_ensSchedTimers[k]){clearTimeout(_ensSchedTimers[k]);_ensSchedTimers[k]=null;}});
    if(_ensBroadcastCh){ supabase.removeChannel(_ensBroadcastCh); _ensBroadcastCh=null; }
    if(_taBcCh){ supabase.removeChannel(_taBcCh); _taBcCh=null; }
    if(_schoolBcCh){ supabase.removeChannel(_schoolBcCh); _schoolBcCh=null; }
    _adminChannels.forEach(ch=>supabase.removeChannel(ch));
    _adminChannels=[];
    document.getElementById('loginWrap').style.display='';
    document.getElementById('adminUI').style.display='none';
    document.getElementById('mobTabBar').style.display='none';
  }
});

// restore session on load
supabase.auth.getSession().then(({data:{session}})=>{
  if(session) showAdminUI();
});

// ── LOAD ──────────────────────────────────────────────────────────────
async function loadAll(){
  const [_season,_ss,_se,_ws,_we,_mode]=await Promise.allSettled([
    getConfig('current_season'),
    getConfig('academic_summer_start'),
    getConfig('academic_summer_end'),
    getConfig('academic_winter_start'),
    getConfig('academic_winter_end'),
    getConfig('season_mode'),
  ]);
  season=_season.status==='fulfilled'?_season.value:'1학기';
  academicDates={
    summerStart:_ss.status==='fulfilled'?_ss.value:null,
    summerEnd:_se.status==='fulfilled'?_se.value:null,
    winterStart:_ws.status==='fulfilled'?_ws.value:null,
    winterEnd:_we.status==='fulfilled'?_we.value:null,
  };
  seasonMode=_mode.status==='fulfilled'?_mode.value:'auto';
  await autoUpdateSeason();
  const _r=await Promise.allSettled([
    fetchTeams(),fetchBaseSlots(season),fetchExceptions(weekOff),
    fetchRequests(weekOff),fetchNotices(),fetchContacts()
  ]);
  [teams,baseSlots,exceptions,requests,notices,contacts]=_r.map(r=>r.status==='fulfilled'?r.value:[]);
  teams=korSort(teams,'name');
  merged=mergeSchedule(baseSlots,exceptions);
  round=await fetchActiveRound(season);
  if(round) applications=await fetchApplications(round.id);
  pendingAll=await fetchAllPendingRequests();
  await loadEnsemble();
  await loadSchoolData();
  if(_ensBroadcastCh){ supabase.removeChannel(_ensBroadcastCh); _ensBroadcastCh=null; }
  _ensBroadcastCh=supabase.channel('ens-pub')
    .on('broadcast',{event:'songUpdate'},async()=>{ await loadEnsemble(); renderEnsemble(); })
    .subscribe();
  if(_taBcCh){ supabase.removeChannel(_taBcCh); _taBcCh=null; }
  _taBcCh=supabase.channel('ta-pub').subscribe();
  if(_schoolBcCh){ supabase.removeChannel(_schoolBcCh); _schoolBcCh=null; }
  _schoolBcCh=supabase.channel('school-pub').subscribe();
  _adminChannels.forEach(ch=>supabase.removeChannel(ch));
  _adminChannels=[
    supabase.channel('admin-school-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'school_rounds'},async(payload)=>{
        console.log('[school-rt] school_rounds change',payload);
        await loadSchoolData(); renderSchool();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'schools'},async(payload)=>{
        console.log('[school-rt] schools change',payload);
        await loadSchoolData(); renderSchool();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'school_applications'},async(payload)=>{
        console.log('[school-rt] school_applications change',payload);
        await loadSchoolData(); renderSchool();
      })
      .subscribe((status,err)=>{
        console.log('[school-rt] subscribe status:',status, err||'');
      }),
    supabase.channel('admin-pending-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'requests'},async()=>{
        pendingAll=await fetchAllPendingRequests();
        renderPending();
      })
      .subscribe(),
    supabase.channel('admin-ens-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'ensemble_rounds'},async()=>{
        await ensUpdated();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'song_applications'},async()=>{
        await ensUpdated();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'session_applications'},async()=>{
        await ensUpdated();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'manual_entries'},async()=>{
        await ensUpdated();
      })
      .subscribe(),
    supabase.channel('admin-schedule-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'base_slots'},async()=>{
        baseSlots=await fetchBaseSlots(season);
        merged=mergeSchedule(baseSlots,exceptions);
        renderSchedule();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'slot_exceptions'},async()=>{
        exceptions=await fetchExceptions(weekOff);
        merged=mergeSchedule(baseSlots,exceptions);
        renderSchedule();
      })
      .subscribe(),
    supabase.channel('admin-apply-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'time_applications'},async()=>{
        if(round) applications=await fetchApplications(round.id);
        renderApply();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'application_rounds'},async()=>{
        round=await fetchActiveRound(season);
        if(round) applications=await fetchApplications(round.id);
        renderApply();
      })
      .subscribe(),
    supabase.channel('admin-vacancy-rt')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'vacancy_reports'},async()=>{
        await checkVacancyReports();
      })
      .subscribe(),
  ];
  render();
  await checkVacancyReports();
}

async function checkVacancyReports(){
  const reports=await fetchVacancyReports().catch(()=>[]);
  if(reports.length) showVacancyPopup(reports[0]);
}

function showVacancyPopup(report){
  const {id,incident_month:mo,incident_day:d,incident_hour:hh,incident_minute:mm}=report;
  const min=String(mm).padStart(2,'0');
  const text=`${mo}월 ${d}일 ${hh}시 ${min}분에, 시간표와 다르게 동아리방이 비어있었어요.`;
  showModal('시간표 불일치 신고 접수',
    `<div style="background:var(--surface2);border-radius:6px;padding:12px 14px;font-size:14px;line-height:1.6;color:var(--text)">${text}</div>`,
    `<button class="btn btn-s" onclick="copyVacancyReport(${JSON.stringify(text).replace(/"/g,'&quot;')})">클립보드에 복사</button>
     <button class="btn btn-d" onclick="confirmVacancyReport(${id},${JSON.stringify(text).replace(/"/g,'&quot;')})">신고 확인</button>`
  );
}

window.copyVacancyReport=function(text){
  navigator.clipboard.writeText(text).then(()=>toast('클립보드에 복사되었습니다','ok')).catch(()=>toast('복사에 실패했습니다','err'));
};

window.confirmVacancyReport=async function(id,text){
  const input=prompt(`신고를 확인하고 삭제하려면 "확인"을 입력하세요.\n\n${text}`);
  if(input?.trim()!=='확인'){toast('취소되었습니다');return;}
  try{
    await deleteVacancyReport(id);
    closeModal(); toast('신고가 삭제되었습니다','ok');
    await checkVacancyReports();
  }catch(e){toast(errMsg(e),'err');}
};

// ── SCHOOL ────────────────────────────────────────────────────────────
async function loadSchoolData(){
  const [{data:rd},{data:sc},{data:ap}]=await Promise.all([
    supabase.from('school_rounds').select('*').order('created_at',{ascending:false}),
    supabase.from('schools').select('*').order('created_at'),
    supabase.from('school_applications').select('*').order('created_at')
  ]);
  adminSchoolRounds=rd||[];
  adminSchools=sc||[];
  adminSchoolApps=ap||[];
}

function schoolDiffToHMS(ms){
  if(ms<=0) return '00:00:00';
  const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;
  return [h,m,sc].map(v=>String(v).padStart(2,'0')).join(':');
}

function stopSchoolCd(){if(schoolCdTimer){clearInterval(schoolCdTimer);schoolCdTimer=null;}}

function startSchoolCd(targetTs,onExpired){
  stopSchoolCd();
  const tick=()=>{
    const diff=new Date(targetTs)-Date.now();
    const el=document.getElementById('schoolCdEl');
    if(el) el.textContent=schoolDiffToHMS(diff);
    if(diff<=0){stopSchoolCd();onExpired();}
  };
  tick();
  schoolCdTimer=setInterval(tick,1000);
}

function fmtSchoolDate(ts){
  if(!ts) return '';
  const d=new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function renderSchool(){
  stopSchoolCd();
  const el=document.getElementById('schoolAdminContent');
  if(!el) return;

  // 현재 회차 = draft 또는 open인 가장 최근 회차; 없으면 가장 최근 closed
  const cur=adminSchoolRounds.find(r=>r.status==='draft'||r.status==='open')||adminSchoolRounds[0]||null;

  if(!cur){
    el.innerHTML=`<div style="color:var(--text3);font-size:13px;text-align:center;padding:24px">진행 중인 스쿨 회차가 없습니다.</div>`;
    return;
  }

  const curClasses=adminSchools.filter(s=>s.round_id===cur.id);
  const curApps=adminSchoolApps.filter(a=>a.round_id===cur.id);
  const toLocal=ts=>ts?new Date(new Date(ts).getTime()-new Date(ts).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  const fS=ts=>ts?fmtSchoolDate(ts):'—';
  const getRoundName=r=>r.name||'스쿨 신청';
  const rndMatch=(cur.name||'').match(/(\d+)차/);
  const initRnd=rndMatch?rndMatch[1]:'';

  // ── DRAFT ──
  if(cur.status==='draft'){
    const classesHtml=curClasses.map(s=>`
      <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg);border:1px solid var(--border);border-radius:5px">
        <div style="flex:1">
          <span style="font-size:13px;font-weight:700">${s.name}</span>
          <span style="font-size:11px;color:var(--text2);margin-left:8px">담당: ${s.teacher_name||'미정'} · 정원 ${s.capacity}명${s.schedule_day?` · ${s.schedule_day}요일 ${s.schedule_hour??'?'}시`:''}</span>
        </div>
        <button class="btn btn-s btn-xs" onclick="openEditClassModal(${s.id})">수정</button>
        <button class="btn btn-d btn-xs" onclick="deleteClass(${s.id})">삭제</button>
      </div>`).join('');

    el.innerHTML=`<div class="card" style="padding:0;overflow:hidden">
      <div style="padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:3px;background:var(--surface2);color:var(--text3);border:1px solid var(--border)">초안</span>
        <span style="font-size:13px;font-weight:700">${getRoundName(cur)}</span>
        <div style="margin-left:auto;display:flex;gap:5px">
          <button class="btn btn-p btn-xs" onclick="schoolOpen(${cur.id})">열기</button>
          <button class="btn btn-d btn-xs" onclick="deleteSchoolRound(${cur.id})">삭제</button>
        </div>
      </div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <div class="fl">학기</div>
            <div class="fi" style="background:var(--surface2);color:var(--text2);cursor:default">${semLabel(season)}</div>
          </div>
          <div>
            <div class="fl">회차(숫자로)</div>
            <input class="fi" id="scRoundNum" type="number" min="1" value="${initRnd}" placeholder="1"/>
          </div>
        </div>
        <div style="font-size:12px;color:var(--text3)">
          회차명 미리보기: <strong id="scNamePreview">${getRoundName(cur)}</strong>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
          <div>
            <div class="fl">오픈 예약 (선택)</div>
            <input class="fi" id="scOpenAt" type="datetime-local" value="${toLocal(cur.open_at)}"/>
          </div>
          <div>
            <div class="fl">마감 예약 (선택)</div>
            <input class="fi" id="scCloseAt" type="datetime-local" value="${toLocal(cur.close_at)}"/>
          </div>
        </div>
        <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
          <input type="checkbox" id="scPriorRet" ${cur.prioritize_returning?'checked':''} style="margin-top:3px;flex-shrink:0"/>
          <span style="font-size:13px;color:var(--text)">이전 회차 스쿨을 들었던 학생들은 신규 학생들의 배정이 모두 끝난 뒤에 배정할까요?</span>
        </label>
        <div style="display:flex;justify-content:flex-end">
          <button class="btn btn-s btn-xs" id="scSaveBtn" onclick="saveDraftSettings(${cur.id})">설정 저장</button>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:12px">
          <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:8px;letter-spacing:.5px">반 목록 (${curClasses.length}개)</div>
          <div style="display:flex;flex-direction:column;gap:5px">
            ${classesHtml||'<div style="font-size:12px;color:var(--text3)">등록된 반이 없습니다.</div>'}
          </div>
          <button class="btn btn-s btn-xs" style="margin-top:8px" onclick="openAddClassModal(${cur.id})">+ 반 추가</button>
        </div>
      </div>
    </div>`;

    // 이름 미리보기 업데이트
    const upd=()=>{
      const n=parseInt(document.getElementById('scRoundNum')?.value)||'n';
      const el2=document.getElementById('scNamePreview');
      if(el2) el2.textContent=`${semLabel(season)} ${n}차 스쿨 신청`;
    };
    document.getElementById('scRoundNum')?.addEventListener('input',upd);
    return;
  }

  // ── OPEN ──
  if(cur.status==='open'){
    const assigned=curApps.filter(a=>a.status==='assigned');
    const pending=curApps.filter(a=>a.status==='pending');
    const unassigned=curApps.filter(a=>a.status==='unassigned');
    const closeAt=cur.close_at;

    const classesHtml=curClasses.map(s=>{
      const sa=assigned.filter(a=>a.assigned_school_id===s.id).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
      return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:9px 12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:${sa.length?'6px':'0'}">
          <div style="font-size:13px;font-weight:700;flex:1">${s.name}</div>
          <span style="font-size:11px;color:var(--text2)">담당: ${s.teacher_name||'미정'} · ${sa.length}/${s.capacity}명${s.schedule_day?` · ${s.schedule_day}요일 ${s.schedule_hour??'?'}시`:''}</span>
          <button class="btn btn-s btn-xs" onclick="openEditClassModal(${s.id})">수정</button>
        </div>
        ${sa.map((a,i)=>`<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;background:var(--surface);border-radius:3px;margin-top:2px">
          <span style="font-size:11px;color:var(--text3);min-width:18px">${i+1}</span>
          <span style="flex:1;font-size:12px">${esc(a.applicant_name)}</span>
          <span style="font-family:'Space Mono',monospace;font-size:11px;color:var(--text2)">${esc(a.student_id)}</span>
          ${a.is_returning?'<span style="font-size:9px;background:rgba(0,119,204,.1);color:var(--accent2);padding:1px 5px;border-radius:2px;font-weight:700">재수강</span>':''}
          <button class="btn btn-d btn-xs" onclick="deleteSchoolApp(${a.id})">삭제</button>
        </div>`).join('')}
      </div>`;
    }).join('');

    el.innerHTML=`<div class="card" style="padding:0;overflow:hidden">
      <div style="padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:3px;background:rgba(92,158,0,.1);color:var(--accent);border:1px solid rgba(92,158,0,.3)">모집중</span>
        <span style="font-size:13px;font-weight:700">${esc(getRoundName(cur))}</span>
        ${closeAt?`<span style="font-size:11px;color:var(--warn)">⏰ 마감: ${fS(closeAt)} — <span id="schoolCdEl" style="font-family:'Space Mono',monospace;font-weight:700">...</span></span>`:''}
        ${cur.prioritize_returning?'<span style="font-size:11px;color:var(--accent2)">이전 회차 대기 적용 중</span>':''}
        <div style="margin-left:auto;display:flex;gap:5px">
          <button class="btn btn-s btn-xs" onclick="openSchoolCloseDeadlineModal(${cur.id})">마감 예약/변경</button>
          <button class="btn btn-s btn-xs" onclick="schoolClose(${cur.id})">마감하기</button>
        </div>
      </div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:8px">
        ${curClasses.length?classesHtml:'<div style="font-size:12px;color:var(--text3)">등록된 반이 없습니다.</div>'}
        ${pending.length?`<div style="border:1px solid rgba(0,119,204,.2);border-radius:5px;padding:9px 12px">
          <div style="font-size:11px;font-weight:700;color:var(--accent2);margin-bottom:5px">마감 후 배정 예정 (${pending.length}명)</div>
          ${pending.map(a=>{
            const p1=curClasses.find(c=>c.id===a.pref1_school_id);
            const p2=curClasses.find(c=>c.id===a.pref2_school_id);
            return `<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;background:var(--surface);border-radius:3px;margin-top:2px">
              <span style="flex:1;font-size:12px">${esc(a.applicant_name)}</span>
              <span style="font-family:'Space Mono',monospace;font-size:11px;color:var(--text2)">${esc(a.student_id)}</span>
              <span style="font-size:10px;color:var(--text3)">${p1?'1지: '+esc(p1.name):''}${p2?' · 2지: '+esc(p2.name):''}</span>
              <button class="btn btn-d btn-xs" onclick="deleteSchoolApp(${a.id})">삭제</button>
            </div>`;}).join('')}
        </div>`:''}
        ${unassigned.length?`<div style="border:1px solid rgba(217,48,37,.2);border-radius:5px;padding:9px 12px">
          <div style="font-size:11px;font-weight:700;color:var(--danger);margin-bottom:5px">미배정 (${unassigned.length}명)</div>
          ${unassigned.map(a=>`<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;background:var(--surface);border-radius:3px;margin-top:2px">
            <span style="flex:1;font-size:12px">${esc(a.applicant_name)}</span>
            <span style="font-family:'Space Mono',monospace;font-size:11px;color:var(--text2)">${esc(a.student_id)}</span>
            <button class="btn btn-d btn-xs" onclick="deleteSchoolApp(${a.id})">삭제</button>
          </div>`).join('')}
        </div>`:''}
      </div>
    </div>`;

    if(closeAt){
      if(new Date(closeAt)<=Date.now()) adminSchoolClose(cur.id);
      else startSchoolCd(closeAt,()=>adminSchoolClose(cur.id));
    }
    return;
  }

  // ── CLOSED ──
  const assigned=curApps.filter(a=>a.status==='assigned');
  const unassigned=curApps.filter(a=>a.status==='unassigned'||a.status==='pending');
  const classesHtml=curClasses.map(s=>{
    const sa=assigned.filter(a=>a.assigned_school_id===s.id).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
    return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:9px 12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:${sa.length?'6px':'0'}">
        <div style="font-size:13px;font-weight:700;flex:1">${s.name}</div>
        <span style="font-size:11px;color:var(--text2)">담당: ${s.teacher_name||'미정'} · ${sa.length}/${s.capacity}명${s.schedule_day?` · ${s.schedule_day}요일 ${s.schedule_hour??'?'}시`:''}</span>
        <button class="btn btn-s btn-xs" onclick="openEditClassModal(${s.id})">수정</button>
      </div>
      ${sa.map((a,i)=>`<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;background:var(--surface);border-radius:3px;margin-top:2px">
        <span style="font-size:11px;color:var(--text3);min-width:18px">${i+1}</span>
        <span style="flex:1;font-size:12px">${esc(a.applicant_name)}</span>
        <span style="font-family:'Space Mono',monospace;font-size:11px;color:var(--text2)">${esc(a.student_id)}</span>
        ${a.is_returning?'<span style="font-size:9px;background:rgba(0,119,204,.1);color:var(--accent2);padding:1px 5px;border-radius:2px;font-weight:700">재수강</span>':''}
      </div>`).join('')}
    </div>`;
  }).join('');

  el.innerHTML=`<div class="card" style="padding:0;overflow:hidden">
    <div style="padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:3px;background:var(--surface2);color:var(--text2);border:1px solid var(--border)">마감</span>
      <span style="font-size:13px;font-weight:700">${getRoundName(cur)}</span>
      <div style="margin-left:auto"><button class="btn btn-p btn-xs" onclick="openCreateSchoolRoundModal()">+ 새 회차 만들기</button></div>
    </div>
    <div style="padding:14px 16px;display:flex;flex-direction:column;gap:6px">
      ${curClasses.length?classesHtml:'<div style="font-size:12px;color:var(--text3)">등록된 반이 없습니다.</div>'}
      ${unassigned.length?`<div style="border:1px solid rgba(217,48,37,.2);border-radius:5px;padding:9px 12px">
        <div style="font-size:11px;font-weight:700;color:var(--danger);margin-bottom:5px">미배정 (${unassigned.length}명)</div>
        ${unassigned.map(a=>`<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;background:var(--surface);border-radius:3px;margin-top:2px">
          <span style="flex:1;font-size:12px">${esc(a.applicant_name)}</span>
          <span style="font-family:'Space Mono',monospace;font-size:11px;color:var(--text2)">${esc(a.student_id)}</span>
        </div>`).join('')}
      </div>`:''}
    </div>
  </div>`;
}

// ── 스쿨 회차 관리 ─────────────────────────────────────────────────────
window.openCreateSchoolRoundModal=function(){
  // 이미 draft/open 회차가 있으면 경고
  const active=adminSchoolRounds.find(r=>r.status==='draft'||r.status==='open');
  if(active){toast('현재 진행 중인 회차를 먼저 마감하세요','err');return;}
  showModal('새 스쿨 회차 만들기',
    `<div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <div class="fl">학기</div>
          <div class="fi" style="background:var(--surface2);color:var(--text2);cursor:default">${semLabel(season)}</div>
        </div>
        <div><div class="fl">회차(숫자로)</div><input class="fi" id="nSchRnd" type="number" min="1" placeholder="1"/></div>
      </div>
    </div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="createSchRoundBtn" onclick="submitCreateSchoolRound()">만들기</button>`
  );
  setTimeout(()=>document.getElementById('nSchRnd')?.focus(),50);
};
window.submitCreateSchoolRound=async function(){
  const rnd=parseInt(document.getElementById('nSchRnd')?.value);
  if(!rnd){toast('회차를 입력해주세요','err');return;}
  const btn=document.getElementById('createSchRoundBtn');
  if(btn){btn.disabled=true;btn.textContent='생성 중...';}
  try{
    const {error}=await supabase.from('school_rounds').insert({
      name:`${semLabel(season)} ${rnd}차 스쿨 신청`,status:'draft'
    });
    if(error) throw error;
    closeModal(); toast('회차가 생성됐습니다','ok');
    await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');if(btn){btn.disabled=false;btn.textContent='만들기';}}
};

window.saveDraftSettings=async function(id){
  const rnd=parseInt(document.getElementById('scRoundNum')?.value);
  const openAtVal=document.getElementById('scOpenAt')?.value;
  const closeAtVal=document.getElementById('scCloseAt')?.value;
  const priorRet=document.getElementById('scPriorRet')?.checked||false;
  if(!rnd){toast('회차를 입력해주세요','err');return;}
  const btn=document.getElementById('scSaveBtn');
  if(btn){btn.disabled=true;btn.textContent='저장 중...';}
  try{
    const {error}=await supabase.from('school_rounds').update({
      name:`${semLabel(season)} ${rnd}차 스쿨 신청`,
      open_at:openAtVal?new Date(openAtVal).toISOString():null,
      close_at:closeAtVal?new Date(closeAtVal).toISOString():null,
      prioritize_returning:priorRet
    }).eq('id',id);
    if(error) throw error;
    toast('저장됐습니다','ok');
    await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');if(btn){btn.disabled=false;btn.textContent='설정 저장';}}
};

window.schoolOpen=async function(id){
  if(!confirm('신청을 열겠습니까?')) return;
  try{
    const {error}=await supabase.from('school_rounds').update({status:'open'}).eq('id',id);
    if(error) throw error;
    _schoolBcCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
    toast('신청이 열렸습니다','ok'); await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');}
};

window.schoolClose=async function(id){
  if(!confirm('신청을 마감하겠습니까?')) return;
  await adminSchoolClose(id);
};

window.openSchoolCloseDeadlineModal=function(id){
  const pad=n=>String(n).padStart(2,'0');
  const r=adminSchoolRounds.find(x=>x.id===id);
  let curCA='';
  if(r?.close_at){const d=new Date(r.close_at);curCA=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;}
  showModal('마감 예약/변경',
    `<div><div class="fl">마감 일시</div><input class="fi" type="datetime-local" id="scCdCA" value="${curCA}"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     ${curCA?`<button class="btn btn-s" onclick="clearSchoolCloseDeadline(${id})">예약 해제</button>`:''}
     <button class="btn btn-p" id="scCdBtn" onclick="saveSchoolCloseDeadline(${id})">저장</button>`
  );
};

window.saveSchoolCloseDeadline=async function(id){
  const ca=document.getElementById('scCdCA').value;
  if(!ca){toast('마감 일시를 입력해주세요','err');return;}
  const btn=document.getElementById('scCdBtn'); btn.disabled=true;
  try{
    const {error}=await supabase.from('school_rounds').update({close_at:new Date(ca).toISOString()}).eq('id',id);
    if(error) throw error;
    _schoolBcCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
    closeModal(); toast('마감 일시가 저장되었습니다','ok');
    await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};

window.clearSchoolCloseDeadline=async function(id){
  try{
    const {error}=await supabase.from('school_rounds').update({close_at:null}).eq('id',id);
    if(error) throw error;
    _schoolBcCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
    closeModal(); toast('마감 예약이 해제되었습니다','ok');
    await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');}
};

function schoolInstrKey(name){
  if(/보컬/.test(name)) return '보컬';
  if(/기타/.test(name)) return '기타';
  if(/베이스/.test(name)) return '베이스';
  if(/드럼/.test(name)) return '드럼';
  if(/키보드|건반|피아노/.test(name)) return '키보드';
  return name;
}

function semLabel(s){
  if(s==='여름방학') return '여름학기';
  if(s==='겨울방학') return '겨울학기';
  const m=(s||'').match(/^(\d+)/);
  return m?m[1]+'학기':s;
}

async function adminSchoolClose(id){
  let closeClasses=[];
  try{
    // B2/L2: .eq('status','open') 가드 — 이미 마감됐으면 UI만 갱신하고 종료
    const {data:updated,error}=await supabase.from('school_rounds').update({status:'closed'}).eq('id',id).eq('status','open').select('id');
    if(error) throw error;
    if(!updated?.length){await loadSchoolData();renderSchool();return;}
    // L1: 마감 직전 신청 현황을 DB에서 새로 불러와 정확한 정원 계산
    await loadSchoolData();
    closeClasses=adminSchools.filter(s=>s.round_id===id);
    // 이전 회차 수강자(pending) 처리
    const r=adminSchoolRounds.find(x=>x.id===id);
    if(r?.prioritize_returning){
      const pending=adminSchoolApps.filter(a=>a.round_id===id&&a.status==='pending').sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
      const counts={};
      adminSchoolApps.filter(a=>a.round_id===id&&a.status==='assigned'&&a.assigned_school_id).forEach(a=>{
        counts[a.assigned_school_id]=(counts[a.assigned_school_id]||0)+1;
      });
      for(const app of pending){
        const p1=app.pref1_school_id,p2=app.pref2_school_id;
        const c1=closeClasses.find(c=>c.id===p1),c2=closeClasses.find(c=>c.id===p2);
        let aid=null;
        if(c1&&(counts[p1]||0)<(c1.capacity||0)){aid=p1;counts[p1]=(counts[p1]||0)+1;}
        else if(p2&&c2&&(counts[p2]||0)<(c2.capacity||0)){aid=p2;counts[p2]=(counts[p2]||0)+1;}
        await supabase.from('school_applications').update({
          assigned_school_id:aid,status:aid?'assigned':'unassigned'
        }).eq('id',app.id);
      }
    }
    toast('마감됐습니다','ok'); await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');return;}
  // 반별 팀 및 시간표 자동 생성
  try{
    const dayMap={'월':0,'화':1,'수':2,'목':3,'금':4,'토':5,'일':6};
    // 악기별 색상 매핑 (같은 악기 = 같은 색)
    const uniqueInstrs=[...new Set(closeClasses.map(c=>schoolInstrKey(c.name)))];
    const instrColor=Object.fromEntries(uniqueInstrs.map((k,i)=>[k,COLORS[i%COLORS.length]]));
    let added=0;
    for(const cls of closeClasses){
      const existingTeam=teams.find(t=>t.name===cls.name&&t.type==='스쿨');
      if(existingTeam){
        // Sync teacher name to info field if changed
        if((existingTeam.info||'')!==(cls.teacher_name||'')){
          await updateTeam(existingTeam.id,{info:cls.teacher_name||''}).catch(()=>{});
          existingTeam.info=cls.teacher_name||'';
        }
        // Sync schedule slot for this season
        if(cls.schedule_day&&cls.schedule_hour!=null){
          const dayIdx=dayMap[cls.schedule_day];
          if(dayIdx!==undefined){
            const existingSlot=baseSlots.find(s=>s.team_id===existingTeam.id&&s.season===season);
            if(!existingSlot){
              const newSlot=await createBaseSlot({team_id:existingTeam.id,day:dayIdx,hour:cls.schedule_hour,season}).catch(()=>null);
              if(newSlot) baseSlots.push(newSlot);
            } else if(existingSlot.day!==dayIdx||existingSlot.hour!==cls.schedule_hour){
              await updateBaseSlot(existingSlot.id,{day:dayIdx,hour:cls.schedule_hour}).catch(()=>{});
              existingSlot.day=dayIdx; existingSlot.hour=cls.schedule_hour;
            }
          }
        }
        continue;
      }
      const color=instrColor[schoolInstrKey(cls.name)];
      const newTeam=await createTeam({name:cls.name,type:'스쿨',color,info:cls.teacher_name||'',members:[]});
      teams.push(newTeam);
      added++;
      if(cls.schedule_day&&cls.schedule_hour!=null){
        const dayIdx=dayMap[cls.schedule_day];
        if(dayIdx!==undefined&&!baseSlots.some(s=>s.team_id===newTeam.id&&s.day===dayIdx&&s.hour===cls.schedule_hour&&s.season===season)){
          const newSlot=await createBaseSlot({team_id:newTeam.id,day:dayIdx,hour:cls.schedule_hour,season});
          baseSlots.push(newSlot);
        }
      }
    }
    if(added){
      teams=korSort(teams,'name');
      merged=mergeSchedule(baseSlots,exceptions);
      renderTeams(); renderSchedule();
      toast(`${added}개 반의 팀 및 시간표가 자동 생성됐습니다`,'ok');
    }
    _schoolBcCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
  }catch(e){toast('팀/시간표 자동 생성 실패: '+errMsg(e),'err');}
}

window.deleteSchoolRound=async function(id){
  const schoolIds=adminSchools.filter(s=>s.round_id===id).map(s=>s.id);
  if(!confirm(`이 회차를 삭제하시겠습니까?\n반 ${schoolIds.length}개와 신청 데이터가 모두 삭제됩니다.`)) return;
  try{
    const {error:e1}=await supabase.from('school_applications').delete().eq('round_id',id);
    if(e1) throw e1;
    const {error:e2}=await supabase.from('schools').delete().eq('round_id',id);
    if(e2) throw e2;
    const {error}=await supabase.from('school_rounds').delete().eq('id',id);
    if(error) throw error;
    toast('삭제됐습니다','ok'); await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');}
};

// ── 반 관리 ────────────────────────────────────────────────────────────
window.openAddClassModal=function(roundId){
  showModal('반 추가',
    `<div style="display:flex;flex-direction:column;gap:10px">
      <div><div class="fl">반 이름</div><input class="fi" id="addClsName" placeholder="기타입문반"/></div>
      <div><div class="fl">담당 이름</div><input class="fi" id="addClsTeacher" placeholder="홍길동"/></div>
      <div><div class="fl">정원</div><input class="fi" id="addClsCap" type="number" min="1" value="10"/></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><div class="fl">요일</div><select class="fi" id="addClsDay"><option value="">선택 안함</option><option>월</option><option>화</option><option>수</option><option>목</option><option>금</option><option>토</option><option>일</option></select></div>
        <div><div class="fl">시작 시간(시)</div><input class="fi" id="addClsHour" type="number" min="0" max="23" placeholder="예: 14"/></div>
      </div>
      <div><div class="fl">스쿨 설명</div><textarea class="fi" id="addClsDesc" rows="3" placeholder="수업 내용" style="resize:vertical"></textarea></div>
    </div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="addClsBtn" onclick="submitAddClass(${roundId})">추가</button>`
  );
  setTimeout(()=>document.getElementById('addClsName')?.focus(),50);
};
window.submitAddClass=async function(roundId){
  const name=(document.getElementById('addClsName')?.value||'').trim();
  const teacher=(document.getElementById('addClsTeacher')?.value||'').trim();
  const cap=parseInt(document.getElementById('addClsCap')?.value)||0;
  const schedDay=(document.getElementById('addClsDay')?.value||'').trim()||null;
  const schedHourRaw=document.getElementById('addClsHour')?.value;
  const schedHour=schedHourRaw!==''&&schedHourRaw!=null?parseInt(schedHourRaw):null;
  const desc=(document.getElementById('addClsDesc')?.value||'').trim()||null;
  if(!name){toast('반 이름을 입력해주세요','err');return;}
  if(cap<1){toast('정원을 1명 이상으로 입력해주세요','err');return;}
  const btn=document.getElementById('addClsBtn');
  if(btn){btn.disabled=true;btn.textContent='추가 중...';}
  try{
    const {error}=await supabase.from('schools').insert({name,teacher_name:teacher,capacity:cap,round_id:roundId,schedule_day:schedDay,schedule_hour:schedHour,description:desc});
    if(error) throw error;
    closeModal(); toast('반이 추가됐습니다','ok');
    await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');if(btn){btn.disabled=false;btn.textContent='추가';}}
};
window.openEditClassModal=function(id){
  const s=adminSchools.find(x=>x.id===id);
  if(!s) return;
  showModal('반 수정',
    `<div style="display:flex;flex-direction:column;gap:10px">
      <div><div class="fl">반 이름</div><input class="fi" id="edClsName" value="${s.name}"/></div>
      <div><div class="fl">담당 이름</div><input class="fi" id="edClsTeacher" value="${s.teacher_name||''}"/></div>
      <div><div class="fl">정원</div><input class="fi" id="edClsCap" type="number" min="1" value="${s.capacity}"/></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><div class="fl">요일</div><select class="fi" id="edClsDay"><option value="">선택 안함</option><option${s.schedule_day==='월'?' selected':''}>월</option><option${s.schedule_day==='화'?' selected':''}>화</option><option${s.schedule_day==='수'?' selected':''}>수</option><option${s.schedule_day==='목'?' selected':''}>목</option><option${s.schedule_day==='금'?' selected':''}>금</option><option${s.schedule_day==='토'?' selected':''}>토</option><option${s.schedule_day==='일'?' selected':''}>일</option></select></div>
        <div><div class="fl">시작 시간 (시)</div><input class="fi" id="edClsHour" type="number" min="0" max="23" value="${s.schedule_hour??''}" placeholder="예: 14"/></div>
      </div>
      <div><div class="fl">스쿨 설명</div><textarea class="fi" id="edClsDesc" rows="3" style="resize:vertical">${s.description||''}</textarea></div>
    </div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="edClsBtn" onclick="submitEditClass(${id})">저장</button>`
  );
};
window.submitEditClass=async function(id){
  const name=(document.getElementById('edClsName')?.value||'').trim();
  const teacher=(document.getElementById('edClsTeacher')?.value||'').trim();
  const cap=parseInt(document.getElementById('edClsCap')?.value)||0;
  const schedDay=(document.getElementById('edClsDay')?.value||'').trim()||null;
  const schedHourRaw=document.getElementById('edClsHour')?.value;
  const schedHour=schedHourRaw!==''&&schedHourRaw!=null?parseInt(schedHourRaw):null;
  const desc=(document.getElementById('edClsDesc')?.value||'').trim()||null;
  if(!name){toast('반 이름을 입력해주세요','err');return;}
  if(cap<1){toast('정원을 1명 이상으로 입력해주세요','err');return;}
  const btn=document.getElementById('edClsBtn');
  if(btn){btn.disabled=true;btn.textContent='저장 중...';}
  try{
    const {error}=await supabase.from('schools').update({name,teacher_name:teacher,capacity:cap,schedule_day:schedDay,schedule_hour:schedHour,description:desc}).eq('id',id);
    if(error) throw error;
    closeModal(); toast('저장됐습니다','ok');
    await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');if(btn){btn.disabled=false;btn.textContent='저장';}}
};
window.deleteClass=async function(id){
  const s=adminSchools.find(x=>x.id===id);
  if(!confirm(`"${s?.name||'반'}"을 삭제하시겠습니까?`)) return;
  try{
    const appIds=adminSchoolApps
      .filter(a=>a.pref1_school_id===id||a.pref2_school_id===id||a.assigned_school_id===id)
      .map(a=>a.id);
    if(appIds.length) await supabase.from('school_applications').delete().in('id',appIds);
    const {error}=await supabase.from('schools').delete().eq('id',id);
    if(error) throw error;
    toast('삭제됐습니다','ok'); await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');}
};
window.deleteSchoolApp=async function(id){
  const app=adminSchoolApps.find(a=>a.id===id);
  if(!confirm(`"${app?.applicant_name||''}"의 신청을 삭제하시겠습니까?`)) return;
  try{
    const {error}=await supabase.from('school_applications').delete().eq('id',id);
    if(error) throw error;
    // 배정된 학생이 삭제됐으면 미배정자 중 가장 빠른 지원자를 자동 배정
    if(app?.status==='assigned'&&app?.assigned_school_id){
      const schoolId=app.assigned_school_id;
      const school=adminSchools.find(s=>s.id===schoolId);
      const round=adminSchoolRounds.find(r=>r.id===app.round_id);
      if(school&&round&&round.status==='open'){
        const occupied=adminSchoolApps.filter(a=>a.id!==id&&a.assigned_school_id===schoolId&&a.status==='assigned').length;
        if(occupied<(school.capacity||0)){
          const candidate=adminSchoolApps.filter(a=>
            a.id!==id&&a.round_id===app.round_id&&a.status==='unassigned'&&
            (a.pref1_school_id===schoolId||a.pref2_school_id===schoolId)
          ).sort((a,b)=>{
            const ap=a.pref1_school_id===schoolId?0:1,bp=b.pref1_school_id===schoolId?0:1;
            return ap!==bp?ap-bp:new Date(a.created_at)-new Date(b.created_at);
          })[0];
          if(candidate){
            const {error:eRA}=await supabase.from('school_applications').update({assigned_school_id:schoolId,status:'assigned'}).eq('id',candidate.id);
            if(eRA){toast('삭제됐습니다. 자동 재배정에 실패했으니 수동으로 확인해주세요.','err');await loadSchoolData();renderSchool();return;}
          }
        }
      }
    }
    toast('삭제됐습니다','ok'); await loadSchoolData(); renderSchool();
  }catch(e){toast(errMsg(e),'err');}
};

function render(){
  const wl=weekLabel(weekOff);
  document.getElementById('weekLbl').textContent=wl;
  document.getElementById('schTitle').innerHTML=`${wl} 시간표 `+(weekOff===0?`<span class="week-now-badge">이번주</span>`:`<span class="week-goto-badge" onclick="goToThisWeek()">이번주로 이동 →</span>`);
  document.getElementById('schSeason').textContent=season;
  document.getElementById('seasonBadge').textContent=season;
  renderSchedule(); renderPending(); renderTeams(); renderApply(); renderNotices(); renderContacts(); renderEnsemble(); renderSchool(); renderAcademicCard();
}

// ── PAGE SWITCH ───────────────────────────────────────────────────────
window.showPage=function(pg){
  ['sch','teams','apply','school','notices','contacts','ensemble','data'].forEach(p=>{
    document.getElementById('pg'+p.charAt(0).toUpperCase()+p.slice(1))?.classList.toggle('active',p===pg);
    document.getElementById('nb-'+p)?.classList.toggle('active',p===pg);
    document.getElementById('mt-'+p)?.classList.toggle('active',p===pg);
  });
  document.getElementById('weekNavEl').style.display=pg==='sch'?'':'none';
  if(pg==='ensemble') renderEnsemble();
  if(pg==='school') renderSchool();
};

window.changeWeek=async function(delta){
  weekOff+=delta;
  [exceptions,requests]=await Promise.all([fetchExceptions(weekOff),fetchRequests(weekOff)]);
  merged=mergeSchedule(baseSlots,exceptions); render();
};
window.goToThisWeek=async function(){
  weekOff=0;
  [exceptions,requests]=await Promise.all([fetchExceptions(0),fetchRequests(0)]);
  merged=mergeSchedule(baseSlots,exceptions); render();
};

async function autoUpdateSeason(){
  if(seasonMode!=='auto') return;
  const today=new Date().toISOString().slice(0,10);
  const {summerStart,summerEnd,winterStart,winterEnd}=academicDates;
  const transitions=[
    winterEnd   && {date:winterEnd,   s:'1학기'},
    summerStart && {date:summerStart, s:'여름방학'},
    summerEnd   && {date:summerEnd,   s:'2학기'},
    winterStart && {date:winterStart, s:'겨울방학'},
  ].filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date));
  let newSeason=null;
  for(const t of transitions) if(today>=t.date) newSeason=t.s;
  if(newSeason && newSeason!==season){
    await setConfig('current_season',newSeason).catch(()=>{});
    season=newSeason;
  }
}

window.setSeasonMode=async function(mode){
  seasonMode=mode;
  await setConfig('season_mode',mode).catch(()=>{});
  if(mode==='auto'){
    await autoUpdateSeason();
    render();
  } else {
    renderAcademicCard();
  }
};

window.setManualSeason=async function(s){
  await setConfig('current_season',s).catch(()=>{});
  season=s;
  [baseSlots,exceptions]=await Promise.all([fetchBaseSlots(season),fetchExceptions(weekOff)]);
  merged=mergeSchedule(baseSlots,exceptions);
  round=await fetchActiveRound(season);
  applications=round?await fetchApplications(round.id):[];
  render(); toast(`${s}으로 전환되었습니다`,'ok');
};


window.goToAcademicCard=function(){
  window.showPage('data');
  const el=document.getElementById('academicCard');
  if(!el) return;
  el.classList.remove('academic-highlight');
  void el.offsetWidth;
  el.classList.add('academic-highlight');
};

window.saveAcademicDates=async function(){
  const ss=document.getElementById('acSummerStart').value||null;
  const se=document.getElementById('acSummerEnd').value||null;
  const ws=document.getElementById('acWinterStart').value||null;
  const we=document.getElementById('acWinterEnd').value||null;
  try{
    await Promise.all([
      ss?setConfig('academic_summer_start',ss):supabase.from('app_config').delete().eq('key','academic_summer_start'),
      se?setConfig('academic_summer_end',se):supabase.from('app_config').delete().eq('key','academic_summer_end'),
      ws?setConfig('academic_winter_start',ws):supabase.from('app_config').delete().eq('key','academic_winter_start'),
      we?setConfig('academic_winter_end',we):supabase.from('app_config').delete().eq('key','academic_winter_end'),
    ]);
    academicDates={summerStart:ss,summerEnd:se,winterStart:ws,winterEnd:we};
    toast('학사일정이 저장되었습니다','ok');
    renderAcademicCard(); await autoUpdateSeason(); render();
  }catch(e){toast(errMsg(e),'err');}
};

function renderAcademicCard(){
  const el=document.getElementById('academicCard');
  if(!el) return;
  const {summerStart,summerEnd,winterStart,winterEnd}=academicDates;
  const isManual=seasonMode==='manual';
  const dis=isManual?'disabled':'';
  const seasons=['1학기','여름방학','2학기','겨울방학'];
  el.innerHTML=`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <div style="font-size:13px;font-weight:700;color:var(--text2)">학사일정</div>
      <div class="season-mode-toggle">
        <button class="${isManual?'active':''}" onclick="setSeasonMode('manual')">수동</button>
        <button class="${!isManual?'active':''}" onclick="setSeasonMode('auto')">자동</button>
      </div>
      ${isManual?`<select class="season-sel" onchange="setManualSeason(this.value)">${seasons.map(s=>`<option${s===season?' selected':''}>${s}</option>`).join('')}</select>`:''}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div><div class="fl">1학기 종강</div>
        <input class="fi" type="date" id="acSummerStart" value="${summerStart||''}" ${dis}/></div>
      <div><div class="fl">2학기 개강</div>
        <input class="fi" type="date" id="acSummerEnd" value="${summerEnd||''}" ${dis}/></div>
      <div><div class="fl">2학기 종강</div>
        <input class="fi" type="date" id="acWinterStart" value="${winterStart||''}" ${dis}/></div>
      <div><div class="fl">내년 1학기 개강</div>
        <input class="fi" type="date" id="acWinterEnd" value="${winterEnd||''}" ${dis}/></div>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn btn-p" onclick="saveAcademicDates()" ${dis}>저장</button>
      ${!isManual?`<span style="font-size:12px;color:var(--text2)">현재 학기: <b>${season}</b></span>`:''}
    </div>`;
}

// ── SCHEDULE ──────────────────────────────────────────────────────────
function renderSchedule(){
  const todayDow=(new Date().getDay()+6)%7;
  const nowH=new Date().getHours(),nowM=new Date().getMinutes();
  const isNow=weekOff===0;
  const mobile=window.innerWidth<=700;
  const wdates=getWeekDates(weekOff);

  const dayTabBar=document.getElementById('dayTabBar');
  if(dayTabBar){
    if(mobile){
      dayTabBar.innerHTML=DAYS.map((d,i)=>`
        <button class="day-tab${i===mobileDayIdx?' active':''}${isNow&&i===todayDow?' today-tab':''}"
          onclick="selectMobileDay(${i})">${d}<br><span style="font-size:9px;font-weight:400">${wdates[i]}</span></button>`).join('');
    } else {
      dayTabBar.innerHTML='';
    }
  }

  document.getElementById('schHdr').innerHTML='<div class="sch-day"></div>'+
    DAYS.map((d,i)=>`<div class="sch-day${isNow&&i===todayDow?' today':''}">${d}<br><span class="sch-day-date">${wdates[i]}</span></div>`).join('');
  document.getElementById('schTimes').innerHTML=HOURS.map(h=>
    `<div class="sch-time"><span>${timeStr(h)}</span>${h>=24?`<span class="sch-time-next">익일</span>`:''}</div>`).join('');
  const grid=document.getElementById('schGrid'); grid.innerHTML='';
  const mm=new Map(merged.map(s=>[`${s.day}-${s.hour}`,s]));
  const pm=new Map(requests.filter(r=>r.type==='extra'&&r.status==='pending').map(r=>[`${r.day}-${r.hour}`,r]));
  for(let d=0;d<7;d++){
    const col=document.createElement('div');
    col.className='sch-col'+(isNow&&d===todayDow?' today':'')+(mobile?(d===mobileDayIdx?' mobile-active':''):'');
    if(isNow&&d===todayDow&&nowH>=HOURS[0]&&nowH<=HOURS[HOURS.length-1]){
      const slotH=window.innerWidth<=700?56:62;
      const line=document.createElement('div'); line.className='now-line';
      line.style.top=((nowH-HOURS[0])*slotH+(nowM/60)*slotH)+'px'; col.appendChild(line);
    }
    for(const h of HOURS){
      const cell=document.createElement('div'); cell.className='sch-slot';
      const s=mm.get(`${d}-${h}`),pe=pm.get(`${d}-${h}`);
      if(s){
        const t=s.teams,absent=s.status==='absent',isExtra=s.source==='extra',c=teamClr(t);
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
        blk.onclick=()=>openSlotModal(s); cell.appendChild(blk);
      } else if(pe){
        const t=pe.teams,c=teamClr(t);
        const blk=document.createElement('div');
        blk.className='blk'; blk.style.cssText=`background:${c}20;border:1.5px dashed ${c}77;opacity:.6`;
        blk.innerHTML=`<div class="blk-top"><span class="blk-name" style="color:${c}">${esc(t.name)}</span><span class="blk-tag" style="color:${c}">대기</span></div><div class="blk-bot"><span class="blk-info" style="color:${c}88">${esc(t.info||'')}</span></div>`;
        blk.onclick=()=>openPendingSlotModal(pe); cell.appendChild(blk);
      } else {
        const ind=document.createElement('div'); ind.className='blk-empty';
        ind.textContent='+'; ind.onclick=()=>openAddSlotModal(d,h); cell.appendChild(ind);
      }
      col.appendChild(cell);
    }
    grid.appendChild(col);
  }
}

window.selectMobileDay=function(idx){
  mobileDayIdx=idx;
  document.querySelectorAll('.day-tab').forEach((btn,i)=>btn.classList.toggle('active',i===idx));
  document.querySelectorAll('.sch-col').forEach((col,i)=>col.classList.toggle('mobile-active',i===idx));
};

function openSlotModal(s){
  const t=s.teams,absent=s.status==='absent',isExtra=s.source==='extra',c=teamClr(t);
  showModal(`${esc(t.name)} · ${DAYS[s.day]} ${s.hour}:00`,
    `<div class="irow"><span class="ik">팀</span><span style="color:${c};font-weight:700">${esc(t.name)}</span></div>
     <div class="irow"><span class="ik">시간</span><span>${DAYS[s.day]} ${s.hour}:00</span></div>
     <div class="irow"><span class="ik">상태</span><span>${absent?'⛔ 미사용':'✅ 정상'}</span></div>
     ${t.info?`<div class="irow"><span class="ik">정보</span><span>${esc(t.info)}</span></div>`:''}`,
    `<button class="btn btn-s" onclick="closeModal()">닫기</button>
     ${s.exceptionId?`<button class="btn btn-s" onclick="removeException(${s.exceptionId})">예외 제거</button>`:''}
     ${!absent&&s.source==='base'?`<button class="btn btn-d" onclick="markAbsent(${s.team_id},${s.day},${s.hour})">이번 주 미사용</button>`:''}
     ${s.source==='base'?`<button class="btn btn-p" onclick="openEditSlotModal(${s.id})">수정</button>`:''}`
  );
}

window.removeException=async function(id){
  try{
    await deleteException(id); exceptions=await fetchExceptions(weekOff);
    merged=mergeSchedule(baseSlots,exceptions); closeModal(); renderSchedule(); toast('예외 제거되었습니다','ok');
  }catch(e){toast(errMsg(e),'err');}
};
window.markAbsent=async function(teamId,day,hour){
  try{
    await createException({team_id:teamId,day,hour,week_offset:weekOff,exception_type:'absent'});
    exceptions=await fetchExceptions(weekOff); merged=mergeSchedule(baseSlots,exceptions);
    closeModal(); renderSchedule(); toast('미사용 처리되었습니다','ok');
  }catch(e){toast(errMsg(e),'err');}
};
window.openEditSlotModal=function(slotId){
  const s=baseSlots.find(b=>b.id===slotId);
  const tOpts=korSort(teams,'name').map(t=>`<option value="${t.id}" ${t.id===s.team_id?'selected':''}>${t.name}</option>`).join('');
  showModal('슬롯 수정',
    `<div><div class="fl">팀</div><select class="fs" id="eTeam">${tOpts}</select></div>
     <div><div class="fl">요일</div><select class="fs" id="eDay">${DAYS.map((d,i)=>`<option value="${i}" ${i===s.day?'selected':''}>${d}</option>`).join('')}</select></div>
     <div><div class="fl">시간</div><select class="fs" id="eHour">${HOURS.map(h=>`<option value="${h}" ${h===s.hour?'selected':''}>${timeStr(h)}</option>`).join('')}</select></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-d" onclick="deleteSlot(${slotId})">삭제</button>
     <button class="btn btn-p" id="eBtn" onclick="saveSlot(${slotId})">저장</button>`
  );
};
window.saveSlot=async function(id){
  const btn=document.getElementById('eBtn'); btn.disabled=true;
  try{
    await updateBaseSlot(id,{team_id:parseInt(document.getElementById('eTeam').value),day:parseInt(document.getElementById('eDay').value),hour:parseInt(document.getElementById('eHour').value)});
    baseSlots=await fetchBaseSlots(season); merged=mergeSchedule(baseSlots,exceptions);
    closeModal(); renderSchedule(); toast('슬롯이 수정되었습니다','ok');
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};
window.deleteSlot=async function(id){
  if(!confirm('이 슬롯을 삭제할까요?')) return;
  try{
    await deleteBaseSlot(id); baseSlots=await fetchBaseSlots(season);
    merged=mergeSchedule(baseSlots,exceptions); closeModal(); renderSchedule(); toast('삭제되었습니다');
  }catch(e){toast(errMsg(e),'err');}
};
window.openAddSlotModal=function(day=0,hour=10){
  const tOpts=korSort(teams,'name').map(t=>`<option value="${t.id}">${t.name}</option>`).join('');
  // ±4주 범위 옵션 생성
  const weekOpts=Array.from({length:9},(_,i)=>i-4).map(off=>{
    const label=weekLabelWithThis(off);
    return `<option value="week_${off}">${label}</option>`;
  }).join('');
  showModal('슬롯 추가',
    `<div>
       <div class="fl">추가 대상</div>
       <select class="fs" id="aTarget">
         <option value="base">${season} 기본 시간표</option>
         ${weekOpts}
       </select>
     </div>
     <div><div class="fl">팀</div><select class="fs" id="aTeam">${tOpts}</select></div>
     <div><div class="fl">요일</div><select class="fs" id="aDay">${DAYS.map((d,i)=>`<option value="${i}" ${i===day?'selected':''}>${d}</option>`).join('')}</select></div>
     <div><div class="fl">시간</div><select class="fs" id="aHour">${HOURS.map(h=>`<option value="${h}" ${h===hour?'selected':''}>${timeStr(h)}</option>`).join('')}</select></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="aBtn" onclick="addSlot()">추가</button>`
  );
};
window.addSlot=async function(){
  const btn=document.getElementById('aBtn'); btn.disabled=true;
  const target=document.getElementById('aTarget').value;
  const team_id=parseInt(document.getElementById('aTeam').value);
  const day=parseInt(document.getElementById('aDay').value);
  const hour=parseInt(document.getElementById('aHour').value);
  try{
    if(target==='base'){
      await createBaseSlot({team_id,day,hour,season});
      baseSlots=await fetchBaseSlots(season);
    } else {
      const off=parseInt(target.replace('week_',''));
      await createException({team_id,day,hour,week_offset:off,exception_type:'extra'});
      exceptions=await fetchExceptions(weekOff);
    }
    merged=mergeSchedule(baseSlots,exceptions);
    closeModal(); renderSchedule(); toast('슬롯이 추가되었습니다','ok');
  }catch(e){toast(e.message.includes('unique')?'이미 해당 시간에 슬롯이 있습니다':errMsg(e),'err');btn.disabled=false;}
};

// ── PENDING SIDEBAR ───────────────────────────────────────────────────
function renderPending(){
  const badge=document.getElementById('pendBadge');
  badge.textContent=pendingAll.length; badge.style.display=pendingAll.length?'':'none';
  const list=document.getElementById('pendList');
  if(!pendingAll.length){list.innerHTML='<div class="no-pend">대기 중인 신청 없음</div>';return;}
  list.innerHTML=pendingAll.map(r=>{
    const isTerminate=r.teams.type==='스쿨'&&r.type==='absent';
    const typeLabel=isTerminate?'종강 신고':r.type==='absent'?'미사용':'추가사용';
    const dateStr=reqActualDate(r.week_offset,r.day);
    return `
    <div class="pcard ${r.type}">
      <div class="pcard-name" style="color:${teamClr(r.teams)}">${esc(r.teams.name)}</div>
      <div class="pcard-detail">${dateStr} ${r.hour}:00 · ${typeLabel}</div>
      <div class="pcard-detail">${esc(r.reason)}</div>
      ${r.requester_name?`<div class="pcard-detail">신청자: ${esc(r.requester_name)}</div>`:''}
      <div class="pcard-detail" style="color:var(--text3)">${fmtTime(r.created_at)}</div>
      <div class="pcard-actions">
        ${isTerminate
          ?`<button class="pa-ok" onclick="doApproveTerminate(${r.id})" title="기본 배정 슬롯을 영구 삭제합니다">종강 승인</button>`
          :`<button class="pa-ok" onclick="doApprove(${r.id})">승인</button>`}
        <button class="pa-no" onclick="doReject(${r.id})">거절</button>
      </div>
    </div>`;
  }).join('');
}
function openPendingSlotModal(req){
  const t=req.teams;
  showModal('추가사용 대기',
    `<div class="irow"><span class="ik">팀</span><span style="font-weight:700">${esc(t.name)}</span></div>
     <div class="irow"><span class="ik">시간</span><span>${DAYS[req.day]} ${req.hour}:00</span></div>
     <div class="irow"><span class="ik">사유</span><span>${esc(req.reason)}</span></div>`,
    `<button class="btn btn-s" onclick="closeModal()">닫기</button>
     <button class="btn btn-d" onclick="doReject(${req.id});closeModal()">거절</button>
     <button class="btn btn-p" onclick="doApprove(${req.id});closeModal()">승인</button>`
  );
}
window.doApprove=async function(id){
  const req=pendingAll.find(r=>r.id===id); if(!req) return;
  try{
    await approveRequest(req,req.week_offset); toast('승인되었습니다','ok');
    [exceptions,requests,pendingAll]=await Promise.all([fetchExceptions(weekOff),fetchRequests(weekOff),fetchAllPendingRequests()]);
    merged=mergeSchedule(baseSlots,exceptions); renderSchedule(); renderPending();
  }catch(e){toast(errMsg(e),'err');}
};
window.doApproveTerminate=async function(id){
  const req=pendingAll.find(r=>r.id===id); if(!req) return;
  try{
    await approveTerminate(req,season); toast('종강 처리되었습니다 — 기본 배정 슬롯이 삭제되었습니다','ok');
    [baseSlots,exceptions,requests,pendingAll]=await Promise.all([fetchBaseSlots(season),fetchExceptions(weekOff),fetchRequests(weekOff),fetchAllPendingRequests()]);
    merged=mergeSchedule(baseSlots,exceptions); renderSchedule(); renderPending();
  }catch(e){toast(errMsg(e),'err');}
};
window.doReject=async function(id){
  try{
    await rejectRequest(id); toast('거절되었습니다');
    pendingAll=await fetchAllPendingRequests(); renderPending();
  }catch(e){toast(errMsg(e),'err');}
};

// ── TEAMS ─────────────────────────────────────────────────────────────
function renderTeams(){
  const groups=[{k:'합주',label:'합주'},{k:'스쿨',label:'스쿨'},{k:'이외',label:'이외'}];
  document.getElementById('teamsContent').innerHTML=groups.map(g=>{
    const list=korSort(teams.filter(t=>t.type===g.k),'name');
    if(!list.length) return '';
    return `<div class="teams-section">
      <div class="teams-section-title">${g.label} (${list.length}팀)</div>
      <div class="teams-grid">
        ${list.map(t=>`<div class="tcard${selectedTeams.has(t.id)?' tcard-sel':''}">
          <div class="tcard-hdr">
            <input type="checkbox" class="team-chk" ${selectedTeams.has(t.id)?'checked':''} onchange="toggleTeamSelect(${t.id},this.checked)"/>
            <div class="tcard-dot" style="background:${teamClr(t)}"></div>
            <div class="tcard-name-static">${t.name}</div>
            <div class="tcard-type">${t.type}</div>
          </div>
          ${g.k!=='합주'?`<div class="tcard-row">
            <input class="fi" style="padding:4px 7px;font-size:12px" value="${t.name}" id="tname-${t.id}" placeholder="팀명"/>
          </div>`:''}
          <div class="tcard-row">
            <input class="fi" style="padding:4px 7px;font-size:12px" value="${t.info||''}" id="tinfo-${t.id}"
              placeholder="${g.k==='스쿨'?'선생님':g.k==='합주'?'합주곡':'추가정보'}"/>
          </div>
          ${t.members&&t.members.length?`<div style="display:flex;flex-direction:column;gap:4px;background:var(--surface2);border-radius:3px;padding:6px 8px">
            <div style="font-size:10px;font-weight:700;color:var(--text2)">참여자</div>
            ${t.members.map((m,i)=>`<div style="display:grid;grid-template-columns:1fr 50px 1fr;gap:3px">
              <input class="fi" style="padding:3px 6px;font-size:11px" id="tmn-${t.id}-${i}" value="${(m.name||'').replace(/"/g,'&quot;')}" placeholder="이름"/>
              <input class="fi" style="padding:3px 6px;font-size:11px;text-align:center" id="tms-${t.id}-${i}" maxlength="3" value="${m.student_id_last3||''}" placeholder="학번"/>
              <input class="fi" style="padding:3px 6px;font-size:11px" id="tmse-${t.id}-${i}" value="${(m.sessions||[]).join(',')}" placeholder="보컬1,기타1"/>
            </div>`).join('')}
            <div style="font-size:9px;color:var(--text3)">세션은 쉼표로 구분</div>
          </div>`:''}
          <div style="display:flex;justify-content:flex-end;gap:5px">
            <button class="btn btn-d btn-xs" onclick="doDeleteTeam(${t.id})">삭제</button>
            <button class="btn btn-p btn-xs" onclick="saveTeamAll(${t.id})">저장</button>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}
window.saveTeamAll=async function(id){
  const t0=teams.find(t=>t.id===id);
  const nameEl=document.getElementById('tname-'+id);
  const name=nameEl?nameEl.value.trim():t0?.name;
  if(!name){toast('팀명을 입력해주세요','err');return;}
  const info=document.getElementById('tinfo-'+id)?.value.trim()??'';
  const members=[];
  let i=0;
  while(document.getElementById(`tmn-${id}-${i}`)){
    const mname=document.getElementById(`tmn-${id}-${i}`)?.value.trim()??'';
    const msid=document.getElementById(`tms-${id}-${i}`)?.value.trim()??'';
    const msessRaw=document.getElementById(`tmse-${id}-${i}`)?.value.trim()??'';
    const msess=msessRaw.split(',').map(s=>s.trim()).filter(Boolean);
    if(mname) members.push({name:mname,student_id_last3:msid,sessions:msess});
    i++;
  }
  try{
    await updateTeam(id,{name,info,members});
    const t=teams.find(t=>t.id===id);
    if(t){t.name=name;t.info=info;t.members=members;}
    teams=korSort(teams,'name');
    toast('저장되었습니다','ok'); renderTeams(); renderSchedule();
  }catch(e){toast(errMsg(e),'err');}
};
window.doDeleteTeam=async function(id){
  if(!confirm('팀을 삭제하면 해당 팀의 모든 슬롯도 삭제됩니다. 계속할까요?')) return;
  try{
    await deleteTeam(id); teams=teams.filter(t=>t.id!==id);
    baseSlots=baseSlots.filter(s=>s.team_id!==id); merged=mergeSchedule(baseSlots,exceptions);
    toast('팀이 삭제되었습니다'); render();
  }catch(e){toast(errMsg(e),'err');}
};
window.toggleTeamSelect=function(id,checked){
  checked?selectedTeams.add(id):selectedTeams.delete(id);
  const c=document.getElementById('teamSelCount');
  if(c) c.textContent=selectedTeams.size?selectedTeams.size+'개 선택됨':'';
  document.querySelectorAll('.tcard').forEach(el=>{
    const chk=el.querySelector('.team-chk');
    if(chk&&chk.getAttribute('onchange')&&chk.getAttribute('onchange').includes(id+',')){
      el.classList.toggle('tcard-sel',checked);
    }
  });
};
window.selectAllTeams=function(){
  const allIds=teams.map(t=>t.id);
  const allSelected=allIds.every(id=>selectedTeams.has(id));
  if(allSelected){ selectedTeams.clear(); }
  else { allIds.forEach(id=>selectedTeams.add(id)); }
  renderTeams();
  const c=document.getElementById('teamSelCount');
  if(c) c.textContent=selectedTeams.size?selectedTeams.size+'개 선택됨':'';
  document.querySelector('.teams-toolbar .btn-s').textContent=selectedTeams.size===allIds.length?'전체 해제':'전체 선택';
};
window.deleteSelectedTeams=async function(){
  if(!selectedTeams.size){toast('삭제할 팀을 선택해주세요','err');return;}
  if(!confirm(`선택한 ${selectedTeams.size}개 팀을 삭제합니다. 해당 팀의 모든 슬롯도 삭제됩니다. 계속할까요?`)) return;
  try{
    for(const id of selectedTeams){ await deleteTeam(id); }
    const deleted=[...selectedTeams];
    selectedTeams.clear();
    teams=teams.filter(t=>!deleted.includes(t.id));
    baseSlots=baseSlots.filter(s=>!deleted.includes(s.team_id));
    merged=mergeSchedule(baseSlots,exceptions);
    toast(`${deleted.length}개 팀이 삭제되었습니다`,'ok'); render();
  }catch(e){toast(errMsg(e),'err');}
};
let _nMIdx=0;
window.openAddTeamModal=function(){
  _nMIdx=0;
  const swatches=COLORS.map(c=>`<div class="swatch" id="sw-${c.replace('#','')}" style="background:${c}" onclick="pickColor('${c}')"></div>`).join('');
  showModal('팀 추가',
    `<div><div class="fl">분류</div>
       <select class="fs" id="nType" onchange="onTypeChange()">
         <option>합주</option><option>스쿨</option><option>이외</option>
       </select></div>
     <div id="ensNameArea">
       <div class="fl">팀 이름</div>
       <div style="font-size:13px;font-weight:700;padding:5px 0;color:var(--text)" id="ensAutoName">—</div>
     </div>
     <div id="plainNameArea" style="display:none">
       <div class="fl">팀 이름</div>
       <input class="fi" id="nName" placeholder="팀 이름"/>
     </div>
     <div id="ensInfoArea">
       <div class="fl">곡 제목</div>
       <input class="fi" id="nInfo" placeholder="곡 제목"/>
     </div>
     <div id="colorArea" style="display:none">
       <div class="fl">컬러</div>
       <div class="swatch-row">${swatches}</div>
       <input type="hidden" id="nColor" value="${COLORS[0]}"/>
     </div>
     <div id="grayNote" style="font-size:11px;color:var(--text3)">합주 팀은 자동으로 회색 표시됩니다</div>
     <div>
       <div class="fl">구성원</div>
       <div style="display:grid;grid-template-columns:1fr 48px 1fr 22px;gap:4px;font-size:10px;color:var(--text3);padding:0 2px;margin-bottom:3px">
         <span>이름</span><span style="text-align:center">학번</span><span>세션 (쉼표 구분)</span><span></span>
       </div>
       <div id="nMemberRows" style="display:flex;flex-direction:column;gap:4px;margin-bottom:6px"></div>
       <button class="btn btn-s btn-xs" onclick="addMemberRow()">+ 구성원 추가</button>
     </div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="nBtn" onclick="addTeam()">추가</button>`
  );
  onTypeChange();
  pickColor(COLORS[0]);
};
window.addMemberRow=function(){
  const i=_nMIdx++;
  const row=document.createElement('div');
  row.id=`nmrow-${i}`;
  row.style.cssText='display:grid;grid-template-columns:1fr 48px 1fr 22px;gap:4px;align-items:center';
  row.innerHTML=`<input class="fi" style="padding:3px 6px;font-size:11px" id="nm-${i}" placeholder="이름"/>
    <input class="fi" style="padding:3px 6px;font-size:11px;text-align:center" id="ns-${i}" maxlength="3" placeholder="학번"/>
    <input class="fi" style="padding:3px 6px;font-size:11px" id="nse-${i}" placeholder="보컬1,기타1"/>
    <button style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;line-height:1;padding:0 2px" onclick="document.getElementById('nmrow-${i}').remove()">×</button>`;
  document.getElementById('nMemberRows').appendChild(row);
};
function nextEnsTeamNum(){
  const nums=teams.filter(t=>t.type==='합주').map(t=>{const m=t.name.match(/^(\d+)팀$/);return m?parseInt(m[1]):0;});
  let n=1; while(nums.includes(n)) n++; return n;
}
window.onTypeChange=function(){
  const t=document.getElementById('nType').value,isEns=t==='합주';
  document.getElementById('ensNameArea').style.display=isEns?'block':'none';
  document.getElementById('plainNameArea').style.display=isEns?'none':'block';
  document.getElementById('ensInfoArea').style.display=isEns?'block':'none';
  document.getElementById('colorArea').style.display=isEns?'none':'block';
  document.getElementById('grayNote').style.display=isEns?'block':'none';
  if(isEns) document.getElementById('ensAutoName').textContent=`${nextEnsTeamNum()}팀`;
};
window.pickColor=function(c){
  const inp=document.getElementById('nColor'); if(inp) inp.value=c;
  COLORS.forEach(x=>{const el=document.getElementById('sw-'+x.replace('#',''));if(el)el.style.borderColor=x===c?'#fff':'transparent';});
};
window.addTeam=async function(){
  const type=document.getElementById('nType').value;
  const isEns=type==='합주';
  const name=isEns?`${nextEnsTeamNum()}팀`:(document.getElementById('nName')?.value.trim()||'');
  const info=isEns?(document.getElementById('nInfo')?.value.trim()||''):'';
  const color=isEns?GRAY:(document.getElementById('nColor')?.value||COLORS[0]);
  if(!name){toast('팀 이름을 입력해주세요','err');return;}
  const members=[];
  document.querySelectorAll('#nMemberRows [id^="nm-"]').forEach(el=>{
    const i=el.id.replace('nm-','');
    const mname=el.value.trim();
    const msid=document.getElementById('ns-'+i)?.value.trim()||'';
    const msessRaw=document.getElementById('nse-'+i)?.value.trim()||'';
    const msess=msessRaw.split(',').map(s=>s.trim()).filter(Boolean);
    if(mname) members.push({name:mname,student_id_last3:msid,sessions:msess});
  });
  const btn=document.getElementById('nBtn'); btn.disabled=true;
  try{
    const t=await createTeam({name,type,color,info,members}); teams.push(t); teams=korSort(teams,'name');
    toast(`${name} 팀이 추가되었습니다`,'ok'); closeModal(); renderTeams();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};

// ── APPLY ─────────────────────────────────────────────────────────────
function renderApply(){
  const isScheduled=round&&round.status==='open'&&round.open_at&&new Date(round.open_at)>new Date();
  const isOpen=round&&round.status==='open'&&(!round.open_at||new Date(round.open_at)<=new Date());
  const isFin=round&&round.status==='finished'&&!round.draft_approved;
  const isClosed=round&&round.status==='closed'&&!round.draft_approved&&!isFin;
  const isFinOrApproved=round&&(round.status==='finished'||round.draft_approved);

  let statusCls=isOpen?'open':isFin?'finished':'closed';
  let statusIcon=isOpen?'🟢':isFin?'🔵':isScheduled?'⏳':isClosed?'🟡':'⭕';
  let statusTitle=isOpen?'신청 진행 중':isFin?'배정 완료':isScheduled?'신청 예약됨':isClosed?'신청 마감됨 — 배정 대기':'신청 기간 아님';
  let statusSub=isScheduled?`${fmtScheduled(round.open_at)}에 신청 시작`:isOpen&&round.close_at?'마감: '+new Date(round.close_at).toLocaleString('ko-KR'):'';

  let html=`<div class="apply-status ${statusCls}">
    <div class="apply-status-left">
      <div class="apply-status-icon">${statusIcon}</div>
      <div>
        <div class="apply-status-title">${statusTitle}</div>
        <div class="apply-status-sub">${statusSub}</div>
      </div>
    </div>
    <div class="apply-status-actions">`;

  if(!round||round.draft_approved){
    html+=`<button class="btn btn-p btn-xs" onclick="openNewRoundModal()">새 신청 설정</button>`;
  } else if(isScheduled){
    html+=`<button class="btn btn-s btn-xs" onclick="openChangeScheduleModal()">예약 변경</button>
           <button class="btn btn-p btn-xs" onclick="openApplyNow()">지금 열기</button>`;
  } else if(isOpen){
    html+=`<button class="btn btn-d btn-xs" onclick="closeRoundNow()">신청 마감</button>
           <button class="btn btn-s btn-xs" onclick="openCloseDeadlineModal()">마감 예약/변경</button>`;
  } else if(isClosed&&!isFin){
    html+=`<button class="btn btn-s btn-xs" onclick="reopenRound()">신청 재오픈</button>
           <button class="btn btn-p btn-xs" onclick="runAssignmentOnly()">배정 실행</button>
           <button class="btn btn-d btn-xs" onclick="openDiscardModal()">신청 폐기</button>`;
  } else if(isFin){
    html+=`<button class="btn btn-p btn-xs" onclick="confirmDraftOnly()">확정</button>
           <button class="btn btn-d btn-xs" onclick="openDiscardModal()">신청 폐기</button>`;
  }

  html+=`</div></div>`;

  if(round&&applications.length){
    const pc=p=>p===1?'p1':p===2?'p2':p===3?'p3':'none';
    const pl=p=>p?p+'지망':'미배정';
    // 팀별 최신 신청 ID 파악 (이미 submitted_at 오름차순 정렬됨)
    const latestIdByTeam=new Map();
    for(const a of applications) latestIdByTeam.set(a.team_id,a.id);
    const isVoid=a=>latestIdByTeam.get(a.team_id)!==a.id;
    const validCount=applications.filter(a=>!isVoid(a)).length;
    html+=`<div class="card">
      <div style="font-size:11px;color:var(--text2);padding:8px 10px 0;font-weight:700">${validCount}팀 신청 중${applications.length>validCount?` (무효 ${applications.length-validCount}건 포함)`:''}</div>
      <table class="apply-tbl">
        <thead><tr><th>#</th><th>팀</th><th>1지망</th><th>2지망</th><th>3지망</th>${isFinOrApproved?'<th>결과</th>':''}<th>제출시각</th><th></th></tr></thead>
        <tbody>${applications.map((a,i)=>{
          const void_=isVoid(a);
          return `<tr style="${void_?'opacity:.3;':''}">
            <td style="color:var(--text3);font-family:'Space Mono',monospace">${String(i+1).padStart(2,'0')}</td>
            <td style="font-weight:600${void_?';text-decoration:line-through':''}">${a.teams.name}${void_?` <span class="pbadge none" style="font-size:9px">무효</span>`:''}</td>
            <td>${DAYS[a.pref1_day]} ${a.pref1_hour}:00</td>
            <td>${a.pref2_day!=null?DAYS[a.pref2_day]+' '+a.pref2_hour+':00':'—'}</td>
            <td>${a.pref3_day!=null?DAYS[a.pref3_day]+' '+a.pref3_hour+':00':'—'}</td>
            ${isFinOrApproved?`<td>${!void_&&a.assigned_day!=null?`<span class="pbadge ${pc(a.assigned_pref)}">${pl(a.assigned_pref)}</span> ${DAYS[a.assigned_day]} ${a.assigned_hour}:00`:`<span class="pbadge none">${void_?'무효':'미배정'}</span>`}</td>`:''}
            <td style="font-size:11px;color:var(--text3)">${fmtTime(a.submitted_at)}</td>
            <td><button class="btn btn-s btn-xs" onclick="delApp(${a.id})">취소</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
  }
  document.getElementById('applyContent').innerHTML=html;

  if(_applySchedTimer){clearTimeout(_applySchedTimer);_applySchedTimer=null;}
  const _MAX_T=24*3600000;
  if(isScheduled&&round?.open_at){
    const d=new Date(round.open_at)-Date.now();
    if(d>0&&d<_MAX_T) _applySchedTimer=setTimeout(async()=>{
      round=await fetchActiveRound(season).catch(()=>round);
      if(round)applications=await fetchApplications(round.id);
      renderApply();
    },d+500);
  }else if(isOpen&&round?.close_at){
    const d=new Date(round.close_at)-Date.now();
    if(d>0&&d<_MAX_T) _applySchedTimer=setTimeout(async()=>{
      const fresh=await fetchActiveRound(season).catch(()=>null);
      if(!fresh||fresh.status!=='open'){round=fresh;renderApply();return;}
      if(fresh.close_at&&new Date(fresh.close_at)>Date.now()){round=fresh;renderApply();return;}
      await updateRound(round.id,{status:'closed'}).catch(()=>{});
      _taBcCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
      round=await fetchActiveRound(season).catch(()=>round);
      if(round)applications=await fetchApplications(round.id);
      renderApply();
    },d+500);
  }
}

window.openNewRoundModal=function(){
  showModal('새 신청 설정',
    `<div><div class="fl">신청 시작 일시 (비워두면 즉시 시작)</div><input class="fi" type="datetime-local" id="nOA"/></div>
     <div><div class="fl">신청 마감 일시 (선택)</div><input class="fi" type="datetime-local" id="nCA"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" onclick="createNewRound()">설정</button>`
  );
};

window.createNewRound=async function(){
  const oa=document.getElementById('nOA').value,ca=document.getElementById('nCA').value;
  try{
    if(!oa&&!ca){
      round=await createRound({season});
    } else if(!oa&&ca){
      round=await createRound({season,close_at:new Date(ca).toISOString()});
    } else {
      round=await createRound({season,open_at:new Date(oa).toISOString(),close_at:ca?new Date(ca).toISOString():null});
    }
    applications=[]; closeModal();
    _taBcCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
    toast('신청이 설정되었습니다','ok'); renderApply();
  }catch(e){toast(errMsg(e),'err');}
};

window.closeRoundNow=async function(){
  if(!confirm('신청을 마감할까요? 이후 배정을 실행할 수 있습니다.')) return;
  try{
    round=await updateRound(round.id,{status:'closed'});
    _taBcCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
    toast('신청이 마감되었습니다','ok'); renderApply();
  }catch(e){toast(errMsg(e),'err');}
};

window.reopenRound=async function(){
  if(!confirm('신청을 다시 열까요?')) return;
  try{
    round=await updateRound(round.id,{status:'open'});
    _taBcCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
    toast('신청이 재오픈되었습니다','ok'); renderApply();
  }catch(e){toast(errMsg(e),'err');}
};

window.runAssignmentOnly=async function(){
  if(!confirm('배정을 실행할까요? 각 팀에 시간이 배정됩니다.')) return;
  try{
    toast('배정 실행 중...');
    applications=await fetchApplications(round.id);
    await runAssignment(round,applications,season);
    round=await fetchActiveRound(season); applications=await fetchApplications(round.id);
    toast('배정이 완료되었습니다. 확인 후 확정하세요.','ok'); renderApply();
  }catch(e){toast(errMsg(e),'err');}
};

window.confirmDraftOnly=async function(){
  if(!confirm('배정 결과를 확정하고 시간표에 반영할까요?')) return;
  try{
    applications=await fetchApplications(round.id);
    await approveDraft(round,applications,season);
    baseSlots=await fetchBaseSlots(season); merged=mergeSchedule(baseSlots,exceptions);
    round=await fetchActiveRound(season);
    toast('시간표 확정 완료','ok'); renderSchedule(); renderApply();
  }catch(e){toast(errMsg(e),'err');}
};
window.openCloseDeadlineModal=function(){
  if(!round) return;
  const pad=n=>String(n).padStart(2,'0');
  let curCA='';
  if(round.close_at){const d=new Date(round.close_at);curCA=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;}
  showModal('마감 예약/변경',
    `<div><div class="fl">마감 일시</div><input class="fi" type="datetime-local" id="cdCA" value="${curCA}"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     ${curCA?`<button class="btn btn-s" onclick="clearCloseDeadline()">예약 해제</button>`:''}
     <button class="btn btn-p" id="cdBtn" onclick="saveCloseDeadline()">저장</button>`
  );
};
window.saveCloseDeadline=async function(){
  const ca=document.getElementById('cdCA').value;
  if(!ca){toast('마감 일시를 입력해주세요','err');return;}
  const btn=document.getElementById('cdBtn'); btn.disabled=true;
  try{
    round=await updateRound(round.id,{close_at:new Date(ca).toISOString()});
    closeModal(); toast('마감 일시가 저장되었습니다','ok'); renderApply();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};
window.clearCloseDeadline=async function(){
  try{
    round=await updateRound(round.id,{close_at:null});
    closeModal(); toast('마감 예약이 해제되었습니다','ok'); renderApply();
  }catch(e){toast(errMsg(e),'err');}
};
window.openDiscardModal=function(){
  showModal('신청 폐기',
    `<div style="color:var(--danger);font-weight:600;font-size:13px">신청을 폐기하시겠습니까? 모든 신청 정보가 사라집니다.</div>
     <div class="fl">폐기하려면 하단에 <b>'폐기'</b>를 입력해주세요.</div>
     <input class="fi" type="text" id="discardInput" placeholder="폐기"/>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn" style="background:var(--danger);color:#fff" onclick="discardRound()">폐기</button>`
  );
};
window.discardRound=async function(){
  const val=document.getElementById('discardInput').value;
  if(val!=='폐기'){toast('"폐기"를 정확히 입력해주세요','err');return;}
  try{
    if(round){
      await supabase.from('time_applications').delete().eq('round_id',round.id);
      await updateRound(round.id,{status:'closed',draft_approved:true});
    }
    round=null; applications=[]; closeModal(); toast('신청이 폐기되었습니다','ok'); renderApply();
  }catch(e){toast(errMsg(e),'err');}
};
window.delApp=async function(id){
  if(!confirm('이 신청을 취소할까요?')) return;
  try{
    await deleteApplication(id); applications=applications.filter(a=>a.id!==id);
    toast('취소되었습니다'); renderApply();
  }catch(e){toast(errMsg(e),'err');}
};
window.openChangeScheduleModal=function(){
  if(!round) return;
  const pad=n=>String(n).padStart(2,'0');
  let curOA='',curCA='';
  if(round.open_at){const d=new Date(round.open_at);curOA=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;}
  if(round.close_at){const d=new Date(round.close_at);curCA=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;}
  showModal('예약 변경',
    `<div><div class="fl">신청 시작 일시</div><input class="fi" type="datetime-local" id="csOA" value="${curOA}"/></div>
     <div><div class="fl">신청 마감 일시 (선택)</div><input class="fi" type="datetime-local" id="csCA" value="${curCA}"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="csBtn" onclick="doChangeSchedule()">저장</button>`
  );
};

window.doChangeSchedule=async function(){
  const oa=document.getElementById('csOA').value,ca=document.getElementById('csCA').value;
  if(!oa){toast('시작 일시를 입력해주세요','err');return;}
  const btn=document.getElementById('csBtn'); btn.disabled=true;
  try{
    round=await updateRound(round.id,{open_at:new Date(oa).toISOString(),close_at:ca?new Date(ca).toISOString():null});
    closeModal(); toast('예약이 변경되었습니다','ok'); renderApply();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};

window.openApplyNow=async function(){
  if(!round) return;
  try{
    round=await updateRound(round.id,{open_at:null});
    toast('신청이 즉시 열렸습니다','ok'); renderApply();
  }catch(e){toast(errMsg(e),'err');}
};

// ── NOTICES ───────────────────────────────────────────────────────────
function renderNotices(){
  const el=document.getElementById('noticesContent');
  if(!el) return;
  if(!notices.length){
    el.innerHTML='<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px 0">공지가 없습니다</div>';
    return;
  }
  el.innerHTML=notices.map(n=>`
    <div class="irow">
      <span style="font-size:13px;flex:1">${n.content}</span>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:12px">
        <span style="font-size:10px;color:var(--text3)">${new Date(n.created_at).toLocaleDateString('ko-KR')}</span>
        <button class="btn btn-d btn-xs" onclick="delNotice(${n.id})">삭제</button>
      </div>
    </div>`).join('');
}
window.openNoticeModal=function(){
  showModal('공지 추가',
    `<div><div class="fl">공지 내용</div><input class="fi" id="nContent" placeholder="공지 내용을 입력하세요"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="ncBtn" onclick="addNotice()">등록</button>`
  );
};
window.addNotice=async function(){
  const content=document.getElementById('nContent').value.trim();
  if(!content){toast('내용을 입력해주세요','err');return;}
  const btn=document.getElementById('ncBtn'); btn.disabled=true;
  try{
    await createNotice(content); notices=await fetchNotices();
    closeModal(); toast('공지가 등록되었습니다','ok'); renderNotices();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};
window.delNotice=async function(id){
  try{
    await deleteNotice(id); notices=notices.filter(n=>n.id!==id);
    toast('공지가 삭제되었습니다'); renderNotices();
  }catch(e){toast(errMsg(e),'err');}
};

// ── CONTACTS ──────────────────────────────────────────────────────────
function renderContacts(){
  const el=document.getElementById('contactsContent');
  if(!el) return;
  if(!contacts.length){
    el.innerHTML='<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px 0">등록된 연락처가 없습니다</div>';
    return;
  }
  el.innerHTML=contacts.map(c=>`
    <div class="irow">
      <div style="display:flex;align-items:center;gap:10px;flex:1">
        <span style="font-size:11px;color:var(--text2);min-width:56px">${c.role}</span>
        <span style="font-size:13px;font-weight:700">${c.name}</span>
        ${c.phone?`<span style="font-size:12px;color:var(--text2)">${c.phone}</span>`:''}
      </div>
      <div style="display:flex;gap:5px;flex-shrink:0;margin-left:10px">
        <button class="btn btn-s btn-xs" onclick="openEditContactModal(${c.id})">수정</button>
        <button class="btn btn-d btn-xs" onclick="delContact(${c.id})">삭제</button>
      </div>
    </div>`).join('');
}

window.openAddContactModal=function(){
  showModal('연락처 추가',
    `<div><div class="fl">역할 (예: 회장, 부회장)</div><input class="fi" id="cRole" placeholder="역할" maxlength="20"/></div>
     <div><div class="fl">이름</div><input class="fi" id="cName" placeholder="이름" maxlength="20"/></div>
     <div><div class="fl">연락처 (선택)</div><input class="fi" id="cPhone" placeholder="010-xxxx-xxxx" maxlength="20"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="cBtn" onclick="saveContact()">추가</button>`
  );
};

window.openEditContactModal=function(id){
  const c=contacts.find(c=>c.id===id);
  showModal('연락처 수정',
    `<div><div class="fl">역할</div><input class="fi" id="cRole" value="${c.role}" maxlength="20"/></div>
     <div><div class="fl">이름</div><input class="fi" id="cName" value="${c.name}" maxlength="20"/></div>
     <div><div class="fl">연락처</div><input class="fi" id="cPhone" value="${c.phone||''}" maxlength="20"/></div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="cBtn" onclick="saveContact(${id})">저장</button>`
  );
};

window.saveContact=async function(id){
  const role=document.getElementById('cRole').value.trim();
  const name=document.getElementById('cName').value.trim();
  const phone=document.getElementById('cPhone').value.trim();
  if(!role||!name){toast('역할과 이름을 입력해주세요','err');return;}
  const btn=document.getElementById('cBtn'); btn.disabled=true;
  try{
    const c=await upsertContact({id,role,name,phone});
    if(id) { const idx=contacts.findIndex(x=>x.id===id); if(idx>=0) contacts[idx]=c; }
    else contacts.push(c);
    toast('저장되었습니다','ok'); closeModal(); renderContacts();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};

window.delContact=async function(id){
  if(!confirm('연락처를 삭제할까요?')) return;
  try{
    await deleteContact(id); contacts=contacts.filter(c=>c.id!==id);
    toast('삭제되었습니다'); renderContacts();
  }catch(e){toast(errMsg(e),'err');}
};

// ── ENSEMBLE ──────────────────────────────────────────────────────────
const SESSIONS=['보컬1','보컬2','기타1','기타2','베이스','키보드1','키보드2','드럼','이외 악기'];
let eRounds={regular:null,busking:null};
let eSongs={regular:[],busking:[]};
let eSessionMap={};
let eDraggingId=null;
let _ftRowIdx=0;
let eManualEntries={regular:[],busking:[]};
let eManualApps={regular:[],busking:[]};

function renderEnsemble(){
  ['regular','busking'].forEach(type=>{
    const r=eRounds[type];
    const songList=eSongs[type]||[];
    const phase=r?.phase||'closed';
    const hasSess2=!!r?.has_session2;
    const pm=(()=>{
      const names={draft:'준비',song:'곡 신청',song_end:'대기',session:'1차 세션 신청',session_end:hasSess2?'대기':'최종 팀 구성',session2:'2차 세션 신청',session2_end:'최종 팀 구성',closed:'완료'};
      const nums=hasSess2
        ?{draft:1,song:2,song_end:3,session:4,session_end:5,session2:6,session2_end:7,closed:8}
        :{draft:1,song:2,song_end:3,session:4,session_end:5,closed:6};
      const cls={draft:'closed',song:'song',song_end:'song',session:'session',session_end:'session',session2:'session',session2_end:'session',closed:'closed'};
      return {label:`${nums[phase]??'?'} ${names[phase]||phase}`,cls:cls[phase]||'closed'};
    })();

    // phase badge
    const badge=document.getElementById(`ephase${type==='regular'?'Regular':'Busking'}`);
    if(badge){ badge.textContent=pm.label; badge.className=`ensemble-phase ${pm.cls}`; }

    // controls + body
    const bodyEl=document.getElementById(`ensemble${type==='regular'?'Regular':'Busking'}Body`);
    if(!bodyEl) return;

    if(r?.mode==='manual'){
      if(badge){
        badge.textContent=`수동 진행${r.is_sheet_public?' — 공개':''}`;
        badge.className='ensemble-phase closed';
      }
      renderManualAdminBody(r,type,bodyEl);
      return;
    }

    // ── No round: empty state ──────────────────────────────────────────
    if(!r){
      bodyEl.innerHTML=`<div class="ens-empty">
        <div class="ens-empty-txt">진행 중인 회차가 없습니다</div>
        <button class="btn btn-p" onclick="openCreateRoundModal('${type}')">+ 새 회차 생성</button>
      </div>`;
      return;
    }

    // ── Build action bar (primary left / danger right) ─────────────────
    const fS=ts=>ts?fmtScheduled(ts):'—';
    const now2=Date.now();
    const schedFieldMap={
      draft:       [{field:'song_scheduled_at',     label:'곡 신청 오픈',  icon:'🕐'}],
      song:        [{field:'song_close_at',          label:'곡 신청 마감',  icon:'⏰'}],
      song_end:    [{field:'session_scheduled_at',  label:'세션 신청 오픈',icon:'🕐'}],
      session:     [{field:'session_close_at',       label:'세션 신청 마감',icon:'⏰'}],
      session_end: hasSess2?[{field:'session2_scheduled_at',label:'2차 세션 오픈',icon:'🕐'}]:[],
      session2:    [{field:'session2_close_at',      label:'2차 세션 마감', icon:'⏰'}],
    };

    let mainBtns='',sideBtns='';
    if(phase==='draft'){
      mainBtns=`<button class="btn btn-p btn-xs" onclick="startSongPhaseNow(${r.id})">곡 신청 열기</button>
                <button class="btn btn-s btn-xs" onclick="openAddFixedTeamModal(${r.id},'${type}')">+ 완성 팀 추가</button>`;
      sideBtns=`<button class="btn btn-d btn-xs" onclick="deleteRound(${r.id})">회차 삭제</button>`;
    } else if(phase==='song'){
      mainBtns=`<button class="btn btn-p btn-xs" onclick="startSongEndNow(${r.id})">곡 신청 종료</button>`;
      sideBtns=`<button class="btn btn-s btn-xs" onclick="revertPhase('${type}',${r.id})">이전 단계</button>
                <button class="btn btn-d btn-xs" onclick="closeRound(${r.id})">닫기</button>`;
    } else if(phase==='song_end'){
      mainBtns=`<button class="btn btn-p btn-xs" onclick="startSessionPhaseNow(${r.id})">세션 신청 열기</button>`;
      sideBtns=`<button class="btn btn-s btn-xs" onclick="revertPhase('${type}',${r.id})">이전 단계</button>
                <button class="btn btn-d btn-xs" onclick="closeRound(${r.id})">닫기</button>`;
    } else if(phase==='session'){
      mainBtns=`<button class="btn btn-p btn-xs" onclick="startSessionEndNow(${r.id})">세션 신청 종료</button>`;
      sideBtns=`<button class="btn btn-s btn-xs" onclick="revertPhase('${type}',${r.id})">이전 단계</button>
                <button class="btn btn-d btn-xs" onclick="closeRound(${r.id})">닫기</button>`;
    } else if(phase==='session_end'){
      const allSessApps=(eSongs[type]||[]).filter(s=>s.status!=='rejected').flatMap(s=>eSessionMap[s.id]||[]);
      const sess1DndDone=allSessApps.length===0||allSessApps.some(a=>a.status==='confirmed'||a.status==='rejected');
      const advLabel=r.has_session2?'2차 세션 신청으로':'완료';
      mainBtns=sess1DndDone?`<button class="btn btn-p btn-xs" onclick="advanceFromSessionEnd('${type}',${r.id})">${advLabel}</button>`:'';
      sideBtns=`<button class="btn btn-s btn-xs" onclick="revertPhase('${type}',${r.id})">이전 단계</button>
                <button class="btn btn-d btn-xs" onclick="closeRound(${r.id})">닫기</button>`;
    } else if(phase==='session2'){
      mainBtns=`<button class="btn btn-p btn-xs" onclick="startSession2EndNow(${r.id})">2차 세션 신청 종료</button>`;
      sideBtns=`<button class="btn btn-s btn-xs" onclick="revertPhase('${type}',${r.id})">이전 단계</button>
                <button class="btn btn-d btn-xs" onclick="closeRound(${r.id})">닫기</button>`;
    } else if(phase==='session2_end'){
      const allSessApps2=(eSongs[type]||[]).filter(s=>s.status!=='rejected').flatMap(s=>eSessionMap[s.id]||[]);
      const sess2Apps=allSessApps2.filter(a=>(a.session_round||1)===2);
      const sess2DndDone=sess2Apps.length===0||sess2Apps.some(a=>a.status==='confirmed'||a.status==='rejected');
      mainBtns=sess2DndDone?`<button class="btn btn-p btn-xs" onclick="completeRound(${r.id})">완료</button>`:'';
      sideBtns=`<button class="btn btn-s btn-xs" onclick="revertPhase('${type}',${r.id})">이전 단계</button>
                <button class="btn btn-d btn-xs" onclick="closeRound(${r.id})">닫기</button>`;
    } else if(phase==='closed'){
      mainBtns=`<button class="btn btn-s btn-xs" onclick="openCreateRoundModal('${type}')">새 회차 생성</button>
                <button class="btn btn-s btn-xs" onclick="exportEnsembleXlsx('${type}')">📥 엑셀로 내보내기</button>`;
    }

    // Schedule chip (inline in action bar; only show if not yet passed)
    let schedChip='';
    const sFields=schedFieldMap[phase]||[];
    if(sFields.length){
      const {field,label,icon}=sFields[0];
      const ts=r[field];
      const isFuture=ts&&new Date(ts)>now2;
      if(!ts||isFuture){
        const tsArg=ts?`'${ts}'`:'null';
        schedChip=`<span class="ens-sched-chip">${icon} ${label}: ${isFuture?`<b style="color:var(--accent2)">${fS(ts)}</b>`:'<span style="opacity:.55">미설정</span>'}<button class="btn btn-s" style="padding:0 5px;font-size:10px;line-height:1.7;margin-left:3px" onclick="openSetScheduleModal(${r.id},'${field}','${label}',${tsArg})">변경</button></span>`;
      }
    }

    // Round header: name + limits + settings
    const settingsBtn=phase!=='closed'?`<button class="btn btn-s btn-xs" onclick="openEditRoundModal(${r.id})">설정</button>`:'';
    const roundHdr=`<div class="ens-round-hdr">
      <span class="ens-round-name">${esc(r.name)}</span>
      <div style="display:flex;gap:6px;align-items:center">
        <span class="ens-round-limits">총 ${r.max_songs}곡 · 인당 ${r.max_songs_per_person}곡</span>
        ${settingsBtn}
      </div>
    </div>`;
    const actionBar=`<div class="ens-action-bar">
      <div class="ens-action-main">${mainBtns}${schedChip}</div>
      ${sideBtns?`<div class="ens-action-side">${sideBtns}</div>`:''}
    </div>`;

    const mkConfirmedSongHtml=(songList2,showDndBtn,dndBtnLabel='팀 구성 시작')=>{
      const confSongs=songList2.filter(s=>s.status!=='rejected');
      let h=confSongs.map((s,i)=>{
        const allSessDisp=(eSessionMap[s.id]||[]).filter(a=>a.status==='confirmed'||a.status==='rejected');
        let sh='';
        if(allSessDisp.length) sh=`<div class="e-sess-list">${allSessDisp.map(a=>{const rej=a.status==='rejected';const isApp=a.student_id===s.student_id;const appBadge=isApp?`<span style="font-size:9px;background:var(--accent);color:#000;border-radius:3px;padding:1px 4px;margin-left:3px;font-weight:700">신청자</span>`:'';return `<div class="e-sess-row" style="${rej?'opacity:.45':''}"><span class="e-sess-dot ${rej?'rejected':'confirmed'}"></span><span class="e-sess-name" style="${rej?'text-decoration:line-through;color:var(--text3)':''}${isApp?';font-weight:900':''}">${esc(a.applicant_name)}${appBadge}</span><div class="e-sess-tags">${a.sessions.map(x=>`<span class="e-sess-tag ${rej?'':'confirmed'}">${esc(x)}</span>`).join('')}</div></div>`;}).join('')}</div>`;
        return `<div class="e-song-item"><div class="e-song-hdr"><span class="e-song-num">${String(i+1).padStart(2,'0')}</span><div style="flex:1;min-width:0"><div class="e-song-title">${esc(s.title)}${s.is_fixed?ENS_FIXED_BADGE:''}</div><div class="e-song-artist">${esc(s.artist)}</div></div></div>${sh}</div>`;
      }).join('');
      if(showDndBtn) h+=`<div style="padding:12px 13px"><button class="btn btn-p" onclick="openEnsDndModal('${type}')">${dndBtnLabel}</button></div>`;
      return h;
    };

    let songsHtml='';
    if(phase==='session_end'){
      const allSessApps=(eSongs[type]||[]).filter(s=>s.status!=='rejected').flatMap(s=>eSessionMap[s.id]||[]);
      const dndDone=allSessApps.some(a=>a.status==='confirmed'||a.status==='rejected');
      if(dndDone){
        songsHtml=mkConfirmedSongHtml(songList,true,'팀 구성 다시 하기');
      } else {
        songsHtml=`<div style="padding:12px 13px"><button class="btn btn-p" onclick="openEnsDndModal('${type}')">팀 구성 시작</button></div>`;
      }
    } else if(phase==='session2_end'){
      const allSessApps2=(eSongs[type]||[]).filter(s=>s.status!=='rejected').flatMap(s=>eSessionMap[s.id]||[]);
      const sess2Apps=allSessApps2.filter(a=>(a.session_round||1)===2);
      const dndDone2=sess2Apps.some(a=>a.status==='confirmed'||a.status==='rejected');
      if(dndDone2){
        songsHtml=mkConfirmedSongHtml(songList,true,'팀 구성 다시 하기');
      } else {
        songsHtml=`<div style="padding:12px 13px"><button class="btn btn-p" onclick="openEnsDndModal('${type}')">팀 구성 시작</button></div>`;
      }
    } else {
      const active=songList.filter(s=>s.status!=='rejected');
      if(!active.length){
        songsHtml=`<div style="padding:16px;text-align:center;font-size:12px;color:var(--text3)">신청된 곡이 없습니다</div>`;
      } else {
        songsHtml=active.map((s,i)=>{
          const sessApps=eSessionMap[s.id]||[];
          let sessHtml='';
          const showSessPhases=['song_end','session','session_end','session2','session2_end','closed'];
          const showSess=sessApps.length&&(showSessPhases.includes(phase)||(s.is_fixed&&(phase==='draft'||phase==='song')));
          if(showSess){
            const isClosedPhase=phase==='closed';
            const displayApps=isClosedPhase?sessApps.filter(a=>a.status==='confirmed'):sessApps;
            if(displayApps.length){
              sessHtml=`<div class="e-sess-list">
                ${displayApps.map(a=>{
                  const rBadge=(a.session_round||1)===2?`<span style="font-size:9px;background:var(--accent2,#e89c3c);color:#fff;border-radius:3px;padding:1px 4px;margin-left:4px">2차</span>`:'';
                  const isAppRow=a.student_id===s.student_id;
                  const appBadgeRow=isAppRow?`<span style="font-size:9px;background:var(--accent);color:#000;border-radius:3px;padding:1px 4px;margin-left:3px;font-weight:700">신청자</span>`:'';
                  const delBtn=`<button class="btn btn-d btn-xs" style="margin-left:auto;padding:0 6px;font-size:10px;line-height:1.7" onclick="deleteSessionApp(${a.id})">삭제</button>`;
                  return `<div class="e-sess-row">
                  <span class="e-sess-dot ${a.status}"></span>
                  <span class="e-sess-name" style="${isAppRow?'font-weight:900':'normal'}">${esc(a.applicant_name)}${appBadgeRow}${rBadge} <span style="color:var(--text3);font-weight:400">${esc(a.student_id)}</span></span>
                  <div class="e-sess-tags">${a.sessions.map(x=>`<span class="e-sess-tag ${a.status==='confirmed'?'confirmed':''}">${esc(x)}</span>`).join('')}</div>
                  <span style="font-size:9px;color:var(--text3);flex-shrink:0">${fmtTime(a.created_at)}</span>
                  ${delBtn}
                </div>`;}).join('')}
              </div>`;
            }
          }
          const fixedBadge=s.is_fixed?`<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:2px;background:rgba(0,119,204,.12);color:var(--accent2);margin-left:4px">FIXED</span>`:'';
          const canDeleteFixed=(phase==='draft'||phase==='song')&&s.is_fixed;
          const deleteBtn=canDeleteFixed
            ?`<button class="btn btn-d btn-xs" style="flex-shrink:0;margin-left:4px" onclick="deleteFixedSong(${s.id})">삭제</button>`
            :phase==='song'&&!s.is_fixed
              ?`<button class="btn btn-d btn-xs" style="flex-shrink:0;margin-left:4px" onclick="rejectSong(${s.id})">삭제</button>`
              :'';
          return `<div class="e-song-item">
            <div class="e-song-hdr">
              <span class="e-song-num">${String(i+1).padStart(2,'0')}</span>
              <div style="flex:1;min-width:0">
                <div class="e-song-title">${esc(s.title)}${fixedBadge}</div>
                <div class="e-song-artist">${esc(s.artist)}</div>
              </div>
              ${deleteBtn}
            </div>
            <div class="e-song-meta">
              <span>${esc(s.applicant_name)} <span style="color:var(--text3)">${esc(s.student_id)}</span></span>
              <span style="color:var(--text3)">${esc(s.sessions.join(' · '))}</span>
            </div>
            ${sessHtml}
          </div>`;
        }).join('');
      }
    }

    bodyEl.innerHTML=roundHdr+actionBar+songsHtml;

    if(_ensSchedTimers[type]){clearTimeout(_ensSchedTimers[type]);_ensSchedTimers[type]=null;}
    if(r&&phase!=='closed'){
      const schedMap={
        draft:{field:'song_scheduled_at',update:{phase:'song',song_scheduled_at:null}},
        song:{field:'song_close_at',update:{phase:'song_end',song_close_at:null}},
        song_end:{field:'session_scheduled_at',update:{phase:'session',session_scheduled_at:null}},
        session:{field:'session_close_at',update:{phase:'session_end',session_close_at:null}},
        session_end:r.has_session2?{field:'session2_scheduled_at',update:{phase:'session2',session2_scheduled_at:null}}:null,
        session2:{field:'session2_close_at',update:{phase:'session2_end',session2_close_at:null}},
      };
      const entry=schedMap[phase];
      if(entry){
        const ts=r[entry.field];
        if(ts){
          const d=new Date(ts)-Date.now();
          const MAX_T=24*3600000;
          if(d<=0) _ensSchedTimers[type]=setTimeout(()=>autoAdvanceEnsPhase(r.id,phase,entry.update),0);
          else if(d<MAX_T) _ensSchedTimers[type]=setTimeout(()=>autoAdvanceEnsPhase(r.id,phase,entry.update),d+500);
        }
      }
    }
  });
}

function renderManualAdminBody(r,type,bodyEl){
  const entries=eManualEntries[type]||[];
  const isPublished=!!r.is_sheet_public;
  const teamNos=[...new Set(entries.map(e=>e.team_no))].sort((a,b)=>a-b);
  let h='';

  h+=`<div class="ens-round-hdr">
    <span class="ens-round-name">${esc(r.name)}</span>
  </div>`;

  h+=`<div class="ens-action-bar">
    <div class="ens-action-main">
      ${isPublished
        ?`<span style="font-size:11px;font-weight:600;color:var(--ok)">✓ 팀 공개됨</span>`
        :`<span style="font-size:11px;font-weight:600;color:var(--text3)">● 비공개</span>`}
    </div>
    <div class="ens-action-side">
      <button class="btn btn-s btn-xs" onclick="exportManualXlsx('${type}')">📥 XLSX</button>
      <button class="btn btn-s btn-xs" onclick="exportManualPng('${type}')">🖼️ PNG</button>
      ${!isPublished
        ?`<button class="btn btn-d btn-xs" onclick="closeAndPublishManual(${r.id})">회차 종료 및 팀 공개</button>`
        :`<button class="btn btn-p btn-xs" onclick="openCreateRoundModal('${type}')">새 회차 생성</button>`}
    </div>
  </div>`;

  h+=`<div style="padding:12px;display:flex;flex-direction:column;gap:10px">`;
  for(const no of teamNos){
    const te=entries.filter(e=>e.team_no===no).sort((a,b)=>a.sort_key-b.sort_key);
    const songName=te[0]?.song_name||'';
    const artistName=te[0]?.artist_name||'';
    h+=`<div style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface2);border-bottom:1px solid var(--border)">
        <span style="font-size:12px;font-weight:700;color:var(--text2);white-space:nowrap">팀 ${no}</span>
        <input class="fi" style="flex:1;padding:4px 8px;font-size:12px;margin:0" placeholder="곡명" value="${esc(songName)}"
               onblur="updateManualTeamInfo(${r.id},${no},'song_name',this.value)"/>
        <input class="fi" style="flex:1;padding:4px 8px;font-size:12px;margin:0" placeholder="아티스트명" value="${esc(artistName)}"
               onblur="updateManualTeamInfo(${r.id},${no},'artist_name',this.value)"/>
        <button class="btn btn-d btn-xs" style="white-space:nowrap" onclick="deleteManualTeam(${r.id},${no})">팀 삭제</button>
      </div>
      <div style="padding:6px 10px;display:flex;flex-direction:column;gap:4px">
        ${te.map(entry=>`<div style="display:flex;gap:6px;align-items:center">
          <input class="fi" style="flex:1;padding:3px 7px;font-size:12px;margin:0" placeholder="세션명" value="${esc(entry.session_name)}"
                 onblur="updateManualEntry(${entry.id},'session_name',this.value)"/>
          <input class="fi" style="flex:1;padding:3px 7px;font-size:12px;margin:0" placeholder="성명" value="${esc(entry.member_name)}"
                 onblur="updateManualEntry(${entry.id},'member_name',this.value)"/>
          <button class="btn btn-d btn-xs" style="padding:2px 7px;font-size:11px" onclick="deleteManualEntry(${entry.id},${r.id},${no})">✕</button>
        </div>`).join('')}
        <button class="btn btn-s" style="width:100%;margin-top:2px;font-size:12px"
                onclick="addManualSession(${r.id},${no})">+ 세션</button>
      </div>
    </div>`;
  }
  h+=`<button class="btn btn-p" style="width:100%;font-size:13px" onclick="addManualTeam(${r.id},'${type}')">+ 팀 추가</button>`;
  h+=`</div>`;

  bodyEl.innerHTML=h;
}

window.switchEnsTab=function(type){
  document.getElementById('ensTabRegular').classList.toggle('active',type==='regular');
  document.getElementById('ensTabBusking').classList.toggle('active',type==='busking');
  document.getElementById('ensembleRegularPanel').style.display=type==='regular'?'':'none';
  document.getElementById('ensembleBuskingPanel').style.display=type==='busking'?'':'none';
};

window.deleteSessionApp=async function(appId){
  if(!confirm('이 세션 신청을 삭제하시겠습니까?')) return;
  const {error}=await supabase.from('session_applications').delete().eq('id',appId);
  if(error){alert('삭제 실패: '+error.message);return;}
  // remove from local state
  for(const sid of Object.keys(eSessionMap)){
    eSessionMap[sid]=eSessionMap[sid].filter(a=>a.id!==appId);
  }
  renderEnsemble();
};

window.openAddFixedTeamModal=function(roundId,type){
  _ftRowIdx=0;
  const sessCbHtml=idx=>SESSIONS.map(sess=>
    `<label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap;cursor:pointer"><input type="checkbox" name="ftSess_${idx}" value="${sess}" style="margin:0"> ${sess}</label>`
  ).join('');
  const rowHtml=idx=>`<div id="ftRow${idx}" style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:11px;color:var(--text3);font-weight:700">참여자 ${idx+1}${idx===0?' (자동 신청자)':''}</span>
      ${idx>0?`<button class="btn btn-d btn-xs" style="margin-left:auto;padding:0 6px;font-size:10px;line-height:1.7" onclick="removeFtRow(${idx})">제거</button>`:''}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <div><div class="fl">이름</div><input class="fi" id="ftName${idx}" placeholder="이름"/></div>
      <div><div class="fl">학번</div><input class="fi" id="ftSid${idx}" placeholder="학번"/></div>
    </div>
    <div class="fl">담당 세션</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px 10px">${sessCbHtml(idx)}</div>
  </div>`;
  showModal('완성 팀 추가',
    `<div><div class="fl">곡 제목</div><input class="fi" id="ftTitle" placeholder="곡 제목"/></div>
     <div style="margin-bottom:12px"><div class="fl">아티스트</div><input class="fi" id="ftArtist" placeholder="아티스트"/></div>
     <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text2);margin-bottom:8px">참여자</div>
     <div id="ftRows">${rowHtml(0)}</div>
     <button class="btn btn-s" style="width:100%;margin-top:4px" onclick="addFtParticipantRow()">+ 참여자 추가</button>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="ftSubmitBtn" onclick="submitAddFixedTeam(${roundId},'${type}')">저장</button>`
  );
};

window.addFtParticipantRow=function(){
  _ftRowIdx++;
  const idx=_ftRowIdx;
  const sessCbHtml=SESSIONS.map(sess=>
    `<label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap;cursor:pointer"><input type="checkbox" name="ftSess_${idx}" value="${sess}" style="margin:0"> ${sess}</label>`
  ).join('');
  const html=`<div id="ftRow${idx}" style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:11px;color:var(--text3);font-weight:700">참여자 ${idx+1}</span>
      <button class="btn btn-d btn-xs" style="margin-left:auto;padding:0 6px;font-size:10px;line-height:1.7" onclick="removeFtRow(${idx})">제거</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <div><div class="fl">이름</div><input class="fi" id="ftName${idx}" placeholder="이름"/></div>
      <div><div class="fl">학번</div><input class="fi" id="ftSid${idx}" placeholder="학번"/></div>
    </div>
    <div class="fl">담당 세션</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px 10px">${sessCbHtml}</div>
  </div>`;
  document.getElementById('ftRows').insertAdjacentHTML('beforeend',html);
};

window.removeFtRow=function(idx){
  document.getElementById('ftRow'+idx)?.remove();
};

window.submitAddFixedTeam=async function(roundId,type){
  const title=(document.getElementById('ftTitle')?.value||'').trim();
  const artist=(document.getElementById('ftArtist')?.value||'').trim();
  if(!title){toast('곡 제목을 입력해주세요','err');return;}
  if(!artist){toast('아티스트를 입력해주세요','err');return;}
  const rowEls=[...document.querySelectorAll('#ftRows>[id^="ftRow"]')];
  const participants=rowEls.map(el=>{
    const idx=el.id.replace('ftRow','');
    const name=(document.getElementById('ftName'+idx)?.value||'').trim();
    const sid=(document.getElementById('ftSid'+idx)?.value||'').trim();
    const sessions=[...el.querySelectorAll('input[type="checkbox"]:checked')].map(cb=>cb.value);
    return {name,sid,sessions};
  }).filter(p=>p.name&&p.sid);
  if(!participants.length){toast('참여자를 1명 이상 입력해주세요','err');return;}
  const first=participants[0];
  if(!first.sessions.length){toast('첫 번째 참여자의 담당 세션을 선택해주세요','err');return;}
  const allSessions=[...new Set(participants.flatMap(p=>p.sessions))];
  const btn=document.getElementById('ftSubmitBtn'); btn.disabled=true;
  try{
    const {data:songData,error:songErr}=await supabase.from('song_applications').insert({
      round_id:roundId,title,artist,
      applicant_name:first.name,student_id:first.sid,
      sessions:allSessions,status:'confirmed',is_fixed:true
    }).select().single();
    if(songErr) throw songErr;
    const sessInserts=participants.map(p=>({
      song_id:songData.id,round_id:roundId,applicant_name:p.name,student_id:p.sid,
      sessions:p.sessions,status:'confirmed',session_round:1
    }));
    const {error:sessErr}=await supabase.from('session_applications').insert(sessInserts);
    if(sessErr) throw sessErr;
    toast('완성 팀이 추가됐습니다','ok'); closeModal(); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};

window.deleteFixedSong=async function(songId){
  if(!confirm('이 완성 팀을 삭제하시겠습니까?')) return;
  try{
    await supabase.from('session_applications').delete().eq('song_id',songId);
    const {error}=await supabase.from('song_applications').delete().eq('id',songId);
    if(error) throw error;
    toast('삭제됐습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.addManualTeam=async function(roundId,type){
  const entries=eManualEntries[type]||[];
  const nextNo=entries.length?Math.max(...entries.map(e=>e.team_no))+1:1;
  const {error}=await supabase.from('manual_entries').insert({round_id:roundId,team_no:nextNo,song_name:'',artist_name:'',session_name:'',member_name:'',sort_key:0});
  if(error){toast(errMsg(error),'err');return;}
  await ensUpdated();
};
window.deleteManualTeam=async function(roundId,teamNo){
  if(!confirm(`팀 ${teamNo}을(를) 삭제하시겠습니까?`)) return;
  const {error}=await supabase.from('manual_entries').delete().eq('round_id',roundId).eq('team_no',teamNo);
  if(error){toast(errMsg(error),'err');return;}
  await ensUpdated();
};
window.addManualSession=async function(roundId,teamNo){
  const type=eRounds.regular?.id===roundId?'regular':'busking';
  const te=(eManualEntries[type]||[]).filter(e=>e.team_no===teamNo);
  const first=te[0];
  const {error}=await supabase.from('manual_entries').insert({round_id:roundId,team_no:teamNo,song_name:first?.song_name||'',artist_name:first?.artist_name||'',session_name:'',member_name:'',sort_key:te.length});
  if(error){toast(errMsg(error),'err');return;}
  await ensUpdated();
};
window.deleteManualEntry=async function(entryId,roundId,teamNo){
  const type=eRounds.regular?.id===roundId?'regular':'busking';
  const te=(eManualEntries[type]||[]).filter(e=>e.team_no===teamNo);
  if(te.length<=1&&!confirm(`마지막 세션입니다. 팀 ${teamNo}을(를) 삭제하시겠습니까?`)) return;
  const {error}=await supabase.from('manual_entries').delete().eq('id',entryId);
  if(error){toast(errMsg(error),'err');return;}
  await ensUpdated();
};
window.updateManualEntry=async function(entryId,field,value){
  await supabase.from('manual_entries').update({[field]:value}).eq('id',entryId);
};
window.updateManualTeamInfo=async function(roundId,teamNo,field,value){
  await supabase.from('manual_entries').update({[field]:value}).eq('round_id',roundId).eq('team_no',teamNo);
};
window.closeAndPublishManual=async function(roundId){
  if(!confirm('이 회차를 종료하고 팀 구성 결과를 공개할까요? 회차를 종료해도 구성을 수정할 수 있습니다.')) return;
  const {error}=await supabase.from('ensemble_rounds').update({is_sheet_public:true}).eq('id',roundId);
  if(error){toast(errMsg(error),'err');return;}
  toast('팀이 공개됐습니다','ok'); await ensUpdated();
};

window.exportManualXlsx=function(type){
  const entries=eManualEntries[type]||[]; const r=eRounds[type];
  if(!entries.length){toast('데이터가 없습니다','err');return;}
  const teamNos=[...new Set(entries.map(e=>e.team_no))].sort((a,b)=>a-b);
  const rows=[['팀 번호','곡명','아티스트명','세션명','성명']];
  const merges=[];
  let ri=1;
  for(const no of teamNos){
    const te=entries.filter(e=>e.team_no===no).sort((a,b)=>a.sort_key-b.sort_key);
    te.forEach((e,i)=>rows.push([i===0?no:'',i===0?e.song_name:'',i===0?e.artist_name:'',e.session_name,e.member_name]));
    if(te.length>1) merges.push({s:{r:ri,c:0},e:{r:ri+te.length-1,c:0}},{s:{r:ri,c:1},e:{r:ri+te.length-1,c:1}},{s:{r:ri,c:2},e:{r:ri+te.length-1,c:2}});
    ri+=te.length;
  }
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!merges']=merges;
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,r?.name||'합주');
  XLSX.writeFile(wb,`${r?.name||'합주'}_팀구성.xlsx`);
};

window.exportManualPng=async function(type){
  const entries=eManualEntries[type]||[]; const r=eRounds[type];
  if(!entries.length){toast('데이터가 없습니다','err');return;}
  if(typeof html2canvas==='undefined'){toast('html2canvas 로딩 중입니다. 잠시 후 다시 시도해주세요','err');return;}
  const eh=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const teamNos=[...new Set(entries.map(e=>e.team_no))].sort((a,b)=>a-b);
  const buildTable=nos=>{
    let tb='';
    for(const no of nos){
      const te=entries.filter(e=>e.team_no===no).sort((a,b)=>a.sort_key-b.sort_key);
      te.forEach((e,i)=>{tb+=`<tr>${i===0?`<td rowspan="${te.length}" style="border:1px solid #ccc;padding:6px 10px;text-align:center;font-weight:700;vertical-align:middle">${no}</td><td rowspan="${te.length}" style="border:1px solid #ccc;padding:6px 10px;vertical-align:middle">${eh(e.song_name)}</td><td rowspan="${te.length}" style="border:1px solid #ccc;padding:6px 10px;vertical-align:middle">${eh(e.artist_name)}</td>`:''}<td style="border:1px solid #ccc;padding:6px 10px">${eh(e.session_name)}</td><td style="border:1px solid #ccc;padding:6px 10px">${eh(e.member_name)}</td></tr>`;});
    }
    return `<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px"><thead><tr style="background:#f0f0f0"><th style="border:1px solid #ccc;padding:7px 10px">팀 번호</th><th style="border:1px solid #ccc;padding:7px 10px">곡명</th><th style="border:1px solid #ccc;padding:7px 10px">아티스트명</th><th style="border:1px solid #ccc;padding:7px 10px">세션명</th><th style="border:1px solid #ccc;padding:7px 10px">성명</th></tr></thead><tbody>${tb}</tbody></table>`;
  };
  const groups=[];
  for(let i=0;i<teamNos.length;i+=4) groups.push(teamNos.slice(i,i+4));
  try{
    const canvases=[];
    for(const grp of groups){
      const div=document.createElement('div');
      div.style.cssText='position:fixed;top:-9999px;left:-9999px;background:#fff;padding:16px';
      div.innerHTML=buildTable(grp);
      document.body.appendChild(div);
      const canvas=await html2canvas(div,{backgroundColor:'#ffffff',scale:2});
      document.body.removeChild(div);
      canvases.push(canvas);
    }
    if(canvases.length===1){
      const a=document.createElement('a');
      a.download=`${r?.name||'합주'}_팀구성.png`;
      a.href=canvases[0].toDataURL('image/png');
      a.click();
    } else {
      if(typeof JSZip==='undefined'){toast('JSZip 로딩 중입니다. 잠시 후 다시 시도해주세요','err');return;}
      const zip=new JSZip();
      canvases.forEach((c,i)=>zip.file(`${r?.name||'합주'}_팀구성_${i+1}.png`,c.toDataURL('image/png').split(',')[1],{base64:true}));
      const blob=await zip.generateAsync({type:'blob'});
      const a=document.createElement('a');
      a.download=`${r?.name||'합주'}_팀구성.zip`;
      a.href=URL.createObjectURL(blob);
      a.click();
    }
  }catch(e){toast('PNG 내보내기 실패: '+e.message,'err');}
};

// ── ENSEMBLE DnD MODAL ───────────────────────────────────────────────
const ENS_FIXED_BADGE=`<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:2px;background:rgba(0,119,204,.12);color:var(--accent2);margin-left:4px">FIXED</span>`;
let eDndSt=null;
let eDndDrag=null;
let eDndFilter=null;
let eMobileSelected=null;

const ENS_SESS_ORDER=SESSIONS;
function sessOrder(s){const i=ENS_SESS_ORDER.indexOf(s);return i===-1?99:i;}
function sortSongSlots(slots){slots.sort((a,b)=>sessOrder(a.overrideSession??a.session)-sessOrder(b.overrideSession??b.session)||new Date(a.createdAt)-new Date(b.createdAt));}
function fmtDndTime(ts){if(!ts)return'';const d=new Date(ts);return`${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;}
function makeSlots(app,songTitle='',songApplicantSid=null){return app.sessions.map(session=>({id:`${app.id}-${session}`,appId:app.id,session,applicantName:app.applicant_name,studentId:app.student_id,createdAt:app.created_at,songTitle,sessionRound:app.session_round||1,isApplicant:!!(songApplicantSid&&app.student_id===songApplicantSid),isManual:!!(app.is_manual)}));}

function computeEnsDndInitial(type){
  const r=eRounds[type]; if(!r) return null;
  const confirmedSongs=(eSongs[type]||[]).filter(s=>s.status==='confirmed');
  const allApps=confirmedSongs.flatMap(s=>(eSessionMap[s.id]||[]));
  const savedKey=`ensDnd_${type}_${r.id}`;
  const songs=[]; const unassigned=[];
  const songTitleById=Object.fromEntries(confirmedSongs.map(s=>[s.id,s.title]));
  const songApplicantSidById=Object.fromEntries(confirmedSongs.map(s=>[s.id,s.student_id]));
  const savedRaw=localStorage.getItem(savedKey);
  if(savedRaw){
    try{
      const savedData=JSON.parse(savedRaw);
      const locMap=Object.fromEntries(savedData.map(({id,loc})=>[id,loc]));
      const osMap=Object.fromEntries(savedData.filter(d=>d.os).map(({id,os})=>[id,os]));
      for(const song of confirmedSongs) songs.push({song,slots:[]});
      for(const app of allApps) for(const sl of makeSlots(app,songTitleById[app.song_id]||'',songApplicantSidById[app.song_id]||null)){
        if(osMap[sl.id]) sl.overrideSession=osMap[sl.id];
        if(sl.isApplicant){
          const own=songs.find(s=>s.song.id===app.song_id);
          if(own) own.slots.push(sl);
        } else {
          const songEntry=songs.find(s=>s.song.id===locMap[sl.id]);
          if(songEntry) songEntry.slots.push(sl); else unassigned.push(sl);
        }
      }
      for(const app of eManualApps[type]) for(const sl of makeSlots(app,'',null)){
        if(osMap[sl.id]) sl.overrideSession=osMap[sl.id];
        const songEntry=songs.find(s=>s.song.id===locMap[sl.id]);
        if(songEntry) songEntry.slots.push(sl); else unassigned.push(sl);
      }
      for(const s of songs) sortSongSlots(s.slots);
      return {type,roundId:r.id,savedKey,songs,unassigned};
    }catch{}
  }
  const hasConfirmed=allApps.some(a=>a.status==='confirmed');
  if(hasConfirmed){
    for(const song of confirmedSongs){
      const sApps=eSessionMap[song.id]||[];
      const confirmedSlots=sApps.filter(a=>a.status==='confirmed').flatMap(a=>makeSlots(a,song.title,song.student_id));
      const pendingSlots=sApps.filter(a=>a.status==='pending').flatMap(a=>makeSlots(a,song.title,song.student_id));
      const slots=[...confirmedSlots];
      pendingSlots.forEach(sl=>{if(sl.isApplicant||sl.sessionRound>=2)slots.push(sl);else unassigned.push(sl);});
      sortSongSlots(slots);
      songs.push({song,slots});
    }
    for(const app of eManualApps[type]) unassigned.push(...makeSlots(app,'',null));
    return {type,roundId:r.id,savedKey,songs,unassigned};
  }
  for(const song of confirmedSongs){
    const apps=(eSessionMap[song.id]||[]).slice().sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
    const claimed=new Set(); const slots=[];
    for(const app of apps) for(const sl of makeSlots(app,song.title,song.student_id)){
      if(sl.isApplicant){slots.push(sl);claimed.add(sl.session);}
      else if(!claimed.has(sl.session)){claimed.add(sl.session);slots.push(sl);}
      else unassigned.push(sl);
    }
    sortSongSlots(slots);
    songs.push({song,slots});
  }
  for(const app of eManualApps[type]) unassigned.push(...makeSlots(app,'',null));
  return {type,roundId:r.id,savedKey,songs,unassigned};
}

function ensDndSaveState(){
  if(!eDndSt) return;
  const enc=sl=>({id:sl.id,loc:null,...(sl.overrideSession?{os:sl.overrideSession}:{})});
  localStorage.setItem(eDndSt.savedKey,JSON.stringify([
    ...eDndSt.songs.flatMap(s=>s.slots.map(sl=>({...enc(sl),loc:s.song.id}))),
    ...eDndSt.unassigned.map(sl=>({...enc(sl),loc:'pool'}))
  ]));
}

window.openEnsDndModal=function(type){
  const r=eRounds[type]; if(!r) return;
  const savedKey=`ensDnd_${type}_${r.id}`;
  if(localStorage.getItem(savedKey)&&!confirm('이전에 임시저장한 내용이 있습니다.\n이어서 진행하시겠습니까?\n(취소하면 처음부터 자동 배정합니다)')) localStorage.removeItem(savedKey);
  eDndSt=computeEnsDndInitial(type); if(!eDndSt) return;
  eDndFilter=null; eMobileSelected=null;
  document.getElementById('ensDndRoundName').textContent=r.name||'팀 구성';
  document.getElementById('ensDndTypeName').textContent=type==='regular'?'일반 합주':'버스킹 합주';
  renderEnsDndModal();
  document.getElementById('ensDndModal').style.display='flex';
  document.body.style.overflow='hidden';
  window._ensDndResize=()=>{if(eDndSt)renderEnsDndModal();};
  window.addEventListener('resize',window._ensDndResize);
};
window.closeEnsDndModal=function(){
  document.getElementById('ensDndModal').style.display='none';
  document.body.style.overflow='';
  if(window._ensDndResize){window.removeEventListener('resize',window._ensDndResize);window._ensDndResize=null;}
  eDndSt=null;
};
window.ensDndSave=function(){ensDndSaveState();toast('임시저장됐습니다','ok');};
window.ensDndSetFilter=function(session){eDndFilter=session;renderEnsDndPool();};

function getConflictedSlotIds(slots){
  const cnt={};
  for(const sl of slots){const k=sl.overrideSession??sl.session;cnt[k]=(cnt[k]||0)+1;}
  return new Set(slots.filter(sl=>cnt[sl.overrideSession??sl.session]>1).map(sl=>sl.id));
}

function ensSlotCardHtml(sl,conflicted,inPool=false){
  const sid=sl.id.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const pinned=sl.isApplicant;
  const dragAttrs=pinned?'draggable="false"':`draggable="true" ondragstart="ensDndDragStart(event,'${sid}')" ondragend="ensDndDragEnd(event)"`;
  const applicantBadge=pinned?'<span style="font-size:9px;background:var(--accent);color:#000;border-radius:3px;padding:1px 4px;margin-left:3px;font-weight:700">신청자</span>':'';
  const r2Badge=sl.sessionRound===2?'<span style="font-size:9px;background:var(--accent2,#e89c3c);color:#fff;border-radius:3px;padding:1px 4px;margin-left:2px">2차</span>':'';
  const effSess=sl.overrideSession??sl.session;
  const sessTag=pinned
    ?`<span class="ens-member-tag">${effSess}</span>`
    :`<select class="ens-sess-sel${conflicted?' conflict':''}" onchange="setSlotSession('${sid}',this.value)" onclick="event.stopPropagation()" ondragstart="event.stopPropagation()">${SESSIONS.map(s=>`<option value="${s}"${s===effSess?' selected':''}>${s}${s===sl.session?' *':''}</option>`).join('')}</select>`;
  const topLine=sl.isManual
    ?`<div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:9px;background:#6c757d;color:#fff;border-radius:3px;padding:1px 4px">수동 추가</span>${inPool?`<button style="font-size:11px;padding:0 4px;line-height:1.4;background:none;border:none;color:var(--text3);cursor:pointer" onclick="deleteManualPoolEntry('${sid}')" ondragstart="event.stopPropagation()">✕</button>`:''}</div>`
    :`<span style="font-size:10px;color:var(--text3);line-height:1.2">${fmtDndTime(sl.createdAt)}</span>`;
  return `<div class="ens-member-card${conflicted?' conflict':''}${pinned?' applicant':''}" ${dragAttrs} data-id="${sl.id}">
    ${topLine}
    <div><span class="ens-member-name" style="${pinned?'font-weight:900':'normal'}">${esc(sl.applicantName)}</span><span class="ens-member-sid">${esc(sl.studentId?.slice(-3)||'')}</span>${sl.songTitle?`<span class="ens-member-sid" style="margin-left:4px">${esc(sl.songTitle)}</span>`:''}${applicantBadge}${r2Badge}</div>
    <div class="ens-member-tags">${sessTag}</div>
  </div>`;
}

window.setSlotSession=function(slotId,newSession){
  if(!eDndSt) return;
  let sl=null;
  for(const s of eDndSt.songs){sl=s.slots.find(x=>x.id===slotId);if(sl)break;}
  if(!sl) sl=eDndSt.unassigned.find(x=>x.id===slotId);
  if(!sl) return;
  sl.overrideSession=newSession;
  ensDndSaveState();
  renderEnsDndSongs();
  renderEnsDndPool();
};

function renderEnsDndPool(){
  if(!eDndSt) return;
  document.getElementById('ensDndPoolCount').textContent=eDndSt.unassigned.length;
  const usedSess=[...new Set(eDndSt.unassigned.map(sl=>sl.overrideSession??sl.session))].sort((a,b)=>sessOrder(a)-sessOrder(b));
  document.getElementById('ensDndFilterRow').innerHTML=usedSess.length
    ?`<button class="btn btn-xs ${!eDndFilter?'btn-p':'btn-s'}" style="font-size:10px;padding:2px 7px" onclick="ensDndSetFilter(null)">전체</button>`
      +usedSess.map(s=>`<button class="btn btn-xs ${eDndFilter===s?'btn-p':'btn-s'}" style="font-size:10px;padding:2px 7px" onclick="ensDndSetFilter('${s}')">${s}</button>`).join('')
    :'';
  const filtered=eDndFilter?eDndSt.unassigned.filter(sl=>(sl.overrideSession??sl.session)===eDndFilter):eDndSt.unassigned;
  const groups={};
  for(const sl of filtered){
    if(!groups[sl.appId]) groups[sl.appId]={createdAt:sl.createdAt,slots:[]};
    groups[sl.appId].slots.push(sl);
  }
  const sorted=Object.values(groups).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  document.getElementById('ensDndPoolCards').innerHTML=sorted.length
    ?sorted.map(g=>g.slots.length===1?ensSlotCardHtml(g.slots[0],false,true):`<div class="ens-pool-group">${g.slots.map(sl=>ensSlotCardHtml(sl,false,true)).join('')}</div>`).join('')
    :'<div class="ens-empty-hint">없음</div>';
}

function renderEnsDndSongs(){
  if(!eDndSt) return;
  document.getElementById('ensDndSongs').innerHTML=eDndSt.songs.map(({song,slots})=>{
    const conflicts=getConflictedSlotIds(slots);
    const filledSess=new Set(slots.map(sl=>sl.overrideSession??sl.session));
    const complete=(song.sessions||[]).length>0&&(song.sessions||[]).every(s=>filledSess.has(s));
    return `<div class="ens-song-card${complete?' complete':''}" data-song-id="${song.id}"
      ondragover="ensDndDragOverSong(event,${song.id})"
      ondragleave="ensDndDragLeaveSong(event)"
      ondrop="ensDndDropToSong(event,${song.id})">
      <div class="ens-song-card-hdr">
        <div class="ens-song-card-title">${esc(song.title)}${song.is_fixed?ENS_FIXED_BADGE:''}</div>
        <div class="ens-song-card-meta">${esc(song.artist)} · ${(song.sessions||[]).map(x=>`<span style="${filledSess.has(x)?'':'color:#c0392b'}">${esc(x)}</span>`).join(' · ')}</div>
      </div>
      <div class="ens-song-members">
        ${slots.length?slots.map(sl=>ensSlotCardHtml(sl,conflicts.has(sl.id))).join(''):'<div class="ens-empty-hint">멤버 없음</div>'}
      </div>
    </div>`;
  }).join('');
}
function renderEnsDndModal(){
  if(!eDndSt) return;
  if(window.innerWidth<=700){renderEnsDndMobile();return;}
  renderEnsDndPool();
  renderEnsDndSongs();
}

// ── MOBILE TAP UI ─────────────────────────────────────────────────────
function ensMobPoolCardHtml(sl){
  const sid=sl.id.replace(/'/g,"\\'");
  const isSel=eMobileSelected===sl.id;
  const effSess=sl.overrideSession??sl.session;
  return `<div class="ens-member-card${isSel?' mob-sel':''}" onclick="ensMobSelectPool('${sid}')">
    ${sl.isManual?`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px"><span style="font-size:9px;background:#6c757d;color:#fff;border-radius:3px;padding:1px 4px">수동 추가</span><button style="font-size:11px;padding:1px 5px;background:none;border:1px solid var(--border);border-radius:3px;color:var(--text3);cursor:pointer" onclick="event.stopPropagation();deleteManualPoolEntry('${sid}')">✕</button></div>`:''}
    <div style="display:flex;align-items:center;gap:6px">
      <div style="flex:1;min-width:0">
        <span class="ens-member-name">${esc(sl.applicantName)}</span>
        <span class="ens-member-sid">${esc(sl.studentId?.slice(-3)||'')}</span>
        ${sl.songTitle?`<span class="ens-member-sid" style="margin-left:4px">${esc(sl.songTitle)}</span>`:''}
        ${sl.sessionRound===2?'<span style="font-size:9px;background:var(--accent2);color:#fff;border-radius:3px;padding:1px 4px;margin-left:2px">2차</span>':''}
      </div>
      <span class="ens-member-tag">${effSess}</span>
    </div>
  </div>`;
}

function ensMobSongMemberHtml(sl,conflicted){
  const sid=sl.id.replace(/'/g,"\\'");
  const pinned=sl.isApplicant;
  const effSess=sl.overrideSession??sl.session;
  const sessOpts=SESSIONS.map(s=>`<option value="${s}"${s===effSess?' selected':''}>${s}${s===sl.session?' *':''}</option>`).join('');
  return `<div class="ens-member-card${conflicted?' conflict':''}${pinned?' applicant':''}">
    <div style="display:flex;align-items:center;gap:6px">
      <div style="flex:1;min-width:0">
        <span class="ens-member-name" style="${pinned?'font-weight:900':''}">${esc(sl.applicantName)}</span>
        <span class="ens-member-sid">${esc(sl.studentId?.slice(-3)||'')}</span>
        ${pinned?'<span style="font-size:9px;background:var(--accent);color:#000;border-radius:3px;padding:1px 4px;margin-left:3px;font-weight:700">신청자</span>':''}
        ${sl.sessionRound===2?'<span style="font-size:9px;background:var(--accent2);color:#fff;border-radius:3px;padding:1px 4px;margin-left:2px">2차</span>':''}
      </div>
      ${pinned?'':`<button class="ens-mob-remove" onclick="event.stopPropagation();ensMobRemove('${sid}')">×</button>`}
    </div>
    <div class="ens-member-tags">
      ${pinned?`<span class="ens-member-tag">${effSess}</span>`:`<select class="ens-sess-sel${conflicted?' conflict':''}" onchange="setSlotSession('${sid}',this.value)" onclick="event.stopPropagation()">${sessOpts}</select>`}
    </div>
  </div>`;
}

function renderEnsDndMobile(){
  if(!eDndSt) return;
  // Pool section
  document.getElementById('ensDndPoolCount').textContent=eDndSt.unassigned.length;
  const usedSess=[...new Set(eDndSt.unassigned.map(sl=>sl.overrideSession??sl.session))].sort((a,b)=>sessOrder(a)-sessOrder(b));
  document.getElementById('ensDndFilterRow').innerHTML=usedSess.length
    ?`<button class="btn btn-xs ${!eDndFilter?'btn-p':'btn-s'}" style="font-size:10px;padding:2px 7px" onclick="ensDndSetFilter(null)">전체</button>`
      +usedSess.map(s=>`<button class="btn btn-xs ${eDndFilter===s?'btn-p':'btn-s'}" style="font-size:10px;padding:2px 7px" onclick="ensDndSetFilter('${s}')">${s}</button>`).join('')
    :'';
  const hint=document.getElementById('ensMobHint');
  if(hint){
    hint.classList.toggle('show',eMobileSelected!==null);
    hint.textContent=eMobileSelected?'배정할 곡을 탭하세요 · 다시 탭하면 선택 취소':'';
  }
  const filtered=eDndFilter?eDndSt.unassigned.filter(sl=>(sl.overrideSession??sl.session)===eDndFilter):eDndSt.unassigned;
  const groups={};
  for(const sl of filtered){if(!groups[sl.appId])groups[sl.appId]={createdAt:sl.createdAt,slots:[]};groups[sl.appId].slots.push(sl);}
  const sorted=Object.values(groups).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  document.getElementById('ensDndPoolCards').innerHTML=sorted.length
    ?sorted.map(g=>g.slots.length===1?ensMobPoolCardHtml(g.slots[0]):`<div class="ens-pool-group">${g.slots.map(sl=>ensMobPoolCardHtml(sl)).join('')}</div>`).join('')
    :'<div class="ens-empty-hint">없음</div>';
  // Songs section
  const hasSel=eMobileSelected!==null;
  document.getElementById('ensDndSongs').innerHTML=eDndSt.songs.map(({song,slots})=>{
    const conflicts=getConflictedSlotIds(slots);
    const filledSess=new Set(slots.map(sl=>sl.overrideSession??sl.session));
    return `<div class="ens-song-card${hasSel?' mob-target':''}" data-song-id="${song.id}"${hasSel?` onclick="ensMobAssign(${song.id})"`:''}>
      <div class="ens-song-card-hdr">
        <div>
          <div class="ens-song-card-title">${esc(song.title)}${song.is_fixed?ENS_FIXED_BADGE:''}</div>
          <div class="ens-song-card-meta">${esc(song.artist)} · ${(song.sessions||[]).map(x=>`<span style="${filledSess.has(x)?'':'color:#c0392b'}">${esc(x)}</span>`).join(' · ')}</div>
        </div>
      </div>
      <div class="ens-song-members" onclick="event.stopPropagation()">
        ${slots.length?slots.map(sl=>ensMobSongMemberHtml(sl,conflicts.has(sl.id))).join(''):'<div class="ens-empty-hint">멤버 없음</div>'}
      </div>
    </div>`;
  }).join('');
}

window.ensMobSelectPool=function(slotId){
  eMobileSelected=eMobileSelected===slotId?null:slotId;
  renderEnsDndMobile();
};
window.ensMobAssign=function(songId){
  if(!eMobileSelected||!eDndSt) return;
  const id=eMobileSelected;
  const idx=eDndSt.unassigned.findIndex(x=>x.id===id);
  if(idx===-1) return;
  const sl=eDndSt.unassigned.splice(idx,1)[0];
  const target=eDndSt.songs.find(s=>s.song.id===songId);
  if(target){target.slots.push(sl);sortSongSlots(target.slots);}
  eMobileSelected=null;
  ensDndSaveState();
  renderEnsDndMobile();
};
window.ensMobRemove=function(slotId){
  if(!eDndSt) return;
  for(const s of eDndSt.songs){
    const idx=s.slots.findIndex(x=>x.id===slotId);
    if(idx!==-1){eDndSt.unassigned.push(s.slots.splice(idx,1)[0]);break;}
  }
  eMobileSelected=null;
  ensDndSaveState();
  renderEnsDndMobile();
};

window.ensDndDragStart=function(event,id){
  eDndDrag={id};
  event.dataTransfer.effectAllowed='move';
  event.dataTransfer.setData('text/plain',id);
  setTimeout(()=>document.querySelector(`.ens-member-card[data-id="${id}"]`)?.classList.add('dragging'),0);
};
window.ensDndDragEnd=function(event){
  document.querySelectorAll('.ens-member-card.dragging').forEach(el=>el.classList.remove('dragging'));
  eDndDrag=null;
};
window.ensDndDragOverSong=function(event,songId){
  event.preventDefault();event.stopPropagation();
  event.currentTarget.classList.add('drag-over');
};
window.ensDndDragLeaveSong=function(event){
  if(!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('drag-over');
};
window.ensDndDragOverPool=function(event){
  event.preventDefault();
  document.getElementById('ensDndPool').classList.add('drag-over-pool');
};
window.ensDndDragLeavePool=function(event){
  const pool=document.getElementById('ensDndPool');
  if(!pool.contains(event.relatedTarget)) pool.classList.remove('drag-over-pool');
};
window.ensDndDropToSong=function(event,songId){
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');
  if(!eDndDrag||!eDndSt) return;
  const id=eDndDrag.id;
  let sl=null;
  for(const s of eDndSt.songs){
    const idx=s.slots.findIndex(x=>x.id===id);
    if(idx!==-1){if(s.song.id===songId)return;sl=s.slots.splice(idx,1)[0];break;}
  }
  if(!sl){const idx=eDndSt.unassigned.findIndex(x=>x.id===id);if(idx!==-1)sl=eDndSt.unassigned.splice(idx,1)[0];}
  if(!sl) return;
  const target=eDndSt.songs.find(s=>s.song.id===songId);
  if(target){target.slots.push(sl);sortSongSlots(target.slots);}
  renderEnsDndModal();
};
window.ensDndDropToPool=function(event){
  event.preventDefault();
  document.getElementById('ensDndPool').classList.remove('drag-over-pool');
  if(!eDndDrag||!eDndSt) return;
  const id=eDndDrag.id;
  if(eDndSt.unassigned.find(x=>x.id===id)) return;
  for(const s of eDndSt.songs){
    const idx=s.slots.findIndex(x=>x.id===id);
    if(idx!==-1){eDndSt.unassigned.push(s.slots.splice(idx,1)[0]);break;}
  }
  renderEnsDndModal();
};

window.openAddManualParticipant=function(){
  if(!eDndSt) return;
  const type=eDndSt.type;
  showModal('참여자 추가',
    `<div><div class="fl">이름</div><input class="fi" id="manualName" placeholder="성명" maxlength="20" onkeydown="if(event.key==='Enter')addManualParticipant('${type}')"/></div>
     <div><div class="fl">세션</div><select class="fs" id="manualSession">${SESSIONS.map(s=>`<option value="${s}">${s}</option>`).join('')}</select></div>`,
    `<button class="btn btn-p" onclick="addManualParticipant('${type}')">추가</button>`
  );
  setTimeout(()=>document.getElementById('manualName')?.focus(),50);
};

window.addManualParticipant=async function(type){
  const name=document.getElementById('manualName')?.value?.trim();
  const session=document.getElementById('manualSession')?.value;
  if(!name){toast('이름을 입력하세요','err');return;}
  const r=eRounds[type]; if(!r){toast('회차 없음','err');return;}
  try{
    const{data,error}=await supabase.from('session_applications').insert({
      round_id:r.id,song_id:null,applicant_name:name,student_id:'',
      sessions:[session],status:'pending',is_manual:true
    }).select().single();
    if(error) throw error;
    eManualApps[type].push(data);
    eDndSt.unassigned.push(...makeSlots(data,'',null));
    ensDndSaveState();
    closeModal();
    renderEnsDndPool();
    toast(`${esc(name)} 추가됐습니다`,'ok');
  }catch(e){toast(errMsg(e),'err');}
};

window.deleteManualPoolEntry=async function(slotId){
  if(!eDndSt) return;
  const idx=eDndSt.unassigned.findIndex(x=>x.id===slotId);
  if(idx===-1) return;
  const sl=eDndSt.unassigned[idx];
  if(!sl.isManual) return;
  if(!confirm(`${sl.applicantName}을(를) 삭제하시겠습니까?`)) return;
  try{
    const{error}=await supabase.from('session_applications').delete().eq('id',sl.appId).eq('is_manual',true);
    if(error) throw error;
    eDndSt.unassigned.splice(idx,1);
    const type=eDndSt.type;
    const mIdx=eManualApps[type].findIndex(a=>a.id===sl.appId);
    if(mIdx!==-1) eManualApps[type].splice(mIdx,1);
    ensDndSaveState();
    renderEnsDndPool();
  }catch(e){toast(errMsg(e),'err');}
};

window.confirmEnsembleTeams=async function(){
  if(!eDndSt) return;
  const allSlots=[...eDndSt.songs.flatMap(s=>s.slots),...eDndSt.unassigned];
  const appIdManual=new Map();
  for(const sl of allSlots) if(!appIdManual.has(sl.appId)) appIdManual.set(sl.appId,sl.isManual);
  const placedAppIds=new Set(eDndSt.songs.flatMap(s=>s.slots.map(sl=>sl.appId)));
  const nonManualIds=[...appIdManual.entries()].filter(([,m])=>!m).map(([id])=>id);
  const rejCnt=nonManualIds.filter(id=>!placedAppIds.has(id)).length;
  const unslotCnt=eDndSt.unassigned.filter(sl=>!sl.isManual).length;
  const msg=(rejCnt||unslotCnt)?`완전 미배정 ${rejCnt}명 · 미배정 슬롯 ${unslotCnt}개.\n미배정자는 거절 처리됩니다. 팀 구성을 완료하시겠습니까?`:'팀 구성을 완료하시겠습니까?';
  if(!confirm(msg)) return;
  try{
    const confirmedNonManualIds=nonManualIds.filter(id=>placedAppIds.has(id));
    const rejectedIds=nonManualIds.filter(id=>!placedAppIds.has(id));
    const placedManualIds=[...appIdManual.entries()].filter(([id,m])=>m&&placedAppIds.has(id)).map(([id])=>id);
    if(confirmedNonManualIds.length){const{error}=await supabase.from('session_applications').update({status:'confirmed'}).in('id',confirmedNonManualIds);if(error)throw error;}
    if(rejectedIds.length){const{error}=await supabase.from('session_applications').update({status:'rejected'}).in('id',rejectedIds);if(error)throw error;}
    if(placedManualIds.length){const{error}=await supabase.from('session_applications').update({status:'confirmed'}).in('id',placedManualIds);if(error)throw error;}
    const appAssign={};
    for(const {song,slots} of eDndSt.songs){
      for(const sl of slots){
        if(!appAssign[sl.appId]) appAssign[sl.appId]=[];
        let a=appAssign[sl.appId].find(x=>x.songId===song.id);
        if(!a){a={songId:song.id,sessions:[]};appAssign[sl.appId].push(a);}
        a.sessions.push(sl.overrideSession??sl.session);
      }
    }
    for(const [appId,assignments] of Object.entries(appAssign)){
      const best=assignments.reduce((b,a)=>a.sessions.length>b.sessions.length?a:b,assignments[0]);
      const{error:eUp}=await supabase.from('session_applications').update({song_id:best.songId,sessions:best.sessions}).eq('id',appId);
      if(eUp) throw eUp;
    }
    // B6: 배정 멤버가 없는 곡은 자동으로 rejected 처리
    const emptySongIds=eDndSt.songs.filter(s=>s.slots.length===0).map(s=>s.song.id);
    if(emptySongIds.length){
      const{error:eRej}=await supabase.from('song_applications').update({status:'rejected'}).in('id',emptySongIds);
      if(eRej) throw eRej;
    }
    localStorage.removeItem(eDndSt.savedKey);
    toast(`${eDndSt.songs.filter(s=>s.slots.length).length}개 팀이 확정됐습니다`,'ok');
    closeEnsDndModal();
    await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

async function loadEnsemble(){
  const {data:rds}=await supabase.from('ensemble_rounds').select('*').order('created_at',{ascending:false});
  if(rds){ eRounds.regular=rds.find(r=>r.type==='regular')||null; eRounds.busking=rds.find(r=>r.type==='busking')||null; }
  for(const type of ['regular','busking']){
    const r=eRounds[type];
    if(!r){ eSongs[type]=[]; continue; }
    const {data:s}=await supabase.from('song_applications').select('*').eq('round_id',r.id).order('created_at');
    eSongs[type]=s||[];
  }
  const allIds=[...eSongs.regular,...eSongs.busking].map(s=>s.id);
  const newMap={};
  if(allIds.length){
    const {data:sess}=await supabase.from('session_applications').select('*').in('song_id',allIds).order('created_at');
    (sess||[]).forEach(s=>{ if(!newMap[s.song_id]) newMap[s.song_id]=[]; newMap[s.song_id].push(s); });
  }
  eSessionMap=newMap;
  eManualApps={regular:[],busking:[]};
  for(const type of ['regular','busking']){
    const r=eRounds[type];
    if(r){const{data:mApps}=await supabase.from('session_applications').select('*').eq('round_id',r.id).eq('is_manual',true).is('song_id',null);eManualApps[type]=mApps||[];}
  }
  for(const type of ['regular','busking']){
    const r=eRounds[type];
    eManualEntries[type]=[];
    if(r?.mode==='manual'){
      const {data}=await supabase.from('manual_entries').select('*').eq('round_id',r.id).order('team_no').order('sort_key');
      eManualEntries[type]=data||[];
    }
  }
}

async function ensUpdated(){
  if(eDndSt&&document.getElementById('ensDndModal')?.style.display!=='none'){
    ensDndSaveState();
    closeEnsDndModal();
    toast('합주 단계가 변경됐습니다. 진행 중이던 팀 구성이 임시저장됐습니다.','');
  }
  await loadEnsemble();
  renderEnsemble();
  _ensBroadcastCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
}

async function autoAdvanceEnsPhase(roundId,expectedPhase,update){
  const {data}=await supabase.from('ensemble_rounds').select('phase').eq('id',roundId).single().catch(()=>({data:null}));
  if(!data||data.phase!==expectedPhase){await ensUpdated();return;}
  await supabase.from('ensemble_rounds').update(update).eq('id',roundId).eq('phase',expectedPhase).catch(()=>{});
  await ensUpdated();
  _ensBroadcastCh?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});
}

// 회차 생성
window.openCreateRoundModal=function(type){
  const typeName=type==='regular'?'일반 합주':'버스킹 합주';
  const nowPlus=h=>{const d=new Date(Date.now()+h*3600000),pad=n=>String(n).padStart(2,'0');return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;};
  const tabStyle=(active)=>`padding:8px 16px;border:none;background:${active?'var(--surface)':'transparent'};color:${active?'var(--text)':'var(--text2)'};font-family:'Noto Sans KR',sans-serif;font-size:13px;font-weight:${active?'700':'500'};cursor:pointer;border-bottom:2px solid ${active?'var(--accent)':'transparent'};margin-bottom:-1px`;
  showModal(`${typeName} 회차 생성`,
    `<div style="display:flex;border-bottom:1px solid var(--border);margin:-4px -20px 16px -20px">
       <button id="ctabSimple" style="${tabStyle(true)}" onclick="switchRoundCreateTab('simple')">⚡ 간편 진행</button>
       <button id="ctabManual" style="${tabStyle(false)}" onclick="switchRoundCreateTab('manual')">⚙️ 수동 진행</button>
     </div>
     <div id="ctabContentSimple">
       <div style="background:var(--surface2);border-radius:6px;padding:12px;margin-bottom:14px;font-size:12px;line-height:1.8;color:var(--text2)">
         <div style="font-weight:700;color:var(--text);margin-bottom:6px">현재 시스템의 합주 신청 방식</div>
         <div><b>1단계 [준비]</b> — 관리자가 회차를 설정하고 곡·세션 신청 일정을 예약합니다. 완성 팀을 미리 추가해 총 곡수 한도에 포함시킬 수 있습니다.</div>
         <div><b>2단계 [곡 신청]</b> — 학생들이 합주할 곡을 신청합니다. 총 N곡·인당 M곡 제한이 적용됩니다.</div>
         <div><b>3단계 [대기]</b> — 곡 신청 마감 후 세션 신청 오픈을 기다립니다.</div>
         <div><b>4단계 [세션 신청]</b> — 학생들이 신청된 곡에 세션으로 참여 신청을 합니다.</div>
         <div><b>5단계 [팀 구성]</b> — 관리자가 드래그앤드롭으로 세션 신청자를 각 곡에 배정합니다.</div>
         <div><b>6단계 [완료]</b> — 팀 구성이 완료됩니다.</div>
         <div style="color:var(--text3);margin-top:4px">※ 2차 세션 신청 사용 시: 5단계 팀 구성 → 6단계 2차 세션 → 7단계 최종 팀 구성 → 8단계 완료</div>
       </div>
       <div><div class="fl">회차 이름</div><input class="fi" id="eName" value="${new Date().getFullYear()} ${typeName}" maxlength="50"/></div>
       <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
         <div><div class="fl">총 최대 곡수</div><input class="fi" id="eMaxS" type="number" value="20" min="1"/></div>
         <div><div class="fl">인당 곡신청</div><input class="fi" id="eMaxSP" type="number" value="2" min="1"/></div>
         <div><div class="fl">인당 세션참여</div><input class="fi" id="eMaxSess" type="number" value="3" min="1"/></div>
       </div>
       <div><div class="fl">🎵 곡 신청 오픈 일시 *</div><input class="fi" type="datetime-local" id="eSongOpen" value="${nowPlus(1)}"/></div>
       <div><div class="fl">🎵 곡 신청 마감 일시 *</div><input class="fi" type="datetime-local" id="eSongClose" value="${nowPlus(25)}"/></div>
       <div><div class="fl">👥 1차 세션 신청 오픈 일시 *</div><input class="fi" type="datetime-local" id="eSessOpen" value="${nowPlus(49)}"/></div>
       <div><div class="fl">👥 1차 세션 신청 마감 일시 *</div><input class="fi" type="datetime-local" id="eSessClose" value="${nowPlus(73)}"/></div>
       <div style="margin-top:10px;border-top:1px solid var(--surface2);padding-top:10px">
         <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
           <input type="checkbox" id="eHasSess2" onchange="toggleSess2Fields()">
           <span>2차 세션 신청 사용</span>
         </label>
       </div>
       <div id="eSess2Fields" style="display:none">
         <div style="margin-top:8px"><div class="fl">2차 세션 신청 대상</div>
           <select class="fs" id="eSess2Mode">
             <option value="any_song">모든 확정 곡 신청 가능 (1차와 동일)</option>
             <option value="missing_only">빈 세션만 신청 가능</option>
           </select>
         </div>
         <div><div class="fl">👥 2차 세션 신청 오픈 일시</div><input class="fi" type="datetime-local" id="eSess2Open" value="${nowPlus(97)}"/></div>
         <div><div class="fl">👥 2차 세션 신청 마감 일시</div><input class="fi" type="datetime-local" id="eSess2Close" value="${nowPlus(121)}"/></div>
       </div>
     </div>
     <div id="ctabContentManual" style="display:none">
       <div style="background:var(--surface2);border-radius:6px;padding:12px;margin-bottom:14px;font-size:12px;line-height:1.8;color:var(--text2)">
         <div style="font-weight:700;color:var(--text);margin-bottom:6px">수동 진행 방식</div>
         <div>이 시스템을 이용하지 않고, Google Forms, Google Sheets 등 제3의 시스템을 이용하여 합주 신청을 진행합니다. 이곳은 확정된 팀 구성 결과를 공지하는 용도로만 사용합니다.</div>
       </div>
       <div><div class="fl">회차 이름</div><input class="fi" id="eManualName" value="${new Date().getFullYear()} ${typeName}" maxlength="50"/></div>
     </div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="ecBtn" onclick="submitRoundCreate('${type}')">회차 생성</button>`
  );
};

window.switchRoundCreateTab=function(tab){
  const isSimple=tab==='simple';
  document.getElementById('ctabSimple').style.fontWeight=isSimple?'700':'500';
  document.getElementById('ctabSimple').style.color=isSimple?'var(--text)':'var(--text2)';
  document.getElementById('ctabSimple').style.borderBottomColor=isSimple?'var(--accent)':'transparent';
  document.getElementById('ctabManual').style.fontWeight=!isSimple?'700':'500';
  document.getElementById('ctabManual').style.color=!isSimple?'var(--text)':'var(--text2)';
  document.getElementById('ctabManual').style.borderBottomColor=!isSimple?'var(--accent)':'transparent';
  document.getElementById('ctabContentSimple').style.display=isSimple?'':'none';
  document.getElementById('ctabContentManual').style.display=isSimple?'none':'';
};

window.submitRoundCreate=function(type){
  const manualTab=document.getElementById('ctabContentManual');
  if(manualTab&&manualTab.style.display!=='none'){
    createManualRound(type);
  } else {
    window.createEnsembleRound(type);
  }
};

window.createManualRound=async function(type){
  const name=(document.getElementById('eManualName')?.value||'').trim();
  if(!name){toast('이름을 입력해주세요','err');return;}
  const btn=document.getElementById('ecBtn'); btn.disabled=true;
  try{
    const {error}=await supabase.from('ensemble_rounds').insert({
      type,name,phase:'draft',mode:'manual',is_sheet_public:false,
      max_songs:9999,max_songs_per_person:9999,max_sessions_per_person:9999
    });
    if(error) throw error;
    toast('수동 회차가 생성됐습니다','ok'); closeModal(); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};

window.createEnsembleRound=async function(type){
  const name=document.getElementById('eName').value.trim();
  const max_songs=parseInt(document.getElementById('eMaxS').value);
  const max_songs_per_person=parseInt(document.getElementById('eMaxSP').value);
  const max_sessions_per_person=parseInt(document.getElementById('eMaxSess').value);
  const songOpenVal=document.getElementById('eSongOpen').value;
  const songCloseVal=document.getElementById('eSongClose').value;
  const sessOpenVal=document.getElementById('eSessOpen').value;
  const sessCloseVal=document.getElementById('eSessClose').value;
  const hasSess2=document.getElementById('eHasSess2')?.checked||false;
  const sess2OpenVal=hasSess2?document.getElementById('eSess2Open')?.value:'';
  const sess2CloseVal=hasSess2?document.getElementById('eSess2Close')?.value:'';
  const sess2Mode=hasSess2?document.getElementById('eSess2Mode')?.value:'any_song';
  if(!name){toast('이름을 입력해주세요','err');return;}
  const now=Date.now();
  const chk=(val,label)=>{
    if(!val){toast(`${label}을(를) 입력해주세요`,'err');return false;}
    if(new Date(val).getTime()<=now){toast('예약 일시를 과거로 설정할 수 없습니다.','err');return false;}
    return true;
  };
  if(!chk(songOpenVal,'곡 신청 오픈 일시')||!chk(songCloseVal,'곡 신청 마감 일시')||!chk(sessOpenVal,'1차 세션 신청 오픈 일시')||!chk(sessCloseVal,'1차 세션 신청 마감 일시')) return;
  if(new Date(songCloseVal)<=new Date(songOpenVal)){toast('곡 신청 마감이 오픈보다 늦어야 합니다','err');return;}
  if(new Date(sessOpenVal)<=new Date(songCloseVal)){toast('세션 신청 오픈이 곡 신청 마감보다 늦어야 합니다','err');return;}
  if(new Date(sessCloseVal)<=new Date(sessOpenVal)){toast('세션 신청 마감이 오픈보다 늦어야 합니다','err');return;}
  if(hasSess2){
    if(!chk(sess2OpenVal,'2차 세션 신청 오픈 일시')||!chk(sess2CloseVal,'2차 세션 신청 마감 일시')) return;
    if(new Date(sess2OpenVal)<=new Date(sessCloseVal)){toast('2차 세션 신청 오픈이 1차 마감보다 늦어야 합니다','err');return;}
    if(new Date(sess2CloseVal)<=new Date(sess2OpenVal)){toast('2차 세션 신청 마감이 오픈보다 늦어야 합니다','err');return;}
  }
  const btn=document.getElementById('ecBtn'); btn.disabled=true;
  try{
    const {error}=await supabase.from('ensemble_rounds').insert({
      type,name,phase:'draft',max_songs,max_songs_per_person,max_sessions_per_person,
      song_scheduled_at:new Date(songOpenVal).toISOString(),
      song_close_at:new Date(songCloseVal).toISOString(),
      session_scheduled_at:new Date(sessOpenVal).toISOString(),
      session_close_at:new Date(sessCloseVal).toISOString(),
      has_session2:hasSess2,
      ...(hasSess2?{session2_mode:sess2Mode,session2_scheduled_at:new Date(sess2OpenVal).toISOString(),session2_close_at:new Date(sess2CloseVal).toISOString()}:{})
    });
    if(error) throw error;
    toast('회차가 생성됐습니다','ok'); closeModal(); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};

window.openEditRoundModal=function(id){
  // id로 직접 회차를 찾아 참조 (eType에 의존하지 않음)
  const r=eRounds.regular?.id===id?eRounds.regular:eRounds.busking;
  if(!r){toast('회차 정보를 찾을 수 없습니다','err');return;}
  showModal('설정 수정',
    `<div><div class="fl">회차 이름</div><input class="fi" id="eName" value="${r.name}" maxlength="50"/></div>
     <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
       <div><div class="fl">총 최대 곡수</div><input class="fi" id="eMaxS" type="number" value="${r.max_songs}" min="1"/></div>
       <div><div class="fl">인당 곡신청</div><input class="fi" id="eMaxSP" type="number" value="${r.max_songs_per_person}" min="1"/></div>
       <div><div class="fl">인당 세션참여</div><input class="fi" id="eMaxSess" type="number" value="${r.max_sessions_per_person}" min="1"/></div>
     </div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="eeBtn" onclick="saveRoundSettings(${id})">저장</button>`
  );
};

window.saveRoundSettings=async function(id){
  const btn=document.getElementById('eeBtn'); btn.disabled=true;
  try{
    const {error}=await supabase.from('ensemble_rounds').update({
      name:document.getElementById('eName').value.trim(),
      max_songs:parseInt(document.getElementById('eMaxS').value),
      max_songs_per_person:parseInt(document.getElementById('eMaxSP').value),
      max_sessions_per_person:parseInt(document.getElementById('eMaxSess').value),
    }).eq('id',id);
    if(error) throw error;
    toast('저장되었습니다','ok'); closeModal(); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');btn.disabled=false;}
};

const dtLocalStr=ts=>{if(!ts)return'';const d=new Date(ts),pad=n=>String(n).padStart(2,'0');return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;};

// Phase advance controls
window.startSongPhaseNow=async function(id){
  try{
    const {error}=await supabase.from('ensemble_rounds').update({phase:'song',song_scheduled_at:null}).eq('id',id);
    if(error) throw error;
    toast('곡 신청이 열렸습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};
window.startSongEndNow=async function(id){
  if(!confirm('곡 신청을 종료하시겠습니까?')) return;
  try{
    const {error}=await supabase.from('ensemble_rounds').update({phase:'song_end'}).eq('id',id);
    if(error) throw error;
    toast('곡 신청이 종료됐습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};
window.startSessionPhaseNow=async function(id){
  try{
    const {error}=await supabase.from('ensemble_rounds').update({phase:'session',session_scheduled_at:null}).eq('id',id);
    if(error) throw error;
    toast('세션 신청이 열렸습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};
window.startSessionEndNow=async function(id){
  if(!confirm('세션 신청을 종료하시겠습니까?')) return;
  try{
    const {error}=await supabase.from('ensemble_rounds').update({phase:'session_end'}).eq('id',id);
    if(error) throw error;
    toast('세션 신청이 종료됐습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.toggleSess2Fields=function(){
  document.getElementById('eSess2Fields').style.display=document.getElementById('eHasSess2').checked?'':'none';
};

window.revertPhase=async function(type,roundId){
  const r=eRounds[type]; if(!r) return;
  const prevMap={song:'draft',song_end:'song',session:'song_end',session_end:'session',session2:'session_end',session2_end:'session2',closed:r.has_session2?'session2_end':'session_end'};
  const prev=prevMap[r.phase]; if(!prev) return;
  const phaseNames={draft:'준비',song:'곡 신청',song_end:'대기',session:'1차 세션 신청',session_end:'대기',session2:'2차 세션 신청',session2_end:'최종 팀 구성',closed:'완료'};
  if(!confirm(`이전 단계 "${phaseNames[prev]}"(으)로 되돌리시겠습니까?`)) return;
  // clear the deadline for the phase we're reverting to, so the public page doesn't immediately re-advance
  const clearOnRevert={song:{song_close_at:null},session:{session_close_at:null},session2:{session2_close_at:null}};
  try{
    const {error}=await supabase.from('ensemble_rounds').update({phase:prev,...(clearOnRevert[prev]||{})}).eq('id',roundId);
    if(error) throw error;
    toast('이전 단계로 이동했습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.advanceFromSessionEnd=async function(type,roundId){
  const r=eRounds[type]; if(!r) return;
  const next=r.has_session2?'session2':'closed';
  const label=next==='session2'?'2차 세션 신청 단계':'완료';
  if(!confirm(`${label}로 이동하시겠습니까?`)) return;
  try{
    if(next==='session2'){
      // 1차 세션 신청 중 미확정(pending) 데이터 삭제
      const confirmedSongIds=(eSongs[type]||[]).filter(s=>s.status==='confirmed').map(s=>s.id);
      if(confirmedSongIds.length){
        const pendingIds=(confirmedSongIds.flatMap(sid=>(eSessionMap[sid]||[]))).filter(a=>a.status==='pending'&&(a.session_round||1)===1).map(a=>a.id);
        if(pendingIds.length){
          const {error:delErr}=await supabase.from('session_applications').delete().in('id',pendingIds);
          if(delErr) throw delErr;
        }
      }
    }
    const {error}=await supabase.from('ensemble_rounds').update({phase:next}).eq('id',roundId);
    if(error) throw error;
    toast(`${label}로 이동했습니다`,'ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.startSession2PhaseNow=async function(id){
  try{
    const {error}=await supabase.from('ensemble_rounds').update({phase:'session2',session2_scheduled_at:null}).eq('id',id);
    if(error) throw error;
    toast('2차 세션 신청이 열렸습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.startSession2EndNow=async function(id){
  if(!confirm('2차 세션 신청을 종료하시겠습니까?')) return;
  try{
    const {error}=await supabase.from('ensemble_rounds').update({phase:'session2_end'}).eq('id',id);
    if(error) throw error;
    toast('2차 세션 신청이 종료됐습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.completeRound=async function(id){
  if(!confirm('합주 신청을 완료 처리하시겠습니까?')) return;
  try{
    const {error}=await supabase.from('ensemble_rounds').update({phase:'closed'}).eq('id',id);
    if(error) throw error;
    toast('합주 신청이 완료됐습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.deleteRound=async function(id){
  if(!confirm('이 회차(준비 중)를 삭제할까요?')) return;
  try{
    const {data:songs}=await supabase.from('song_applications').select('id').eq('round_id',id);
    const songIds=(songs||[]).map(s=>s.id);
    if(songIds.length) await supabase.from('session_applications').delete().in('song_id',songIds);
    await supabase.from('song_applications').delete().eq('round_id',id);
    await supabase.from('ensemble_rounds').delete().eq('id',id);
    toast('삭제되었습니다'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.openSetScheduleModal=function(roundId,field,label,tsStr){
  const toLocal=ts=>ts&&ts!=='null'?new Date(new Date(ts).getTime()-new Date(ts).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  showModal(`${label} 예약 변경`,
    `<div>
       <div class="fl">${label}</div>
       <input class="fi" type="datetime-local" id="ssMoDt" value="${toLocal(tsStr!=='null'?tsStr:null)}"/>
       <div style="font-size:11px;color:var(--text3);margin-top:5px">비워두면 예약이 해제됩니다</div>
     </div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="ssMoBtn" onclick="saveEnsSchedule(${roundId},'${field}')">저장</button>`
  );
};
window.saveEnsSchedule=async function(roundId,field){
  const val=document.getElementById('ssMoDt').value;
  const isoVal=val?new Date(val).toISOString():null;
  const btn=document.getElementById('ssMoBtn'); btn.disabled=true;
  try{
    const {error}=await supabase.from('ensemble_rounds').update({[field]:isoVal}).eq('id',roundId);
    if(error) throw error;
    toast('저장되었습니다','ok'); closeModal(); await ensUpdated();
  }catch(e){toast(errMsg(e),'err'); btn.disabled=false;}
};

function fmtScheduled(ts){
  const d=new Date(ts),pad=n=>String(n).padStart(2,'0');
  return `${String(d.getFullYear()).slice(2)}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

window.closeRound=async function(id){
  if(!confirm('합주 신청을 완전히 마감할까요? 다음 신청은 첫 단계부터 다시 시작해야 합니다.')) return;
  try{
    const {error}=await supabase.from('ensemble_rounds').update({phase:'closed'}).eq('id',id);
    if(error) throw error;
    toast('닫혔습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.rejectSong=async function(id){
  if(!confirm('이 곡을 삭제할까요?')) return;
  try{
    await supabase.from('session_applications').delete().eq('song_id',id);
    await supabase.from('song_applications').delete().eq('id',id);
    toast('삭제되었습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

// ── DRAG & DROP TEAM BUILDER ──────────────────────────────────────────
window.eDragStart=function(event,id){
  eDraggingId=id;
  event.dataTransfer.effectAllowed='move';
};
window.eDragOver=function(event,songId){
  event.preventDefault();
  const app=Object.values(eSessionMap).flat().find(a=>a.id===eDraggingId);
  const el=event.currentTarget;
  el.classList.remove('dnd-over','dnd-invalid');
  if(app&&app.song_id===songId&&app.status!=='confirmed'){
    event.dataTransfer.dropEffect='move'; el.classList.add('dnd-over');
  } else {
    event.dataTransfer.dropEffect='none'; el.classList.add('dnd-invalid');
  }
};
window.eDragLeave=function(event){
  event.currentTarget.classList.remove('dnd-over','dnd-invalid');
};
window.eDropToSong=async function(event,songId){
  event.preventDefault();
  event.currentTarget.classList.remove('dnd-over','dnd-invalid');
  if(!eDraggingId) return;
  const app=Object.values(eSessionMap).flat().find(a=>a.id===eDraggingId);
  eDraggingId=null;
  if(!app) return;
  if(app.song_id!==songId){toast('이 곡에 신청하지 않은 참가자입니다','err');return;}
  if(app.status==='confirmed') return;
  try{
    await supabase.from('session_applications').update({status:'confirmed'}).eq('id',app.id);
    toast('배정됐습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};
window.eDropToPool=async function(event,el){
  event.preventDefault();
  el.classList.remove('dnd-over-pool');
  if(!eDraggingId) return;
  const app=Object.values(eSessionMap).flat().find(a=>a.id===eDraggingId);
  eDraggingId=null;
  if(!app||app.status==='pending') return;
  try{
    await supabase.from('session_applications').update({status:'pending'}).eq('id',app.id);
    toast('배정이 취소됐습니다','ok'); await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

window.confirmAllTeams=async function(type,roundId){
  const r=eRounds[type]; if(!r) return;
  const confirmedSongs=(eSongs[type]||[]).filter(s=>s.status==='confirmed');
  const allPending=confirmedSongs.flatMap(s=>(eSessionMap[s.id]||[]).filter(a=>a.status==='pending'));
  const msg=allPending.length?`미배정 참가자가 ${allPending.length}명 있습니다.\n미배정자는 거절 처리됩니다. 팀 구성을 확정하시겠습니까?`:'팀 구성을 확정하시겠습니까?';
  if(!confirm(msg)) return;
  try{
    if(allPending.length){
      const {error:e1}=await supabase.from('session_applications').update({status:'rejected'}).in('id',allPending.map(a=>a.id));
      if(e1) throw e1;
    }
    toast(`${confirmedSongs.length}개 팀이 확정됐습니다`,'ok');
    await ensUpdated();
  }catch(e){toast(errMsg(e),'err');}
};

// ── MODAL ─────────────────────────────────────────────────────────────
const isMobile=()=>window.innerWidth<=700;

function showModal(title,body,foot){
  document.getElementById('modalTtl').textContent=title;
  document.getElementById('modalBody').innerHTML=body;
  document.getElementById('modalFoot').innerHTML=foot;
  document.getElementById('modalBd').style.display='flex';
  document.body.style.overflow='hidden';
  if(isMobile()){
    const modal=document.querySelector('#modalBd .modal');
    if(!modal) return;
    let startY=0,isDragging=false;
    modal.style.transform='';
    modal.addEventListener('touchstart',e=>{startY=e.touches[0].clientY;isDragging=true;modal.style.transition='none';},{passive:true,once:false});
    modal.addEventListener('touchmove',e=>{if(!isDragging)return;const dy=e.touches[0].clientY-startY;if(dy>0)modal.style.transform=`translateY(${dy}px)`;},{passive:true,once:false});
    modal.addEventListener('touchend',e=>{if(!isDragging)return;isDragging=false;const dy=e.changedTouches[0].clientY-startY;modal.style.transition='transform .2s';if(dy>100){modal.style.transform=`translateY(100%)`;setTimeout(closeModal,200);}else{modal.style.transform='';}},{once:false});
  }
}
window.closeModal=()=>{document.getElementById('modalBd').style.display='none';document.body.style.overflow='';};
window.onMBd=e=>{if(e.target===document.getElementById('modalBd'))closeModal();};

// ── DATA MANAGEMENT ───────────────────────────────────────────────────
window.openDeleteTimeModal=function(){
  const s=document.getElementById('delSeasonSel').value;
  showModal('시간 정보 삭제',
    `<div style="color:var(--danger);font-weight:600;font-size:13px">${s}의 모든 시간 정보를 삭제합니다. 이 작업은 되돌릴 수 없습니다.</div>
     <div class="fl">삭제하려면 하단에 <b>'삭제'</b>를 입력해주세요.</div>
     <input class="fi" type="text" id="delTimeInput" placeholder="삭제"/>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-d" onclick="doDeleteTime('${s}')">삭제</button>`
  );
};
window.doDeleteTime=async function(s){
  const val=document.getElementById('delTimeInput').value;
  if(val!=='삭제'){toast('"삭제"를 정확히 입력해주세요','err');return;}
  try{
    const {data:rds}=await supabase.from('application_rounds').select('id').eq('season',s);
    if(rds&&rds.length) await supabase.from('time_applications').delete().in('round_id',rds.map(r=>r.id));
    await supabase.from('application_rounds').delete().eq('season',s);
    await supabase.from('base_slots').delete().eq('season',s);
    if(season===s){
      baseSlots=[]; merged=mergeSchedule(baseSlots,exceptions); round=null; applications=[];
      renderSchedule(); renderApply();
    }
    closeModal(); toast(`${s} 시간 정보가 삭제되었습니다`,'ok');
  }catch(e){toast(errMsg(e),'err');}
};
window.openDeleteTeamsModal=function(){
  showModal('팀 정보 삭제',
    `<div style="color:var(--danger);font-weight:600;font-size:13px">모든 팀 정보를 삭제합니다. 이 작업은 되돌릴 수 없습니다.</div>
     <div class="fl">삭제하려면 하단에 <b>'삭제'</b>를 입력해주세요.</div>
     <input class="fi" type="text" id="delTeamsInput" placeholder="삭제"/>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-d" onclick="doDeleteTeams()">삭제</button>`
  );
};
window.doDeleteTeams=async function(){
  const val=document.getElementById('delTeamsInput').value;
  if(val!=='삭제'){toast('"삭제"를 정확히 입력해주세요','err');return;}
  try{
    await supabase.from('teams').delete().neq('id',0);
    teams=[]; baseSlots=[]; merged=[]; exceptions=[];
    closeModal(); toast('팀 정보가 삭제되었습니다','ok'); renderTeams(); renderSchedule();
  }catch(e){toast(errMsg(e),'err');}
};
window.changeAdminPassword=async function(){
  const pw1=document.getElementById('newPw1').value;
  const pw2=document.getElementById('newPw2').value;
  if(pw1!==pw2){toast('비밀번호가 일치하지 않습니다','err');return;}
  if(pw1.length<6){toast('비밀번호는 6자 이상이어야 합니다','err');return;}
  const {error}=await supabase.auth.updateUser({password:pw1});
  if(error){toast(errMsg(error),'err');return;}
  document.getElementById('newPw1').value='';
  document.getElementById('newPw2').value='';
  toast('비밀번호가 변경되었습니다','ok');
};

// ── ENSEMBLE XLSX EXPORT ──────────────────────────────────────────────
window.exportEnsembleXlsx = function(type) {
  if (typeof XLSX === 'undefined') { toast('라이브러리 로드 중입니다. 잠시 후 다시 시도해주세요', 'err'); return; }
  const r = eRounds[type];
  if (!r) { toast('데이터가 없습니다', 'err'); return; }
  const typeName = type === 'regular' ? '일반합주' : '버스킹합주';
  const confirmedSongs = (eSongs[type] || []).filter(s => s.status !== 'rejected');
  if (!confirmedSongs.length) { toast('내보낼 곡 데이터가 없습니다', 'err'); return; }

  const rows = [['번호', '곡명', '아티스트', '이름', '학번', '세션']];
  confirmedSongs.forEach((song, i) => {
    const num = String(i + 1).padStart(2, '0');
    const confirmed = (eSessionMap[song.id] || []).filter(a => a.status === 'confirmed');
    if (!confirmed.length) {
      rows.push([num, song.title, song.artist, '', '', '']);
    } else {
      confirmed.forEach(a => {
        rows.push([num, song.title, song.artist, a.applicant_name, a.student_id, a.sessions.join(', ')]);
      });
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = rows[0].map((_, ci) => ({
    wch: Math.max(...rows.map(row => String(row[ci] ?? '').length)) + 2
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, typeName);
  const d = new Date();
  const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  XLSX.writeFile(wb, `${typeName}_결과_${ds}.xlsx`);
  toast('엑셀 파일을 내보냈습니다', 'ok');
};

// ── TOAST ─────────────────────────────────────────────────────────────
let toastT;
function toast(msg,type=''){
  let el=document.getElementById('toast');
  if(!el){el=document.createElement('div');el.id='toast';document.body.appendChild(el);}
  el.className='toast'+(type?' '+type:''); el.textContent=msg; el.style.display='block';
  clearTimeout(toastT); toastT=setTimeout(()=>el.style.display='none',2800);
}
