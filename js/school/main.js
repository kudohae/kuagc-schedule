import { supabase } from '../supabase.js';
import { initTheme, toggleTheme } from '../utils/theme.js';
import { diffToHMS, fmtDate } from '../utils/time.js';
import { syncServerTime, serverNow } from '../utils/serverTime.js';

let round=null, prevRound=null, classes=[], apps=[], prevApps=[];
let cdTimer=null;
let _rtChannel=null;
let _bcChannel=null;
let _outerContainer=null;
let _withdrawLookup=null;
let _lastSchoolSubmitTs=0;
let _lastLookupTs=0;
let _pollTimer=null;

function broadcastRefresh(){_bcChannel?.send({type:'broadcast',event:'update',payload:{}}).catch(()=>{});}

function escHtml(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function stopCd(){if(cdTimer){clearInterval(cdTimer);cdTimer=null;}}

function startCd(targetTs,onExpired){
  stopCd();
  const update=()=>{
    const diff=new Date(targetTs)-serverNow();
    const el=document.getElementById('cdEl');
    if(el) el.textContent=diffToHMS(diff);
    if(diff<=0){stopCd();onExpired();}
  };
  update();
  cdTimer=setInterval(update,1000);
}

// ── EXPORTED INIT ─────────────────────────────────────────────────────
export async function init(outerContainer) {
  _outerContainer = outerContainer;
  round=null; prevRound=null; classes=[]; apps=[]; prevApps=[];

  outerContainer.innerHTML = '<div style="display:flex;justify-content:center;padding:40px"><div class="spin"></div></div>';

  const inner = document.createElement('div');
  inner.className = 'container';
  inner.id = 'container';
  outerContainer.innerHTML = '';
  outerContainer.appendChild(inner);

  await syncServerTime(supabase);
  await load();

  _rtChannel = supabase.channel('school-public-rt-' + Date.now())
    .on('postgres_changes',{event:'*',schema:'public',table:'school_rounds'},()=>{
      if(document.getElementById('container')) load();
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'schools'},()=>{
      if(document.getElementById('container')) load();
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'school_applications'},async()=>{
      if(!round||!document.getElementById('container')) return;
      const {data}=await supabase.from('school_applications').select('*').eq('round_id',round.id).order('created_at');
      apps=data||[];
      render();
    })
    .subscribe();

  _bcChannel=supabase.channel('school-pub')
    .on('broadcast',{event:'update'},()=>{
      if(document.getElementById('container')) load();
    })
    .subscribe();

  _pollTimer=setInterval(async()=>{
    if(!document.getElementById('container')) return;
    const{data}=await supabase.from('school_rounds').select('id,status,open_at,close_at').order('created_at',{ascending:false}).limit(1).maybeSingle();
    const chg=(!data&&round)||(data&&(!round||data.status!==round.status||data.open_at!==round.open_at||data.close_at!==round.close_at));
    if(chg) await load();
  },3000);

  return function destroy() {
    stopCd();
    if(_pollTimer){clearInterval(_pollTimer);_pollTimer=null;}
    if(_rtChannel){ supabase.removeChannel(_rtChannel); _rtChannel=null; }
    if(_bcChannel){ supabase.removeChannel(_bcChannel); _bcChannel=null; }
    _outerContainer = null;
  };
}

async function load(){
  const {data:rds}=await supabase.from('school_rounds').select('*').order('created_at',{ascending:false}).limit(2);
  round=(rds||[])[0]||null;

  if(round){
    const {data:prev}=await supabase.from('school_rounds').select('*').eq('status','closed').neq('id',round.id).order('created_at',{ascending:false}).limit(1);
    prevRound=prev?.[0]||null;

    const [{data:sc},{data:ap}]=await Promise.all([
      supabase.from('schools').select('*').eq('round_id',round.id).order('created_at'),
      supabase.from('school_applications').select('*').eq('round_id',round.id).order('created_at')
    ]);
    classes=sc||[];
    apps=ap||[];

    if(prevRound&&round.prioritize_returning){
      const {data:pa}=await supabase.from('school_applications').select('student_id')
        .eq('round_id',prevRound.id).eq('status','assigned');
      prevApps=pa||[];
    } else {
      prevApps=[];
    }
  }
  render();
}

function getRoundName(){
  if(round?.semester&&round?.round_num) return `${round.semester}학기 ${round.round_num}차 스쿨 신청`;
  return round?.name||'스쿨 신청';
}

function isReturning(sid){
  if(!round?.prioritize_returning) return false;
  return prevApps.some(a=>a.student_id===sid);
}

function countAssigned(classId){
  return apps.filter(a=>a.assigned_school_id===classId&&a.status==='assigned').length;
}

function pickClass(pref1,pref2){
  const c1=classes.find(c=>c.id===pref1);
  if(c1&&countAssigned(pref1)<(c1.capacity||0)) return pref1;
  if(pref2){
    const c2=classes.find(c=>c.id===pref2);
    if(c2&&countAssigned(pref2)<(c2.capacity||0)) return pref2;
  }
  return null;
}

function render(){
  stopCd();
  const el=document.getElementById('container');
  if(!el) return;
  if(!round){
    el.innerHTML='<div class="empty-state">스쿨 신청 기간이 아닙니다.</div>';
    return;
  }
  const {status}=round;
  if(status==='draft') renderDraft();
  else if(status==='open') renderOpen();
  else renderClosed();
}

function renderDraft(){
  const el=document.getElementById('container');
  if(!el) return;
  const name=getRoundName();
  const openAt=round.open_at;
  let html=`<div class="round-status draft">
    <div class="rs-icon">⏳</div>
    <div class="rs-texts">
      <div class="rs-title">${name}</div>
      <div class="rs-sub">스쿨 신청 준비 중입니다.</div>
      ${openAt?`<div class="rs-sub" style="margin-top:2px">오픈 예정: ${fmtDate(openAt)}</div><div class="cd-num cd-open" id="cdEl">...</div>`:''}
    </div>
  </div>`;
  el.innerHTML=html;
  if(openAt){
    if(new Date(openAt)<=serverNow()){autoOpen();}
    else startCd(openAt,autoOpen);
  }
}

async function autoOpen(){
  // Idempotent: only opens if still in 'draft' state
  const {error}=await supabase.from('school_rounds').update({status:'open'}).eq('id',round.id).eq('status','draft');
  if(!error){round.status='open';render();}
}

function renderOpen(){
  const el=document.getElementById('container');
  if(!el) return;
  const name=getRoundName();
  const closeAt=round.close_at;
  if(closeAt&&new Date(closeAt)<=serverNow()){autoClose();return;}

  let html=`<div class="round-status open">
    <div class="rs-icon">📋</div>
    <div class="rs-texts">
      <div class="rs-title">${name} — 신청 진행 중</div>
      ${closeAt?`<div class="rs-sub" style="color:var(--warn)">⏰ 마감: ${fmtDate(closeAt)}</div><div class="cd-num cd-close" id="cdEl">...</div>`:'<div class="rs-sub">성명·학번·1지망을 입력하고 신청하세요.</div>'}
      ${round.prioritize_returning?'<div class="rs-notice">ℹ️ 이전 회차 스쿨을 들었던 수강자는 신규 수강자의 배정이 모두 끝난 뒤에 배정합니다.</div>':''}
    </div>
  </div>`;

  html+=`<div class="apply-form-card">
    <div class="apply-form-title">스쿨 신청</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="form-grid">
        <div><div class="fl">성명 *</div><input class="fi" id="applyName" placeholder="허우진" autocomplete="off"/></div>
        <div><div class="fl">학번 *</div><input class="fi" id="applySid" placeholder="2021130905" inputmode="numeric" autocomplete="off"/></div>
      </div>
      <div><div class="fl">1지망 *</div><select class="fi" id="applyPref1">
        <option value="">— 선택하세요 —</option>
        ${classes.map(c=>`<option value="${c.id}">${escHtml(c.name)}${c.teacher_name?` (담당: ${escHtml(c.teacher_name)})`:''  }${countAssigned(c.id)>=(c.capacity||0)?' — 만석':''}</option>`).join('')}
      </select></div>
      <div><div class="fl">2지망 (선택)</div><select class="fi" id="applyPref2">
        <option value="">— 없음 —</option>
        ${classes.map(c=>`<option value="${c.id}">${escHtml(c.name)}${c.teacher_name?` (담당: ${escHtml(c.teacher_name)})`:''  }${countAssigned(c.id)>=(c.capacity||0)?' — 만석':''}</option>`).join('')}
      </select></div>
      <div class="form-foot"><button class="btn btn-p" id="applySubmitBtn" onclick="submitApply()">신청하기</button></div>
    </div>
  </div>`;

  html+=`<div class="withdraw-card">
    <div class="withdraw-title">내 신청 철회</div>
    <div id="withdrawContent">${withdrawInputHtml()}</div>
  </div>`;

  html+=renderClassCards(true);
  el.innerHTML=html;
  _withdrawLookup=null;
  if(closeAt) startCd(closeAt,autoClose);
}

async function autoClose(){
  const {data:fresh}=await supabase.from('school_rounds').select('status,close_at').eq('id',round.id).single();
  if(!fresh||fresh.status!=='open'){ await load(); return; }
  if(fresh.close_at&&new Date(fresh.close_at)>new Date(serverNow())){round.close_at=fresh.close_at;render();return;}
  const {error}=await supabase.from('school_rounds').update({status:'closed'}).eq('id',round.id).eq('status','open');
  if(!error){
    round.status='closed';
    if(round.prioritize_returning) await processReturning();
    await load();
  }
}

async function processReturning(){
  const pending=apps.filter(a=>a.status==='pending').sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const counts={};
  apps.filter(a=>a.status==='assigned'&&a.assigned_school_id).forEach(a=>{
    counts[a.assigned_school_id]=(counts[a.assigned_school_id]||0)+1;
  });
  for(const app of pending){
    const p1=app.pref1_school_id, p2=app.pref2_school_id;
    const c1=classes.find(c=>c.id===p1), c2=classes.find(c=>c.id===p2);
    let assignedId=null;
    if(c1&&(counts[p1]||0)<(c1.capacity||0)){assignedId=p1;counts[p1]=(counts[p1]||0)+1;}
    else if(p2&&c2&&(counts[p2]||0)<(c2.capacity||0)){assignedId=p2;counts[p2]=(counts[p2]||0)+1;}
    const {error}=await supabase.from('school_applications').update({
      assigned_school_id:assignedId,status:assignedId?'assigned':'unassigned'
    }).eq('id',app.id);
    if(!error){
      const a=apps.find(x=>x.id===app.id);
      if(a){a.assigned_school_id=assignedId;a.status=assignedId?'assigned':'unassigned';}
    }
  }
}

function renderClosed(){
  const el=document.getElementById('container');
  if(!el) return;
  const name=getRoundName();
  let html=`<div class="round-status closed">
    <div class="rs-icon">🔒</div>
    <div class="rs-texts">
      <div class="rs-title">${name} — 마감</div>
      <div class="rs-sub">스쿨 신청이 마감됐습니다. 배정 결과를 확인하세요.</div>
    </div>
  </div>`;
  html+=renderClassCards(false);
  el.innerHTML=html;
}

function renderClassCards(isOpen){
  let html='';
  classes.forEach(c=>{
    const assigned=apps.filter(a=>a.assigned_school_id===c.id&&a.status==='assigned').sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
    const cap=c.capacity||0;
    const isFull=assigned.length>=cap;
    const fillPct=Math.min(100,Math.round((assigned.length/Math.max(1,cap))*100));
    let badgeCls='closed',badgeTxt='마감';
    if(isOpen&&isFull){badgeCls='full';badgeTxt='만석';}
    else if(isOpen){badgeCls='open';badgeTxt='모집중';}
    html+=`<div class="school-card">
      <div class="school-card-hdr">
        <div>
          <div class="school-name">${escHtml(c.name)}</div>
          ${c.teacher_name?`<div class="school-teacher">담당: ${escHtml(c.teacher_name)}</div>`:''}
          ${c.schedule_day?`<div class="school-schedule">${escHtml(c.schedule_day)}요일 ${Number(c.schedule_hour)}시</div>`:''}
        </div>
        <span class="school-badge ${badgeCls}">${badgeTxt}</span>
      </div>
      ${c.description?`<div class="school-desc-bar">
        <button class="school-desc-toggle" onclick="toggleSchoolDesc(${c.id})">스쿨 설명 보기</button>
        <div class="school-desc-body" id="desc-${c.id}">${escHtml(c.description).replace(/\n/g,'<br>')}</div>
      </div>`:''}
      <div class="school-body">
        <div class="cap-row">
          <div class="cap-bar"><div class="cap-fill${isFull?' full':''}" style="width:${fillPct}%"></div></div>
          <div class="cap-text">${assigned.length} / ${cap}명</div>
        </div>
        ${assigned.length?`<div class="applicant-section">
          <div class="applicant-section-title">배정 확정 (${assigned.length}명)</div>
          <div class="applicant-list">
            ${assigned.map((a,i)=>`<div class="applicant-row">
              <span class="applicant-num">${i+1}</span>
              <span class="applicant-name">${escHtml(a.applicant_name)}</span>
              <span class="applicant-sid">···${escHtml(a.student_id.slice(-3))}</span>
              ${a.is_returning?'<span class="ret-badge">재수강</span>':''}
            </div>`).join('')}
          </div>
        </div>`:'<div style="font-size:12px;color:var(--text3)">배정된 학생이 없습니다.</div>'}
      </div>
    </div>`;
  });

  const pending=apps.filter(a=>a.status==='pending');
  if(isOpen&&pending.length){
    html+=`<div class="pending-card">
      <div class="pending-hdr">
        <div class="pending-title">마감 후 배정 예정 — ${pending.length}명</div>
        <div style="font-size:11px;color:var(--accent2);margin-top:2px">이전 회차 수강자입니다. 마감 후 남은 자리에 배정됩니다.</div>
      </div>
      <div style="padding:10px 16px"><div class="applicant-list">
        ${pending.map(a=>{const p1=classes.find(c=>c.id===a.pref1_school_id);const p2=classes.find(c=>c.id===a.pref2_school_id);return`<div class="applicant-row">
          <span class="applicant-name">${escHtml(a.applicant_name)}</span>
          <span class="applicant-sid">···${escHtml(a.student_id.slice(-3))}</span>
          <span style="font-size:10px;color:var(--text3)">${p1?'1지: '+escHtml(p1.name):''}${p2?' · 2지: '+escHtml(p2.name):''}</span>
        </div>`}).join('')}
      </div></div>
    </div>`;
  }

  const unassigned=apps.filter(a=>a.status==='unassigned');
  if(unassigned.length){
    html+=`<div class="unassigned-card">
      <div class="unassigned-hdr">
        <div class="unassigned-title">미배정 — ${unassigned.length}명</div>
      </div>
      <div style="padding:10px 16px"><div class="applicant-list">
        ${unassigned.map(a=>{const p1=classes.find(c=>c.id===a.pref1_school_id);const p2=classes.find(c=>c.id===a.pref2_school_id);return`<div class="applicant-row">
          <span class="applicant-name">${escHtml(a.applicant_name)}</span>
          <span class="applicant-sid">···${escHtml(a.student_id.slice(-3))}</span>
          <span style="font-size:10px;color:var(--text3)">${p1?'1지: '+escHtml(p1.name):''}${p2?' · 2지: '+escHtml(p2.name):''}</span>
        </div>`}).join('')}
      </div></div>
    </div>`;
  }
  return html||'<div class="empty-state">등록된 반이 없습니다.</div>';
}

function withdrawInputHtml(){
  return `<div style="display:flex;flex-direction:column;gap:10px">
    <div style="font-size:12px;color:var(--text2)">학번 전체를 입력하면 신청 내역을 확인하고 철회할 수 있습니다.</div>
    <div style="display:flex;gap:8px">
      <input class="fi" id="withdrawSid" placeholder="학번 전체 입력" inputmode="numeric" autocomplete="off" style="flex:1"/>
      <button class="btn btn-s" onclick="lookupWithdraw()">조회</button>
    </div>
  </div>`;
}

window.lookupWithdraw=function(){
  const _now=Date.now();
  if(_now-_lastLookupTs<1500){return;} // silent debounce
  _lastLookupTs=_now;
  const sid=(document.getElementById('withdrawSid')?.value||'').trim();
  if(!sid){window.toast('학번을 입력해주세요','err');return;}
  const found=apps.find(a=>a.student_id===sid);
  if(!found){window.toast('해당 학번으로 접수된 신청이 없습니다','err');return;}
  _withdrawLookup=found;
  const c1=classes.find(c=>c.id===found.pref1_school_id);
  const c2=classes.find(c=>c.id===found.pref2_school_id);
  const asgn=classes.find(c=>c.id===found.assigned_school_id);
  const statusText=found.status==='assigned'?`배정됨 (${asgn?.name||''})`:found.status==='pending'?'마감 후 배정 예정':'미배정';
  document.getElementById('withdrawContent').innerHTML=`
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="background:var(--surface2);border-radius:5px;padding:10px 12px;font-size:13px;display:flex;flex-direction:column;gap:5px">
        <div><span style="color:var(--text3);display:inline-block;min-width:44px">이름</span>${found.applicant_name}</div>
        <div><span style="color:var(--text3);display:inline-block;min-width:44px">1지망</span>${c1?.name||'—'}</div>
        ${c2?`<div><span style="color:var(--text3);display:inline-block;min-width:44px">2지망</span>${c2.name}</div>`:''}
        <div><span style="color:var(--text3);display:inline-block;min-width:44px">상태</span>${statusText}</div>
      </div>
      <div style="font-size:12px;color:var(--text2)">철회하려면 학번을 한 번 더 입력해주세요.</div>
      <input class="fi" id="withdrawConfirmSid" placeholder="학번 전체 입력" inputmode="numeric" autocomplete="off"/>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-s" onclick="cancelWithdraw()">취소</button>
        <button class="btn btn-d" id="withdrawConfirmBtn" onclick="confirmWithdraw()">신청 철회</button>
      </div>
    </div>`;
};

window.cancelWithdraw=function(){
  _withdrawLookup=null;
  const el=document.getElementById('withdrawContent');
  if(el) el.innerHTML=withdrawInputHtml();
};

window.confirmWithdraw=async function(){
  if(!_withdrawLookup) return;
  if(!round||round.status!=='open'){window.toast('신청 기간이 아닙니다','err');return;}
  const input=(document.getElementById('withdrawConfirmSid')?.value||'').trim();
  if(input!==_withdrawLookup.student_id){window.toast('학번이 일치하지 않습니다','err');return;}
  const btn=document.getElementById('withdrawConfirmBtn');
  if(btn){btn.disabled=true;btn.textContent='처리 중...';}
  try{
    const {error}=await supabase.from('school_applications').delete().eq('id',_withdrawLookup.id);
    if(error) throw error;
    apps=apps.filter(a=>a.id!==_withdrawLookup.id);
    _withdrawLookup=null;
    window.toast('신청이 철회됐습니다','ok');
    render();
  }catch(e){
    window.toast(e?.message||'오류가 발생했습니다','err');
    if(btn){btn.disabled=false;btn.textContent='신청 철회';}
  }
};

window.submitApply=async function(){
  if(!round||round.status!=='open'){window.toast('신청 기간이 아닙니다','err');return;}
  // Enforce close_at client-side even if DB status hasn't updated yet
  if(round.close_at&&new Date(round.close_at)<=serverNow()){window.toast('신청 기간이 마감됐습니다','err');return;}
  const _now=Date.now();
  if(_now-_lastSchoolSubmitTs<3000){window.toast('잠시 후 다시 시도해주세요','err');return;}
  const name=(document.getElementById('applyName')?.value||'').trim();
  const sid=(document.getElementById('applySid')?.value||'').trim();
  const pref1Raw=document.getElementById('applyPref1')?.value;
  const pref2Raw=document.getElementById('applyPref2')?.value;
  if(!name){window.toast('성명을 입력해주세요','err');return;}
  if(sid.length<4){window.toast('학번을 올바르게 입력해주세요','err');return;}
  if(!pref1Raw){window.toast('1지망을 선택해주세요','err');return;}
  const pref1=parseInt(pref1Raw);
  const pref2=pref2Raw?parseInt(pref2Raw):null;
  if(pref2&&pref2===pref1){window.toast('1지망과 2지망이 같습니다','err');return;}

  const existing=apps.find(a=>a.student_id===sid);
  if(existing){
    if(!confirm('이미 신청한 내역이 있습니다.\n기존 신청이 철회되고 새로 신청됩니다. 계속하시겠습니까?')) return;
  }

  _lastSchoolSubmitTs=Date.now();
  const btn=document.getElementById('applySubmitBtn');
  if(btn){btn.disabled=true;btn.textContent='처리 중...';}
  try{
    if(existing){
      const {error}=await supabase.from('school_applications').delete().eq('id',existing.id);
      if(error) throw error;
      apps=apps.filter(a=>a.id!==existing.id);
    }

    const returning=isReturning(sid);
    let assignedId=null, status;
    if(returning){
      status='pending';
    } else {
      assignedId=pickClass(pref1,pref2);
      status=assignedId?'assigned':'unassigned';
    }

    const {error}=await supabase.from('school_applications').insert({
      round_id:round.id,applicant_name:name,student_id:sid,
      pref1_school_id:pref1,pref2_school_id:pref2||null,
      assigned_school_id:assignedId,is_returning:returning,status
    });
    if(error) throw error;

    broadcastRefresh();
    if(returning){
      window.toast('신청 등록 완료. 이전 회차 수강자로, 마감 후 남은 자리에 배정될 예정입니다.','ok');
    } else if(assignedId){
      const c=classes.find(x=>x.id===assignedId);
      window.toast(`${c?.name||'반'}에 배정됐습니다!`,'ok');
    } else {
      window.toast('신청 등록 완료. 현재 모든 반이 만석입니다.','');
    }
  }catch(e){
    _lastSchoolSubmitTs=0; // reset on error so user can retry
    window.toast(e?.message||'오류가 발생했습니다','err');
    if(btn){btn.disabled=false;btn.textContent='신청하기';}
  }
};

window.toggleSchoolDesc=function(id){
  const body=document.getElementById('desc-'+id);
  const btn=body?.previousElementSibling;
  if(!body) return;
  if(body.style.display==='none'||!body.style.display){
    body.style.display='block';
    if(btn) btn.textContent='스쿨 설명 닫기';
  } else {
    body.style.display='none';
    if(btn) btn.textContent='스쿨 설명 보기';
  }
};
