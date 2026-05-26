import { supabase } from '../supabase.js';
import { escapeHtml as esc } from '../utils/html.js';
import { diffToHMS } from '../utils/time.js';

const SESSIONS = ['보컬1','보컬2','기타1','기타2','베이스','키보드1','키보드2','드럼','이외 악기'];

let currentType = 'regular';
let rounds = {regular:null, busking:null};
let songs = {regular:[], busking:[]};
let sessionMap = {};
let searchQ = '';
let countdownTimers = {};
let _rtChannel = null;

function fmtTime(ts){
  if(!ts) return '';
  const d=new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

function fmtScheduled(ts){
  const d=new Date(ts);
  const yy=String(d.getFullYear()).slice(2);
  const mo=String(d.getMonth()+1).padStart(2,'0');
  const dd=String(d.getDate()).padStart(2,'0');
  const hh=String(d.getHours()).padStart(2,'0');
  const mm=String(d.getMinutes()).padStart(2,'0');
  const ss=String(d.getSeconds()).padStart(2,'0');
  return `${yy}-${mo}-${dd} ${hh}:${mm}:${ss}`;
}

const errMsg=e=>{const m=e?.message||'';if(m.includes('unique')||m.includes('duplicate'))return'이미 동일한 신청이 존재합니다';if(m.includes('network')||m.includes('fetch'))return'네트워크 오류가 발생했습니다. 다시 시도해주세요';if(m.includes('JWT')||m.includes('auth'))return'인증 오류입니다. 새로고침 후 시도해주세요';return m||'오류가 발생했습니다';};

// ── EXPORTED INIT ─────────────────────────────────────────────────────
export async function init(outerContainer) {
  currentType='regular'; rounds={regular:null,busking:null};
  songs={regular:[],busking:[]}; sessionMap={}; searchQ='';
  Object.values(countdownTimers).forEach(t=>clearInterval(t)); countdownTimers={};

  outerContainer.innerHTML='';
  const inner=document.createElement('div');
  inner.className='container';
  inner.id='mainContainer';
  inner.innerHTML='<div style="display:flex;justify-content:center;padding:40px"><div class="spin"></div></div>';
  outerContainer.appendChild(inner);

  try{
    await loadAll();

    _rtChannel=supabase.channel('ens-rt')
      .on('postgres_changes',{event:'*',schema:'public',table:'song_applications'},refreshList)
      .on('postgres_changes',{event:'*',schema:'public',table:'session_applications'},refreshList)
      .on('postgres_changes',{event:'*',schema:'public',table:'ensemble_rounds'},loadAll)
      .subscribe();

    document.addEventListener('visibilitychange',onVisibilityChange);

    // sync type-toggle header buttons
    syncTypeToggle();
  }catch(e){
    outerContainer.innerHTML=`
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;padding:40px">
        <div style="color:var(--danger);font-size:15px">불러오기 실패</div>
        <div style="color:var(--text2);font-size:13px">${e.message}</div>
        <button class="btn btn-p" onclick="navigate('ensemble')">다시 시도</button>
      </div>`;
  }

  return function destroy(){
    Object.values(countdownTimers).forEach(t=>clearInterval(t)); countdownTimers={};
    if(_rtChannel){ supabase.removeChannel(_rtChannel); _rtChannel=null; }
    document.removeEventListener('visibilitychange',onVisibilityChange);
  };
}

function onVisibilityChange(){
  if(!document.hidden&&document.getElementById('mainContainer')) refreshList();
}

function syncTypeToggle(){
  document.getElementById('tb-regular')?.classList.toggle('active',currentType==='regular');
  document.getElementById('tb-busking')?.classList.toggle('active',currentType==='busking');
}

let _refreshGen = 0;

async function refreshList(){
  const gen = ++_refreshGen;
  for(const type of ['regular','busking']){
    const r=rounds[type];
    if(!r){songs[type]=[];continue;}
    const {data:s}=await supabase.from('song_applications').select('*').eq('round_id',r.id).order('created_at');
    if(gen!==_refreshGen) return;
    songs[type]=s||[];
  }
  const allIds=[...songs.regular,...songs.busking].map(s=>s.id);
  const newMap={};
  if(allIds.length){
    const {data:sess}=await supabase.from('session_applications').select('*').in('song_id',allIds).order('created_at');
    if(gen!==_refreshGen) return;
    (sess||[]).forEach(s=>{ if(!newMap[s.song_id]) newMap[s.song_id]=[]; newMap[s.song_id].push(s); });
  }
  if(gen!==_refreshGen) return;
  sessionMap=newMap;
  renderList();
}

async function loadAll(){
  const {data:rds}=await supabase.from('ensemble_rounds').select('*').order('created_at',{ascending:false});
  if(rds){
    rounds.regular=rds.find(r=>r.type==='regular')||null;
    rounds.busking=rds.find(r=>r.type==='busking')||null;
  }
  await refreshList();
  render();
}

window.switchType=function(t){
  currentType=t; searchQ='';
  syncTypeToggle();
  render();
};

window.onSearchInput=function(v){
  searchQ=v.trim().toLowerCase();
  renderList();
};
window.clearSearch=function(){
  searchQ='';
  const el=document.getElementById('searchInput');
  if(el) el.value='';
  renderList();
};

function startCountdown(type,targetDate,onExpired){
  if(countdownTimers[type]) clearInterval(countdownTimers[type]);
  countdownTimers[type]=setInterval(()=>{
    const diff=new Date(targetDate)-Date.now();
    const el=document.getElementById(`cd-${type}`);
    if(el) el.textContent=diffToHMS(diff);
    if(diff<=0){
      clearInterval(countdownTimers[type]);
      delete countdownTimers[type];
      onExpired();
    }
  },1000);
}

function render(){
  const el=document.getElementById('mainContainer');
  if(!el) return;

  const r=rounds[currentType];
  const phase=r?.phase||'closed';
  const typeName=currentType==='regular'?'일반 합주':'버스킹 합주';
  const type=currentType;

  Object.keys(countdownTimers).filter(k=>k===type||k.startsWith(type+'-')).forEach(k=>{clearInterval(countdownTimers[k]);delete countdownTimers[k];});

  let html='';

  html+=`<div class="search-bar">
    <span class="search-icon">🔍</span>
    <input class="search-input" id="searchInput" placeholder="곡 제목 또는 세션으로 검색..." value="${searchQ}" oninput="onSearchInput(this.value)"/>
    <button class="search-clear" onclick="clearSearch()" style="${searchQ?'':'display:none'}">×</button>
  </div>`;

  if(phase==='draft'){
    const target=r?.song_scheduled_at;
    if(target){
      const diff=new Date(target)-Date.now();
      if(diff>0){
        html+=`<div class="status-card closed">
          <div class="status-icon">⏳</div>
          <div class="status-texts">
            <div class="status-title">${r.name||typeName} — 합주 곡 신청 준비 중</div>
            <div class="status-sub">${fmtScheduled(target)}에 곡 신청이 열립니다</div>
            <div class="cd-num cd-open" id="cd-${type}">${diffToHMS(diff)}</div>
          </div>
        </div>`;
        el.innerHTML=html;
        startCountdown(type,target,async()=>{
          if(rounds[type]?.id===r.id){rounds[type].phase='song';rounds[type].song_scheduled_at=null;}
          try{await supabase.from('ensemble_rounds').update({phase:'song',song_scheduled_at:null}).eq('id',r.id);}catch(e){}
          render();
        });
        return;
      } else {
        if(rounds[type]?.id===r.id){rounds[type].phase='song';rounds[type].song_scheduled_at=null;}
        supabase.from('ensemble_rounds').update({phase:'song',song_scheduled_at:null}).eq('id',r.id).then(()=>{});
        render(); return;
      }
    }
    html+=`<div class="status-card closed">
      <div class="status-icon">🕐</div>
      <div class="status-texts">
        <div class="status-title">${r?.name||typeName} — 합주 곡 신청 준비 중</div>
        <div class="status-sub">관리자가 곡 신청을 열면 여기서 신청할 수 있습니다.</div>
      </div>
    </div>`;
  }

  else if(phase==='song'){
    const closeAt=r?.song_close_at;
    if(closeAt&&new Date(closeAt)<=new Date()){
      if(rounds[type]?.id===r.id){rounds[type].phase='song_end';rounds[type].song_close_at=null;}
      supabase.from('ensemble_rounds').update({phase:'song_end',song_close_at:null}).eq('id',r.id).then(()=>{});
      render(); return;
    }
    const diff=closeAt?new Date(closeAt)-Date.now():0;
    html+=`<div class="status-card song">
      <div class="status-icon">🎵</div>
      <div class="status-texts">
        <div class="status-title">${r.name||typeName} — 합주 곡 신청 진행 중</div>
        <div class="status-sub">최대 ${r.max_songs}곡 · 인당 ${r.max_songs_per_person}곡</div>
        ${closeAt?`<div class="status-sub" style="color:var(--warn)">⏰ 마감: ${fmtScheduled(closeAt)}</div>`:''}
        ${closeAt?`<div class="cd-num cd-close" id="cd-${type}">${diffToHMS(diff)}</div>`:''}
      </div>
    </div>`;
    if(closeAt){
      startCountdown(type,closeAt,async()=>{
        if(rounds[type]?.id===r.id){rounds[type].phase='song_end';rounds[type].song_close_at=null;}
        const {error}=await supabase.from('ensemble_rounds').update({phase:'song_end',song_close_at:null}).eq('id',r.id);
        if(error) console.error('song→song_end(timer):',error.message);
        render();
      });
    }
    const active=songs[currentType].filter(s=>s.status!=='rejected');
    const remaining=r.max_songs-active.length;
    html+=`<div class="form-card">
      <div class="form-title">곡 신청 (잔여 ${remaining}/${r.max_songs}곡)</div>
      <div class="form-row">
        <div><div class="fl">신청자 성명 *</div><input class="fi" id="sName" placeholder="홍길동" maxlength="20"/></div>
        <div><div class="fl">학번 *</div><input class="fi" id="sStudentId" placeholder="2021130905" maxlength="20"/></div>
      </div>
      <div class="form-row">
        <div><div class="fl">곡 제목 *</div><input class="fi" id="sTitle" placeholder="곡 제목" maxlength="100"/></div>
        <div><div class="fl">아티스트 *</div><input class="fi" id="sArtist" placeholder="아티스트명" maxlength="100"/></div>
      </div>
      <div>
        <div class="fl">필요 세션 * (이 곡에 필요한 세션 전체)</div>
        <div class="session-grid">
          ${SESSIONS.map(s=>`<input type="checkbox" class="session-chk" id="ns_${s.replace(/\s/g,'_')}" value="${s}" onchange="onSessionChkChange(this)"/><label class="session-label" for="ns_${s.replace(/\s/g,'_')}">${s}</label>`).join('')}
        </div>
      </div>
      <div>
        <div class="fl">내가 담당할 세션 * (신청자 본인)</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:5px">필요 세션에 포함된 세션만 선택할 수 있습니다</div>
        <div class="session-grid">
          ${SESSIONS.map(s=>`<input type="checkbox" class="session-chk" id="ms_${s.replace(/\s/g,'_')}" value="${s}" disabled/><label class="session-label" for="ms_${s.replace(/\s/g,'_')}">${s}</label>`).join('')}
        </div>
      </div>
      <div class="form-footer"><button class="btn btn-p" onclick="submitSong()">곡 신청</button></div>
    </div>`;
  }

  else if(phase==='song_end'){
    const target=r?.session_scheduled_at;
    if(target&&new Date(target)<=new Date()){
      if(rounds[type]?.id===r.id){rounds[type].phase='session';rounds[type].session_scheduled_at=null;}
      supabase.from('ensemble_rounds').update({phase:'session',session_scheduled_at:null}).eq('id',r.id).then(({error})=>{if(error)console.error('song_end→session:',error.message);});
      render(); return;
    }
    const diff=target?new Date(target)-Date.now():0;
    html+=`<div class="status-card closed">
      <div class="status-icon">⏸️</div>
      <div class="status-texts">
        <div class="status-title">${r.name||typeName} — 곡 신청이 끝났습니다</div>
        <div class="status-sub">세션 신청을 기다려주세요.</div>
        ${target?`<div class="cd-num cd-open" id="cd-${type}">${diffToHMS(diff)}</div>`:''}
      </div>
    </div>`;
    if(target){
      startCountdown(type,target,async()=>{
        if(rounds[type]?.id===r.id){rounds[type].phase='session';rounds[type].session_scheduled_at=null;}
        const {error}=await supabase.from('ensemble_rounds').update({phase:'session',session_scheduled_at:null}).eq('id',r.id);
        if(error) console.error('song_end→session(timer):',error.message);
        render();
      });
    }
  }

  else if(phase==='session'){
    const closeAt=r?.session_close_at;
    if(closeAt&&new Date(closeAt)<=new Date()){
      if(rounds[type]?.id===r.id){rounds[type].phase='session_end';rounds[type].session_close_at=null;}
      supabase.from('ensemble_rounds').update({phase:'session_end',session_close_at:null}).eq('id',r.id).then(()=>{});
      render(); return;
    }
    const diff=closeAt?new Date(closeAt)-Date.now():0;
    html+=`<div class="status-card session">
      <div class="status-icon">👥</div>
      <div class="status-texts">
        <div class="status-title">${r.name||typeName} — 합주 세션 신청 진행 중</div>
        <div class="status-sub">인당 최대 ${r.max_sessions_per_person}곡 참여 가능</div>
        ${closeAt?`<div class="status-sub" style="color:var(--warn)">⏰ 마감: ${fmtScheduled(closeAt)}</div>`:''}
        ${closeAt?`<div class="cd-num cd-close" id="cd-${type}">${diffToHMS(diff)}</div>`:''}
      </div>
    </div>`;
    if(closeAt){
      startCountdown(type,closeAt,async()=>{
        if(rounds[type]?.id===r.id){rounds[type].phase='session_end';rounds[type].session_close_at=null;}
        const {error}=await supabase.from('ensemble_rounds').update({phase:'session_end',session_close_at:null}).eq('id',r.id);
        if(error) console.error('session→session_end(timer):',error.message);
        render();
      });
    }
    const confirmedSongs=songs[currentType].filter(s=>s.status!=='rejected');
    html+=`<div class="form-card">
      <div class="form-title">세션 신청</div>
      <div class="form-row">
        <div><div class="fl">성명 *</div><input class="fi" id="ssName" placeholder="홍길동" maxlength="20"/></div>
        <div><div class="fl">학번 *</div><input class="fi" id="ssStudentId" placeholder="2021130905" maxlength="20"/></div>
      </div>
      <div class="form-row single">
        <div>
          <div class="fl">참여할 곡 *</div>
          <select class="fs" id="ssSong" onchange="onSongSelect()">
            <option value="">— 곡 선택 —</option>
            ${confirmedSongs.map(s=>`<option value="${s.id}" data-sessions='${JSON.stringify(s.sessions)}'>${esc(s.title)} — ${esc(s.artist)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="sessionSelectArea">
        <div class="no-song-selected">곡을 선택하면 신청 가능한 세션이 표시됩니다.</div>
      </div>
      <div class="form-footer"><button class="btn btn-p" onclick="submitSession()">세션 신청</button></div>
    </div>`;
  }

  else if(phase==='session_end'){
    const allSessApps=Object.values(sessionMap).flat().filter(a=>a.round_id===r.id);
    const dndDone=allSessApps.some(a=>a.status==='confirmed'||a.status==='rejected');
    if(dndDone){
      const target=r?.has_session2&&r?.session2_scheduled_at;
      if(target&&new Date(target)<=new Date()){
        if(rounds[type]?.id===r.id){rounds[type].phase='session2';rounds[type].session2_scheduled_at=null;}
        supabase.from('ensemble_rounds').update({phase:'session2',session2_scheduled_at:null}).eq('id',r.id).then(({error})=>{if(error)console.error('session_end→session2:',error.message);});
        render(); return;
      }
      html+=`<div class="status-card closed">
        <div class="status-icon">✅</div>
        <div class="status-texts">
          <div class="status-title">${r?.name||typeName} — 1차 팀 구성이 완료됐습니다</div>
          <div class="status-sub">${r?.has_session2?'2차 세션 신청을 기다려주세요.':'합주 팀을 확인하세요.'}</div>
        </div>
      </div>`;
      if(target){
        const diff=new Date(target)-Date.now();
        html+=`<div class="cd-num cd-open" id="cd-${type}">${diffToHMS(diff)}</div>`;
        startCountdown(type,target,async()=>{
          if(rounds[type]?.id===r.id){rounds[type].phase='session2';rounds[type].session2_scheduled_at=null;}
          const {error}=await supabase.from('ensemble_rounds').update({phase:'session2',session2_scheduled_at:null}).eq('id',r.id);
          if(error) console.error('session_end→session2(timer):',error.message);
          render();
        });
      }
    } else {
      html+=`<div class="status-card closed">
        <div class="status-icon">⏸️</div>
        <div class="status-texts">
          <div class="status-title">${r?.name||typeName} — 세션 신청이 끝났습니다</div>
          <div class="status-sub">합주 팀 배정을 기다려주세요.</div>
        </div>
      </div>`;
    }
  }

  else if(phase==='session2'){
    const closeAt=r?.session2_close_at;
    if(closeAt&&new Date(closeAt)<=new Date()){
      if(rounds[type]?.id===r.id){rounds[type].phase='session2_end';rounds[type].session2_close_at=null;}
      supabase.from('ensemble_rounds').update({phase:'session2_end',session2_close_at:null}).eq('id',r.id).then(()=>{});
      render(); return;
    }
    const diff=closeAt?new Date(closeAt)-Date.now():0;
    html+=`<div class="status-card session">
      <div class="status-icon">👥</div>
      <div class="status-texts">
        <div class="status-title">${r?.name||typeName} — 2차 세션 신청 진행 중</div>
        <div class="status-sub">인당 최대 ${r.max_sessions_per_person}곡 참여 가능</div>
        ${closeAt?`<div class="status-sub" style="color:var(--warn)">⏰ 마감: ${fmtScheduled(closeAt)}</div>`:''}
        ${closeAt?`<div class="cd-num cd-close" id="cd-${type}">${diffToHMS(diff)}</div>`:''}
      </div>
    </div>`;
    if(closeAt){
      startCountdown(type,closeAt,async()=>{
        if(rounds[type]?.id===r.id){rounds[type].phase='session2_end';rounds[type].session2_close_at=null;}
        const {error}=await supabase.from('ensemble_rounds').update({phase:'session2_end',session2_close_at:null}).eq('id',r.id);
        if(error) console.error('session2→session2_end(timer):',error.message);
        render();
      });
    }
    const confirmedSongs=songs[type].filter(s=>s.status!=='rejected');
    const isMissingOnly=r?.session2_mode==='missing_only';
    html+=`<div class="form-card">
      <div class="form-title">2차 세션 신청</div>
      <div class="form-row">
        <div><div class="fl">성명 *</div><input class="fi" id="ssName" placeholder="홍길동" maxlength="20"/></div>
        <div><div class="fl">학번 *</div><input class="fi" id="ssStudentId" placeholder="2021130905" maxlength="20"/></div>
      </div>
      <div class="form-row single">
        <div>
          <div class="fl">참여할 곡 *</div>
          <select class="fs" id="ssSong" onchange="onSess2SongSelect()">
            <option value="">— 곡 선택 —</option>
            ${confirmedSongs.map(s=>{
              const confirmed1st=(sessionMap[s.id]||[]).filter(a=>a.status==='confirmed').flatMap(a=>a.sessions);
              const available=isMissingOnly?s.sessions.filter(x=>!confirmed1st.includes(x)):s.sessions;
              return `<option value="${s.id}" data-sessions='${JSON.stringify(available)}' data-missing='${isMissingOnly}'>${esc(s.title)} — ${esc(s.artist)}${isMissingOnly&&!available.length?' (빈 세션 없음)':''}</option>`;
            }).join('')}
          </select>
        </div>
      </div>
      <div id="sessionSelectArea">
        <div class="no-song-selected">곡을 선택하면 신청 가능한 세션이 표시됩니다.</div>
      </div>
      <div class="form-footer"><button class="btn btn-p" onclick="submitSession2()">세션 신청</button></div>
    </div>`;
  }

  else if(phase==='session2_end'){
    const allSessApps2=Object.values(sessionMap).flat().filter(a=>a.round_id===r.id&&(a.session_round||1)===2);
    const dndDone2=allSessApps2.some(a=>a.status==='confirmed'||a.status==='rejected');
    html+=`<div class="status-card closed">
      <div class="status-icon">${dndDone2?'✅':'⏸️'}</div>
      <div class="status-texts">
        <div class="status-title">${r?.name||typeName} — ${dndDone2?'팀 구성이 완료됐습니다':'2차 세션 신청이 끝났습니다'}</div>
        <div class="status-sub">${dndDone2?'합주 팀을 확인하세요.':'합주 팀 배정을 기다려주세요.'}</div>
      </div>
    </div>`;
  }

  else if(phase==='closed'){
    html+=`<div class="status-card closed">
      <div class="status-icon">✅</div>
      <div class="status-texts">
        <div class="status-title">${r?.name||typeName} — 팀 구성이 완료됐습니다</div>
        <div class="status-sub">합주 팀을 확인하세요.</div>
      </div>
    </div>`;
  }

  else {
    html+=`<div class="status-card closed">
      <div class="status-icon">❌</div>
      <div class="status-texts">
        <div class="status-title">${typeName} — 신청 기간이 아닙니다</div>
        <div class="status-sub">관리자가 신청을 열면 여기서 신청할 수 있습니다.</div>
      </div>
    </div>`;
  }

  html+=`<div id="songListEl"></div>`;
  el.innerHTML=html;
  renderList();
}

function renderList(){
  const r=rounds[currentType];
  const phase=r?.phase||'closed';
  const songList=songs[currentType]||[];
  const active=songList.filter(s=>s.status!=='rejected');
  let filtered=active;
  if(searchQ){
    filtered=active.filter(s=>
      s.title.toLowerCase().includes(searchQ)||
      s.artist.toLowerCase().includes(searchQ)||
      s.sessions.some(sess=>sess.toLowerCase().includes(searchQ))
    );
  }
  const el=document.getElementById('songListEl');
  if(!el) return;
  if(!active.length){el.innerHTML='';return;}
  let html=`<div class="list-card">
    <div class="list-card-hdr">
      <div class="list-card-title">${phase==='song'?'신청 현황':'곡 목록'}</div>
      <div class="list-card-count">${searchQ?`${filtered.length}/${active.length}곡`:active.length+'곡'}</div>
    </div>`;
  if(!filtered.length){
    html+=`<div class="empty-search">검색 결과가 없습니다</div>`;
  } else {
    filtered.forEach((s,i)=>{ html+=renderSongItem(s,i+1,phase); });
  }
  html+=`</div>`;
  el.innerHTML=html;
}

function renderSongItem(s,num,phase){
  const sessApps=(sessionMap[s.id]||[]);
  const filledSessions=new Set(sessApps.flatMap(a=>a.sessions));
  const needBadges=s.sessions.map(sess=>
    `<span class="sneed ${filledSessions.has(sess)?'filled':''}">${sess}</span>`).join('');
  const closedLike=['closed','session_end','session2','session2_end'].includes(phase);
  const sessionRows=sessApps.length?`
    <div class="session-list">
      ${sessApps.map(a=>{
        const isApplicant=a.student_id===s.student_id;
        const rejected=closedLike&&a.status==='rejected';
        const rBadge=(a.session_round||1)===2&&['session2','session2_end','closed'].includes(phase)?`<span style="font-size:9px;background:var(--accent2,#e89c3c);color:#fff;border-radius:3px;padding:1px 3px;margin-left:3px">2차</span>`:'';
        const appBadge=isApplicant?`<span style="font-size:9px;background:var(--accent);color:#000;border-radius:3px;padding:1px 4px;margin-left:3px;font-weight:700">신청자</span>`:'';
        return `<div class="session-row" style="${rejected?'opacity:.55':''}">
          <span class="session-row-name" style="${rejected?'text-decoration:line-through;color:var(--text3)':''}${isApplicant?';font-weight:700':''}">${esc(a.applicant_name)}(${esc(a.student_id.slice(-3))})${rBadge}${appBadge}</span>
          <div class="session-row-right">
            <div class="session-row-sessions">
              ${a.sessions.map(sess=>`<span class="sess-tag ${a.status==='confirmed'?'confirmed':''}">${sess}</span>`).join('')}
            </div>
            <span class="sess-ts">${fmtTime(a.created_at)}</span>
          </div>
        </div>`;}).join('')}
    </div>`:'';
  return `<div class="song-item">
    <div class="song-item-hdr">
      <span class="song-num">${String(num).padStart(2,'0')}</span>
      <div class="song-info">
        <div class="song-title">${esc(s.title)}</div>
        <div class="song-artist">${esc(s.artist)}</div>
      </div>
    </div>
    <div class="song-meta">
      <span class="song-applicant">신청: ${esc(s.applicant_name)}(${esc(s.student_id.slice(-3))})</span>
      <span class="song-ts">${fmtTime(s.created_at)}</span>
      <div class="sessions-needed">${needBadges}</div>
    </div>
    ${sessApps.length||phase==='session'?sessionRows:''}
    ${phase==='session'&&s.status!=='rejected'?
      `<div style="display:flex;justify-content:flex-end;margin-top:4px">
         <button class="btn btn-s btn-xs" onclick="openSessionModal(${s.id})">이 곡에 세션 신청</button>
       </div>`:''}
  </div>`;
}

window.onSongSelect=function(){
  const sel=document.getElementById('ssSong');
  const area=document.getElementById('sessionSelectArea');
  if(!sel||!area) return;
  const opt=sel.options[sel.selectedIndex];
  if(!opt||!opt.value){
    area.innerHTML='<div class="no-song-selected">곡을 선택하면 신청 가능한 세션이 표시됩니다.</div>';
    return;
  }
  const neededSessions=JSON.parse(opt.dataset.sessions||'[]');
  if(!neededSessions.length){
    area.innerHTML='<div class="no-song-selected">이 곡의 필요 세션 정보가 없습니다.</div>';
    return;
  }
  const songId2=parseInt(opt.value);
  const songObj2=songs[currentType].find(s=>s.id===songId2);
  const appApp2=songObj2?(sessionMap[songId2]||[]).find(a=>a.student_id===songObj2.student_id&&a.status!=='rejected'):null;
  const appSess2=new Set(appApp2?.sessions||[]);
  const avail2=neededSessions.filter(s=>!appSess2.has(s));
  area.innerHTML=`
    <div class="session-area">
      <div class="fl">참여할 세션 *</div>
      ${appSess2.size?`<div style="font-size:11px;color:var(--text3);margin-bottom:5px">신청자 담당 세션(${[...appSess2].join(', ')})은 선택 불가</div>`:''}
      ${avail2.length?`<div class="session-grid">
        ${avail2.map(s=>`
          <input type="checkbox" class="session-chk" id="sss_${s.replace(/\s/g,'_')}" value="${s}"/>
          <label class="session-label" for="sss_${s.replace(/\s/g,'_')}">${s}</label>`).join('')}
      </div>`:'<div class="no-song-selected">신청 가능한 세션이 없습니다.</div>'}
    </div>`;
};

window.onSessionChkChange=function(el){
  const s=el.value;
  const requires={'보컬2':'보컬1','기타2':'기타1','키보드2':'키보드1'};
  const gates={'보컬1':'보컬2','기타1':'기타2','키보드1':'키보드2'};
  if(el.checked){
    const req=requires[s];
    if(req){
      const reqEl=document.getElementById('ns_'+req.replace(/\s/g,'_'));
      if(!reqEl||!reqEl.checked){
        el.checked=false;
        const base=s.slice(0,-1);
        window.toast(`${base} 1을 선택해야 ${base} 2를 추가할 수 있습니다`,'err');
      }
    }
  } else {
    const dep=gates[s];
    if(dep){
      const depEl=document.getElementById('ns_'+dep.replace(/\s/g,'_'));
      if(depEl&&depEl.checked) depEl.checked=false;
    }
  }
  syncMySessionCheckboxes();
};

function syncMySessionCheckboxes(){
  SESSIONS.forEach(s=>{
    const nsEl=document.getElementById('ns_'+s.replace(/\s/g,'_'));
    const msEl=document.getElementById('ms_'+s.replace(/\s/g,'_'));
    if(!nsEl||!msEl) return;
    msEl.disabled=!nsEl.checked;
    if(!nsEl.checked) msEl.checked=false;
  });
}

window.submitSong=async function(){
  const r=rounds[currentType];
  if(!r||r.phase!=='song'){window.toast('현재 곡 신청 기간이 아닙니다','err');return;}
  if(r.song_close_at&&new Date(r.song_close_at)<=new Date()){window.toast('곡 신청이 마감됐습니다','err');return;}
  const name=document.getElementById('sName').value.trim();
  const sid=document.getElementById('sStudentId').value.trim();
  const title=document.getElementById('sTitle').value.trim();
  const artist=document.getElementById('sArtist').value.trim();
  const sessions=[...document.querySelectorAll('[id^="ns_"]:checked')].map(c=>c.value);
  const mySessions=[...document.querySelectorAll('[id^="ms_"]:checked')].map(c=>c.value);
  if(!name||!sid||!title||!artist){window.toast('모든 필드를 입력해주세요','err');return;}
  if(!sessions.length){window.toast('필요 세션을 하나 이상 선택해주세요','err');return;}
  if(!mySessions.length){window.toast('본인이 담당할 세션을 하나 이상 선택해주세요','err');return;}
  const titleNorm=title.trim().toLowerCase();
  const artistNorm=artist.trim().toLowerCase();
  const dup=songs[currentType].find(s=>
    s.status!=='rejected'&&
    s.title.trim().toLowerCase()===titleNorm&&
    s.artist.trim().toLowerCase()===artistNorm
  );
  if(dup){window.toast('이미 동일한 곡이 신청되어 있습니다','err');return;}
  const myCount=songs[currentType].filter(s=>s.student_id===sid&&s.status!=='rejected').length;
  if(myCount>=r.max_songs_per_person){window.toast(`인당 최대 ${r.max_songs_per_person}곡까지 신청 가능합니다`,'err');return;}
  const totalCount=songs[currentType].filter(s=>s.status!=='rejected').length;
  if(totalCount>=r.max_songs){window.toast('신청 가능한 곡 수가 초과됐습니다','err');return;}
  try{
    const {data:songData,error:sErr}=await supabase.from('song_applications').insert({
      round_id:r.id,applicant_name:name,student_id:sid,title,artist,sessions,status:'confirmed'
    }).select().single();
    if(sErr) throw sErr;
    // ensure confirmed even if a DB trigger overrides the status on insert
    if(songData.status!=='confirmed'){
      await supabase.from('song_applications').update({status:'confirmed'}).eq('id',songData.id);
    }
    const {error:sessErr}=await supabase.from('session_applications').insert({
      song_id:songData.id,round_id:r.id,applicant_name:name,student_id:sid,sessions:mySessions,status:'pending',session_round:1
    });
    if(sessErr) console.error('신청자 세션 등록 실패:',sessErr.message);
    window.toast('곡 신청이 완료됐습니다','ok');
    await loadAll();
  }catch(e){window.toast(errMsg(e),'err');}
};

window.submitSession=async function(){
  const r=rounds[currentType];
  if(!r||r.phase!=='session'){window.toast('현재 세션 신청 기간이 아닙니다','err');return;}
  if(r.session_close_at&&new Date(r.session_close_at)<=new Date()){window.toast('세션 신청이 마감됐습니다','err');return;}
  const name=document.getElementById('ssName').value.trim();
  const sid=document.getElementById('ssStudentId').value.trim();
  const songId=document.getElementById('ssSong').value;
  if(!name||!sid||!songId){window.toast('모든 필드를 입력해주세요','err');return;}
  const sessions=[...document.querySelectorAll('[id^="sss_"]:checked')].map(c=>c.value);
  if(!sessions.length){window.toast('참여할 세션을 하나 이상 선택해주세요','err');return;}
  await doSubmitSession(parseInt(songId),r,name,sid,sessions,1);
};

window.submitSession2=async function(){
  const r=rounds[currentType];
  if(!r||r.phase!=='session2'){window.toast('현재 2차 세션 신청 기간이 아닙니다','err');return;}
  if(r.session2_close_at&&new Date(r.session2_close_at)<=new Date()){window.toast('2차 세션 신청이 마감됐습니다','err');return;}
  const name=document.getElementById('ssName').value.trim();
  const sid=document.getElementById('ssStudentId').value.trim();
  const songId=document.getElementById('ssSong').value;
  if(!name||!sid||!songId){window.toast('모든 필드를 입력해주세요','err');return;}
  const sessions=[...document.querySelectorAll('[id^="sss_"]:checked')].map(c=>c.value);
  if(!sessions.length){window.toast('참여할 세션을 하나 이상 선택해주세요','err');return;}
  await doSubmitSession(parseInt(songId),r,name,sid,sessions,2);
};

window.onSess2SongSelect=function(){
  const sel=document.getElementById('ssSong');
  const area=document.getElementById('sessionSelectArea');
  if(!sel||!area) return;
  const opt=sel.options[sel.selectedIndex];
  if(!opt||!opt.value){area.innerHTML='<div class="no-song-selected">곡을 선택하면 신청 가능한 세션이 표시됩니다.</div>';return;}
  const songId3=parseInt(opt.value);
  const songObj3=songs[currentType].find(s=>s.id===songId3);
  const appApp3=songObj3?(sessionMap[songId3]||[]).find(a=>a.student_id===songObj3.student_id&&a.status!=='rejected'):null;
  const appSess3=new Set(appApp3?.sessions||[]);
  const available=JSON.parse(opt.dataset.sessions||'[]').filter(s=>!appSess3.has(s));
  if(!available.length){area.innerHTML='<div class="no-song-selected">이 곡에 신청 가능한 빈 세션이 없습니다.</div>';return;}
  area.innerHTML=`<div class="session-area"><div class="fl">참여할 세션 *</div>${appSess3.size?`<div style="font-size:11px;color:var(--text3);margin-bottom:5px">신청자 담당 세션(${[...appSess3].join(', ')})은 선택 불가</div>`:''}<div class="session-grid">${available.map(s=>`<input type="checkbox" class="session-chk" id="sss_${s.replace(/\s/g,'_')}" value="${s}"/><label class="session-label" for="sss_${s.replace(/\s/g,'_')}">${s}</label>`).join('')}</div></div>`;
};

window.openSessionModal=function(songId){
  const song=songs[currentType].find(s=>s.id===songId);
  const neededSessions=song.sessions||[];
  const applicantApp=(sessionMap[songId]||[]).find(a=>a.student_id===song.student_id&&a.status!=='rejected');
  const applicantSessions=new Set(applicantApp?.sessions||[]);
  const availableSessions=neededSessions.filter(s=>!applicantSessions.has(s));
  showModal(`세션 신청 — ${esc(song.title)}`,
    `<div class="irow"><span class="ik">곡</span><span style="font-weight:700">${esc(song.title)}</span></div>
     <div class="irow"><span class="ik">아티스트</span><span>${esc(song.artist)}</span></div>
     <div><div class="fl" style="margin-top:8px">성명 *</div><input class="fi" id="mssName" placeholder="홍길동" maxlength="20"/></div>
     <div><div class="fl">학번 *</div><input class="fi" id="mssId" placeholder="2021130905" maxlength="20"/></div>
     <div>
       <div class="fl">참여할 세션 * (이 곡에 필요한 세션만 표시)</div>
       ${applicantSessions.size?`<div style="font-size:11px;color:var(--text3);margin-bottom:5px">신청자 담당 세션(${[...applicantSessions].join(', ')})은 선택 불가</div>`:''}
       ${availableSessions.length?`<div class="session-grid">
         ${availableSessions.map(s=>`
           <input type="checkbox" class="session-chk" id="mss_${s.replace(/\s/g,'_')}" value="${s}"/>
           <label class="session-label" for="mss_${s.replace(/\s/g,'_')}">${s}</label>`).join('')}
       </div>`:'<div style="font-size:12px;color:var(--text3)">신청 가능한 세션이 없습니다.</div>'}
     </div>`,
    `<button class="btn btn-s" onclick="closeModal()">취소</button>
     <button class="btn btn-p" id="mssBtn" onclick="submitSessionModal(${songId})">신청</button>`
  );
};

window.submitSessionModal=async function(songId){
  const r=rounds[currentType];
  const name=document.getElementById('mssName').value.trim();
  const sid=document.getElementById('mssId').value.trim();
  const sessions=[...document.querySelectorAll('[id^="mss_"]:checked')].map(c=>c.value);
  if(!name||!sid){window.toast('성명과 학번을 입력해주세요','err');return;}
  if(!sessions.length){window.toast('세션을 하나 이상 선택해주세요','err');return;}
  const btn=document.getElementById('mssBtn'); btn.disabled=true;
  const ok=await doSubmitSession(songId,r,name,sid,sessions,r?.phase==='session2'?2:1);
  if(!ok) btn.disabled=false;
};

async function doSubmitSession(songId,r,name,sid,sessions,sessionRound=1){
  const allSess=Object.values(sessionMap).flat().filter(a=>(a.session_round||1)===sessionRound);
  const mySongs=new Set(allSess.filter(a=>a.student_id===sid&&a.round_id===r.id&&a.status!=='rejected').map(a=>a.song_id));
  if(!mySongs.has(songId)&&mySongs.size>=r.max_sessions_per_person){
    window.toast(`인당 최대 ${r.max_sessions_per_person}곡까지 참여 가능합니다`,'err');return false;
  }
  const existing=(sessionMap[songId]||[]).find(a=>a.student_id===sid&&a.status!=='rejected'&&(a.session_round||1)===sessionRound);
  if(existing){window.toast('이미 이 곡에 세션을 신청했습니다','err');return false;}
  const songObj=[...songs.regular,...songs.busking].find(s=>s.id===songId);
  if(songObj&&songObj.student_id!==sid){
    const applicantApp=(sessionMap[songId]||[]).find(a=>a.student_id===songObj.student_id&&a.status!=='rejected');
    if(applicantApp){
      const conflict=sessions.filter(s=>applicantApp.sessions.includes(s));
      if(conflict.length){window.toast(`신청자가 담당한 세션(${conflict.join(', ')})에는 신청할 수 없습니다`,'err');return false;}
    }
  }
  try{
    await supabase.from('session_applications').insert({
      song_id:songId,round_id:r.id,applicant_name:name,student_id:sid,sessions,status:'pending',session_round:sessionRound
    });
    window.toast('세션 신청이 완료됐습니다','ok');
    window.closeModal?.(); await loadAll(); return true;
  }catch(e){window.toast(errMsg(e),'err');return false;}
}

function showModal(title,body,foot){
  const ttl=document.getElementById('modalTtl');
  const bd=document.getElementById('modalBody');
  const ft=document.getElementById('modalFoot');
  const modalBd=document.getElementById('modalBd');
  if(!ttl||!bd||!ft||!modalBd) return;
  ttl.textContent=title; bd.innerHTML=body; ft.innerHTML=foot;
  const modal=document.querySelector('#modalBd .modal');
  if(modal){ modal.style.transform=''; modal.style.transition=''; }
  modalBd.style.display='flex';
  document.body.style.overflow='hidden';
  if(window.innerWidth<=700&&modal){
    let startY=0,isDragging=false;
    const onStart=e=>{startY=e.touches[0].clientY;isDragging=true;modal.style.transition='none';};
    const onMove=e=>{if(!isDragging)return;const dy=e.touches[0].clientY-startY;if(dy>0)modal.style.transform=`translateY(${dy}px)`;};
    const onEnd=e=>{if(!isDragging)return;isDragging=false;const dy=e.changedTouches[0].clientY-startY;modal.style.transition='transform .2s';if(dy>100){modal.style.transform=`translateY(100%)`;setTimeout(()=>window.closeModal?.(),200);}else{modal.style.transform='';}};
    modal.addEventListener('touchstart',onStart,{passive:true});
    modal.addEventListener('touchmove',onMove,{passive:true});
    modal.addEventListener('touchend',onEnd);
  }
}
