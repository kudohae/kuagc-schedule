export function diffToHMS(ms){
  if(ms<=0) return '00:00:00';
  const s=Math.floor(ms/1000);
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;
  return [h,m,sc].map(v=>String(v).padStart(2,'0')).join(':');
}

export function fmtDate(ts){
  if(!ts) return '';
  const d=new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
