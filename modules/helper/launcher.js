// Registration is public UI only. Each entry retains its fixed installation origin.
export function mountBilibiliLauncher(origin) {
  const chinese = /^zh(?:-|$)/i.test(navigator.language);
  const text = chinese
    ? {
        action: '在 OVS 中观看',
        sites: '选择 OVS 站点',
        invalid: '请先打开有效的 B 站视频页。',
      }
    : {
        action: 'Watch in OVS',
        sites: 'Choose an OVS site',
        invalid: 'Open a supported Bilibili video first.',
      };
  function destination() {
    const url = new URL(location.href);
    if (url.origin !== 'https://www.bilibili.com') return;
    const params = new URLSearchParams({ v: '1' });
    const video = /^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})\/?$/.exec(
      url.pathname,
    );
    const bangumi = /^\/bangumi\/play\/(ep|ss)([1-9][0-9]{0,14})\/?$/.exec(
      url.pathname,
    );
    if (video) {
      const pages = url.searchParams.getAll('p');
      const page = pages[0] ?? '1';
      if (
        pages.length > 1 ||
        !/^[1-9][0-9]{0,4}$/.test(page) ||
        Number(page) > 10000
      )
        return;
      params.set('bvid', video[1]);
      params.set('part', page);
    } else if (bangumi) {
      params.set(bangumi[1] === 'ep' ? 'episodeId' : 'seasonId', bangumi[2]);
      params.set('part', '1');
    } else return;
    return `${origin}/import#${params}`;
  }
  function mount() {
    if (!document.body) return;
    const id = 'ovs-bilibili-launcher-v1';
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement('details');
      root.id = id;
    }
    // Adopt the public v1 registry without replacing other helpers' link handlers.
    if (root.dataset.ovsUi !== 'toolbar') {
      root.dataset.ovsUi = 'toolbar';
      root.style.cssText = '';
      const style = document.createElement('style');
      style.textContent = `
        #${id} { display:inline-block; vertical-align:middle; position:relative; flex:0 0 auto; margin:0 0 0 16px; border:0; padding:0; background:none; color:var(--text2,#61666d); font:400 12px/20px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
        #${id} > summary { display:flex; align-items:center; gap:5px; width:max-content; min-height:28px; margin:0; padding:0 4px; border-radius:4px; color:inherit; cursor:pointer; list-style:none; user-select:none; }
        #${id} > summary::-webkit-details-marker { display:none; }
        #${id} > summary svg { flex:none; width:20px; height:20px; }
        .toolbar .toolbar-left > #${id} { vertical-align:top; margin-top:4px; }
        #${id} > summary:focus-visible { outline:2px solid var(--brand_blue,#00aeec); outline-offset:3px; }
        #${id}[open] > summary { color:var(--brand_blue,#00aeec); }
        #${id}[data-ovs-placement="floating"] { position:fixed; right:16px; bottom:88px; z-index:100; margin:0; border:1px solid var(--line_regular,#e3e5e7); border-radius:6px; background:var(--bg1,#fff); }
        #${id}[data-ovs-placement="floating"] > summary { min-height:32px; padding:0 8px; }
        #${id} [data-ovs-menu] { box-sizing:border-box; position:fixed; z-index:10000; width:280px; max-width:calc(100vw - 24px); max-height:min(360px,calc(100vh - 24px)); overflow:auto; overscroll-behavior:contain; padding:4px; border:1px solid var(--line_regular,#e3e5e7); border-radius:8px; background:var(--bg1,#fff); color:var(--text1,#18191c); box-shadow:0 2px 12px #00000014; }
        #${id} [data-ovs-heading] { margin:0; padding:6px 10px; color:var(--text2,#61666d); font-size:12px; font-weight:400; }
        #${id} [data-ovs-sites] { display:flex; flex-direction:column; border:0; padding:0; }
        #${id} [data-ovs-sites] > a { display:block; padding:8px 10px; border-radius:4px; color:var(--text1,#18191c) !important; font-size:13px; line-height:20px; text-decoration:none !important; overflow-wrap:anywhere; }
        #${id} [data-ovs-sites] > a:focus-visible { outline:2px solid var(--brand_blue,#00aeec); outline-offset:-2px; background:var(--graph_bg_thin,#f6f7f8); }
        #${id} [data-ovs-status] { margin:0; padding:8px 10px; color:var(--text2,#61666d); font-size:12px; overflow-wrap:anywhere; }
        @media (hover:hover) and (pointer:fine) {
          #${id} > summary:hover { color:var(--brand_blue,#00aeec); }
          #${id} [data-ovs-sites] > a:hover { color:var(--brand_blue,#00aeec) !important; background:var(--graph_bg_thin,#f6f7f8); }
        }
        @media (pointer:coarse) {
          #${id} > summary, #${id}[data-ovs-placement="floating"] > summary { min-height:44px; }
          #${id} [data-ovs-sites] > a { min-height:28px; }
        }
      `;
      const summary = document.createElement('summary');
      summary.setAttribute('aria-label', text.action);
      summary.title = text.action;
      const icon = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'svg',
      );
      for (const [name, value] of Object.entries({
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
      }))
        icon.setAttribute(name, value);
      const path = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      );
      path.setAttribute(
        'd',
        'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 17h8m-4-4v4m-2-13 5 3-5 3V8Z',
      );
      icon.append(path);
      summary.append(icon);
      const label = document.createElement('span');
      label.textContent = 'OVS';
      summary.append(label);
      const menu = document.createElement('div');
      menu.dataset.ovsMenu = '1';
      const heading = document.createElement('p');
      heading.dataset.ovsHeading = '1';
      heading.textContent = text.sites;
      menu.append(heading);
      const list =
        root.querySelector('[data-ovs-sites="1"]') ||
        document.createElement('nav');
      list.style.cssText = '';
      list.setAttribute('aria-label', text.sites);
      list.dataset.ovsSites = '1';
      menu.append(list);
      const status =
        root.querySelector('[data-ovs-status="1"]') ||
        document.createElement('p');
      status.dataset.ovsStatus = '1';
      status.setAttribute('role', 'status');
      status.style.cssText = 'display:none';
      menu.append(status);
      root.replaceChildren(style, summary, menu);
      function positionMenu() {
        if (!root.open) return;
        const anchor = summary.getBoundingClientRect();
        const bounds = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
        menu.style.top = `${anchor.bottom + 8 + bounds.height <= window.innerHeight - 12 ? anchor.bottom + 8 : Math.max(12, anchor.top - bounds.height - 8)}px`;
      }
      summary.addEventListener('click', (event) => {
        event.preventDefault();
        root.open = !root.open;
        positionMenu();
      });
      function place() {
        const candidate =
          document.querySelector?.('.video-toolbar-left-main') ||
          document.querySelector?.('.video-toolbar-left') ||
          document.querySelector?.('.toolbar .toolbar-left');
        // Editing Vue's SSR subtree before hydration triggers a full rebuild,
        // which disrupts Bilibili's separately mounted navigation header.
        const toolbar = candidate?.closest('[data-server-rendered]')
          ? undefined
          : candidate;
        const target = toolbar || document.body;
        root.dataset.ovsPlacement = toolbar ? 'toolbar' : 'floating';
        if (root.parentElement !== target) target.append(root);
        positionMenu();
      }
      function outside(event) {
        if (!root.contains(event.target)) root.open = false;
      }
      function keyboard(event) {
        if (root.open && event.key === 'Escape' && !event.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          root.open = false;
          summary.focus();
        }
      }
      function close() {
        root.open = false;
      }
      function scroll(event) {
        if (!menu.contains(event.target)) close();
      }
      let frame;
      const observer =
        typeof MutationObserver === 'function'
          ? new MutationObserver(() => {
              if (
                (root.isConnected && root.dataset.ovsPlacement === 'toolbar') ||
                frame !== undefined
              )
                return;
              frame = requestAnimationFrame(() => {
                frame = undefined;
                place();
              });
            })
          : undefined;
      function start() {
        place();
        observer?.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-server-rendered'],
        });
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', keyboard);
        document.addEventListener('scroll', scroll, true);
        window.addEventListener('resize', close);
      }
      function stop() {
        close();
        observer?.disconnect();
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        document.removeEventListener('pointerdown', outside);
        document.removeEventListener('keydown', keyboard);
        document.removeEventListener('scroll', scroll, true);
        window.removeEventListener('resize', close);
      }
      root.addEventListener('toggle', positionMenu);
      root.addEventListener('ovs-launcher-layout', positionMenu);
      window.addEventListener('pagehide', stop);
      window.addEventListener('pageshow', start);
      start();
    }
    const list = root.querySelector('[data-ovs-sites="1"]');
    if (!list) return;
    if ([...list.children].some((item) => item.dataset.ovsOrigin === origin))
      return;
    const link = document.createElement('a');
    link.dataset.ovsOrigin = origin;
    link.textContent = origin;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    function update(event) {
      const next = destination();
      const status = root.querySelector('[data-ovs-status="1"]');
      if (next) {
        link.href = next;
        if (status) status.style.display = 'none';
      } else {
        link.removeAttribute('href');
        event?.preventDefault();
        if (status) {
          status.textContent = text.invalid;
          status.style.display = 'block';
        }
      }
      if (root.open) root.dispatchEvent(new Event('ovs-launcher-layout'));
    }
    update();
    link.addEventListener('pointerdown', update);
    link.addEventListener('click', update);
    link.addEventListener('auxclick', update);
    root.addEventListener('toggle', update);
    list.append(link);
    if (root.open) root.dispatchEvent(new Event('ovs-launcher-layout'));
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}
