(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  // Host mode: open the site once with ?host=KEY and this phone can remove photos and download the album.
  const params = new URLSearchParams(location.search);
  if (params.get('host')) {
    store.set('hostKey', params.get('host'));
    history.replaceState(null, '', location.pathname + location.hash);
  }
  let hostKey = store.get('hostKey');
  let isHost = false;

  const nameInput = $('guest-name');
  nameInput.value = store.get('guestName');
  nameInput.addEventListener('input', () => store.set('guestName', nameInput.value));

  /* ---------- Views ---------- */
  function show(view) {
    $('share').hidden = view !== 'share';
    $('gallery').hidden = view !== 'gallery';
    if (view === 'gallery') refresh(true);
    window.scrollTo(0, 0);
  }
  $('to-gallery').addEventListener('click', () => { location.hash = 'photos'; });
  $('to-share').addEventListener('click', () => { location.hash = ''; });
  window.addEventListener('hashchange', route);
  function route() { show(location.hash === '#photos' ? 'gallery' : 'share'); }

  /* ---------- Upload ---------- */
  const fileInput = $('file-input');
  $('pick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    fileInput.value = '';
    if (files.length) uploadAll(files);
  });

  async function loadImage(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }

  function toJpeg(src, maxSide, quality) {
    const sw = src.width, sh = src.height;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return { b64: c.toDataURL('image/jpeg', quality).split(',')[1], w, h };
  }

  async function uploadOne(file) {
    const src = await loadImage(file);
    const full = toJpeg(src, 2000, 0.82);
    const thumb = toJpeg(src, 480, 0.72);
    if (src.close) src.close();
    const res = await fetch('/api/photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameInput.value, full: full.b64, thumb: thumb.b64, w: full.w, h: full.h }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    return data;
  }

  let busy = false;
  async function uploadAll(files) {
    if (busy) return;
    busy = true;
    const pick = $('pick'), progress = $('progress'), text = $('progress-text'), fill = $('bar-fill');
    const notice = $('notice'), strip = $('just-added');
    pick.disabled = true; notice.hidden = true; progress.hidden = false;
    let done = 0, failed = 0, lastError = '';
    const tick = () => {
      fill.style.width = `${Math.round(((done + failed) / files.length) * 100)}%`;
      text.textContent = `Adding ${Math.min(done + failed + 1, files.length)} of ${files.length}. Keep this page open.`;
    };
    tick();
    const queue = files.slice();
    const worker = async () => {
      while (queue.length) {
        const file = queue.shift();
        try {
          const p = await uploadOne(file);
          done++;
          const img = new Image();
          img.src = `/t/${p.id}.jpg`; img.alt = '';
          strip.prepend(img);
          while (strip.children.length > 8) strip.lastChild.remove();
          strip.hidden = false;
        } catch (e) {
          failed++;
          lastError = e.message === 'unreadable' ? 'One of those files is not a photo we can read.' : e.message;
        }
        tick();
      }
    };
    await Promise.all([worker(), worker()]);
    progress.hidden = true; fill.style.width = '0';
    pick.disabled = false; busy = false;
    notice.hidden = false;
    if (failed === 0) {
      notice.className = 'notice good';
      notice.textContent = done === 1 ? 'Photo added. Thank you!' : `${done} photos added. Thank you!`;
    } else {
      notice.className = 'notice bad';
      notice.textContent = `${done} added, ${failed} did not go through. ${lastError}`;
    }
    $('pick').lastChild.textContent = ' Add more photos';
    loadCount();
  }

  /* ---------- Gallery ---------- */
  let photos = [], total = 0, loading = false, exhausted = false;
  const grid = $('grid');

  function tile(p) {
    const b = document.createElement('button');
    b.className = 'tile'; b.type = 'button'; b.dataset.id = p.id;
    b.setAttribute('aria-label', p.name ? `Photo from ${p.name}` : 'Photo');
    const img = new Image();
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
    img.src = `/t/${p.id}.jpg`;
    b.append(img);
    return b;
  }
  function setTotal(n) {
    total = n;
    const label = n === 1 ? '1 photo' : `${n} photos`;
    $('gallery-count').textContent = n ? label : '';
    $('count-pill').textContent = n; $('count-pill').hidden = !n;
    $('empty').hidden = n > 0;
  }
  async function fetchPage(before) {
    const res = await fetch(`/api/photos?limit=60${before ? `&before=${before}` : ''}`);
    if (!res.ok) throw new Error('load');
    return res.json();
  }
  // Pull the newest page and add anything we have not shown yet to the top.
  async function refresh(reset) {
    if (loading) return;
    loading = true;
    try {
      const data = await fetchPage();
      if (reset && !photos.length) {
        photos = data.photos;
        grid.replaceChildren(...photos.map(tile));
        exhausted = data.photos.length < 60;
      } else {
        const known = new Set(photos.map((p) => p.id));
        const fresh = data.photos.filter((p) => !known.has(p.id));
        if (fresh.length) {
          photos = fresh.concat(photos);
          grid.prepend(...fresh.map(tile));
        }
      }
      setTotal(data.total);
    } catch {} finally { loading = false; }
  }
  async function loadMore() {
    if (loading || exhausted || !photos.length) return;
    loading = true;
    try {
      const data = await fetchPage(photos[photos.length - 1].id);
      photos = photos.concat(data.photos);
      grid.append(...data.photos.map(tile));
      exhausted = data.photos.length < 60;
      setTotal(data.total);
    } catch {} finally { loading = false; }
  }
  async function loadCount() {
    try { const d = await (await fetch('/api/photos?limit=1')).json(); setTotal(d.total); } catch {}
  }
  new IntersectionObserver((entries) => { if (entries[0].isIntersecting) loadMore(); }, { rootMargin: '600px' }).observe($('sentinel'));
  setInterval(() => { if (!$('gallery').hidden && !document.hidden) refresh(false); }, 20000);

  /* ---------- Viewer ---------- */
  const viewer = $('viewer');
  let current = -1;
  function open(i) {
    if (i < 0 || i >= photos.length) return;
    current = i;
    const p = photos[i];
    $('v-img').src = `/p/${p.id}.jpg`;
    $('v-caption').textContent = p.name ? `From ${p.name}` : '';
    $('v-save').href = `/p/${p.id}.jpg?dl=1`;
    $('v-prev').hidden = i === 0;
    $('v-next').hidden = i === photos.length - 1;
    $('v-delete').hidden = !isHost;
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
    if (i > photos.length - 6) loadMore();
  }
  function close() { viewer.hidden = true; $('v-img').removeAttribute('src'); document.body.style.overflow = ''; current = -1; }
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (t) open(photos.findIndex((p) => String(p.id) === t.dataset.id));
  });
  $('v-close').addEventListener('click', close);
  $('v-prev').addEventListener('click', () => open(current - 1));
  $('v-next').addEventListener('click', () => open(current + 1));
  viewer.addEventListener('click', (e) => { if (e.target === viewer) close(); });
  document.addEventListener('keydown', (e) => {
    if (viewer.hidden) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') open(current - 1);
    if (e.key === 'ArrowRight') open(current + 1);
  });
  let touchX = null;
  viewer.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  viewer.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) open(current + (dx < 0 ? 1 : -1));
  });

  // Two taps to remove, so a stray tap does nothing.
  const del = $('v-delete');
  let armed = null;
  del.addEventListener('click', async () => {
    const p = photos[current];
    if (!p) return;
    if (armed !== p.id) {
      armed = p.id; del.textContent = 'Tap again to remove';
      setTimeout(() => { armed = null; del.textContent = 'Remove'; }, 3000);
      return;
    }
    const res = await fetch(`/api/photos/${p.id}`, { method: 'DELETE', headers: { 'x-host-key': hostKey } });
    if (!res.ok) return;
    armed = null; del.textContent = 'Remove';
    photos.splice(current, 1);
    grid.querySelector(`[data-id="${p.id}"]`)?.remove();
    setTotal(Math.max(0, total - 1));
    if (photos.length) open(Math.min(current, photos.length - 1)); else close();
  });

  /* ---------- Start ---------- */
  if (hostKey) {
    fetch('/api/host', { headers: { 'x-host-key': hostKey } }).then((r) => r.json()).then((d) => {
      isHost = !!d.host;
      if (isHost) {
        const a = $('download-all');
        a.href = `/download.zip?key=${encodeURIComponent(hostKey)}`;
        a.hidden = false;
      }
    }).catch(() => {});
  }
  route();
  loadCount();
})();
