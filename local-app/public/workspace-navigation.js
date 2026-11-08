(function () {
  const narrow = matchMedia('(max-width: 900px)');
  const minWidth = 180;
  const maxWidth = 360;
  const mainMinimum = 640;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  let active;

  function read(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* Storage is optional. */ }
  }

  function mount(shell, userId) {
    active?.finish(false);
    const sidebar = shell.querySelector('.local-side');
    const header = shell.querySelector('.local-header');
    const key = 'quality-navigation:' + userId;
    const storedWidth = Number(read(key + ':width'));
    let preferred = storedWidth ? clamp(storedWidth, minWidth, maxWidth) : 240;
    const storedCollapsed = read(key + ':collapsed');
    let collapsed = storedCollapsed === null ? narrow.matches : storedCollapsed === 'true';
    let pointer = null;
    let current;
    let animationTimer;

    const rail = document.createElement('div');
    rail.className = 'workspace-nav-rail';
    sidebar.before(rail);
    rail.append(sidebar);
    sidebar.id = 'workspace-navigation';
    sidebar.querySelector('.brand').insertAdjacentHTML('beforeend',
      '<button type="button" class="work-btn compact workspace-nav-close" aria-controls="workspace-navigation">收起导航</button>');
    const close = sidebar.querySelector('.workspace-nav-close');
    const handle = document.createElement('div');
    handle.className = 'workspace-nav-resize';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', '调整导航宽度');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-controls', sidebar.id);
    rail.append(handle);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'workspace-nav-open';
    open.textContent = '☰';
    open.setAttribute('aria-label', '展开导航');
    open.setAttribute('aria-controls', sidebar.id);
    header.firstElementChild.before(open);
    header.firstElementChild.nextElementSibling.classList.add('workspace-breadcrumb');

    const limit = () => clamp(shell.clientWidth - mainMinimum, minWidth, maxWidth);
    function layout(width = preferred) {
      current = clamp(width, minWidth, limit());
      shell.style.setProperty('--workspace-nav-width', current + 'px');
      shell.classList.toggle('workspace-nav-collapsed', collapsed);
      rail.inert = collapsed;
      sidebar.setAttribute('aria-hidden', String(collapsed));
      open.hidden = !collapsed;
      open.setAttribute('aria-expanded', String(!collapsed));
      close.setAttribute('aria-expanded', String(!collapsed));
      handle.setAttribute('aria-valuemin', minWidth);
      handle.setAttribute('aria-valuemax', limit());
      handle.setAttribute('aria-valuenow', current);
    }

    function toggle(value) {
      clearTimeout(animationTimer);
      shell.classList.add('workspace-nav-animate');
      animationTimer = setTimeout(() => shell.classList.remove('workspace-nav-animate'), 250);
      collapsed = value;
      save(key + ':collapsed', value);
      layout();
      (value ? open : close).focus({preventScroll: true});
    }
    close.addEventListener('click', () => toggle(true));
    open.addEventListener('click', () => toggle(false));

    function finish(commit) {
      if (!pointer) return;
      const id = pointer.id;
      pointer = null;
      if (commit && current !== clamp(preferred, minWidth, limit())) {
        preferred = current;
        save(key + ':width', preferred);
      }
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
      shell.classList.remove('workspace-nav-dragging');
      document.documentElement.classList.remove('workspace-nav-drag-active');
      layout();
    }
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || narrow.matches || collapsed || pointer) return;
      event.preventDefault();
      handle.focus({preventScroll: true});
      handle.setPointerCapture(event.pointerId);
      pointer = {id: event.pointerId, x: event.clientX, width: current};
      shell.classList.add('workspace-nav-dragging');
      document.documentElement.classList.add('workspace-nav-drag-active');
    });
    handle.addEventListener('pointermove', event => {
      if (pointer?.id === event.pointerId) layout(pointer.width + event.clientX - pointer.x);
    });
    handle.addEventListener('pointerup', event => {
      if (pointer?.id === event.pointerId) finish(true);
    });
    for (const event of ['pointercancel', 'lostpointercapture']) {
      handle.addEventListener(event, () => finish(false));
    }
    handle.addEventListener('keydown', event => {
      const widths = {ArrowLeft: current - 10, ArrowRight: current + 10, Home: minWidth, End: limit()};
      if (!Object.hasOwn(widths, event.key)) return;
      event.preventDefault();
      const next = clamp(widths[event.key], minWidth, limit());
      if (next === current) return;
      preferred = next;
      save(key + ':width', preferred);
      layout();
    });
    active = {finish, resize() {
      if (!shell.isConnected) { active = null; return; }
      finish(false);
      layout();
    }};
    layout();
  }

  window.addEventListener('resize', () => active?.resize());
  window.addEventListener('blur', () => active?.finish(false));
  window.WorkspaceNavigation = {mount, unmount() { active?.finish(false); active = null; }};
})();
