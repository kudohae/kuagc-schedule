export const DAYS  = ['월','화','수','목','금','토','일'];
export const HOURS = Array.from({length:18},(_,i)=>i+8);
export const GRAY  = '#888888';

export const korSort = (a,k) => [...a].sort((x,y)=>x[k].localeCompare(y[k],'ko-KR',{numeric:true}));

export const getWeekDates = off => {
  const now=new Date(),mon=new Date(now);
  mon.setDate(now.getDate()-((now.getDay()+6)%7)+off*7);
  return Array.from({length:7},(_,i)=>{const d=new Date(mon);d.setDate(mon.getDate()+i);return `${d.getMonth()+1}/${d.getDate()}`;});
};

export const teamClr = t => t.type==='합주'?GRAY:(t.color||GRAY);
export const timeStr = h => h<24?h+':00':'0'+(h-24)+':00';

export const errMsg = e => {
  const m=e?.message||'';
  if(m.includes('unique')||m.includes('duplicate')) return '이미 동일한 데이터가 존재합니다';
  if(m.includes('foreign key')) return '참조 데이터가 존재하지 않습니다';
  if(m.includes('network')||m.includes('fetch')) return '네트워크 오류가 발생했습니다. 다시 시도해주세요';
  if(m.includes('JWT')||m.includes('auth')) return '인증 오류가 발생했습니다. 새로고침 후 시도해주세요';
  return m||'오류가 발생했습니다';
};

export function weekLabel(off){
  const now=new Date(),m=new Date(now);
  m.setDate(now.getDate()-((now.getDay()+6)%7)+off*7);
  const mo=m.getMonth()+1;
  const wn=Math.ceil((m.getDate()+(new Date(m.getFullYear(),m.getMonth(),1).getDay()+6)%7)/7);
  return `${mo}월 ${wn}주차`;
}
