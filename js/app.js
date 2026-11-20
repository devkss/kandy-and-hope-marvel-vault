(function () {
  const CARDS = window.VAULT_CARDS || [];
  const DISPLAYS = window.VAULT_DISPLAYS || [];
  const SETS = window.VAULT_SETS || [];
  const ODDS = window.VAULT_ODDS || [];
  const CHASES = window.VAULT_CHASES || [];

  const GH_STORAGE_KEY = 'kh_vault_gh_config_v1';
  const RECENT_UPLOADS_KEY = 'kh_vault_recent_uploads_v1';

  function loadGHConfig() {
    try {
      const raw = localStorage.getItem(GH_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { owner: 'devkss', repo: 'kandy-and-hope-marvel-vault', branch: 'main', token: '' };
  }

  function saveGHConfig(cfg) {
    try { localStorage.setItem(GH_STORAGE_KEY, JSON.stringify(cfg)); } catch (_) {}
  }

  function loadRecentUploads() {
    try { return JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) || '{}'); } catch (_) { return {}; }
  }

  function markRecentUpload(path) {
    const map = loadRecentUploads();
    map[path] = Date.now();
    try { localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(map)); } catch (_) {}
  }

  const state = {
    activeTab: 'hope',
    valMode: 'mid',
    viewMode: { 1: 'wall', 2: 'wall', 3: 'wall', 4: 'wall', 5: 'wall' },
    sessionPhotos: {}, // card.id -> objectURL
    realPhotoLoaded: {}, // card.id -> true/false
    recentUploads: loadRecentUploads(),
    gh: loadGHConfig(),
    stagedCardPhoto: null, // { file, rawBlob, previewUrl, optBlob, optBase64 }
    stagedHeroPhoto: null, // { file, rawBlob, previewUrl, optBlob, optBase64 }
    filters: {
      search: '',
      owner: 'all',
      display: 'all',
      set: 'all',
      sort: 'slot',
      quickTag: 'all'
    },
    guideFilter: 'all',
    guideSearch: ''
  };

  // Helpers
  const fmtGBP = (n) => '£' + Math.round(n).toLocaleString('en-GB');
  const fmtKB = (bytes) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  const cardVal = (c, mode = state.valMode) => {
    if (mode === 'low') return c.valLow;
    if (mode === 'high') return c.valHigh;
    return Math.round((c.valLow + c.valHigh) / 2);
  };
  const sumVals = (list, mode = state.valMode) => list.reduce((acc, c) => acc + cardVal(c, mode), 0);

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.remove('show'), 3000);
  }

  // Convert any image Blob/File into an optimised crisp web JPEG (max 1200px long edge)
  function processImageBlob(blob, optimise = true) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const maxDim = optimise ? 1200 : 2400;
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          if (Math.max(w, h) > maxDim) {
            const ratio = maxDim / Math.max(w, h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const quality = optimise ? 0.88 : 0.95;
          canvas.toBlob((outBlob) => {
            URL.revokeObjectURL(url);
            if (!outBlob) return reject(new Error('Could not encode JPEG'));
            const reader = new FileReader();
            reader.onloadend = () => {
              const dataUrl = reader.result;
              const base64 = String(dataUrl).split(',')[1];
              resolve({ blob: outBlob, base64, width: w, height: h });
            };
            reader.onerror = () => reject(new Error('Could not read encoded image'));
            reader.readAsDataURL(outBlob);
          }, 'image/jpeg', quality);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Invalid or unreadable image file'));
      };
      img.src = url;
    });
  }

  // Upload/Overwrite a file directly in GitHub via REST Contents API
  async function uploadToGitHub(repoFilePath, base64Content, commitMessage) {
    const { owner, repo, branch, token } = state.gh;
    if (!token || !owner || !repo) {
      throw new Error('NOT_CONFIGURED');
    }

    const encodedPath = repoFilePath.split('/').map(encodeURIComponent).join('/');
    const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
    const headers = {
      'Authorization': `Bearer ${token.trim()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    // Step 1: Check if file already exists to grab its SHA (required by GitHub to overwrite)
    let existingSha = null;
    const checkRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch || 'main')}`, { headers });
    if (checkRes.status === 200) {
      const existingData = await checkRes.json();
      existingSha = existingData.sha || null;
    } else if (checkRes.status !== 404) {
      const errBody = await checkRes.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub check failed (${checkRes.status})`);
    }

    // Step 2: PUT the new/updated file content
    const payload = {
      message: commitMessage,
      content: base64Content,
      branch: branch || 'main'
    };
    if (existingSha) payload.sha = existingSha;

    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub upload failed (${putRes.status})`);
    }
    return await putRes.json();
  }

  // Save Blob locally with the exact required filename (uses File System Access API on Chrome/Edge PC, falls back to download)
  async function saveBlobLocally(blob, exactFilename) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: exactFilename,
          types: [{ description: 'JPEG Image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return 'picker';
      } catch (err) {
        if (err && err.name === 'AbortError') return 'cancelled';
        // Fall through to standard download if picker is blocked/unsupported
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exactFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return 'download';
  }

  // Update GitHub Sync button badge
  function updateGHButtonState() {
    const btn = document.getElementById('gh-settings-btn');
    const guideBtn = document.getElementById('guide-gh-btn');
    const connected = Boolean(state.gh.token && state.gh.owner && state.gh.repo);
    if (btn) {
      btn.textContent = connected ? '✅ GitHub Connected' : '☁️ GitHub Sync';
      btn.classList.toggle('btn-github-connected', connected);
      btn.classList.toggle('btn-soft', !connected);
    }
    if (guideBtn) {
      guideBtn.textContent = connected ? '✅ GitHub Sync Connected' : '☁️ Connect GitHub Sync';
    }
  }

  // Hero Photo auto-loader & uploader
  function initHeroPhoto() {
    const img = document.getElementById('hero-photo');
    const recentTs = state.recentUploads['assets/photos/kandy-and-hope.jpg'];
    const qs = recentTs ? `?v=${recentTs}` : '';
    const candidates = [
      `assets/photos/kandy-and-hope.jpg${qs}`,
      'assets/photos/kandy-and-hope.jpeg',
      'assets/photos/kandy-and-hope.png',
      'assets/photos/kandy-and-hope.webp',
      'assets/photos/kandy-and-hope.svg'
    ];
    let idx = 0;
    function tryNext() {
      if (idx >= candidates.length) return;
      img.src = candidates[idx++];
    }
    img.onerror = tryNext;
    tryNext();

    document.getElementById('hero-photo-input').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const previewUrl = URL.createObjectURL(file);
      img.onerror = null;
      img.src = previewUrl;
      state.stagedHeroPhoto = { file, previewUrl };
      document.getElementById('hero-save-actions').classList.add('visible');
      showToast('Previewing your photo! Click "Save to GitHub" or "Save Locally" below it.');
      e.target.value = '';
    });

    document.getElementById('hero-save-gh-btn').addEventListener('click', async () => {
      if (!state.stagedHeroPhoto) return;
      if (!state.gh.token) {
        openGHModal('Paste your GitHub token to save your photo directly to the repo.');
        return;
      }
      const btn = document.getElementById('hero-save-gh-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Saving...';
      try {
        const processed = await processImageBlob(state.stagedHeroPhoto.file, true);
        await uploadToGitHub(
          'assets/photos/kandy-and-hope.jpg',
          processed.base64,
          'Update hero photo: Kandy & Hope'
        );
        markRecentUpload('assets/photos/kandy-and-hope.jpg');
        state.recentUploads = loadRecentUploads();
        document.getElementById('hero-save-actions').classList.remove('visible');
        state.stagedHeroPhoto = null;
        showToast('✅ Kandy & Hope photo saved to GitHub! Live site refreshes in ~45s.');
        burstConfetti();
      } catch (err) {
        showToast(`Upload error: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '☁️ Save to GitHub';
      }
    });

    document.getElementById('hero-save-local-btn').addEventListener('click', async () => {
      if (!state.stagedHeroPhoto) return;
      try {
        const processed = await processImageBlob(state.stagedHeroPhoto.file, true);
        const res = await saveBlobLocally(processed.blob, 'kandy-and-hope.jpg');
        if (res !== 'cancelled') {
          showToast('💾 Saved locally as kandy-and-hope.jpg!');
        }
      } catch (err) {
        showToast(`Save error: ${err.message}`);
      }
    });
  }

  // Update Hero KPI Stats
  function renderHeroStats() {
    const hopeCards = CARDS.filter(c => c.owner === 'Hope');
    const kandyCards = CARDS.filter(c => c.owner === 'Kandy');
    const ace10 = CARDS.filter(c => c.grade && c.grade.includes('10')).length;
    const ace9 = CARDS.filter(c => c.grade && c.grade.includes('9')).length;
    const ultraRare = CARDS.filter(c => (c.printRun && c.printRun <= 10) || c.tags.includes('Case Hit')).length;

    const grandLow = sumVals(CARDS, 'low');
    const grandHigh = sumVals(CARDS, 'high');
    const grandCur = sumVals(CARDS, state.valMode);

    document.getElementById('stat-total-cards').textContent = CARDS.length;
    document.getElementById('stat-total-sub').textContent = `${hopeCards.length} Hope · ${kandyCards.length} Kandy`;
    document.getElementById('stat-slabs').textContent = ace10 + ace9;
    document.getElementById('stat-slabs-sub').textContent = `${ace10}× ACE 10 · ${ace9}× ACE 9`;
    document.getElementById('stat-ultra').textContent = ultraRare;
    document.getElementById('stat-value').textContent = fmtGBP(grandCur);
    document.getElementById('stat-value-range').textContent = `Range: ${fmtGBP(grandLow)} – ${fmtGBP(grandHigh)}`;

    document.querySelectorAll('.val-toggle button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === state.valMode);
    });
  }

  // Smart Image Resolver per Card (with cache-busting for freshly uploaded GitHub photos)
  function attachSmartImage(imgEl, card, tileEl) {
    if (state.sessionPhotos[card.id]) {
      imgEl.onload = null;
      imgEl.onerror = null;
      imgEl.src = state.sessionPhotos[card.id];
      state.realPhotoLoaded[card.id] = true;
      if (tileEl) tileEl.classList.add('has-real-photo');
      return;
    }
    const base = `assets/cards/${card.folder}/${card.baseFilename}`;
    const ts = state.recentUploads[card.recommendedPath];
    const qs = ts ? `?v=${ts}` : '';
    const candidates = [
      { url: `${base}.jpg${qs}`, isReal: true },
      { url: `${base}.jpeg`, isReal: true },
      { url: `${base}.png`, isReal: true },
      { url: `${base}.webp`, isReal: true },
      { url: card.placeholderSvg, isReal: false }
    ];
    let idx = 0;
    function loadNext() {
      if (idx >= candidates.length) return;
      const cand = candidates[idx++];
      imgEl.onload = () => {
        state.realPhotoLoaded[card.id] = cand.isReal;
        if (tileEl) tileEl.classList.toggle('has-real-photo', cand.isReal);
        updatePhotoCounter();
      };
      imgEl.onerror = loadNext;
      imgEl.src = cand.url;
    }
    loadNext();
  }

  function updatePhotoCounter() {
    const realCount = Object.values(state.realPhotoLoaded).filter(Boolean).length;
    const badge = document.getElementById('photo-progress-badge');
    if (badge) badge.textContent = `${realCount} / ${CARDS.length} Real Photos Loaded`;
  }

  // Create a 3D Holographic Card Tile
  function createCardTile(card) {
    const tile = document.createElement('div');
    tile.className = 'card-tile' + (card.orientation === 'landscape' ? ' landscape' : '');
    tile.dataset.cardId = card.id;

    const isSlab = Boolean(card.grade);
    const slabClass = isSlab ? (card.grade.includes('10') ? 'is-slab ace-10' : 'is-slab ace-9') : '';
    const slabHeaderHTML = isSlab ? `
      <div class="slab-header ${card.grade.includes('10') ? 'ace-10' : 'ace-9'}">
        <span>ACE ${card.grade.includes('10') ? 'GEM MINT' : 'MINT'}</span>
        <span class="slab-grade-box">${card.grade.includes('10') ? '10' : '9'}</span>
      </div>` : '';

    const specialEmoji = card.tags.includes('Alpha #1') ? '🥇 ' :
                         card.tags.includes('Bookend') ? '👑 ' :
                         card.tags.includes('Case Hit') ? '⚡ ' :
                         card.tags.includes('Autograph') ? '✍️ ' : '';

    tile.innerHTML = `
      <div class="card-3d ${slabClass}">
        ${slabHeaderHTML}
        <div class="card-img-wrap">
          <span class="real-photo-dot">REAL PHOTO</span>
          <img alt="${card.character} - ${card.parallel}" loading="lazy"/>
          <div class="holo-glare"></div>
        </div>
      </div>
      <div class="card-caption">
        <div class="card-char" title="${card.character}">${specialEmoji}${card.character}</div>
        <div class="card-par" title="${card.parallel}">${card.parallel}</div>
        <div class="card-meta-row">
          <span class="serial-chip">${card.serial === 'Unnumbered' ? card.slot : card.serial}</span>
          <span class="price-chip">${fmtGBP(cardVal(card))}</span>
        </div>
      </div>
    `;

    const imgEl = tile.querySelector('img');
    attachSmartImage(imgEl, card, tile);

    // 3D Tilt interaction
    const card3d = tile.querySelector('.card-3d');
    const glare = tile.querySelector('.holo-glare');
    tile.addEventListener('mousemove', (e) => {
      const rect = card3d.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const rotY = (x - 0.5) * 18;
      const rotX = (0.5 - y) * 18;
      card3d.style.transform = `rotateX(${rotX}deg) rotateY(${rotY}deg) scale(1.03)`;
      glare.style.setProperty('--mx', `${Math.round(x * 100)}%`);
      glare.style.setProperty('--my', `${Math.round(y * 100)}%`);
    });
    tile.addEventListener('mouseleave', () => {
      card3d.style.transform = 'rotateX(0deg) rotateY(0deg) scale(1)';
    });

    tile.addEventListener('click', () => openCardModal(card));
    return tile;
  }

  // Render Display Case Section
  function renderDisplaySection(container, displayId) {
    const meta = DISPLAYS.find(d => d.id === displayId);
    const dCards = CARDS.filter(c => c.display === displayId);
    const mode = state.viewMode[displayId] || 'wall';

    const sec = document.createElement('section');
    sec.className = 'display-section';

    const low = sumVals(dCards, 'low');
    const high = sumVals(dCards, 'high');
    const cur = sumVals(dCards, state.valMode);

    let rainbowBar = '';
    if (displayId === 1 || displayId === 2) {
      const uniqueParallels = new Set(dCards.filter(c => c.set === '2026 Topps Chrome Marvel').map(c => c.parallel)).size;
      const pct = Math.min(100, Math.round((uniqueParallels / 42) * 100));
      rainbowBar = `
        <div class="rainbow-bar-box">
          <div class="rainbow-bar-top">
            <span>🌈 ${meta.shortTitle} Progress — ${uniqueParallels} of 42 Unique Chrome Parallels Collected!</span>
            <span>${pct}% Complete</span>
          </div>
          <div class="rainbow-track"><div class="rainbow-fill" style="width:${pct}%"></div></div>
        </div>`;
    }

    sec.innerHTML = `
      <div class="display-header">
        <div class="display-title-group">
          <h2>${meta.title}</h2>
          <p>${meta.subtitle}</p>
        </div>
        <div class="display-badges">
          <span class="pill ${meta.owner === 'Hope' ? 'pill-pink' : 'pill-cyan'}">${dCards.length} Cards</span>
          <span class="pill pill-gold">Est. ${fmtGBP(cur)} (${fmtGBP(low)}–${fmtGBP(high)})</span>
        </div>
      </div>
      ${rainbowBar}
      <div class="view-bar">
        <span style="font-size:0.84rem;color:var(--text-muted);font-weight:600;">💡 ${meta.extraNote}</span>
        <div class="segmented">
          <button class="${mode === 'wall' ? 'active' : ''}" data-view="wall">🖼️ Wall Case View</button>
          <button class="${mode === 'grid' ? 'active' : ''}" data-view="grid">✨ Gallery Grid</button>
        </div>
      </div>
      <div class="display-body"></div>
    `;

    sec.querySelectorAll('.segmented button').forEach(btn => {
      btn.addEventListener('click', () => {
        state.viewMode[displayId] = btn.dataset.view;
        renderActiveTab();
      });
    });

    const body = sec.querySelector('.display-body');
    if (mode === 'wall') {
      const wall = document.createElement('div');
      wall.className = 'wall-case';
      const rows = [...new Set(dCards.map(c => c.row))].sort((a, b) => a - b);
      rows.forEach(r => {
        const rowCards = dCards.filter(c => c.row === r).sort((a, b) => a.col - b.col);
        const rowWrap = document.createElement('div');
        rowWrap.className = 'shelf-row-wrap';
        const rowTitle = r === 0 ? 'TOP OF DISPLAY CASE — CLASSIC COMIC BOOK COVERS (9 OF 10 · MISSING CC-10)' : `SHELF ROW ${r}`;
        rowWrap.innerHTML = `
          <div class="shelf-row-label">
            <span>${rowTitle}</span>
            <span>${rowCards.length} cards</span>
          </div>
          ${r > 0 ? '<div class="shelf-led-bar"></div>' : ''}
          <div class="shelf-cards"></div>
        `;
        const grid = rowWrap.querySelector('.shelf-cards');
        rowCards.forEach(c => grid.appendChild(createCardTile(c)));
        wall.appendChild(rowWrap);
      });
      body.appendChild(wall);
    } else {
      const grid = document.createElement('div');
      grid.className = 'cards-grid';
      dCards.forEach(c => grid.appendChild(createCardTile(c)));
      body.appendChild(grid);
    }

    container.appendChild(sec);
  }

  // Render All-180 Explorer Tab
  function renderExplorer() {
    const f = state.filters;
    let list = CARDS.filter(c => {
      if (f.owner !== 'all' && c.owner !== f.owner) return false;
      if (f.display !== 'all' && String(c.display) !== f.display) return false;
      if (f.set !== 'all' && c.set !== f.set) return false;
      if (f.quickTag !== 'all') {
        if (f.quickTag === 'ace' && !c.grade) return false;
        else if (f.quickTag === 'low10' && !(c.printRun && c.printRun <= 10)) return false;
        else if (f.quickTag === 'auto' && !c.tags.includes('Autograph')) return false;
        else if (f.quickTag === 'casehit' && !c.tags.includes('Case Hit')) return false;
        else if (f.quickTag === 'special' && !(c.tags.includes('Alpha #1') || c.tags.includes('Bookend'))) return false;
      }
      if (f.search.trim()) {
        const q = f.search.trim().toLowerCase();
        const hay = `${c.character} ${c.parallel} ${c.set} ${c.serial} ${c.artist || ''} ${c.subset} ${c.baseFilename}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (f.sort === 'val-desc') list.sort((a, b) => cardVal(b) - cardVal(a));
    else if (f.sort === 'val-asc') list.sort((a, b) => cardVal(a) - cardVal(b));
    else if (f.sort === 'rarity') list.sort((a, b) => (a.printRun || 9999) - (b.printRun || 9999));
    else if (f.sort === 'alpha') list.sort((a, b) => a.character.localeCompare(b.character));

    document.getElementById('explorer-summary').textContent =
      `Showing ${list.length} of ${CARDS.length} cards · Filtered Est. Value: ${fmtGBP(sumVals(list))}`;

    const grid = document.getElementById('explorer-grid');
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = '<div style="padding:36px;text-align:center;color:var(--text-muted);font-weight:700;">No cards match those filters—try clearing your search!</div>';
      return;
    }
    list.forEach(c => grid.appendChild(createCardTile(c)));
  }

  // Render Sets, Odds, Valuations & Chase Tracker Tab
  function renderSetsTab() {
    const setsWrap = document.getElementById('sets-cards-wrap');
    setsWrap.innerHTML = SETS.map(s => `
      <div class="set-card">
        <span class="pill" style="margin-bottom:10px;">Released ${s.releaseDate} · ${s.baseSize}</span>
        <h3>${s.name}</h3>
        <p style="color:var(--text-muted);line-height:1.58;font-size:0.94rem;">${s.summary}</p>
        <strong style="font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em;">Box Formats</strong>
        <ul>${s.formats.map(x => `<li>${x}</li>`).join('')}</ul>
        <strong style="font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em;">Key Inserts &amp; Chases</strong>
        <ul>${s.inserts.map(x => `<li>${x}</li>`).join('')}</ul>
        <strong style="font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em;display:block;margin-bottom:8px;">Full Base &amp; Insert Character Checklists</strong>
        <div class="checklist-links">
          ${s.links.map(l => `<a href="${l.url}" target="_blank" rel="noopener noreferrer"><span>🔗 ${l.label}</span><span>↗</span></a>`).join('')}
        </div>
      </div>
    `).join('');

    const oddsBody = document.getElementById('odds-tbody');
    oddsBody.innerHTML = ODDS.map(o => `
      <tr>
        <td><span class="pill ${o.set === 'Chrome' ? 'pill-gold' : 'pill-cyan'}">${o.set}</span></td>
        <td><strong>${o.item}</strong></td>
        <td style="font-family:'JetBrains Mono',monospace;">${o.hobby}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${o.mega}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${o.blaster}</td>
        <td style="color:var(--text-muted);">${o.highlight}</td>
      </tr>
    `).join('');

    const valBody = document.getElementById('valuation-tbody');
    valBody.innerHTML = DISPLAYS.map(d => {
      const dc = CARDS.filter(c => c.display === d.id);
      return `
        <tr>
          <td><strong>Display ${d.id}: ${d.shortTitle}</strong></td>
          <td><span class="pill ${d.owner === 'Hope' ? 'pill-pink' : 'pill-cyan'}">${d.owner}</span></td>
          <td>${dc.length}</td>
          <td style="font-family:'JetBrains Mono',monospace;">${fmtGBP(sumVals(dc, 'low'))}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-weight:800;">${fmtGBP(sumVals(dc, 'mid'))}</td>
          <td style="font-family:'JetBrains Mono',monospace;">${fmtGBP(sumVals(dc, 'high'))}</td>
        </tr>
      `;
    }).join('') + `
      <tr style="background:var(--surface-soft);font-weight:900;">
        <td colspan="2">COMBINED VAULT TOTAL (HOPE + KANDY)</td>
        <td>${CARDS.length}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${fmtGBP(sumVals(CARDS, 'low'))}</td>
        <td style="font-family:'JetBrains Mono',monospace;color:var(--pink);">${fmtGBP(sumVals(CARDS, 'mid'))}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${fmtGBP(sumVals(CARDS, 'high'))}</td>
      </tr>
    `;

    const chaseWrap = document.getElementById('chase-grid');
    chaseWrap.innerHTML = CHASES.map(ch => `
      <div class="chase-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span class="pill ${ch.owner === 'Hope' ? 'pill-pink' : 'pill-gold'}">${ch.owner}'s Chase</span>
          <span style="font-size:0.74rem;font-weight:800;color:var(--pink);">${ch.priority}</span>
        </div>
        <h4 style="margin:0 0 6px;font-size:1.05rem;">${ch.title}</h4>
        <p style="margin:0;font-size:0.86rem;color:var(--text-muted);line-height:1.5;">${ch.detail}</p>
      </div>
    `).join('');
  }

  // Render Photo Setup & Filename Guide Tab
  function renderGuideTab() {
    const tbody = document.getElementById('guide-tbody');
    const q = state.guideSearch.trim().toLowerCase();
    const list = CARDS.filter(c => {
      if (state.guideFilter !== 'all' && String(c.display) !== state.guideFilter) return false;
      if (q && !`${c.character} ${c.parallel} ${c.serial} ${c.recommendedPath}`.toLowerCase().includes(q)) return false;
      return true;
    });

    tbody.innerHTML = list.map(c => {
      const hasReal = Boolean(state.realPhotoLoaded[c.id]);
      return `
        <tr>
          <td><strong>D${c.display} · ${c.slot}</strong></td>
          <td>${c.character}</td>
          <td>${c.parallel} <span style="color:var(--text-muted);">(${c.serial})</span></td>
          <td><code class="fname">${c.recommendedPath}</code></td>
          <td>${hasReal ? '<span class="pill" style="background:rgba(16,185,129,0.2);color:#059669;">✅ Real Photo</span>' : '<span class="pill">🎨 Placeholder SVG</span>'}</td>
          <td>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-primary" style="padding:5px 10px;font-size:0.74rem;" data-open-card="${c.id}">📸 Swap</button>
              <button class="btn btn-soft" style="padding:5px 10px;font-size:0.74rem;" data-copy="${c.baseFilename}.jpg">Copy</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('button[data-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard?.writeText(btn.dataset.copy);
        showToast(`Copied: ${btn.dataset.copy}`);
      });
    });

    tbody.querySelectorAll('button[data-open-card]').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = CARDS.find(x => x.id === btn.dataset.openCard);
        if (card) openCardModal(card);
      });
    });
  }

  // ==========================================================================
  // CARD INSPECTOR MODAL + STAGED PHOTO STUDIO
  // ==========================================================================
  let currentModalCard = null;

  function clearStagedCardPhoto(restoreImg = false) {
    if (state.stagedCardPhoto && state.stagedCardPhoto.previewUrl) {
      URL.revokeObjectURL(state.stagedCardPhoto.previewUrl);
    }
    state.stagedCardPhoto = null;
    document.getElementById('staged-panel').classList.remove('visible');
    const statusEl = document.getElementById('modal-upload-status');
    statusEl.textContent = '';
    statusEl.className = 'upload-status';
    if (restoreImg && currentModalCard) {
      attachSmartImage(document.getElementById('modal-img'), currentModalCard, null);
    }
  }

  async function stageCardPhotoBlob(blob) {
    if (!currentModalCard || !blob) return;
    const statusEl = document.getElementById('modal-upload-status');
    const sizeInfo = document.getElementById('staged-size-info');
    const optChecked = document.getElementById('opt-web-jpeg').checked;

    const previewUrl = URL.createObjectURL(blob);
    const modalImg = document.getElementById('modal-img');
    modalImg.onload = null;
    modalImg.onerror = null;
    modalImg.src = previewUrl;

    document.getElementById('staged-panel').classList.add('visible');
    statusEl.textContent = 'Preparing photo preview...';
    statusEl.className = 'upload-status';

    try {
      const processed = await processImageBlob(blob, optChecked);
      if (state.stagedCardPhoto && state.stagedCardPhoto.previewUrl) {
        URL.revokeObjectURL(state.stagedCardPhoto.previewUrl);
      }
      state.stagedCardPhoto = {
        rawBlob: blob,
        previewUrl,
        outBlob: processed.blob,
        outBase64: processed.base64
      };
      sizeInfo.textContent = `Preview Ready · ${processed.width}×${processed.height}px (${fmtKB(processed.blob.size)})`;
      statusEl.textContent = 'Looks good? Confirm to save to GitHub or save locally!';
      statusEl.className = 'upload-status ok';
    } catch (err) {
      statusEl.textContent = `Could not process image: ${err.message}`;
      statusEl.className = 'upload-status err';
    }
  }

  function openCardModal(card) {
    currentModalCard = card;
    clearStagedCardPhoto(false);

    const modal = document.getElementById('card-modal');
    const img = document.getElementById('modal-img');
    attachSmartImage(img, card, null);

    document.getElementById('modal-title').textContent = card.character;
    document.getElementById('modal-subtitle').textContent = `${card.set} · ${card.cardNum} · ${card.parallel}`;
    document.getElementById('modal-owner-badge').textContent = `${card.owner}'s Vault · Display ${card.display} (${card.slot})`;

    const details = [
      ['Serial Number', card.serial],
      ['Print Run', card.printRun ? `/${card.printRun}` : 'Unnumbered'],
      ['Format / Exclusivity', card.format],
      ['Pull Odds', card.odds],
      ['Est. Value (GBP)', `${fmtGBP(card.valLow)} – ${fmtGBP(card.valHigh)} (Mid ${fmtGBP(cardVal(card, 'mid'))})`],
      ['Grade / Condition', card.grade || 'Raw · One-Touch Magnetic Case'],
      ['Subset', card.subset],
      ['Artist / Notes', card.artist || (card.tags.length ? card.tags.join(', ') : 'Display Collection')]
    ];
    document.getElementById('modal-details').innerHTML = details.map(([k, v]) => `
      <div class="detail-item"><span>${k}</span><strong>${v}</strong></div>
    `).join('');

    document.getElementById('modal-filepath').textContent = card.recommendedPath;
    modal.classList.add('open');
  }

  function closeCardModal() {
    clearStagedCardPhoto(false);
    document.getElementById('card-modal').classList.remove('open');
  }

  // ==========================================================================
  // GITHUB SYNC SETTINGS MODAL
  // ==========================================================================
  function openGHModal(hintMsg = '') {
    document.getElementById('gh-owner').value = state.gh.owner || 'devkss';
    document.getElementById('gh-repo').value = state.gh.repo || 'kandy-and-hope-marvel-vault';
    document.getElementById('gh-branch').value = state.gh.branch || 'main';
    document.getElementById('gh-token').value = state.gh.token || '';
    const st = document.getElementById('gh-test-status');
    st.textContent = hintMsg;
    st.className = 'upload-status';
    document.getElementById('gh-modal').classList.add('open');
  }

  function closeGHModal() {
    document.getElementById('gh-modal').classList.remove('open');
  }

  // Batch Folder Photo Loader
  function handleFolderUpload(files) {
    let matched = 0;
    const mapByStem = {};
    CARDS.forEach(c => { mapByStem[c.baseFilename.toLowerCase()] = c; });

    Array.from(files).forEach(file => {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return;
      const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
      if (stem === 'kandy-and-hope') {
        const heroImg = document.getElementById('hero-photo');
        heroImg.onerror = null;
        heroImg.src = URL.createObjectURL(file);
        matched++;
        return;
      }
      const card = mapByStem[stem];
      if (card) {
        state.sessionPhotos[card.id] = URL.createObjectURL(file);
        state.realPhotoLoaded[card.id] = true;
        matched++;
      }
    });

    if (matched > 0) {
      renderActiveTab();
      updatePhotoCounter();
      showToast(`🎉 Loaded ${matched} real photo${matched === 1 ? '' : 's'} into the vault!`);
      burstConfetti();
    } else {
      showToast('No matching filenames found — check the Photo Setup tab for exact names.');
    }
  }

  // Render active tab
  function renderActiveTab() {
    renderHeroStats();
    updateGHButtonState();
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === state.activeTab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${state.activeTab}`));

    if (state.activeTab === 'hope') {
      const wrap = document.getElementById('hope-displays-wrap');
      wrap.innerHTML = '';
      renderDisplaySection(wrap, 1);
      renderDisplaySection(wrap, 2);
    } else if (state.activeTab === 'chrome') {
      const wrap = document.getElementById('chrome-displays-wrap');
      wrap.innerHTML = '';
      renderDisplaySection(wrap, 3);
      renderDisplaySection(wrap, 4);
    } else if (state.activeTab === 'neon') {
      const wrap = document.getElementById('neon-displays-wrap');
      wrap.innerHTML = '';
      renderDisplaySection(wrap, 5);
    } else if (state.activeTab === 'explorer') {
      renderExplorer();
    } else if (state.activeTab === 'sets') {
      renderSetsTab();
    } else if (state.activeTab === 'guide') {
      renderGuideTab();
    }
  }

  // Confetti Celebration
  function burstConfetti() {
    const canvas = document.getElementById('confetti-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ['#ec4899', '#facc15', '#06b6d4', '#8b5cf6', '#22c55e', '#f97316'];
    const particles = Array.from({ length: 110 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * 140,
      vx: (Math.random() - 0.5) * 7,
      vy: 3 + Math.random() * 5.5,
      size: 6 + Math.random() * 7,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.25,
      color: colors[Math.floor(Math.random() * colors.length)],
      shape: Math.random() > 0.5 ? 'rect' : 'star'
    }));
    let frame = 0;
    function tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.08;
        p.rot += p.vrot;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === 'rect') ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.65);
        else { ctx.beginPath(); ctx.arc(0, 0, p.size * 0.45, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      });
      frame++;
      if (frame < 130) requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    tick();
  }

  // CSV Download
  function downloadCSV() {
    const header = ['Display','Slot','Owner','Set','CardNum','Character','Parallel','Serial','Grade','EstLowGBP','EstHighGBP','Folder','ExactFilenameToSave'];
    const rows = CARDS.map(c => [
      `Display ${c.display}`, c.slot, c.owner, c.set, c.cardNum, c.character, c.parallel,
      c.serial, c.grade || 'Raw', c.valLow, c.valHigh, `assets/cards/${c.folder}/`, `${c.baseFilename}.jpg`
    ]);
    const csvText = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kandy-and-hope-card-filenames.csv';
    a.click();
  }

  // Boot & Event Wiring
  document.addEventListener('DOMContentLoaded', () => {
    initHeroPhoto();
    updateGHButtonState();

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => { state.activeTab = btn.dataset.tab; renderActiveTab(); });
    });

    // Valuation toggle
    document.querySelectorAll('.val-toggle button').forEach(btn => {
      btn.addEventListener('click', () => { state.valMode = btn.dataset.mode; renderActiveTab(); });
    });

    // Theme switcher
    document.getElementById('theme-toggle').addEventListener('click', (e) => {
      document.body.classList.toggle('dark-vault');
      const isDark = document.body.classList.contains('dark-vault');
      e.currentTarget.textContent = isDark ? '🌈 Bubble Pop Mode' : '🌙 Dark Vault Mode';
    });

    // Sparkle button
    document.getElementById('sparkle-btn').addEventListener('click', () => {
      burstConfetti();
      showToast('✨ Boom! Hope & Kandy Rainbow Sparkle Mode!');
    });

    // Folder batch loader
    const folderInput = document.getElementById('folder-upload-input');
    document.getElementById('load-folder-btn').addEventListener('click', () => folderInput.click());
    document.getElementById('guide-folder-btn').addEventListener('click', () => folderInput.click());
    folderInput.addEventListener('change', (e) => handleFolderUpload(e.target.files));

    // Explorer Filters
    document.getElementById('f-search').addEventListener('input', e => { state.filters.search = e.target.value; renderExplorer(); });
    document.getElementById('f-owner').addEventListener('change', e => { state.filters.owner = e.target.value; renderExplorer(); });
    document.getElementById('f-display').addEventListener('change', e => { state.filters.display = e.target.value; renderExplorer(); });
    document.getElementById('f-set').addEventListener('change', e => { state.filters.set = e.target.value; renderExplorer(); });
    document.getElementById('f-sort').addEventListener('change', e => { state.filters.sort = e.target.value; renderExplorer(); });

    document.querySelectorAll('.qtag').forEach(btn => {
      btn.addEventListener('click', () => {
        state.filters.quickTag = btn.dataset.qtag;
        document.querySelectorAll('.qtag').forEach(b => b.classList.toggle('active', b === btn));
        renderExplorer();
      });
    });

    // Guide tab filters & CSV
    document.getElementById('guide-display-filter').addEventListener('change', e => { state.guideFilter = e.target.value; renderGuideTab(); });
    document.getElementById('guide-search').addEventListener('input', e => { state.guideSearch = e.target.value; renderGuideTab(); });
    document.getElementById('download-csv-btn').addEventListener('click', downloadCSV);

    // GitHub Sync Modal controls
    document.getElementById('gh-settings-btn').addEventListener('click', () => openGHModal());
    document.getElementById('guide-gh-btn').addEventListener('click', () => openGHModal());
    document.getElementById('gh-close-btn').addEventListener('click', closeGHModal);
    document.getElementById('gh-modal').addEventListener('click', (e) => { if (e.target.id === 'gh-modal') closeGHModal(); });

    document.getElementById('gh-save-btn').addEventListener('click', async () => {
      const owner = document.getElementById('gh-owner').value.trim();
      const repo = document.getElementById('gh-repo').value.trim();
      const branch = document.getElementById('gh-branch').value.trim() || 'main';
      const token = document.getElementById('gh-token').value.trim();
      const st = document.getElementById('gh-test-status');

      if (!owner || !repo || !token) {
        st.textContent = 'Please enter Username, Repository Name, and Token.';
        st.className = 'upload-status err';
        return;
      }

      st.textContent = '⏳ Testing connection to GitHub...';
      st.className = 'upload-status';
      try {
        const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || `HTTP ${res.status}`);
        }
        const repoData = await res.json();
        if (repoData.permissions && repoData.permissions.push === false) {
          throw new Error('Token connected, but lacks Contents Read & Write permission.');
        }
        state.gh = { owner, repo, branch, token };
        saveGHConfig(state.gh);
        updateGHButtonState();
        st.textContent = `✅ Connected to ${owner}/${repo} (${branch})! You can now save photos directly to GitHub.`;
        st.className = 'upload-status ok';
        showToast('✅ GitHub Direct Upload connected!');
        setTimeout(() => closeGHModal(), 1100);
      } catch (err) {
        st.textContent = `❌ Connection failed: ${err.message}`;
        st.className = 'upload-status err';
      }
    });

    document.getElementById('gh-clear-btn').addEventListener('click', () => {
      state.gh.token = '';
      saveGHConfig(state.gh);
      document.getElementById('gh-token').value = '';
      updateGHButtonState();
      const st = document.getElementById('gh-test-status');
      st.textContent = 'Token cleared from this browser.';
      st.className = 'upload-status';
      showToast('GitHub token disconnected.');
    });

    // Card Modal controls
    document.getElementById('modal-close-btn').addEventListener('click', closeCardModal);
    document.getElementById('card-modal').addEventListener('click', (e) => { if (e.target.id === 'card-modal') closeCardModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeCardModal(); closeGHModal(); }
    });

    document.getElementById('modal-copy-btn').addEventListener('click', () => {
      if (!currentModalCard) return;
      const fn = `${currentModalCard.baseFilename}.jpg`;
      navigator.clipboard?.writeText(fn);
      showToast(`Copied filename: ${fn}`);
    });

    // 1) Choose Photo (Native Android Google Photos picker on phone / file picker on PC)
    document.getElementById('modal-choose-btn').addEventListener('click', () => {
      document.getElementById('modal-photo-input').click();
    });
    document.getElementById('modal-photo-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) stageCardPhotoBlob(file);
      e.target.value = '';
    });

    // 2) Paste from Google Photos button + Ctrl+V global listener when card modal is open
    document.getElementById('modal-paste-btn').addEventListener('click', async () => {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        showToast('Press Ctrl+V on your keyboard to paste the copied photo!');
        return;
      }
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imgType = item.types.find(t => t.startsWith('image/'));
          if (imgType) {
            const blob = await item.getType(imgType);
            await stageCardPhotoBlob(blob);
            return;
          }
        }
        showToast('No image found on clipboard — right-click a photo in Google Photos and click "Copy image" first!');
      } catch (_) {
        showToast('Tip: Press Ctrl+V on your keyboard to paste your copied Google Photos image!');
      }
    });

    window.addEventListener('paste', (e) => {
      if (!document.getElementById('card-modal').classList.contains('open')) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            stageCardPhotoBlob(blob);
            return;
          }
        }
      }
    });

    // 3) Drag & Drop onto Photo Studio or Card Preview
    ['photo-studio-zone', 'modal-drop-preview'].forEach(elId => {
      const zone = document.getElementById(elId);
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        document.getElementById('photo-studio-zone').classList.add('drag-over');
      });
      zone.addEventListener('dragleave', () => {
        document.getElementById('photo-studio-zone').classList.remove('drag-over');
      });
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        document.getElementById('photo-studio-zone').classList.remove('drag-over');
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) stageCardPhotoBlob(file);
      });
    });

    // Re-encode if user toggles "Optimise for fast web JPEG"
    document.getElementById('opt-web-jpeg').addEventListener('change', () => {
      if (state.stagedCardPhoto && state.stagedCardPhoto.rawBlob) {
        stageCardPhotoBlob(state.stagedCardPhoto.rawBlob);
      }
    });

    // Cancel staged preview
    document.getElementById('modal-cancel-stage-btn').addEventListener('click', () => {
      clearStagedCardPhoto(true);
    });

    // Save Staged Photo Directly to GitHub (overwriting old photo)
    document.getElementById('modal-save-gh-btn').addEventListener('click', async () => {
      if (!currentModalCard || !state.stagedCardPhoto) return;
      if (!state.gh.token) {
        openGHModal('Paste your GitHub Personal Access Token once to enable direct saving to GitHub!');
        return;
      }

      const btn = document.getElementById('modal-save-gh-btn');
      const statusEl = document.getElementById('modal-upload-status');
      btn.disabled = true;
      btn.textContent = '⏳ Uploading to GitHub...';
      statusEl.textContent = `Committing ${currentModalCard.recommendedPath} to GitHub...`;
      statusEl.className = 'upload-status';

      try {
        await uploadToGitHub(
          currentModalCard.recommendedPath,
          state.stagedCardPhoto.outBase64,
          `Update card photo: ${currentModalCard.character} (${currentModalCard.slot} ${currentModalCard.serial})`
        );

        // Immediately show the new real photo in the live UI
        const keepUrl = URL.createObjectURL(state.stagedCardPhoto.outBlob);
        state.sessionPhotos[currentModalCard.id] = keepUrl;
        state.realPhotoLoaded[currentModalCard.id] = true;
        markRecentUpload(currentModalCard.recommendedPath);
        state.recentUploads = loadRecentUploads();

        document.getElementById('modal-img').src = keepUrl;
        renderActiveTab();
        updatePhotoCounter();

        statusEl.textContent = '✅ Saved to GitHub! Your live site updates automatically in ~45 seconds.';
        statusEl.className = 'upload-status ok';
        showToast(`☁️ Saved ${currentModalCard.character} to GitHub!`);
        burstConfetti();

        // Hide staged actions cleanly after brief confirmation
        setTimeout(() => {
          if (state.stagedCardPhoto && state.stagedCardPhoto.previewUrl) {
            URL.revokeObjectURL(state.stagedCardPhoto.previewUrl);
          }
          state.stagedCardPhoto = null;
          document.getElementById('staged-panel').classList.remove('visible');
        }, 1800);
      } catch (err) {
        statusEl.textContent = `❌ Upload failed: ${err.message}`;
        statusEl.className = 'upload-status err';
      } finally {
        btn.disabled = false;
        btn.textContent = '☁️ Confirm & Save to GitHub';
      }
    });

    // Save Staged Photo Locally with Exact Auto-Renamed Filename
    document.getElementById('modal-save-local-btn').addEventListener('click', async () => {
      if (!currentModalCard || !state.stagedCardPhoto) return;
      const exactFilename = `${currentModalCard.baseFilename}.jpg`;
      const statusEl = document.getElementById('modal-upload-status');
      try {
        const res = await saveBlobLocally(state.stagedCardPhoto.outBlob, exactFilename);
        if (res === 'cancelled') return;

        const keepUrl = URL.createObjectURL(state.stagedCardPhoto.outBlob);
        state.sessionPhotos[currentModalCard.id] = keepUrl;
        state.realPhotoLoaded[currentModalCard.id] = true;
        document.getElementById('modal-img').src = keepUrl;
        renderActiveTab();
        updatePhotoCounter();

        statusEl.textContent = `💾 Saved locally as ${exactFilename}! (Put in assets/cards/${currentModalCard.folder}/)`;
        statusEl.className = 'upload-status ok';
        showToast(`💾 Saved as ${exactFilename}`);
      } catch (err) {
        statusEl.textContent = `❌ Local save failed: ${err.message}`;
        statusEl.className = 'upload-status err';
      }
    });

    renderActiveTab();
  });
})();
