export function initTheme(){
  const s=localStorage.getItem('theme');
  if(s==='dark') document.body.classList.add('dark');
  const btn=document.getElementById('themeBtn');
  if(btn) btn.textContent=document.body.classList.contains('dark')?'☀️':'🌙';
}

export function toggleTheme(){
  document.body.classList.toggle('dark');
  localStorage.setItem('theme',document.body.classList.contains('dark')?'dark':'light');
  document.getElementById('themeBtn').textContent=document.body.classList.contains('dark')?'☀️':'🌙';
}
