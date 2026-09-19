// SPA router -- hash-based navigation with dynamic CSS loading and view lifecycle

const VIEW_CSS = {
  timeassign: 'css/timeassign.css',
  school:     'css/school.css',
  'school-test': 'css/school.css',
  ensemble:   'css/ensemble.css',
};

let _currentView = null;
let _currentDestroy = null;
let _currentCssLink = null;
let _navToken = 0;

function setHeaderVisibility(view) {
  const weekNav    = document.getElementById('weekNavEl');
  const seasonChip = document.getElementById('seasonChip');
  const contacts   = document.querySelector('.hdr-contacts-btn');
  const games      = document.querySelector('.hdr-games-btn');
  const typeToggle = document.getElementById('typeToggle');
  const isSchedule = view === 'schedule' || view === 'teams';

  if (weekNav)    weekNav.style.display    = isSchedule ? '' : 'none';
  if (seasonChip) seasonChip.style.display = isSchedule ? '' : 'none';
  if (contacts)   contacts.style.display   = isSchedule ? '' : 'none';
  if (games)      games.style.display      = view === 'schedule' ? '' : 'none';
  if (typeToggle) typeToggle.style.display  = view === 'ensemble' ? '' : 'none';
}

function updateActiveStates(view) {
  const tabMap = {
    schedule:   'tb-schedule',
    teams:      'tb-teams',
    timeassign: 'tb-apply',
    school:     'tb-school',
    'school-test': 'tb-school',
    ensemble:   'tb-ensemble',
  };
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(tabMap[view])?.classList.add('active');

  document.querySelectorAll('.hdr-apply-btn,.hdr-school-btn,.hdr-ensemble-btn')
    .forEach(el => el.classList.remove('active'));
  const hdrMap = { timeassign: '.hdr-apply-btn', school: '.hdr-school-btn', 'school-test': '.hdr-school-btn', ensemble: '.hdr-ensemble-btn' };
  if (hdrMap[view]) document.querySelector(hdrMap[view])?.classList.add('active');

  document.getElementById('nb-schedule')?.classList.toggle('active', view === 'schedule' || view === 'teams');
}

async function initViewAddon(view, dynamicEl) {
  if (view !== 'ensemble') return null;

  try {
    const addon = await import('./ensemble/session-manager.js');
    return await addon.init(dynamicEl) || null;
  } catch (error) {
    console.warn('Ensemble session manager load error:', error);
    return null;
  }
}

export async function navigate(view) {
  if (view === _currentView) return;

  const token = ++_navToken;

  if (_currentDestroy) {
    try { _currentDestroy(); } catch(e) {}
    _currentDestroy = null;
  }
  if (_currentCssLink) {
    _currentCssLink.remove();
    _currentCssLink = null;
  }

  const pgSchedule      = document.getElementById('pgSchedule');
  const mobileTeamPanel = document.getElementById('mobileTeamPanel');
  const dynamicEl       = document.getElementById('view-dynamic');

  if (view === 'schedule' || view === 'teams') {
    pgSchedule.classList.add('active');
    dynamicEl.style.display = 'none';
    window._showSchedulePage?.(view);
  } else {
    pgSchedule.classList.remove('active');
    if (mobileTeamPanel) mobileTeamPanel.classList.remove('active');
    dynamicEl.style.display = 'block';
    dynamicEl.innerHTML = '';

    if (VIEW_CSS[view]) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = VIEW_CSS[view];
      document.head.appendChild(link);
      _currentCssLink = link;
    }

    try {
      const mod = await import(`./${view}/main.js`);
      if (token !== _navToken) return;
      const destroy = await mod.init(dynamicEl) || null;
      if (token !== _navToken) { try { destroy?.(); } catch(e) {} return; }
      const addonDestroy = await initViewAddon(view, dynamicEl);
      if (token !== _navToken) {
        try { addonDestroy?.(); } catch(e) {}
        try { destroy?.(); } catch(e) {}
        return;
      }
      _currentDestroy = () => {
        try { addonDestroy?.(); } catch(e) {}
        try { destroy?.(); } catch(e) {}
      };
    } catch(e) {
      if (token !== _navToken) return;
      console.error('View load error:', e);
      dynamicEl.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger)">불러오기 실패: ${e.message}</div>`;
    }
  }

  if (token !== _navToken) return;
  _currentView = view;
  setHeaderVisibility(view);
  updateActiveStates(view);

  const hash = (view === 'schedule') ? '' : view;
  if (location.hash.slice(1) !== hash) {
    history.pushState(null, '', hash ? '#' + hash : location.pathname + location.search);
  }
}

function getHashView() {
  const h = location.hash.slice(1);
  return ['timeassign', 'school', 'school-test', 'ensemble', 'teams'].includes(h) ? h : 'schedule';
}

export function initRouter() {
  navigate(getHashView());
  window.addEventListener('popstate', () => navigate(getHashView()));
}

window.navigate = navigate;
