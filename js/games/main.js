import { supabase } from '../supabase.js';
import { initTheme, toggleTheme } from '../utils/theme.js';
import { getConfig, fetchContacts } from '../schedule.js';
import { weekLabel } from '../utils/common.js';

const screens=[...document.querySelectorAll('.screen')];
const scoreValue=document.getElementById('scoreValue');
const gameStage=document.getElementById('gameStage');
const introCopy=document.getElementById('introCopy');
const countdownEl=document.getElementById('countdown');
const listenCopy=document.getElementById('listenCopy');
const choicesEl=document.getElementById('choices');
const formMessage=document.getElementById('formMessage');
const wordGrid=document.getElementById('wordGrid');
const wordTime=document.getElementById('wordTime');
const wordProgress=document.getElementById('wordProgress');
const wordCheer=document.getElementById('wordCheer');
const noteNames=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const notes=Array.from({length:25},(_,i)=>midiToNote(40+i));
const randomSyllables=['가','나','다','라','마','바','사','아','자','차','카','타','파','하','고','노','도','로','모','보','소','오','조','초','코','토','포','호','구','누','두','무','부','수','우','주','추','쿠','투','푸','후','기','니','디','리','미','비','시','이','지','치','키','티','피','히','개','내','대','래','매','배','새','애','재','채','캐','태','패','해','거','너','더','러','머','버','서','어','저','처','커','터','퍼','허'];

let audioContext;
let score=0;
let answer=null;
let state='list';
let countdownTimer=null;
let duelChannel=null;
let duelClock=null;
let duelCode='';
let duelRole='';
let duelPhase='';
let lastDuelAction=0;
let currentGame='pitch';
let wordAnswerIndexes=[];
let wordSelected=new Set();
let wordStartedAt=0;
let wordTimer=null;
let wordResultMs=0;
const playerToken=localStorage.getItem('guitarDuelToken')||crypto.randomUUID();
localStorage.setItem('guitarDuelToken',playerToken);

function midiToNote(midi){
  return {midi,label:`${noteNames[midi%12]}${Math.floor(midi/12)-1}`,frequency:440*Math.pow(2,(midi-69)/12)};
}

function showScreen(id){
  screens.forEach(screen=>screen.classList.toggle('active',screen.id===id));
}

async function resetGame(){
  currentGame='pitch';
  await leaveDuel(true);
  clearInterval(countdownTimer);
  score=0;answer=null;state='ready';
  scoreValue.textContent='0';
  introCopy.style.display='flex';
  countdownEl.textContent='';
  listenCopy.style.display='none';
  choicesEl.innerHTML='';
  showScreen('gameScreen');
}

function ensureAudio(){
  if(!audioContext) audioContext=new (window.AudioContext||window.webkitAudioContext)();
  if(audioContext.state==='suspended') audioContext.resume().catch(()=>{});
}

function startRound(){
  if(state==='countdown'||state==='playing') return;
  state='countdown';ensureAudio();
  introCopy.style.display='none';listenCopy.style.display='none';choicesEl.innerHTML='';
  let count=3;countdownEl.textContent=count;clearInterval(countdownTimer);
  countdownTimer=setInterval(()=>{
    count-=1;
    if(count>0){countdownEl.textContent=count;return;}
    clearInterval(countdownTimer);countdownEl.textContent='';presentQuestion();
  },700);
}

function presentQuestion(){
  answer=notes[Math.floor(Math.random()*notes.length)];
  const options=[answer];
  while(options.length<3){
    const candidate=notes[Math.floor(Math.random()*notes.length)];
    if(!options.some(note=>note.midi===candidate.midi)) options.push(candidate);
  }
  options.sort(()=>Math.random()-.5);
  choicesEl.innerHTML=options.map(note=>`<button class="choice-btn" data-midi="${note.midi}">${note.label}</button>`).join('');
  listenCopy.style.display='block';state='playing';playNote(answer.frequency);
}

function playNote(frequency){
  const now=audioContext.currentTime;
  const oscillator=audioContext.createOscillator(),gain=audioContext.createGain();
  oscillator.type='sine';oscillator.frequency.setValueAtTime(frequency,now);
  gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.42,now+.03);
  gain.gain.setValueAtTime(.42,now+.75);gain.gain.exponentialRampToValueAtTime(.0001,now+1.2);
  oscillator.connect(gain).connect(audioContext.destination);oscillator.start(now);oscillator.stop(now+1.22);
}

function chooseAnswer(midi){
  if(state!=='playing') return;
  if(midi===answer.midi){score+=1;scoreValue.textContent=score;state='between';startRound();return;}
  state='ended';choicesEl.innerHTML='';
  document.getElementById('resultTitle').innerHTML=`<strong id="finalScore">${score}</strong>개를 맞혔습니다.`;
  document.getElementById('correctAnswerText').textContent=`정답은 ${answer.label}였습니다.`;
  prepareResultForm();
}

function prepareResultForm(){
  document.getElementById('nickname').value='';formMessage.textContent='';
  document.getElementById('submitScore').disabled=false;showScreen('resultScreen');
  document.getElementById('nickname').focus();
}

async function submitScore(event){
  event.preventDefault();
  const nickname=document.getElementById('nickname').value.trim();
  if(!nickname){formMessage.textContent='닉네임을 입력하세요.';return;}
  const button=document.getElementById('submitScore');button.disabled=true;formMessage.textContent='제출 중...';
  const table=currentGame==='word'?'word_find_scores':'absolute_pitch_scores';
  const payload=currentGame==='word'?{nickname,time_ms:wordResultMs}:{nickname,score};
  const {error}=await supabase.from(table).insert(payload);
  if(error){formMessage.textContent='점수를 저장하지 못했습니다. SQL 설정을 확인하세요.';button.disabled=false;return;}
  await showLeaderboard();
}

async function showLeaderboard(){
  showScreen('leaderboardScreen');
  const isWord=currentGame==='word';
  document.getElementById('leaderboardEyebrow').textContent=isWord?'FIND GEURUTEOGI':'ABSOLUTE PITCH';
  document.getElementById('leaderboardDescription').textContent=isWord?'찾는 데 걸린 시간이 짧은 순서대로 표시됩니다.':'점수가 높은 순서대로 표시됩니다.';
  const board=document.getElementById('leaderboard');
  board.innerHTML='<div class="leaderboard-empty">기록을 불러오는 중...</div>';
  let query=supabase.from(isWord?'word_find_scores':'absolute_pitch_scores')
    .select(isWord?'nickname,time_ms,created_at':'nickname,score,created_at');
  query=isWord?query.order('time_ms',{ascending:true}):query.order('score',{ascending:false});
  const {data,error}=await query.order('created_at',{ascending:true}).limit(100);
  if(error){board.innerHTML='<div class="leaderboard-empty">리더보드를 불러오지 못했습니다.</div>';return;}
  board.innerHTML=data.length?data.map((row,index)=>`<div class="leaderboard-row"><span class="leaderboard-rank">${index+1}</span><span class="leaderboard-name">${escapeHtml(row.nickname)}</span><span class="leaderboard-score">${isWord?formatWordTime(row.time_ms):row.score}</span></div>`).join(''):'<div class="leaderboard-empty">아직 등록된 기록이 없습니다.</div>';
}

function openWordGame(){
  clearInterval(countdownTimer);clearInterval(wordTimer);leaveDuel(true);
  currentGame='word';wordSelected=new Set();wordAnswerIndexes=createWordBoard();
  wordProgress.textContent='0 / 4';wordTime.textContent='0.00';wordCheer.style.display='none';
  showScreen('wordScreen');wordStartedAt=performance.now();
  wordTimer=setInterval(()=>{wordTime.textContent=formatWordTime(performance.now()-wordStartedAt);},10);
}

function createWordBoard(){
  const directions=[[0,1],[1,0],[1,1],[1,-1]];
  const [dr,dc]=directions[Math.floor(Math.random()*directions.length)];
  const starts=[];
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){
    const er=r+dr*3,ec=c+dc*3;
    if(er>=0&&er<8&&ec>=0&&ec<8) starts.push([r,c]);
  }
  const [sr,sc]=starts[Math.floor(Math.random()*starts.length)];
  const answer=[0,1,2,3].map(i=>(sr+dr*i)*8+sc+dc*i);
  const letters=Array.from({length:64},()=>randomSyllables[Math.floor(Math.random()*randomSyllables.length)]);
  ['그','루','터','기'].forEach((letter,index)=>{letters[answer[index]]=letter;});
  wordGrid.innerHTML=letters.map((letter,index)=>`<button class="word-cell" data-index="${index}">${letter}</button>`).join('');
  return answer;
}

function selectWordCell(button){
  const index=Number(button.dataset.index);
  if(wordSelected.has(index)) return;
  if(!wordAnswerIndexes.includes(index)){
    button.classList.remove('wrong');void button.offsetWidth;button.classList.add('wrong');return;
  }
  wordSelected.add(index);button.classList.add('selected');wordProgress.textContent=`${wordSelected.size} / 4`;
  if(wordSelected.size===4) finishWordGame();
}

function finishWordGame(){
  wordResultMs=Math.max(1,Math.round(performance.now()-wordStartedAt));clearInterval(wordTimer);
  wordTime.textContent=formatWordTime(wordResultMs);wordCheer.style.display='flex';
  setTimeout(()=>{
    document.getElementById('resultTitle').innerHTML=`<strong id="finalScore">${formatWordTime(wordResultMs)}</strong>초`;
    document.getElementById('correctAnswerText').textContent='그루터기를 모두 찾았습니다.';
    prepareResultForm();
  },1300);
}

function formatWordTime(ms){return (Number(ms)/1000).toFixed(2);}

async function openDuelGame(){
  clearInterval(countdownTimer);await leaveDuel(true);showScreen('duelScreen');
  document.getElementById('duelLobby').style.display='flex';
  document.getElementById('duelArena').style.display='none';
  document.getElementById('duelMessage').textContent='';
}

async function joinDuel(event){
  event.preventDefault();
  const message=document.getElementById('duelMessage');
  duelCode=document.getElementById('duelCode').value.trim().toUpperCase();
  message.textContent='방에 연결하는 중...';
  const {data,error}=await supabase.rpc('join_guitar_duel',{p_code:duelCode,p_token:playerToken});
  if(error){message.textContent='입장하지 못했습니다. 업데이트된 SQL을 실행했는지 확인하세요.';return;}
  if(data.status==='full'){message.textContent='이미 두 명이 참가 중인 방입니다.';return;}
  duelRole=data.role||'';
  document.getElementById('duelLobby').style.display='none';
  document.getElementById('duelArena').style.display='block';
  document.getElementById('duelRoomCode').textContent=duelCode;
  subscribeDuel();
  renderDuel(data.room);
}

function subscribeDuel(){
  if(duelChannel) supabase.removeChannel(duelChannel);
  duelChannel=supabase.channel(`guitar-duel-${duelCode}-${playerToken}`)
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'guitar_duel_rooms',filter:`code=eq.${duelCode}`},()=>requestDuelRefresh())
    .subscribe();
}

function renderDuel(room){
  if(!room) return;
  duelPhase=room.status;
  const tension=Math.max(0,Math.min(100,room.tension));
  document.getElementById('tensionFill').style.width=`${tension}%`;
  const keyPhase=(tension-29)*Math.PI/12;
  document.getElementById('tuningKey').style.setProperty('--key-width',(1+Math.abs(Math.sin(keyPhase))*2.4).toFixed(2));
  document.getElementById('guitarString').classList.toggle('broken',room.winner==='attack');
  clearInterval(duelClock);
  const overlay=document.getElementById('roleOverlay');
  const spinner=document.getElementById('roleSpinner');
  const title=document.getElementById('roleTitle');
  const instruction=document.getElementById('roleInstruction');
  const controls=document.getElementById('duelControls');
  const result=document.getElementById('duelResult');
  result.style.display='none';controls.style.display='none';

  if(room.status==='waiting'){
    overlay.style.display='flex';spinner.style.display='block';spinner.textContent='상대 기다리는 중...';
    title.textContent='방 코드 '+duelCode;instruction.textContent='친구가 같은 코드를 입력하면 시작합니다.';return;
  }
  if(room.status==='assigning'){
    overlay.style.display='flex';spinner.style.display='block';spinner.textContent='공격? 수비?';
    title.textContent='역할을 무작위로 배정합니다';instruction.textContent='';
    duelClock=setInterval(()=>updateDuelClock(room),50);return;
  }
  if(room.status==='briefing'){
    overlay.style.display='flex';spinner.style.display='none';
    title.textContent=duelRole==='attack'?'공격':duelRole==='defend'?'수비':'역할 확인 중...';
    instruction.textContent=duelRole==='attack'?'줄을 감아 끊어버리세요!':duelRole==='defend'?'줄을 풀어 끊기지 않게 하세요!':'잠시만 기다려 주세요.';
    duelClock=setInterval(()=>updateDuelClock(room),50);return;
  }
  if(room.status==='playing'){
    if(!duelRole){requestDuelRefresh();return;}
    overlay.style.display='none';controls.style.display='grid';
    controls.querySelector('[data-action="attack"]').disabled=duelRole!=='attack';
    controls.querySelector('[data-action="defend"]').disabled=duelRole!=='defend';
    duelClock=setInterval(()=>updateDuelClock(room),50);return;
  }
  if(room.status==='finished'){
    overlay.style.display='none';showDuelResult(room.winner);return;
  }
}

function updateDuelClock(room){
  const now=Date.now(),starts=new Date(room.starts_at).getTime(),ends=new Date(room.ends_at).getTime();
  const remaining=Math.max(0,ends-now);
  document.getElementById('duelTime').textContent=(remaining/1000).toFixed(1);
  if(room.status==='assigning'&&now>=starts-2500) requestDuelRefresh();
  if(room.status==='briefing'&&now>=starts) requestDuelRefresh();
  if(room.status==='playing'&&now>=ends) finalizeDuel();
}

async function requestDuelRefresh(){
  clearInterval(duelClock);
  const {data}=await supabase.rpc('get_guitar_duel',{p_code:duelCode,p_token:playerToken});
  if(data){duelRole=data.role||duelRole;renderDuel(data.room);}
}

async function duelAction(action){
  if(duelPhase!=='playing'||action!==duelRole) return;
  const now=performance.now();if(now-lastDuelAction<90) return;lastDuelAction=now;
  const {data}=await supabase.rpc('act_guitar_duel',{p_code:duelCode,p_token:playerToken,p_action:action});
  if(data?.room) renderDuel(data.room);
}

async function finalizeDuel(){
  clearInterval(duelClock);
  const {data}=await supabase.rpc('finish_guitar_duel',{p_code:duelCode,p_token:playerToken});
  if(data?.room) renderDuel(data.room);
}

function showDuelResult(winner){
  const won=winner===duelRole;
  const result=document.getElementById('duelResult');result.style.display='flex';
  document.getElementById('duelResultTitle').textContent=won?'승리!':'패배';
  document.getElementById('duelResultText').textContent=winner==='attack'?'기타 줄이 끊어졌습니다.':'기타 줄을 지켜냈습니다.';
}

async function leaveDuel(cleanup=false){
  const code=duelCode;
  clearInterval(duelClock);
  if(duelChannel){supabase.removeChannel(duelChannel);duelChannel=null;}
  if(cleanup&&code) await supabase.rpc('cleanup_guitar_duel',{p_code:code,p_token:playerToken}).catch(()=>{});
  duelCode='';duelRole='';duelPhase='';
}

function escapeHtml(value){const div=document.createElement('div');div.textContent=value;return div.innerHTML;}
async function initHeader(){document.getElementById('weekLbl').textContent=weekLabel(0);document.getElementById('seasonChip').textContent=await getConfig('current_season').catch(()=>'—');}
async function openContacts(){
  const modal=document.getElementById('modalBd'),body=document.getElementById('modalBody');modal.style.display='flex';
  body.innerHTML='<div style="color:var(--text2)">연락처를 불러오는 중...</div>';
  const contacts=await fetchContacts().catch(()=>[]);
  body.innerHTML=contacts.length?contacts.map(contact=>`<div class="irow"><span class="ik">${escapeHtml(contact.role)}</span><span style="display:flex;flex-direction:column;align-items:flex-end;gap:2px"><strong>${escapeHtml(contact.name)}</strong>${contact.phone?`<span style="font-size:11px;color:var(--text2)">${escapeHtml(contact.phone)}</span>`:''}</span></div>`).join(''):'<div style="color:var(--text2)">등록된 연락처가 없습니다.</div>';
}
function closeContacts(){document.getElementById('modalBd').style.display='none';}

document.getElementById('themeBtn').addEventListener('click',toggleTheme);
document.getElementById('contactsBtn').addEventListener('click',openContacts);
document.getElementById('closeModal').addEventListener('click',closeContacts);
document.getElementById('closeModalFoot').addEventListener('click',closeContacts);
document.getElementById('modalBd').addEventListener('click',event=>{if(event.target.id==='modalBd') closeContacts();});
document.getElementById('previousWeek').addEventListener('click',()=>{location.href='index.html';});
document.getElementById('nextWeek').addEventListener('click',()=>{location.href='index.html';});
document.getElementById('openPitchGame').addEventListener('click',resetGame);
document.getElementById('openDuelGame').addEventListener('click',openDuelGame);
document.getElementById('openWordGame').addEventListener('click',openWordGame);
gameStage.addEventListener('click',()=>{if(state==='ready') startRound();});
choicesEl.addEventListener('click',event=>{const button=event.target.closest('.choice-btn');if(button) chooseAnswer(Number(button.dataset.midi));});
document.getElementById('scoreForm').addEventListener('submit',submitScore);
document.getElementById('backToList').addEventListener('click',()=>{clearInterval(wordTimer);state='list';showScreen('listScreen');});
document.getElementById('duelJoinForm').addEventListener('submit',joinDuel);
document.querySelectorAll('.duel-action').forEach(button=>button.addEventListener('pointerdown',()=>duelAction(button.dataset.action)));
document.getElementById('duelBackToList').addEventListener('click',async()=>{await leaveDuel(true);showScreen('listScreen');});
wordGrid.addEventListener('click',event=>{const button=event.target.closest('.word-cell');if(button) selectWordCell(button);});
window.addEventListener('beforeunload',leaveDuel);

initTheme();initHeader();
