(function () {
  const CARDS = window.VAULT_CARDS || [];
  const DISPLAYS = window.VAULT_DISPLAYS || [];
  const SETS = window.VAULT_SETS || [];
  const ODDS = window.VAULT_ODDS || [];
  const CHASES = window.VAULT_CHASES || [];

  const GH_STORAGE_KEY = 'kh_vault_gh_config_v1';
  const RECENT_UPLOADS_KEY = 'kh_vault_recent_uploads_v1';
  const STATUS_STORAGE_KEY = 'kh_vault_card_status_v1';

  const CHROME_INSERT_DISPLAYS = DISPLAYS.filter(d => d.isChromeInsert);
  const CHROME_INSERT_IDS = new Set(CHROME_INSERT_DISPLAYS.map(d => d.id));
  const NEON_INSERT_DISPLAYS = DISPLAYS.filter(d => d.isNeonInsert);
  const NEON_INSERT_IDS = new Set(NEON_INSERT_DISPLAYS.map(d => d.id));
  const ALL_INSERT_IDS = new Set([...CHROME_INSERT_IDS, ...NEON_INSERT_IDS]);

  function loadGHConfig() {
    try {
      const raw = localStorage.getItem(GH_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { owner: 'devkss', repo: 'kandy-and-hope-marvel-vault', branch: 'main', token: '', hasWrite: false };
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

  function loadLocalStatusOverrides() {
    try { return JSON.parse(localStorage.getItem(STATUS_STORAGE_KEY) || '{}'); } catch (_) { return {}; }
  }

  function saveLocalStatusOverrides(map) {
    try { localStorage.setItem(STATUS_STORAGE_KEY, JSON.stringify(map)); } catch (_) {}
  }

  // Default section status filters:
  // - Hope's Moon Girl (1) & Devil Dinosaur (2): default to 'owned'
  // - Kandy's collapsible Chrome Insert subsets (101..129): default to 'owned'
  const defaultStatusFilters = { 1: 'owned', 2: 'owned' };
  CHROME_INSERT_DISPLAYS.forEach(d => { defaultStatusFilters[d.id] = 'owned'; });
  NEON_INSERT_DISPLAYS.forEach(d => { defaultStatusFilters[d.id] = 'owned'; });

  const state = {
    activeTab: 'hope',
    valMode: 'mid',           // 'low' | 'mid' | 'high' (used exclusively on Estimated Values tab)
    valOwnerFilter: 'all',    // 'all' (Together - default) | 'Kandy' | 'Hope'
    valSearch: '',
    sectionSort: {},          // displayId -> 'rarity' | 'name' (Hope always locked to 'rarity')
    sectionStatusFilter: defaultStatusFilters,
    expandedInserts: {},      // displayId -> true/false (all collapsed by default)
    chromeInsertFilter: 'all',// 'all' | 'with-owned'
    neonInsertFilter: 'all',  // 'all' | 'with-owned'
    statusOverrides: loadLocalStatusOverrides(),
    sessionPhotos: {},
    realPhotoLoaded: {},
    recentUploads: loadRecentUploads(),
    gh: loadGHConfig(),
    stagedCardPhoto: null,
    stagedHeroPhoto: null,
    filters: {
      search: '',
      owner: 'all',
      display: 'all',
      set: 'all',
      sort: 'rarity',
      quickTag: 'all'
    }
  };

  // ==========================================================================
  // EFFECTIVE CARD ACCESSORS (MERGING BASE DATA + STATUS OVERRIDES)
  // ==========================================================================
  function getCardOverride(c) {
    return state.statusOverrides[c.id] || null;
  }

  function isCardMissing(c) {
    const ov = getCardOverride(c);
    if (ov && typeof ov.missing === 'boolean') return ov.missing;
    return Boolean(c.missing);
  }

  function getCardSerial(c) {
    const ov = getCardOverride(c);
    if (ov && typeof ov.serial === 'string' && ov.serial.trim() !== '') return ov.serial.trim();
    if (isCardMissing(c)) return c.printRun ? `/${c.printRun}` : 'Unnumbered';
    return c.serial;
  }

  function getCardValBounds(c) {
    if (isCardMissing(c)) return { low: 0, high: 0 };
    const ov = getCardOverride(c);
    if (ov && typeof ov.valLow === 'number' && typeof ov.valHigh === 'number') {
      return { low: ov.valLow, high: ov.valHigh };
    }
    return { low: c.valLow || 0, high: c.valHigh || 0 };
  }

  const fmtGBP = (n) => '£' + Math.round(n).toLocaleString('en-GB');
  const fmtKB = (bytes) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

  const cardVal = (c, mode = state.valMode) => {
    const { low, high } = getCardValBounds(c);
    if (mode === 'low') return low;
    if (mode === 'high') return high;
    return Math.round((low + high) / 2);
  };
  const sumVals = (list, mode = state.valMode) => list.reduce((acc, c) => acc + cardVal(c, mode), 0);

  // Pull live js/collection-status.json on boot so status updates saved to GitHub sync across devices
  async function loadRemoteStatusOverrides() {
    try {
      const res = await fetch(`js/collection-status.json?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const remote = await res.json();
      if (!remote || typeof remote !== 'object') return;
      const merged = { ...remote };
      Object.keys(state.statusOverrides).forEach(id => {
        const loc = state.statusOverrides[id];
        const rem = remote[id];
        if (!rem || (loc.updatedAt || 0) >= (rem.updatedAt || 0)) {
          merged[id] = loc;
        }
      });
      state.statusOverrides = merged;
      saveLocalStatusOverrides(merged);
      renderActiveTab();
    } catch (_) {
      // Offline / file:// open — keep localStorage overrides
    }
  }

  // ==========================================================================
  // SMART SORTING (PULL RARITY / CHECKLIST POSITION / NAME / VALUE [VALUES TAB])
  // ==========================================================================
  function parseSerialNum(serial) {
    if (!serial || String(serial).toLowerCase() === 'unnumbered') return 999999;
    const m = String(serial).match(/^(\d+)\s*\//);
    return m ? parseInt(m[1], 10) : 999999;
  }

  function compareNaturalCardNum(aNum, bNum) {
    return String(aNum || '').localeCompare(String(bNum || ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  function getRarityTier(c) {
    if (c.printRun !== null && c.printRun !== undefined) return c.printRun;
    const sub = (c.subset || '').toLowerCase();
    const par = (c.parallel || '').toLowerCase();
    const tags = (c.tags || []).map(t => t.toLowerCase());
    if (sub.includes('autograph') || tags.includes('autograph')) return 1000;
    if (tags.includes('case hit')) return 1010;
    if (sub.includes('classic comic')) return 1020;
    if (sub.includes('neon variation') || par.includes('etch')) return 1030;
    if (tags.includes('insert') || ALL_INSERT_IDS.has(c.display)) return 1040;
    if (sub === 'base' || par === 'base card') return 1060;
    return 1050;
  }

  // Exact sub-order within the same 'Numbered to' (same colour):
  // RayWave -> Storm -> X-Fractor -> Shimmer -> Lazer -> Wave -> Base
  function getFinishRank(c) {
    const par = (c.parallel || '').toLowerCase();
    const sub = (c.subset || '').toLowerCase();

    if (par.includes('clawed')) return 0.1;
    if (sub.includes('facsimile autograph')) return 0.2;
    if (sub.includes('artist autograph')) return 0.3;
    if (ALL_INSERT_IDS.has(c.display) || ['marvel icons', 'future stars', 'fanfare', 'manga madness'].includes(sub)) return 0.4;

    if (par.includes('raywave') || par.includes('ray wave')) return 1;
    if (par.includes('storm') || par.includes('lightning')) return 2;
    if (par.includes('x-fractor') || par.includes('xfractor')) return 3;
    if (par.includes('shimmer')) return 4;
    if (par.includes('lazer') || par.includes('laser')) return 5;
    if (par.includes('wave')) return 6;

    if (par.includes('sparkle')) return 6.2;
    if (par.includes('diamante')) return 6.4;

    if (par.includes('sapphire') || sub.includes('sapphire')) return 8;

    if (par === 'base card') return 7.5;
    return 7;
  }

  function comparePullRarity(a, b) {
    const tierDiff = getRarityTier(a) - getRarityTier(b);
    if (tierDiff !== 0) return tierDiff;

    const finishDiff = getFinishRank(a) - getFinishRank(b);
    if (finishDiff !== 0) return finishDiff;

    if (a.printRun == null && b.printRun == null) {
      if (a.subset !== b.subset) return (a.subset || '').localeCompare(b.subset || '');
      const numDiff = compareNaturalCardNum(a.cardNum, b.cardNum);
      if (numDiff !== 0) return numDiff;
    }

    const serDiff = parseSerialNum(getCardSerial(a)) - parseSerialNum(getCardSerial(b));
    if (serDiff !== 0) return serDiff;

    return (a.character || '').localeCompare(b.character || '');
  }

  function compareChecklistPosition(a, b) {
    const numDiff = compareNaturalCardNum(a.cardNum, b.cardNum);
    if (numDiff !== 0) return numDiff;
    return comparePullRarity(a, b);
  }

  function sortCards(list, sortMode) {
    const copy = [...list];
    if (sortMode === 'checklist') {
      copy.sort(compareChecklistPosition);
    } else if (sortMode === 'val-desc' || sortMode === 'value') {
      copy.sort((a, b) => (cardVal(b) - cardVal(a)) || comparePullRarity(a, b));
    } else if (sortMode === 'alpha' || sortMode === 'name') {
      copy.sort((a, b) => (a.character || '').localeCompare(b.character || '') || comparePullRarity(a, b));
    } else {
      copy.sort(comparePullRarity);
    }
    return copy;
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.remove('show'), 3000);
  }

  // Convert any image Blob/File into an optimised crisp web JPEG
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

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  // Upload/Overwrite a file directly in GitHub via REST Contents API
  async function uploadToGitHub(repoFilePath, base64Content, commitMessage) {
    const { owner, repo, branch, token } = state.gh;
    if (!token || !owner || !repo) throw new Error('NOT_CONFIGURED');

    const encodedPath = repoFilePath.split('/').map(encodeURIComponent).join('/');
    const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
    const headers = {
      'Authorization': `Bearer ${token.trim()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    let existingSha = null;
    const checkRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch || 'main')}`, { headers });
    if (checkRes.status === 200) {
      const existingData = await checkRes.json();
      existingSha = existingData.sha || null;
    } else if (checkRes.status !== 404) {
      const errBody = await checkRes.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub check failed (${checkRes.status})`);
    }

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

  async function saveStatusOverridesToGitHub(commitMsg) {
    const jsonText = JSON.stringify(state.statusOverrides, null, 2) + '\n';
    return await uploadToGitHub('js/collection-status.json', utf8ToBase64(jsonText), commitMsg);
  }

  // Save Blob locally with exact required filename
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

  function hasGitHubEditPermissions() {
    return Boolean(
      state.gh &&
      typeof state.gh.token === 'string' &&
      state.gh.token.trim().length > 0 &&
      state.gh.owner &&
      state.gh.repo &&
      state.gh.hasWrite !== false
    );
  }

  function updateModalPermissionsUI() {
    const canEdit = hasGitHubEditPermissions();
    const modalBox = document.querySelector('#card-modal .modal-box');
    const statusStudio = document.getElementById('modal-status-studio');
    const photoStudio = document.getElementById('photo-studio-zone');
    if (statusStudio) statusStudio.hidden = !canEdit;
    if (photoStudio) photoStudio.hidden = !canEdit;
    if (modalBox) modalBox.classList.toggle('modal-readonly', !canEdit);
  }

  function updateGHButtonState() {
    const btn = document.getElementById('gh-settings-btn');
    const connected = hasGitHubEditPermissions();
    if (btn) {
      btn.textContent = connected ? '✅ GitHub Connected' : '☁️ GitHub Sync';
      btn.classList.toggle('btn-github-connected', connected);
      btn.classList.toggle('btn-soft', !connected);
    }
    updateModalPermissionsUI();
  }

  // Silently re-verify stored GitHub token permissions on startup (handles revoked/read-only tokens)
  async function verifyStoredGitHubPermissions() {
    if (!state.gh || !state.gh.token || !state.gh.owner || !state.gh.repo) {
      if (state.gh && state.gh.hasWrite) {
        state.gh.hasWrite = false;
        saveGHConfig(state.gh);
      }
      updateGHButtonState();
      return;
    }
    try {
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(state.gh.owner)}/${encodeURIComponent(state.gh.repo)}`,
        {
          headers: {
            'Authorization': `Bearer ${state.gh.token.trim()}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      );
      if (res.ok) {
        const repoData = await res.json();
        const canPush = !(repoData.permissions && repoData.permissions.push === false);
        state.gh.hasWrite = canPush;
        saveGHConfig(state.gh);
        updateGHButtonState();
      } else if (res.status === 401 || res.status === 403 || res.status === 404) {
        state.gh.hasWrite = false;
        saveGHConfig(state.gh);
        updateGHButtonState();
      }
    } catch (_) {
      // Offline / transient network error — keep existing verified local state
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

    document.getElementById('hero-photo-input').addEventListener('change', (e) => {
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
        if (res !== 'cancelled') showToast('💾 Saved locally as kandy-and-hope.jpg!');
      } catch (err) {
        showToast(`Save error: ${err.message}`);
      }
    });
  }

  // Update Hero KPI Stats & Tab Counts dynamically (ZERO money references!)
  function renderHeroStats() {
    const ownedCards = CARDS.filter(c => !isCardMissing(c));
    const missingCards = CARDS.filter(c => isCardMissing(c));
    const hopeOwned = ownedCards.filter(c => c.owner === 'Hope');
    const kandyOwned = ownedCards.filter(c => c.owner === 'Kandy');
    const kandyChromeOwned = kandyOwned.filter(c => c.display === 3 || CHROME_INSERT_IDS.has(c.display));
    const kandyNeonOwned = kandyOwned.filter(c => c.display === 5 || NEON_INSERT_IDS.has(c.display));
    const ace10 = ownedCards.filter(c => c.grade && c.grade.includes('10')).length;
    const ace9 = ownedCards.filter(c => c.grade && c.grade.includes('9')).length;
    const ultraRare = ownedCards.filter(c => (c.printRun && c.printRun <= 10) || c.tags.includes('Case Hit')).length;

    document.getElementById('stat-total-cards').textContent = ownedCards.length;
    document.getElementById('stat-total-sub').textContent = `${hopeOwned.length} Hope · ${kandyOwned.length} Kandy (+${missingCards.length} tracked)`;
    document.getElementById('stat-slabs').textContent = ace10 + ace9;
    document.getElementById('stat-slabs-sub').textContent = `${ace10}× ACE 10 · ${ace9}× ACE 9`;
    document.getElementById('stat-ultra').textContent = ultraRare;

    const hopeTabBtn = document.getElementById('tab-btn-hope');
    if (hopeTabBtn) hopeTabBtn.textContent = `🌈 Hope's Rainbow Room (${hopeOwned.length})`;

    const chromeTabBtn = document.getElementById('tab-btn-chrome');
    if (chromeTabBtn) chromeTabBtn.textContent = `🏆 Kandy's Chrome Vault (${kandyChromeOwned.length})`;

    const neonTabBtn = document.getElementById('tab-btn-neon');
    if (neonTabBtn) neonTabBtn.textContent = `⚡ Kandy's Neon Vault (${kandyNeonOwned.length})`;
  }

  // Smart Image Resolver per Card
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
    const fallbackUrl = isCardMissing(card) ? 'assets/cards/missing-card-icon.svg' : card.placeholderSvg;

    const candidates = [
      { url: `${base}.jpg${qs}`, isReal: true },
      { url: `${base}.jpeg`, isReal: true },
      { url: `${base}.png`, isReal: true },
      { url: `${base}.webp`, isReal: true },
      { url: fallbackUrl, isReal: false }
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
    const ownedIds = new Set(CARDS.filter(c => !isCardMissing(c)).map(c => c.id));
    const realCount = Object.entries(state.realPhotoLoaded).filter(([id, ok]) => ok && ownedIds.has(id)).length;
    const badge = document.getElementById('photo-progress-badge');
    if (badge) badge.textContent = `${realCount} / ${ownedIds.size} Real Photos Loaded`;
  }

  // Create a Uniform-Height, Bottom-Aligned 3D Holographic Card Tile (ZERO Money Values!)
  function createCardTile(card) {
    const missing = isCardMissing(card);
    const serial = getCardSerial(card);

    const tile = document.createElement('div');
    tile.className = 'card-tile' +
      (card.orientation === 'landscape' ? ' landscape' : '') +
      (missing ? ' is-missing' : '');
    tile.dataset.cardId = card.id;

    const isSlab = !missing && Boolean(card.grade);
    const slabTier = isSlab ? (card.grade.includes('10') ? 'ace-10' : 'ace-9') : '';
    const slabClass = isSlab ? `is-slab ${slabTier}` : '';

    const cornerBadgeHTML = missing
      ? '<span class="missing-badge">MISSING</span>'
      : (isSlab ? `
          <span class="ace-floating-badge ${slabTier}">
            <span>ACE</span>
            <span class="grade-num">${card.grade.includes('10') ? '10' : '9'}</span>
          </span>` : '');

    const specialEmoji = missing ? '' :
                         card.tags.includes('Alpha #1') ? '🥇 ' :
                         card.tags.includes('Bookend') ? '👑 ' :
                         card.tags.includes('Case Hit') ? '⚡ ' :
                         card.tags.includes('Autograph') ? '✍️ ' : '';

    const isNumbered = serial !== 'Unnumbered';
    const cardNumberLeft = card.cardNum || card.slot;
    const numberedRight = isNumbered ? serial : 'Unnumbered';
    const rightChipClasses = [
      'serial-chip',
      !isNumbered ? 'serial-unnumbered' : '',
      missing ? 'serial-missing' : ''
    ].filter(Boolean).join(' ');

    const subtitleLine = (card.artist && !card.parallel.includes(card.artist) && card.character !== card.artist)
      ? `${card.parallel} · ${card.artist}`
      : card.parallel;

    tile.innerHTML = `
      <div class="card-stage">
        <div class="card-3d ${slabClass}">
          <div class="card-img-wrap">
            ${cornerBadgeHTML}
            <span class="real-photo-dot">✓ Photo</span>
            <img alt="${card.character} - ${card.parallel}" loading="lazy"/>
            <div class="holo-glare"></div>
          </div>
        </div>
      </div>
      <div class="card-caption">
        <div class="card-char" title="${card.character}">${specialEmoji}${card.character}</div>
        <div class="card-par" title="${subtitleLine}">${subtitleLine}</div>
        <div class="card-meta-row">
          <span class="card-num-chip" title="Card ${cardNumberLeft}">${cardNumberLeft}</span>
          <span class="${rightChipClasses}" title="${numberedRight}">${numberedRight}</span>
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

    tile.addEventListener('click', () => openCardModal(card, false));
    return tile;
  }

  // Render Standard Display Section (Hope Displays 1, 2, 6 + Kandy Base Numbered 3 + Kandy Neon 5)
  function renderDisplaySection(container, displayId) {
    const meta = DISPLAYS.find(d => d.id === displayId);
    const isHopeSection = meta.owner === 'Hope';
    // On Hope's section: locked strictly to Pull Rarity with no sort-by control!
    const sortMode = isHopeSection ? 'rarity' : (state.sectionSort[displayId] || 'rarity');

    const allSectionCards = CARDS.filter(c => c.display === displayId);
    const ownedSectionCards = allSectionCards.filter(c => !isCardMissing(c));
    const missingSectionCards = allSectionCards.filter(c => isCardMissing(c));

    const isRainbowDisplay = displayId === 1 || displayId === 2;
    const statusFilter = isRainbowDisplay ? (state.sectionStatusFilter[displayId] || 'owned') : 'all';

    let visibleCards = allSectionCards;
    if (statusFilter === 'owned') visibleCards = ownedSectionCards;
    else if (statusFilter === 'missing') visibleCards = missingSectionCards;

    const sortedCards = sortCards(visibleCards, sortMode);

    const sec = document.createElement('section');
    sec.className = 'display-section';

    let rainbowBar = '';
    if (isRainbowDisplay) {
      const allUnique = new Set(allSectionCards.map(c => c.parallel)).size;
      const ownedUnique = new Set(ownedSectionCards.map(c => c.parallel)).size;
      const missingUnique = Math.max(0, allUnique - ownedUnique);
      const pct = Math.min(100, Math.round((ownedUnique / Math.max(1, allUnique)) * 100));
      rainbowBar = `
        <div class="rainbow-bar-box">
          <div class="rainbow-bar-top">
            <span>🌈 ${meta.shortTitle} Progress — ${ownedUnique} of ${allUnique} Unique 2026 Chrome Parallels Collected (${missingUnique} Missing)</span>
            <span>${pct}% Complete</span>
          </div>
          <div class="rainbow-track"><div class="rainbow-fill" style="width:${pct}%"></div></div>
        </div>`;
    }

    const statusFilterHTML = isRainbowDisplay ? `
      <div class="sort-controls">
        <span class="sort-label">Show:</span>
        <div class="segmented">
          <button class="${statusFilter === 'owned' ? 'active' : ''}" data-sfilter="owned">Owned (${ownedSectionCards.length})</button>
          <button class="${statusFilter === 'all' ? 'active' : ''}" data-sfilter="all">All (${allSectionCards.length})</button>
          <button class="${statusFilter === 'missing' ? 'active' : ''}" data-sfilter="missing">Missing (${missingSectionCards.length})</button>
        </div>
      </div>` : '';

    // Sort controls ONLY on Kandy's sections (Pull Rarity & Name — no Value, and removed on Hope's sections)
    const sortControlHTML = !isHopeSection ? `
      <div class="sort-controls">
        <span class="sort-label">Sort by:</span>
        <div class="segmented">
          <button class="${sortMode === 'rarity' ? 'active' : ''}" data-sort="rarity">🎯 Pull Rarity</button>
          <button class="${sortMode === 'name' ? 'active' : ''}" data-sort="name">🔤 Name</button>
        </div>
      </div>` : '';

    const countBadgeText = isRainbowDisplay
      ? `${ownedSectionCards.length} Owned · ${missingSectionCards.length} Missing`
      : `${ownedSectionCards.length} Cards`;

    sec.innerHTML = `
      <div class="display-header">
        <div class="display-title-group">
          <h2>${meta.title}</h2>
          <p>${meta.subtitle}</p>
        </div>
        <div class="display-badges">
          <span class="pill ${meta.owner === 'Hope' ? 'pill-pink' : 'pill-cyan'}">${countBadgeText}</span>
        </div>
      </div>
      ${rainbowBar}
      <div class="view-bar">
        <span style="font-size:0.84rem;color:var(--text-muted);font-weight:600;">💡 ${meta.extraNote}</span>
        <div class="section-toolbar">
          ${statusFilterHTML}
          ${sortControlHTML}
        </div>
      </div>
      <div class="display-body"></div>
    `;

    sec.querySelectorAll('.segmented button[data-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.sectionSort[displayId] = btn.dataset.sort;
        renderActiveTab();
      });
    });

    sec.querySelectorAll('.segmented button[data-sfilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.sectionStatusFilter[displayId] = btn.dataset.sfilter;
        renderActiveTab();
      });
    });

    const body = sec.querySelector('.display-body');

    if (meta.groupedBySetAndChar) {
      const setOrder = ['2026 Topps Chrome Marvel Sapphire', '2026 Topps Neon Marvel'];
      const charOrder = ['Moon Girl', 'Devil Dinosaur'];
      const groupsMap = new Map();

      sortedCards.forEach(c => {
        const key = `${c.set}|||${c.character}`;
        if (!groupsMap.has(key)) groupsMap.set(key, { set: c.set, character: c.character, cards: [] });
        groupsMap.get(key).cards.push(c);
      });

      const orderedGroups = [...groupsMap.values()].sort((a, b) => {
        const sa = setOrder.indexOf(a.set);
        const sb = setOrder.indexOf(b.set);
        if (sa !== sb) return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb);
        const ca = charOrder.indexOf(a.character);
        const cb = charOrder.indexOf(b.character);
        if (ca !== cb) return (ca === -1 ? 99 : ca) - (cb === -1 ? 99 : cb);
        return a.character.localeCompare(b.character);
      });

      orderedGroups.forEach(grp => {
        const grpWrap = document.createElement('div');
        grpWrap.className = 'set-char-group';
        const isSapphire = grp.set.toLowerCase().includes('sapphire');
        grpWrap.innerHTML = `
          <div class="set-char-header">
            <div class="set-char-title">
              <span class="pill ${isSapphire ? 'pill-cyan' : 'pill-pink'}">${grp.set}</span>
              <span>${grp.character}</span>
            </div>
            <div class="display-badges">
              <span class="pill">${grp.cards.length} Card${grp.cards.length === 1 ? '' : 's'}</span>
            </div>
          </div>
          <div class="cards-grid"></div>
        `;
        const grid = grpWrap.querySelector('.cards-grid');
        sortCards(grp.cards, 'rarity').forEach(c => grid.appendChild(createCardTile(c)));
        body.appendChild(grpWrap);
      });
    } else {
      const grid = document.createElement('div');
      grid.className = 'cards-grid';
      if (!sortedCards.length) {
        grid.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-weight:700;">No cards in this filter view.</div>';
      } else {
        sortedCards.forEach(c => grid.appendChild(createCardTile(c)));
      }
      body.appendChild(grid);
    }

    container.appendChild(sec);
  }

  // ==========================================================================
  // KANDY'S COLLAPSIBLE CHROME INSERT SECTIONS
  // - Default to Owned cards
  // - When All is selected, show cards in their exact proper checklist positions!
  // ==========================================================================
  function populateAccordionBody(bodyEl, meta) {
    const displayId = meta.id;
    const allSectionCards = CARDS.filter(c => c.display === displayId);
    const ownedSectionCards = allSectionCards.filter(c => !isCardMissing(c));
    const missingSectionCards = allSectionCards.filter(c => isCardMissing(c));
    const sortMode = state.sectionSort[displayId] || 'rarity';
    const statusFilter = state.sectionStatusFilter[displayId] || 'owned';

    let visibleCards = ownedSectionCards;
    if (statusFilter === 'all') visibleCards = allSectionCards;
    else if (statusFilter === 'missing') visibleCards = missingSectionCards;

    // When 'All' or 'Missing' is selected and default order is active -> exact checklist positions!
    const effectiveSort = (sortMode === 'name')
      ? 'name'
      : (statusFilter === 'owned' ? 'rarity' : 'checklist');

    const sortedCards = sortCards(visibleCards, effectiveSort);
    const pct = Math.min(100, Math.round((ownedSectionCards.length / Math.max(1, allSectionCards.length)) * 100));
    const defaultSortLabel = statusFilter === 'owned' ? '🎯 Pull Rarity' : '📋 Checklist Order';

    bodyEl.innerHTML = `
      <div class="rainbow-bar-box" style="margin-top:12px;margin-bottom:16px;">
        <div class="rainbow-bar-top">
          <span>✨ ${meta.title} Progress — ${ownedSectionCards.length} of ${allSectionCards.length} Cards Collected (${missingSectionCards.length} Missing)</span>
          <span>${pct}% Complete</span>
        </div>
        <div class="rainbow-track"><div class="rainbow-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="view-bar">
        <span style="font-size:0.82rem;color:var(--text-muted);font-weight:600;">💡 ${meta.extraNote}</span>
        <div class="section-toolbar">
          <div class="sort-controls">
            <span class="sort-label">Show:</span>
            <div class="segmented">
              <button class="${statusFilter === 'owned' ? 'active' : ''}" data-sfilter="owned">Owned (${ownedSectionCards.length})</button>
              <button class="${statusFilter === 'all' ? 'active' : ''}" data-sfilter="all">All (${allSectionCards.length})</button>
              <button class="${statusFilter === 'missing' ? 'active' : ''}" data-sfilter="missing">Missing (${missingSectionCards.length})</button>
            </div>
          </div>
          <div class="sort-controls">
            <span class="sort-label">Sort by:</span>
            <div class="segmented">
              <button class="${sortMode === 'rarity' ? 'active' : ''}" data-sort="rarity">${defaultSortLabel}</button>
              <button class="${sortMode === 'name' ? 'active' : ''}" data-sort="name">🔤 Name</button>
            </div>
          </div>
        </div>
      </div>
      <div class="accordion-cards-host"></div>
    `;

    bodyEl.querySelectorAll('.segmented button[data-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.sectionSort[displayId] = btn.dataset.sort;
        populateAccordionBody(bodyEl, meta);
      });
    });

    bodyEl.querySelectorAll('.segmented button[data-sfilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.sectionStatusFilter[displayId] = btn.dataset.sfilter;
        populateAccordionBody(bodyEl, meta);
      });
    });

    const host = bodyEl.querySelector('.accordion-cards-host');
    if (!sortedCards.length) {
      if (statusFilter === 'owned') {
        host.innerHTML = `
          <div class="empty-owned-state">
            <span>No cards collected in <strong>${meta.title}</strong> yet. Switch to <strong>All</strong> to browse the full ${allSectionCards.length}-card checklist in proper order.</span>
            <button type="button" class="btn btn-primary" style="padding:7px 14px;font-size:0.8rem;" data-show-all-btn>📋 Show All ${allSectionCards.length} Cards</button>
          </div>`;
        host.querySelector('[data-show-all-btn]').addEventListener('click', () => {
          state.sectionStatusFilter[displayId] = 'all';
          populateAccordionBody(bodyEl, meta);
        });
      } else {
        host.innerHTML = '<div style="padding:20px;color:var(--text-muted);font-weight:700;">No cards match this filter in this insert set.</div>';
      }
    } else {
      const grid = document.createElement('div');
      grid.className = 'cards-grid';
      sortedCards.forEach(c => grid.appendChild(createCardTile(c)));
      host.appendChild(grid);
    }
  }

  function renderVaultWithCollapsibleInserts(container, opts) {
    const {
      baseDisplayId,
      insertDisplays,
      insertIds,
      filterStateKey,
      headingText,
      rerenderFn
    } = opts;

    container.innerHTML = '';

    // 1. Top Section: Base Character Cards (Numbered Only)
    renderDisplaySection(container, baseDisplayId);

    // 2. Insert Sets Master Header & Controls (Zero Money Values!)
    const allInsertCards = CARDS.filter(c => insertIds.has(c.display));
    const ownedInsertCards = allInsertCards.filter(c => !isCardMissing(c));
    const sectionsWithOwned = insertDisplays.filter(d =>
      CARDS.some(c => c.display === d.id && !isCardMissing(c))
    );

    const activeFilter = state[filterStateKey] || 'all';
    const visibleInsertDisplays = activeFilter === 'with-owned'
      ? sectionsWithOwned
      : insertDisplays;

    const masterBar = document.createElement('div');
    masterBar.className = 'inserts-master-bar';
    masterBar.innerHTML = `
      <div class="inserts-master-title">
        <h2>${headingText} (${insertDisplays.length} Sections)</h2>
        <p>${ownedInsertCards.length} of ${allInsertCards.length} checklist cards collected across ${sectionsWithOwned.length} active sets</p>
      </div>
      <div class="inserts-master-actions">
        <div class="segmented">
          <button class="${activeFilter === 'all' ? 'active' : ''}" data-ifilter="all">All Sets (${insertDisplays.length})</button>
          <button class="${activeFilter === 'with-owned' ? 'active' : ''}" data-ifilter="with-owned">With Owned (${sectionsWithOwned.length})</button>
        </div>
        <button type="button" data-expand-all class="btn btn-soft" style="padding:7px 13px;font-size:0.8rem;">⊞ Expand All</button>
        <button type="button" data-collapse-all class="btn btn-soft" style="padding:7px 13px;font-size:0.8rem;">⊟ Collapse All</button>
      </div>
    `;

    masterBar.querySelectorAll('button[data-ifilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        state[filterStateKey] = btn.dataset.ifilter;
        rerenderFn(container);
      });
    });

    masterBar.querySelector('[data-expand-all]').addEventListener('click', () => {
      visibleInsertDisplays.forEach(d => { state.expandedInserts[d.id] = true; });
      rerenderFn(container);
    });

    masterBar.querySelector('[data-collapse-all]').addEventListener('click', () => {
      insertDisplays.forEach(d => { state.expandedInserts[d.id] = false; });
      rerenderFn(container);
    });

    container.appendChild(masterBar);

    // 3. Render Each Collapsible Insert Section (Zero Money Values!)
    visibleInsertDisplays.forEach(meta => {
      const secCards = CARDS.filter(c => c.display === meta.id);
      const ownedCards = secCards.filter(c => !isCardMissing(c));
      const pct = Math.min(100, Math.round((ownedCards.length / Math.max(1, secCards.length)) * 100));
      const isOpen = Boolean(state.expandedInserts[meta.id]);

      const acc = document.createElement('section');
      acc.className = 'insert-accordion' +
        (ownedCards.length > 0 ? ' has-owned' : '') +
        (isOpen ? ' is-open' : '');

      acc.innerHTML = `
        <button type="button" class="accordion-trigger" aria-expanded="${isOpen ? 'true' : 'false'}">
          <div class="accordion-left">
            <span class="accordion-chevron" aria-hidden="true">▸</span>
            <div class="accordion-heading">
              <span class="accordion-title">${meta.title}</span>
              <span class="accordion-sub">${meta.subtitle}</span>
            </div>
          </div>
          <div class="accordion-right">
            <div class="mini-progress-wrap" title="${pct}% complete">
              <div class="mini-progress-track"><div class="mini-progress-fill" style="width:${pct}%"></div></div>
              <span class="mini-progress-pct">${pct}%</span>
            </div>
            <span class="pill ${ownedCards.length > 0 ? 'pill-owned-hit' : 'pill-zero'}">${ownedCards.length} / ${secCards.length} Owned</span>
          </div>
        </button>
        <div class="accordion-body"></div>
      `;

      const trigger = acc.querySelector('.accordion-trigger');
      const bodyEl = acc.querySelector('.accordion-body');

      if (isOpen) {
        populateAccordionBody(bodyEl, meta);
      }

      trigger.addEventListener('click', () => {
        const nowOpen = !state.expandedInserts[meta.id];
        state.expandedInserts[meta.id] = nowOpen;
        acc.classList.toggle('is-open', nowOpen);
        trigger.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
        if (nowOpen && !bodyEl.hasChildNodes()) {
          populateAccordionBody(bodyEl, meta);
        }
      });

      container.appendChild(acc);
    });
  }

  function renderKandyChromeVault(container) {
    renderVaultWithCollapsibleInserts(container, {
      baseDisplayId: 3,
      insertDisplays: CHROME_INSERT_DISPLAYS,
      insertIds: CHROME_INSERT_IDS,
      filterStateKey: 'chromeInsertFilter',
      headingText: '📚 2026 Topps Chrome Marvel Insert Sets',
      rerenderFn: renderKandyChromeVault
    });
  }

  function renderKandyNeonVault(container) {
    renderVaultWithCollapsibleInserts(container, {
      baseDisplayId: 5,
      insertDisplays: NEON_INSERT_DISPLAYS,
      insertIds: NEON_INSERT_IDS,
      filterStateKey: 'neonInsertFilter',
      headingText: '⚡ 2026 Topps Neon Marvel Insert Sets',
      rerenderFn: renderKandyNeonVault
    });
  }

  // Render All-Cards Explorer Tab (Zero Money Values!)
  function renderExplorer() {
    const f = state.filters;
    let list = CARDS.filter(c => {
      const missing = isCardMissing(c);
      if (f.quickTag === 'missing') {
        if (!missing) return false;
      } else {
        if (missing) return false;
      }
      if (f.owner !== 'all' && c.owner !== f.owner) return false;
      if (f.display !== 'all') {
        if (f.display === 'chrome-inserts') {
          if (!CHROME_INSERT_IDS.has(c.display)) return false;
        } else if (f.display === 'neon-inserts') {
          if (!NEON_INSERT_IDS.has(c.display)) return false;
        } else if (String(c.display) !== f.display) {
          return false;
        }
      }
      if (f.set !== 'all' && c.set !== f.set) return false;
      if (f.quickTag !== 'all' && f.quickTag !== 'missing') {
        if (f.quickTag === 'ace' && !c.grade) return false;
        else if (f.quickTag === 'low10' && !(c.printRun && c.printRun <= 10)) return false;
        else if (f.quickTag === 'auto' && !c.tags.includes('Autograph')) return false;
        else if (f.quickTag === 'casehit' && !c.tags.includes('Case Hit')) return false;
        else if (f.quickTag === 'special' && !(c.tags.includes('Alpha #1') || c.tags.includes('Bookend'))) return false;
      }
      if (f.search.trim()) {
        const q = f.search.trim().toLowerCase();
        const hay = `${c.character} ${c.parallel} ${c.set} ${c.cardNum} ${getCardSerial(c)} ${c.artist || ''} ${c.subset} ${c.baseFilename}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list = sortCards(list, f.sort);
    const totalOwned = CARDS.filter(c => !isCardMissing(c)).length;

    document.getElementById('explorer-summary').textContent =
      f.quickTag === 'missing'
        ? `Showing ${list.length} Missing Checklist Slots`
        : `Showing ${list.length} of ${totalOwned} owned cards`;

    const grid = document.getElementById('explorer-grid');
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = '<div style="padding:36px;text-align:center;color:var(--text-muted);font-weight:700;">No cards match those filters—try clearing your search!</div>';
      return;
    }
    list.forEach(c => grid.appendChild(createCardTile(c)));
  }

  // Render Sets, Checklists, Pull Odds & Chase Tracker Tab (Zero Money Values!)
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

  // ==========================================================================
  // DEDICATED ESTIMATED VALUES TAB (BREAKDOWN + RANKED DESCENDING LIST)
  // ==========================================================================
  function renderValuesTab() {
    const ownedAll = CARDS.filter(c => !isCardMissing(c));
    const ownedKandy = ownedAll.filter(c => c.owner === 'Kandy');
    const ownedHope = ownedAll.filter(c => c.owner === 'Hope');
    const mode = state.valMode;

    // 1. Update Estimate Mode Buttons & Column Highlights
    document.querySelectorAll('#val-mode-switcher button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    ['low', 'mid', 'high'].forEach(m => {
      const thBd = document.getElementById(`th-bd-${m}`);
      const thRk = document.getElementById(`th-rk-${m}`);
      if (thBd) thBd.classList.toggle('col-active-val', m === mode);
      if (thRk) thRk.classList.toggle('col-active-val', m === mode);
    });

    // 2. Top KPI Cards
    const grandLow = sumVals(ownedAll, 'low');
    const grandHigh = sumVals(ownedAll, 'high');
    const grandCur = sumVals(ownedAll, mode);
    const kandyCur = sumVals(ownedKandy, mode);
    const hopeCur = sumVals(ownedHope, mode);

    const rankedAll = sortCards(ownedAll, 'val-desc');
    const topCard = rankedAll[0] || null;

    document.getElementById('val-kpi-total').textContent = fmtGBP(grandCur);
    document.getElementById('val-kpi-range').textContent = `Range: ${fmtGBP(grandLow)} – ${fmtGBP(grandHigh)}`;
    document.getElementById('val-kpi-kandy').textContent = fmtGBP(kandyCur);
    document.getElementById('val-kpi-kandy-sub').textContent = `${ownedKandy.length} owned cards (${fmtGBP(sumVals(ownedKandy, 'low'))}–${fmtGBP(sumVals(ownedKandy, 'high'))})`;
    document.getElementById('val-kpi-hope').textContent = fmtGBP(hopeCur);
    document.getElementById('val-kpi-hope-sub').textContent = `${ownedHope.length} owned cards (${fmtGBP(sumVals(ownedHope, 'low'))}–${fmtGBP(sumVals(ownedHope, 'high'))})`;
    document.getElementById('val-kpi-top').textContent = topCard ? fmtGBP(cardVal(topCard, mode)) : '£0';
    document.getElementById('val-kpi-top-sub').textContent = topCard
      ? `${topCard.character} · ${getCardSerial(topCard)}${topCard.grade ? ' · ' + topCard.grade.replace(' Gem Mint', '').replace(' Mint', '') : ''}`
      : '—';

    // 3. Estimated Market Value Breakdown Table
    const summaryRows = [
      { label: 'Hope: Moon Girl Rainbow', owner: 'Hope', filter: c => c.display === 1 },
      { label: 'Hope: Devil Dinosaur Rainbow', owner: 'Hope', filter: c => c.display === 2 },
      { label: 'Hope: Neon/Sapphire Others', owner: 'Hope', filter: c => c.display === 6 },
      { label: "Kandy: Chrome Base (Numbered Only)", owner: 'Kandy', filter: c => c.display === 3 },
      { label: `Kandy: Chrome Insert Sets (${CHROME_INSERT_DISPLAYS.length} Sets)`, owner: 'Kandy', filter: c => CHROME_INSERT_IDS.has(c.display) },
      { label: "Kandy: Neon Base (Numbered Only)", owner: 'Kandy', filter: c => c.display === 5 },
      { label: `Kandy: Neon Insert Sets (${NEON_INSERT_DISPLAYS.length} Sets)`, owner: 'Kandy', filter: c => NEON_INSERT_IDS.has(c.display) },
    ];

    const colClass = (m) => m === mode ? 'col-active-val' : '';
    const valBody = document.getElementById('valuation-tbody');
    valBody.innerHTML = summaryRows.map(row => {
      const dc = ownedAll.filter(row.filter);
      return `
        <tr>
          <td><strong>${row.label}</strong></td>
          <td><span class="pill ${row.owner === 'Hope' ? 'pill-pink' : 'pill-cyan'}">${row.owner}</span></td>
          <td>${dc.length}</td>
          <td class="${colClass('low')}" style="font-family:'JetBrains Mono',monospace;">${fmtGBP(sumVals(dc, 'low'))}</td>
          <td class="${colClass('mid')}" style="font-family:'JetBrains Mono',monospace;">${fmtGBP(sumVals(dc, 'mid'))}</td>
          <td class="${colClass('high')}" style="font-family:'JetBrains Mono',monospace;">${fmtGBP(sumVals(dc, 'high'))}</td>
        </tr>
      `;
    }).join('') + `
      <tr style="background:var(--surface-soft);font-weight:900;">
        <td colspan="2">COMBINED VAULT TOTAL (HOPE + KANDY)</td>
        <td>${ownedAll.length}</td>
        <td class="${colClass('low')}" style="font-family:'JetBrains Mono',monospace;">${fmtGBP(grandLow)}</td>
        <td class="${colClass('mid')}" style="font-family:'JetBrains Mono',monospace;">${fmtGBP(sumVals(ownedAll, 'mid'))}</td>
        <td class="${colClass('high')}" style="font-family:'JetBrains Mono',monospace;">${fmtGBP(grandHigh)}</td>
      </tr>
    `;

    // 4. Owner Filter Buttons (Together = Default, Kandy, Hope)
    document.getElementById('val-btn-all').textContent = `✨ Together (${ownedAll.length})`;
    document.getElementById('val-btn-kandy').textContent = `🏆 Kandy's Cards (${ownedKandy.length})`;
    document.getElementById('val-btn-hope').textContent = `🌈 Hope's Cards (${ownedHope.length})`;
    document.querySelectorAll('#val-owner-filter button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.vowner === state.valOwnerFilter);
    });

    // 5. Filtered & Ranked Descending Card List
    const q = state.valSearch.trim().toLowerCase();
    const filteredList = rankedAll.filter(c => {
      if (state.valOwnerFilter !== 'all' && c.owner !== state.valOwnerFilter) return false;
      if (q) {
        const hay = `${c.character} ${c.parallel} ${c.set} ${c.cardNum} ${getCardSerial(c)} ${c.grade || ''} ${c.artist || ''} ${c.owner}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const filteredSubtotal = sumVals(filteredList, mode);
    const ownerLabel = state.valOwnerFilter === 'all'
      ? "Kandy & Hope Together"
      : `${state.valOwnerFilter}'s Cards`;
    const modeLabel = mode === 'low' ? 'Low' : (mode === 'high' ? 'High' : 'Mid');

    document.getElementById('val-list-summary').textContent =
      `Showing ${filteredList.length} cards (${ownerLabel}) · Sorted highest → lowest (${modeLabel} Est.) · Click any row to inspect`;
    document.getElementById('val-list-subtotal-pill').textContent =
      `Subtotal (${modeLabel}): ${fmtGBP(filteredSubtotal)}`;

    const rankedTbody = document.getElementById('val-ranked-tbody');
    rankedTbody.innerHTML = '';

    if (!filteredList.length) {
      rankedTbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--text-muted);font-weight:700;">No cards match your search filter.</td></tr>';
      return;
    }

    const frag = document.createDocumentFragment();
    filteredList.forEach((c, idx) => {
      const rank = idx + 1;
      const rankClass = rank <= 3 ? `rank-${rank}` : '';
      const serial = getCardSerial(c);
      const { low, high } = getCardValBounds(c);
      const mid = Math.round((low + high) / 2);

      const gradeHTML = c.grade
        ? `<span class="val-grade-pill ${c.grade.includes('9') ? 'ace-9' : ''}">${c.grade.replace(' Gem Mint', '').replace(' Mint', '')}</span>`
        : '';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="rank-badge ${rankClass}">#${rank}</span></td>
        <td>
          <div class="val-card-cell">
            <div class="val-thumb"><img alt="${c.character}" loading="lazy" /></div>
            <div class="val-card-info">
              <span class="val-card-name">${c.character}${c.artist ? ` <span style="font-weight:600;color:var(--text-muted);font-size:0.78rem;">(${c.artist})</span>` : ''}</span>
              <span class="val-card-sub">${c.set} · ${c.parallel}</span>
            </div>
          </div>
        </td>
        <td><span class="pill ${c.owner === 'Hope' ? 'pill-pink' : 'pill-cyan'}">${c.owner}</span></td>
        <td>
          <div class="val-serial-stack">
            <span class="serial-chip">${serial === 'Unnumbered' ? c.cardNum : serial}</span>
            ${gradeHTML}
          </div>
        </td>
        <td class="${colClass('low')}" style="font-family:'JetBrains Mono',monospace;">${fmtGBP(low)}</td>
        <td class="${colClass('mid')}" style="font-family:'JetBrains Mono',monospace;">${fmtGBP(mid)}</td>
        <td class="${colClass('high')}" style="font-family:'JetBrains Mono',monospace;">${fmtGBP(high)}</td>
      `;

      const thumbImg = tr.querySelector('.val-thumb img');
      attachSmartImage(thumbImg, c, null);
      tr.addEventListener('click', () => openCardModal(c, true));
      frag.appendChild(tr);
    });

    rankedTbody.appendChild(frag);
  }


  // ==========================================================================
  // CARD INSPECTOR MODAL + STATUS TOGGLE + STAGED PHOTO STUDIO
  // ==========================================================================
  let currentModalCard = null;
  let currentModalShowValue = false;
  let pendingModalMissingState = false;

  function renderModalDetails(card) {
    const missing = isCardMissing(card);
    const serial = getCardSerial(card);
    const { low, high } = getCardValBounds(card);
    const valText = missing
      ? '£0 (Missing from collection)'
      : (low === high ? fmtGBP(low) : `${fmtGBP(low)} – ${fmtGBP(high)} (Mid ${fmtGBP(cardVal(card, 'mid'))})`);

    const details = [
      ['Collection Status', missing ? '🔍 Missing (Chasing)' : '✅ Owned in Collection'],
      ['Serial Number', serial],
      ['Print Run', card.printRun ? `/${card.printRun}` : 'Unnumbered'],
      ['Format / Exclusivity', card.format],
      ['Pull Odds', card.odds],
      currentModalShowValue
        ? ['Est. Value (GBP)', valText]
        : ['Card Number', card.cardNum],
      ['Grade / Condition', missing ? 'Not yet acquired' : (card.grade || 'Raw · One-Touch Magnetic Case')],
      ['Subset / Artist', card.artist ? `${card.subset} · ${card.artist}` : card.subset]
    ];
    document.getElementById('modal-details').innerHTML = details.map(([k, v]) => `
      <div class="detail-item"><span>${k}</span><strong>${v}</strong></div>
    `).join('');

    // Apply/remove greyscale filter on modal preview immediately to match status!
    document.getElementById('modal-drop-preview').classList.toggle('is-missing', missing);
  }

  function syncModalStatusUI(card, draftMissing, showEditor = false) {
    pendingModalMissingState = draftMissing;
    const box = document.getElementById('modal-status-studio');
    const pill = document.getElementById('modal-status-pill');
    const toggleBtn = document.getElementById('modal-toggle-status-btn');
    const fields = document.getElementById('status-edit-fields');
    const valueFieldWrap = document.getElementById('status-value-field-wrap');
    const saveRow = document.getElementById('status-save-row');
    const markOwnedWrap = document.getElementById('opt-mark-owned-wrap');

    box.classList.toggle('is-missing', draftMissing);
    box.classList.toggle('is-owned', !draftMissing);
    document.getElementById('modal-drop-preview').classList.toggle('is-missing', draftMissing);

    if (draftMissing) {
      pill.className = 'status-pill-missing';
      pill.textContent = '🔍 Missing from Collection';
      toggleBtn.textContent = '🎉 Mark as Collected!';
      toggleBtn.className = 'btn btn-success';
      toggleBtn.style.padding = '6px 13px';
      toggleBtn.style.fontSize = '0.78rem';
      if (markOwnedWrap) markOwnedWrap.style.display = 'inline-flex';
    } else {
      pill.className = 'status-pill-owned';
      pill.textContent = '✅ Owned in Collection';
      toggleBtn.textContent = '↩️ Mark as Missing';
      toggleBtn.className = 'btn btn-soft';
      toggleBtn.style.padding = '6px 13px';
      toggleBtn.style.fontSize = '0.78rem';
      if (markOwnedWrap) markOwnedWrap.style.display = 'none';
    }

    // Only expose GBP input when opened from the Estimated Values tab
    if (valueFieldWrap) {
      valueFieldWrap.style.display = currentModalShowValue ? 'block' : 'none';
    }
    fields.classList.toggle('single-col', !currentModalShowValue);
    fields.classList.toggle('visible', showEditor && !draftMissing);
    saveRow.classList.toggle('visible', showEditor);
  }

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

  function openCardModal(card, showValueContext = false) {
    currentModalCard = card;
    currentModalShowValue = Boolean(showValueContext || state.activeTab === 'values');
    clearStagedCardPhoto(false);

    const modal = document.getElementById('card-modal');
    const img = document.getElementById('modal-img');
    attachSmartImage(img, card, null);

    const dispMeta = DISPLAYS.find(d => d.id === card.display);
    document.getElementById('modal-title').textContent = card.character;
    document.getElementById('modal-subtitle').textContent = `${card.set} · ${card.cardNum} · ${card.parallel}`;
    document.getElementById('modal-owner-badge').textContent =
      `${card.owner}'s Vault · ${dispMeta ? dispMeta.shortTitle : 'Display ' + card.display} (${card.cardNum})`;

    renderModalDetails(card);

    const missing = isCardMissing(card);
    document.getElementById('status-serial-input').value = getCardSerial(card);
    document.getElementById('status-value-input').value = cardVal(card, 'mid');
    const statusMsg = document.getElementById('modal-status-msg');
    statusMsg.textContent = '';
    statusMsg.className = 'upload-status';
    syncModalStatusUI(card, missing, false);

    document.getElementById('modal-filepath').textContent = card.recommendedPath;
    updateModalPermissionsUI();
    modal.classList.add('open');
  }

  function closeCardModal() {
    clearStagedCardPhoto(false);
    document.getElementById('card-modal').classList.remove('open');
  }

  function applyPendingCardStatus(card) {
    const nowMissing = pendingModalMissingState;
    if (nowMissing) {
      state.statusOverrides[card.id] = {
        missing: true,
        serial: card.printRun ? `/${card.printRun}` : 'Unnumbered',
        valLow: 0,
        valHigh: 0,
        updatedAt: Date.now()
      };
    } else {
      const serialInput = (document.getElementById('status-serial-input').value || '').trim();
      const finalSerial = serialInput || (card.printRun ? `/${card.printRun}` : 'Unnumbered');
      // Preserve existing card valuation bounds unless explicitly edited in Estimated Values context
      let valLow = card.valLow || 0;
      let valHigh = card.valHigh || 0;
      if (currentModalShowValue) {
        const valNum = Math.max(0, parseInt(document.getElementById('status-value-input').value || '0', 10) || 0);
        valLow = valNum;
        valHigh = valNum;
      }
      state.statusOverrides[card.id] = {
        missing: false,
        serial: finalSerial,
        valLow,
        valHigh,
        updatedAt: Date.now()
      };
    }
    saveLocalStatusOverrides(state.statusOverrides);
    renderModalDetails(card);
    attachSmartImage(document.getElementById('modal-img'), card, null);
    renderActiveTab();
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
      showToast('No matching filenames found — open any card to check its exact filename.');
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
      renderDisplaySection(wrap, 6);
    } else if (state.activeTab === 'chrome') {
      const wrap = document.getElementById('chrome-displays-wrap');
      renderKandyChromeVault(wrap);
    } else if (state.activeTab === 'neon') {
      const wrap = document.getElementById('neon-displays-wrap');
      renderKandyNeonVault(wrap);
    } else if (state.activeTab === 'explorer') {
      renderExplorer();
    } else if (state.activeTab === 'sets') {
      renderSetsTab();
    } else if (state.activeTab === 'values') {
      renderValuesTab();

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


  // Boot & Event Wiring
  document.addEventListener('DOMContentLoaded', () => {
    initHeroPhoto();
    updateGHButtonState();

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => { state.activeTab = btn.dataset.tab; renderActiveTab(); });
    });

    // Estimated Values tab controls
    document.querySelectorAll('#val-mode-switcher button').forEach(btn => {
      btn.addEventListener('click', () => {
        state.valMode = btn.dataset.mode;
        renderValuesTab();
      });
    });

    document.querySelectorAll('#val-owner-filter button').forEach(btn => {
      btn.addEventListener('click', () => {
        state.valOwnerFilter = btn.dataset.vowner;
        renderValuesTab();
      });
    });

    document.getElementById('val-search').addEventListener('input', (e) => {
      state.valSearch = e.target.value;
      renderValuesTab();
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

    // GitHub Sync Modal controls
    document.getElementById('gh-settings-btn').addEventListener('click', () => openGHModal());
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
        state.gh = { owner, repo, branch, token, hasWrite: true };
        saveGHConfig(state.gh);
        updateGHButtonState();
        st.textContent = `✅ Connected to ${owner}/${repo} (${branch})! You can now save photos & status directly to GitHub.`;
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
      state.gh.hasWrite = false;
      saveGHConfig(state.gh);
      document.getElementById('gh-token').value = '';
      updateGHButtonState();
      const st = document.getElementById('gh-test-status');
      st.textContent = 'Token cleared from this browser.';
      st.className = 'upload-status';
      showToast('GitHub token disconnected.');
    });

    // Card Modal: Status Toggle & Save controls
    document.getElementById('modal-toggle-status-btn').addEventListener('click', () => {
      if (!currentModalCard) return;
      const nextMissing = !pendingModalMissingState;
      syncModalStatusUI(currentModalCard, nextMissing, true);
      const msg = document.getElementById('modal-status-msg');
      msg.textContent = nextMissing
        ? 'Click Save below to mark this card as Missing (greyscale).'
        : (currentModalShowValue
            ? 'Enter the card serial # & estimated value (optional), then click Save!'
            : 'Enter the card serial # (optional), then click Save to unlock full colour!');
      msg.className = 'upload-status';
    });

    document.getElementById('status-save-local-btn').addEventListener('click', () => {
      if (!currentModalCard) return;
      applyPendingCardStatus(currentModalCard);
      const nowMissing = isCardMissing(currentModalCard);
      syncModalStatusUI(currentModalCard, nowMissing, false);
      const msg = document.getElementById('modal-status-msg');
      msg.textContent = nowMissing
        ? '💾 Saved locally as Missing.'
        : '🎉 Marked as Collected & saved locally!';
      msg.className = 'upload-status ok';
      showToast(nowMissing ? 'Marked as Missing' : `🎉 ${currentModalCard.character} (${currentModalCard.parallel}) marked as Collected!`);
      if (!nowMissing) burstConfetti();
    });

    document.getElementById('status-save-gh-btn').addEventListener('click', async () => {
      if (!currentModalCard) return;
      if (!state.gh.token) {
        openGHModal('Paste your GitHub token once to sync collection status to GitHub!');
        return;
      }
      applyPendingCardStatus(currentModalCard);
      const nowMissing = isCardMissing(currentModalCard);
      const btn = document.getElementById('status-save-gh-btn');
      const msg = document.getElementById('modal-status-msg');
      btn.disabled = true;
      btn.textContent = '⏳ Syncing...';
      msg.textContent = 'Saving js/collection-status.json to GitHub...';
      msg.className = 'upload-status';
      try {
        await saveStatusOverridesToGitHub(
          `Update card status (${nowMissing ? 'Missing' : 'Collected'}): ${currentModalCard.character} ${currentModalCard.parallel}`
        );
        syncModalStatusUI(currentModalCard, nowMissing, false);
        msg.textContent = '✅ Status saved to GitHub! Live site updates in ~45 seconds.';
        msg.className = 'upload-status ok';
        showToast(nowMissing ? '☁️ Saved as Missing on GitHub' : `☁️ Marked ${currentModalCard.character} as Collected on GitHub!`);
        if (!nowMissing) burstConfetti();
      } catch (err) {
        msg.textContent = `❌ GitHub sync failed (saved locally instead): ${err.message}`;
        msg.className = 'upload-status err';
      } finally {
        btn.disabled = false;
        btn.textContent = '☁️ Save Status to GitHub';
      }
    });

    // Card Modal close & copy
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

    // Choose Photo
    document.getElementById('modal-choose-btn').addEventListener('click', () => {
      document.getElementById('modal-photo-input').click();
    });
    document.getElementById('modal-photo-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) stageCardPhotoBlob(file);
      e.target.value = '';
    });

    // Paste from Google Photos button + Ctrl+V listener
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
      if (!hasGitHubEditPermissions()) return;
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

    // Drag & Drop onto Photo Studio or Card Preview (only active when GitHub write permissions are connected)
    ['photo-studio-zone', 'modal-drop-preview'].forEach(elId => {
      const zone = document.getElementById(elId);
      zone.addEventListener('dragover', (e) => {
        if (!hasGitHubEditPermissions()) return;
        e.preventDefault();
        document.getElementById('photo-studio-zone').classList.add('drag-over');
      });
      zone.addEventListener('dragleave', () => {
        if (!hasGitHubEditPermissions()) return;
        document.getElementById('photo-studio-zone').classList.remove('drag-over');
      });
      zone.addEventListener('drop', (e) => {
        if (!hasGitHubEditPermissions()) return;
        e.preventDefault();
        document.getElementById('photo-studio-zone').classList.remove('drag-over');
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) stageCardPhotoBlob(file);
      });
    });

    document.getElementById('opt-web-jpeg').addEventListener('change', () => {
      if (state.stagedCardPhoto && state.stagedCardPhoto.rawBlob) {
        stageCardPhotoBlob(state.stagedCardPhoto.rawBlob);
      }
    });

    document.getElementById('modal-cancel-stage-btn').addEventListener('click', () => {
      clearStagedCardPhoto(true);
    });

    // Save Staged Photo Directly to GitHub
    document.getElementById('modal-save-gh-btn').addEventListener('click', async () => {
      if (!currentModalCard || !state.stagedCardPhoto) return;
      if (!state.gh.token) {
        openGHModal('Paste your GitHub Personal Access Token once to enable direct saving to GitHub!');
        return;
      }

      const btn = document.getElementById('modal-save-gh-btn');
      const statusEl = document.getElementById('modal-upload-status');
      const shouldAlsoMarkOwned = isCardMissing(currentModalCard) && document.getElementById('opt-mark-owned').checked;

      btn.disabled = true;
      btn.textContent = '⏳ Uploading to GitHub...';
      statusEl.textContent = `Committing ${currentModalCard.recommendedPath} to GitHub...`;
      statusEl.className = 'upload-status';

      try {
        await uploadToGitHub(
          currentModalCard.recommendedPath,
          state.stagedCardPhoto.outBase64,
          `Update card photo: ${currentModalCard.character} (${currentModalCard.cardNum} ${getCardSerial(currentModalCard)})`
        );

        if (shouldAlsoMarkOwned) {
          pendingModalMissingState = false;
          applyPendingCardStatus(currentModalCard);
          await saveStatusOverridesToGitHub(
            `Mark collected with new photo: ${currentModalCard.character} ${currentModalCard.parallel}`
          );
          syncModalStatusUI(currentModalCard, false, false);
        }

        const keepUrl = URL.createObjectURL(state.stagedCardPhoto.outBlob);
        state.sessionPhotos[currentModalCard.id] = keepUrl;
        state.realPhotoLoaded[currentModalCard.id] = true;
        markRecentUpload(currentModalCard.recommendedPath);
        state.recentUploads = loadRecentUploads();

        document.getElementById('modal-img').src = keepUrl;
        renderActiveTab();
        updatePhotoCounter();

        statusEl.textContent = shouldAlsoMarkOwned
          ? '✅ Photo saved & card marked as Collected on GitHub!'
          : '✅ Saved to GitHub! Your live site updates automatically in ~45 seconds.';
        statusEl.className = 'upload-status ok';
        showToast(`☁️ Saved ${currentModalCard.character} to GitHub!`);
        burstConfetti();

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

    // Save Staged Photo Locally (Auto-Renamed)
    document.getElementById('modal-save-local-btn').addEventListener('click', async () => {
      if (!currentModalCard || !state.stagedCardPhoto) return;
      const exactFilename = `${currentModalCard.baseFilename}.jpg`;
      const statusEl = document.getElementById('modal-upload-status');
      const shouldAlsoMarkOwned = isCardMissing(currentModalCard) && document.getElementById('opt-mark-owned').checked;
      try {
        const res = await saveBlobLocally(state.stagedCardPhoto.outBlob, exactFilename);
        if (res === 'cancelled') return;

        if (shouldAlsoMarkOwned) {
          pendingModalMissingState = false;
          applyPendingCardStatus(currentModalCard);
          syncModalStatusUI(currentModalCard, false, false);
        }

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
    loadRemoteStatusOverrides();
    verifyStoredGitHubPermissions();
  });
})();
