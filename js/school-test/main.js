const STORAGE_KEY = 'kuagc_school_test_apps_v1';

const round = {
  id: 'school-test-round',
  name: '스쿨 모의 신청',
  status: 'open',
};

const classes = [
  {
    id: 1,
    name: '기타 기초',
    teacher_name: '모의 강사 A',
    capacity: 3,
    schedule_day: '월',
    schedule_hour: 18,
    description: '코드 운지, 기본 스트로크, 쉬운 곡 반주를 연습합니다.',
  },
  {
    id: 2,
    name: '보컬 입문',
    teacher_name: '모의 강사 B',
    capacity: 2,
    schedule_day: '화',
    schedule_hour: 19,
    description: '호흡, 발성, 음정 안정과 합주에서의 마이크 사용을 연습합니다.',
  },
  {
    id: 3,
    name: '드럼 리듬',
    teacher_name: '모의 강사 C',
    capacity: 2,
    schedule_day: '수',
    schedule_hour: 18,
    description: '기본 8비트, 필인, 합주에서 템포를 유지하는 감각을 연습합니다.',
  },
  {
    id: 4,
    name: '베이스 라인',
    teacher_name: '모의 강사 D',
    capacity: 2,
    schedule_day: '목',
    schedule_hour: 19,
    description: '루트 중심 라인, 리듬 고정, 드럼과 맞추는 방법을 연습합니다.',
  },
];

let apps = [];
let _outerContainer = null;

function escHtml(s){
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function toast(msg,type=''){
  if(window.toast) window.toast(msg,type);
  else alert(msg);
}

function loadApps(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    apps = Array.isArray(parsed) ? parsed : [];
  }catch(e){
    apps = [];
  }
  recomputeAssignments();
}

function saveApps(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(apps));
}

function countAssigned(classId){
  return apps.filter(a=>a.assigned_school_id===classId&&a.status==='assigned').length;
}

function pickClass(pref1,pref2){
  const c1 = classes.find(c=>c.id===pref1);
  if(c1&&countAssigned(pref1)<(c1.capacity||0)) return pref1;
  if(pref2){
    const c2 = classes.find(c=>c.id===pref2);
    if(c2&&countAssigned(pref2)<(c2.capacity||0)) return pref2;
  }
  return null;
}

function recomputeAssignments(){
  apps = apps
    .filter(a=>a&&a.round_id===round.id)
    .sort((a,b)=>new Date(a.created_at)-new Date(b.created_at))
    .map(a=>({...a,assigned_school_id:null,status:'unassigned'}));
  for(const app of apps){
    const assignedId = pickClass(app.pref1_school_id,app.pref2_school_id);
    app.assigned_school_id = assignedId;
    app.status = assignedId ? 'assigned' : 'unassigned';
  }
}

export async function init(outerContainer){
  _outerContainer = outerContainer;
  loadApps();
  installHandlers();

  const inner = document.createElement('div');
  inner.className = 'container';
  inner.id = 'schoolTestContainer';
  outerContainer.innerHTML = '';
  outerContainer.appendChild(inner);
  render();

  return function destroy(){
    _outerContainer = null;
    delete window.submitSchoolTestApply;
    delete window.resetSchoolTest;
    delete window.toggleSchoolTestDesc;
  };
}

function installHandlers(){
  window.submitSchoolTestApply = submitSchoolTestApply;
  window.resetSchoolTest = resetSchoolTest;
  window.toggleSchoolTestDesc = toggleSchoolTestDesc;
}

function render(){
  const el = document.getElementById('schoolTestContainer');
  if(!el) return;
  const formState = captureFormState();

  let html = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
    <h2 style="font-size:15px;font-weight:700">🏫 스쿨 모의 신청</h2>
  </div>
  <div class="round-status open">
    <div class="rs-icon">🧪</div>
    <div class="rs-texts">
      <div class="rs-title">${round.name} 진행 중</div>
      <div class="rs-sub">실제 신청에는 반영되지 않습니다.</div>
    </div>
  </div>`;

  html += `<div class="apply-form-card">
    <div class="apply-form-title">스쿨 신청</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="form-grid">
        <div><div class="fl">성명 *</div><input class="fi" id="testApplyName" placeholder="홍길동" autocomplete="off"/></div>
        <div><div class="fl">학번 *</div><input class="fi" id="testApplySid" placeholder="2021130905" inputmode="numeric" autocomplete="off"/></div>
      </div>
      <div><div class="fl">1지망 *</div><select class="fi" id="testApplyPref1">
        <option value="">선택하세요</option>
        ${classes.map(c=>`<option value="${c.id}">${escHtml(c.name)}${countAssigned(c.id)>=(c.capacity||0)?' - 만석':''}</option>`).join('')}
      </select></div>
      <div><div class="fl">2지망 (선택)</div><select class="fi" id="testApplyPref2">
        <option value="">없음</option>
        ${classes.map(c=>`<option value="${c.id}">${escHtml(c.name)}${countAssigned(c.id)>=(c.capacity||0)?' - 만석':''}</option>`).join('')}
      </select></div>
      <div class="form-foot" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-s" onclick="resetSchoolTest()">초기화</button>
        <button class="btn btn-p" id="testApplySubmitBtn" onclick="submitSchoolTestApply()">신청하기</button>
      </div>
    </div>
  </div>`;

  html += renderClassCards(true);
  el.innerHTML = html;
  restoreFormState(formState);
}

function captureFormState(){
  const active = document.activeElement;
  const ids = ['testApplyName','testApplySid','testApplyPref1','testApplyPref2'];
  const values = {};
  ids.forEach(id=>{const el=document.getElementById(id); if(el) values[id]=el.value;});
  return {
    values,
    activeId: ids.includes(active?.id) ? active.id : null,
    selectionStart: typeof active?.selectionStart==='number' ? active.selectionStart : null,
    selectionEnd: typeof active?.selectionEnd==='number' ? active.selectionEnd : null,
  };
}

function restoreFormState(state){
  if(!state) return;
  Object.entries(state.values||{}).forEach(([id,value])=>{
    const el = document.getElementById(id);
    if(el) el.value = value;
  });
  if(state.activeId){
    const el = document.getElementById(state.activeId);
    if(el){
      try{el.focus({preventScroll:true});}catch(e){el.focus();}
      if(typeof el.setSelectionRange==='function'&&state.selectionStart!=null){
        el.setSelectionRange(state.selectionStart,state.selectionEnd);
      }
    }
  }
}

function renderClassCards(isOpen){
  let html = '';
  classes.forEach(c=>{
    const assigned = apps
      .filter(a=>a.assigned_school_id===c.id&&a.status==='assigned')
      .sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
    const cap = c.capacity||0;
    const isFull = assigned.length>=cap;
    const fillPct = Math.min(100,Math.round((assigned.length/Math.max(1,cap))*100));
    const badgeCls = isOpen&&isFull ? 'full' : 'open';
    const badgeTxt = isOpen&&isFull ? '만석' : '모집중';

    html += `<div class="school-card">
      <div class="school-card-hdr">
        <div>
          <div class="school-name">${escHtml(c.name)}</div>
          <div class="school-teacher">담당: ${escHtml(c.teacher_name)}</div>
          <div class="school-schedule">${escHtml(c.schedule_day)}요일 ${Number(c.schedule_hour)}시</div>
        </div>
        <span class="school-badge ${badgeCls}">${badgeTxt}</span>
      </div>
      <div class="school-desc-bar">
        <button class="school-desc-toggle" onclick="toggleSchoolTestDesc(${c.id})">스쿨 설명 보기</button>
        <div class="school-desc-body" id="test-desc-${c.id}">${escHtml(c.description).replace(/\n/g,'<br>')}</div>
      </div>
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
              <span class="applicant-sid">***${escHtml(a.student_id.slice(-3))}</span>
            </div>`).join('')}
          </div>
        </div>`:'<div style="font-size:12px;color:var(--text3)">배정된 학생이 없습니다.</div>'}
      </div>
    </div>`;
  });

  const unassigned = apps.filter(a=>a.status==='unassigned');
  if(unassigned.length){
    html += `<div class="unassigned-card">
      <div class="unassigned-hdr">
        <div class="unassigned-title">미배정 ${unassigned.length}명</div>
      </div>
      <div style="padding:10px 16px"><div class="applicant-list">
        ${unassigned.map(a=>{
          const p1=classes.find(c=>c.id===a.pref1_school_id);
          const p2=classes.find(c=>c.id===a.pref2_school_id);
          return `<div class="applicant-row">
            <span class="applicant-name">${escHtml(a.applicant_name)}</span>
            <span class="applicant-sid">***${escHtml(a.student_id.slice(-3))}</span>
            <span style="font-size:10px;color:var(--text3)">${p1?'1지망: '+escHtml(p1.name):''}${p2?' · 2지망: '+escHtml(p2.name):''}</span>
          </div>`;
        }).join('')}
      </div></div>
    </div>`;
  }

  return html;
}

function submitSchoolTestApply(){
  const name = (document.getElementById('testApplyName')?.value||'').trim();
  const sid = (document.getElementById('testApplySid')?.value||'').trim();
  const pref1Raw = document.getElementById('testApplyPref1')?.value;
  const pref2Raw = document.getElementById('testApplyPref2')?.value;
  if(!name){toast('성명을 입력해주세요','err');return;}
  if(sid.length<4){toast('학번을 올바르게 입력해주세요','err');return;}
  if(!pref1Raw){toast('1지망을 선택해주세요','err');return;}
  const pref1 = parseInt(pref1Raw,10);
  const pref2 = pref2Raw ? parseInt(pref2Raw,10) : null;
  if(pref2&&pref2===pref1){toast('1지망과 2지망이 같습니다','err');return;}

  const existing = apps.find(a=>a.student_id===sid);
  if(existing&&!confirm('이미 모의 신청 내역이 있습니다.\n기존 내역을 지우고 새로 신청할까요?')) return;

  apps = apps.filter(a=>a.student_id!==sid);
  apps.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    round_id: round.id,
    applicant_name: name,
    student_id: sid,
    pref1_school_id: pref1,
    pref2_school_id: pref2,
    assigned_school_id: null,
    status: 'unassigned',
    created_at: new Date().toISOString(),
  });
  recomputeAssignments();
  saveApps();
  ['testApplyName','testApplySid','testApplyPref1','testApplyPref2'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.value='';
  });
  render();
  const app = apps.find(a=>a.student_id===sid);
  const assigned = classes.find(c=>c.id===app?.assigned_school_id);
  toast(assigned?`${assigned.name}에 배정됐습니다`:'모의 신청이 등록됐습니다','ok');
}

function resetSchoolTest(){
  if(!confirm('모의 신청 기록을 초기화할까요?')) return;
  apps = [];
  saveApps();
  render();
  toast('모의 신청 기록을 초기화했습니다','ok');
}

function toggleSchoolTestDesc(id){
  const body = document.getElementById('test-desc-'+id);
  const btn = body?.previousElementSibling;
  if(!body) return;
  if(body.style.display==='none'||!body.style.display){
    body.style.display='block';
    if(btn) btn.textContent='스쿨 설명 닫기';
  }else{
    body.style.display='none';
    if(btn) btn.textContent='스쿨 설명 보기';
  }
}
