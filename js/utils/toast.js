let toastTimer;
export function toast(msg,type=''){
  const el=document.getElementById('toastEl');
  el.textContent=msg; el.className='toast'+(type?' '+type:'');
  void el.offsetWidth; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),4000);
}
