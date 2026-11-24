(function () {
  const APP_VERSION = 'V1.13';
  const ANIM_PREF_KEY = 'kh_vault_anim_paused_v1';
  const DISPLAY_STICKERS = {
    1: { src: 'assets/stickers/moon-girl-topps.png', alt: 'Moon Girl Topps comic sticker', cls: 'sticker-tall' },
    2: { src: 'assets/stickers/devil-dinosaur.png', alt: 'Devil Dinosaur sticker', cls: 'sticker-wide' },
    6: { src: 'assets/stickers/mg-dd-duo.png', alt: 'Moon Girl and Devil Dinosaur die-cut sticker', cls: 'sticker-duo' }
  };
  const BASE_CARDS = window.VAULT_CARDS || [];
  let CARDS = [...BASE_CARDS];
  const BIOS = window.VAULT_CHARACTER_BIOS || {};
  const DISPLAYS = window.VAULT_DISPLAYS || [];
  const SETS = window.VAULT_SETS || [];
  const ODDS = window.VAULT_ODDS || [];
  const CHASES = window.VAULT_CHASES || [];

  const GH_STORAGE_KEY = 'kh_vault_gh_config_v1';
  const RECENT_UPLOADS_KEY = 'kh_vault_recent_uploads_v1';
  const STATUS_STORAGE_KEY = 'kh_vault_card_status_v1';
  const CUSTOM_CARDS_STORAGE_KEY = 'kh_vault_custom_cards_v1';
  const LOCAL_PHOTO_DB_NAME = 'kh_vault_local_photos_v1';
  const LOCAL_PHOTO_STORE = 'photos';

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

  function loadLocalCustomStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(CUSTOM_CARDS_STORAGE_KEY) || 'null');
      if (Array.isArray(raw)) return { cards: raw, deletedIds: [] };
      if (raw && Array.isArray(raw.cards)) {
        return { cards: raw.cards, deletedIds: Array.isArray(raw.deletedIds) ? raw.deletedIds : [] };
      }
    } catch (_) {}
    return { cards: [], deletedIds: [] };
  }

  function saveLocalCustomStore(store) {
    try { localStorage.setItem(CUSTOM_CARDS_STORAGE_KEY, JSON.stringify(store)); } catch (_) {}
  }

  // Lightweight IndexedDB store so locally-added card photos survive page refreshes offline
  function openLocalPhotoDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open(LOCAL_PHOTO_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(LOCAL_PHOTO_STORE)) {
          db.createObjectStore(LOCAL_PHOTO_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveLocalPhotoBlob(cardId, blob) {
    try {
      const db = await openLocalPhotoDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(LOCAL_PHOTO_STORE, 'readwrite');
        tx.objectStore(LOCAL_PHOTO_STORE).put(blob, cardId);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) {}
  }

  async function deleteLocalPhotoBlob(cardId) {
    try {
      const db = await openLocalPhotoDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(LOCAL_PHOTO_STORE, 'readwrite');
        tx.objectStore(LOCAL_PHOTO_STORE).delete(cardId);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) {}
  }

  async function hydrateLocalPhotoBlobs() {
    try {
      const db = await openLocalPhotoDB();
      if (!db) return;
      const entries = await new Promise((resolve) => {
        const out = [];
        const tx = db.transaction(LOCAL_PHOTO_STORE, 'readonly');
        const store = tx.objectStore(LOCAL_PHOTO_STORE);
        const curReq = store.openCursor();
        curReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            out.push([cursor.key, cursor.value]);
            cursor.continue();
          } else {
            resolve(out);
          }
        };
        curReq.onerror = () => resolve(out);
      });
      let hydrated = 0;
      entries.forEach(([cardId, blob]) => {
        if (blob instanceof Blob && !state.sessionPhotos[cardId]) {
          state.sessionPhotos[cardId] = URL.createObjectURL(blob);
          state.realPhotoLoaded[cardId] = true;
          hydrated++;
        }
      });
      if (hydrated > 0) {
        renderActiveTab();
        updatePhotoCounter();
      }
    } catch (_) {}
  }

  // Default section status filters:
  // - Hope's Moon Girl (1) & Devil Dinosaur (2): default to 'owned'
  // - Kandy's collapsible Chrome Insert subsets (101..129): default to 'owned'
  const defaultStatusFilters = { 1: 'owned', 2: 'owned' };
  CHROME_INSERT_DISPLAYS.forEach(d => { defaultStatusFilters[d.id] = 'owned'; });
  NEON_INSERT_DISPLAYS.forEach(d => { defaultStatusFilters[d.id] = 'owned'; });

  function loadInitialAnimPaused() {
    try {
      const saved = localStorage.getItem(ANIM_PREF_KEY);
      if (saved === 'true') return true;
      if (saved === 'false') return false;
    } catch (_) {}
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  const state = {
    animationsPaused: loadInitialAnimPaused(),
    activeTab: 'hope',
    valMode: 'mid',           // 'low' | 'mid' | 'high' (used exclusively on Estimated Values tab)
    valOwnerFilter: 'all',    // 'all' (Together - default) | 'Kandy' | 'Hope'
    valSearch: '',
    sectionSort: {},          // displayId -> 'rarity' | 'name' (Hope always locked to 'rarity')
    sectionStatusFilter: defaultStatusFilters,
    expandedInserts: {},      // displayId -> true/false (all collapsed by default)
    expandedBios: {},         // bioKey -> true/false (both collapsed by default)
    chromeInsertFilter: 'all',// 'all' | 'with-owned'
    neonInsertFilter: 'all',  // 'all' | 'with-owned'
    statusOverrides: loadLocalStatusOverrides(),
    remoteStatusOverrides: {},
    remoteStatusLoaded: false,
    customStore: loadLocalCustomStore(),
    remoteCustomStore: { cards: [], deletedIds: [] },
    remoteCustomLoaded: false,
    sessionPhotos: {},
    realPhotoLoaded: {},
    recentUploads: loadRecentUploads(),
    gh: loadGHConfig(),
    stagedCardPhoto: null,
    stagedAddPhoto: null,
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

  function syncCardsArray() {
    const customList = (state.customStore && Array.isArray(state.customStore.cards))
      ? state.customStore.cards
      : [];
    CARDS = [...BASE_CARDS, ...customList];
  }
  syncCardsArray();

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

  // Check whether an override entry matches a card's base definition in data.js
  function isOverrideMatchingBase(cardId, ov) {
    const base = BASE_CARDS.find(c => c.id === cardId);
    if (!base || !ov) return false;
    const baseMissing = Boolean(base.missing);
    const ovMissing = typeof ov.missing === 'boolean' ? ov.missing : baseMissing;
    if (ovMissing !== baseMissing) return false;
    if (ovMissing) return true; // Both missing -> redundant
    const ovSerial = (ov.serial || '').trim();
    if (ovSerial && ovSerial !== base.serial) return false;
    if (typeof ov.valLow === 'number' && ov.valLow !== (base.valLow || 0)) return false;
    if (typeof ov.valHigh === 'number' && ov.valHigh !== (base.valHigh || 0)) return false;
    return true;
  }

  // Build a clean status map with redundant base-matching entries stripped before pushing to GitHub
  function getCleanedStatusMapForGitHub(sourceMap) {
    const clean = {};
    Object.keys(sourceMap || {}).forEach(id => {
      const ov = sourceMap[id];
      if (!isOverrideMatchingBase(id, ov)) {
        clean[id] = ov;
      }
    });
    return clean;
  }

  function computeLocalGitHubDrift() {
    const driftItems = [];
    if (state.remoteStatusLoaded) {
      const allIds = new Set([
        ...Object.keys(state.statusOverrides || {}),
        ...Object.keys(state.remoteStatusOverrides || {})
      ]);
      allIds.forEach(id => {
        const loc = state.statusOverrides[id];
        const rem = state.remoteStatusOverrides[id];
        const base = BASE_CARDS.find(c => c.id === id);
        const locMissing = loc && typeof loc.missing === 'boolean' ? loc.missing : (base ? Boolean(base.missing) : false);
        const remMissing = rem && typeof rem.missing === 'boolean' ? rem.missing : (base ? Boolean(base.missing) : false);
        const locSerial = (loc && loc.serial) || (base ? base.serial : '');
        const remSerial = (rem && rem.serial) || (base ? base.serial : '');
        if (locMissing !== remMissing || (!locMissing && locSerial !== remSerial)) {
          driftItems.push(base ? `${base.character} (${base.parallel})` : id);
        }
      });
    }
    if (state.remoteCustomLoaded) {
      const locIds = new Set((state.customStore.cards || []).map(c => c.id));
      const remIds = new Set((state.remoteCustomStore.cards || []).map(c => c.id));
      locIds.forEach(id => {
        if (!remIds.has(id)) {
          const c = (state.customStore.cards || []).find(x => x.id === id);
          driftItems.push(c ? `Added: ${c.character} (${c.cardNum})` : id);
        }
      });
      remIds.forEach(id => {
        if (!locIds.has(id)) {
          const c = (state.remoteCustomStore.cards || []).find(x => x.id === id);
          driftItems.push(c ? `Removed: ${c.character} (${c.cardNum})` : id);
        }
      });
    }
    return driftItems;
  }

  function updateDriftIndicatorUI() {
    const canEdit = hasGitHubEditPermissions();
    const driftItems = canEdit ? computeLocalGitHubDrift() : [];
    const hasDrift = driftItems.length > 0;

    const driftBtn = document.getElementById('gh-drift-btn');
    if (driftBtn) {
      driftBtn.hidden = !hasDrift;
      if (hasDrift) {
        driftBtn.textContent = `⚠️ Sync ${driftItems.length} Local Change${driftItems.length === 1 ? '' : 's'}`;
      }
    }

    const syncBox = document.getElementById('gh-sync-box');
    const syncTitle = document.getElementById('gh-sync-summary');
    const syncDetail = document.getElementById('gh-sync-detail');
    const pushBtn = document.getElementById('gh-push-local-btn');

    if (syncBox) {
      syncBox.hidden = !canEdit;
      syncBox.classList.toggle('has-drift', hasDrift);
    }
    if (pushBtn) pushBtn.hidden = !hasDrift;
    if (syncTitle && syncDetail) {
      if (hasDrift) {
        syncTitle.textContent = `⚠️ ${driftItems.length} Unsynced Local Change${driftItems.length === 1 ? '' : 's'} Found`;
        const preview = driftItems.slice(0, 3).join(', ') + (driftItems.length > 3 ? ` (+${driftItems.length - 3} more)` : '');
        syncDetail.textContent = `Other browsers won't see these until pushed to GitHub: ${preview}.`;
      } else {
        syncTitle.textContent = '✅ Local browser & GitHub are in sync';
        syncDetail.textContent = 'Every card status and added card matches what visitors see on GitHub Pages.';
      }
    }
  }

  // Pull live js/collection-status.json on boot so status updates saved to GitHub sync across devices
  async function loadRemoteStatusOverrides() {
    try {
      const res = await fetch(`js/collection-status.json?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const remote = await res.json();
      if (!remote || typeof remote !== 'object') return;
      state.remoteStatusOverrides = remote;
      state.remoteStatusLoaded = true;

      // Visitors (without GitHub write access) ALWAYS see exact GitHub live data — never stale localStorage
      if (!hasGitHubEditPermissions()) {
        state.statusOverrides = { ...remote };
        saveLocalStatusOverrides(state.statusOverrides);
        renderActiveTab();
        updateDriftIndicatorUI();
        return;
      }

      // GitHub-connected browser: merge newer local edits, but prune redundant entries that match both remote & base
      const merged = { ...remote };
      Object.keys(state.statusOverrides).forEach(id => {
        const loc = state.statusOverrides[id];
        const rem = remote[id];
        if (!rem) {
          // If remote doesn't override this card AND local matches base data.js, drop redundant local entry
          if (!isOverrideMatchingBase(id, loc)) {
            merged[id] = loc;
          }
        } else if ((loc.updatedAt || 0) >= (rem.updatedAt || 0)) {
          merged[id] = loc;
        }
      });

      state.statusOverrides = merged;
      saveLocalStatusOverrides(merged);
      renderActiveTab();
      updateDriftIndicatorUI();
    } catch (_) {
      // Offline / file:// open — keep localStorage overrides
    }
  }

  // Pull live js/custom-cards.json on boot so added cards saved to GitHub sync across devices
  async function loadRemoteCustomCards() {
    try {
      const res = await fetch(`js/custom-cards.json?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const raw = await res.json();
      const remoteCards = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.cards) ? raw.cards : []);
      const remoteDeleted = Array.isArray(raw && raw.deletedIds) ? raw.deletedIds : [];
      state.remoteCustomStore = { cards: remoteCards, deletedIds: remoteDeleted };
      state.remoteCustomLoaded = true;

      // Visitors (without GitHub write access) ALWAYS see exact GitHub live custom cards
      if (!hasGitHubEditPermissions()) {
        const delSet = new Set(remoteDeleted);
        state.customStore = {
          cards: remoteCards.filter(c => c && c.id && !delSet.has(c.id)),
          deletedIds: [...remoteDeleted]
        };
        saveLocalCustomStore(state.customStore);
        syncCardsArray();
        renderActiveTab();
        updateDriftIndicatorUI();
        return;
      }

      const allDeleted = new Set([...remoteDeleted, ...(state.customStore.deletedIds || [])]);
      const byId = new Map();
      remoteCards.forEach(c => {
        if (c && c.id && !allDeleted.has(c.id)) byId.set(c.id, c);
      });
      (state.customStore.cards || []).forEach(c => {
        if (!c || !c.id || allDeleted.has(c.id)) return;
        const prev = byId.get(c.id);
        if (!prev || (c.updatedAt || 0) >= (prev.updatedAt || 0)) {
          byId.set(c.id, c);
        }
      });

      state.customStore = {
        cards: [...byId.values()],
        deletedIds: [...allDeleted]
      };
      saveLocalCustomStore(state.customStore);
      syncCardsArray();
      renderActiveTab();
      updateDriftIndicatorUI();
    } catch (_) {
      // Offline / file:// or js/custom-cards.json not yet created — keep localStorage custom cards
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
    }

    // Group cards sharing the same Card Serial # right alongside each other
    const numDiff = compareNaturalCardNum(a.cardNum, b.cardNum);
    if (numDiff !== 0) return numDiff;

    const serDiff = parseSerialNum(getCardSerial(a)) - parseSerialNum(getCardSerial(b));
    if (serDiff !== 0) return serDiff;

    // Owned cards appear directly before any matching empty/missing slot
    const missDiff = (isCardMissing(a) ? 1 : 0) - (isCardMissing(b) ? 1 : 0);
    if (missDiff !== 0) return missDiff;

    return (a.character || '').localeCompare(b.character || '');
  }

  function compareChecklistPosition(a, b) {
    // Primary: natural Card Serial # order so all cards with the same # sit alongside each other
    const numDiff = compareNaturalCardNum(a.cardNum, b.cardNum);
    if (numDiff !== 0) return numDiff;
    // Secondary: owned versions right next to each other before empty/missing slot, rarest first
    const missDiff = (isCardMissing(a) ? 1 : 0) - (isCardMissing(b) ? 1 : 0);
    if (missDiff !== 0) return missDiff;
    return comparePullRarity(a, b);
  }

  function sortCards(list, sortMode) {
    const copy = [...list];
    if (sortMode === 'checklist' || sortMode === 'cardnum') {
      copy.sort(compareChecklistPosition);
    } else if (sortMode === 'val-desc' || sortMode === 'value') {
      copy.sort((a, b) => (cardVal(b) - cardVal(a)) || comparePullRarity(a, b));
    } else if (sortMode === 'alpha' || sortMode === 'name') {
      copy.sort((a, b) => (a.character || '').localeCompare(b.character || '') || compareChecklistPosition(a, b));
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
    const cleanMap = getCleanedStatusMapForGitHub(state.statusOverrides);
    const jsonText = JSON.stringify(cleanMap, null, 2) + '\n';
    const result = await uploadToGitHub('js/collection-status.json', utf8ToBase64(jsonText), commitMsg);
    state.statusOverrides = { ...cleanMap };
    state.remoteStatusOverrides = { ...cleanMap };
    state.remoteStatusLoaded = true;
    saveLocalStatusOverrides(state.statusOverrides);
    updateDriftIndicatorUI();
    return result;
  }

  async function saveCustomCardsToGitHub(commitMsg) {
    const jsonText = JSON.stringify(state.customStore, null, 2) + '\n';
    const result = await uploadToGitHub('js/custom-cards.json', utf8ToBase64(jsonText), commitMsg);
    state.remoteCustomStore = {
      cards: [...(state.customStore.cards || [])],
      deletedIds: [...(state.customStore.deletedIds || [])]
    };
    state.remoteCustomLoaded = true;
    updateDriftIndicatorUI();
    return result;
  }

  function readBlobAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const parts = String(reader.result || '').split(',');
        resolve(parts[1] || '');
      };
      reader.onerror = () => reject(new Error('Could not read file bytes'));
      reader.readAsDataURL(blob);
    });
  }

  function isGifFile(file) {
    return Boolean(file && (file.type === 'image/gif' || /\.gif$/i.test(file.name || '')));
  }

  async function deleteFromGitHubIfExists(repoFilePath, commitMessage) {
    const { owner, repo, branch, token } = state.gh;
    if (!token || !owner || !repo) return;
    const encodedPath = repoFilePath.split('/').map(encodeURIComponent).join('/');
    const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
    const headers = {
      'Authorization': `Bearer ${token.trim()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    const checkRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch || 'main')}`, { headers });
    if (checkRes.status !== 200) return;
    const existingData = await checkRes.json();
    if (!existingData || !existingData.sha) return;
    await fetch(apiBase, {
      method: 'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        sha: existingData.sha,
        branch: branch || 'main'
      })
    });
  }

  // Save Blob locally with exact required filename
  async function saveBlobLocally(blob, exactFilename) {
    const isGif = /\.gif$/i.test(exactFilename || '');
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: exactFilename,
          types: isGif
            ? [{ description: 'Animated GIF', accept: { 'image/gif': ['.gif'] } }]
            : [{ description: 'JPEG Image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }]
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
    document.body.classList.toggle('gh-can-edit', connected);
    if (btn) {
      btn.textContent = connected ? '✅ GitHub Connected' : '☁️ GitHub Sync';
      btn.classList.toggle('btn-github-connected', connected);
      btn.classList.toggle('btn-soft', !connected);
    }
    updateModalPermissionsUI();
    updateDriftIndicatorUI();
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

  // Hero Photo / Animated GIF auto-loader & uploader
  function initHeroPhoto() {
    const img = document.getElementById('hero-photo');
    const gifTs = state.recentUploads['assets/photos/kandy-and-hope.gif'];
    const jpgTs = state.recentUploads['assets/photos/kandy-and-hope.jpg'];
    const gifUrl = `assets/photos/kandy-and-hope.gif${gifTs ? `?v=${gifTs}` : ''}`;
    const jpgUrl = `assets/photos/kandy-and-hope.jpg${jpgTs ? `?v=${jpgTs}` : ''}`;

    const candidates = [
      { url: gifUrl, isGif: true },
      { url: jpgUrl, isGif: false },
      { url: 'assets/photos/kandy-and-hope.jpeg', isGif: false },
      { url: 'assets/photos/kandy-and-hope.png', isGif: false },
      { url: 'assets/photos/kandy-and-hope.webp', isGif: false },
      { url: 'assets/photos/kandy-and-hope.svg', isGif: false }
    ];
    let idx = 0;
    function tryNext() {
      if (idx >= candidates.length) return;
      const cand = candidates[idx++];
      img.onload = () => {
        if (cand.isGif) {
          img.classList.add('vault-anim-gif');
          img.dataset.gif = gifUrl;
          img.dataset.poster = jpgUrl;
          if (state.animationsPaused) syncAnimationsState();
        } else {
          img.classList.remove('vault-anim-gif');
          delete img.dataset.gif;
          delete img.dataset.poster;
        }
      };
      img.src = cand.url;
    }
    img.onerror = tryNext;
    tryNext();

    document.getElementById('hero-photo-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const previewUrl = URL.createObjectURL(file);
      img.onerror = null;
      img.onload = null;
      img.classList.remove('vault-anim-gif');
      img.src = previewUrl;
      state.stagedHeroPhoto = { file, previewUrl, isGif: isGifFile(file) };
      document.getElementById('hero-save-actions').classList.add('visible');
      showToast(
        state.stagedHeroPhoto.isGif
          ? 'Previewing your animated GIF! Click "Save to GitHub" or "Save Locally" below it.'
          : 'Previewing your photo! Click "Save to GitHub" or "Save Locally" below it.'
      );
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
        const { file, isGif } = state.stagedHeroPhoto;
        if (isGif) {
          // Upload raw animated GIF bytes untouched (preserves all animation frames!)
          const rawGifBase64 = await readBlobAsBase64(file);
          await uploadToGitHub(
            'assets/photos/kandy-and-hope.gif',
            rawGifBase64,
            'Update hero animated GIF: Kandy & Hope'
          );
          // Also save frame 1 as static JPG poster for Animations: Paused mode
          try {
            const poster = await processImageBlob(file, true);
            await uploadToGitHub(
              'assets/photos/kandy-and-hope.jpg',
              poster.base64,
              'Update hero static poster: Kandy & Hope'
            );
            markRecentUpload('assets/photos/kandy-and-hope.jpg');
          } catch (_) {}
          markRecentUpload('assets/photos/kandy-and-hope.gif');
          state.recentUploads = loadRecentUploads();
          const freshGifUrl = `assets/photos/kandy-and-hope.gif?v=${state.recentUploads['assets/photos/kandy-and-hope.gif']}`;
          const freshJpgUrl = `assets/photos/kandy-and-hope.jpg?v=${state.recentUploads['assets/photos/kandy-and-hope.jpg'] || Date.now()}`;
          img.classList.add('vault-anim-gif');
          img.dataset.gif = freshGifUrl;
          img.dataset.poster = freshJpgUrl;
        } else {
          const processed = await processImageBlob(file, true);
          await uploadToGitHub(
            'assets/photos/kandy-and-hope.jpg',
            processed.base64,
            'Update hero photo: Kandy & Hope'
          );
          // Remove any previous hero GIF so the new static photo takes priority
          await deleteFromGitHubIfExists(
            'assets/photos/kandy-and-hope.gif',
            'Replace hero GIF with static photo'
          ).catch(() => {});
          markRecentUpload('assets/photos/kandy-and-hope.jpg');
          state.recentUploads = loadRecentUploads();
          img.classList.remove('vault-anim-gif');
          delete img.dataset.gif;
          delete img.dataset.poster;
        }
        document.getElementById('hero-save-actions').classList.remove('visible');
        state.stagedHeroPhoto = null;
        showToast(
          isGif
            ? '✅ Animated hero GIF saved to GitHub! Live site refreshes in ~45s.'
            : '✅ Kandy & Hope photo saved to GitHub! Live site refreshes in ~45s.'
        );
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
        const { file, isGif } = state.stagedHeroPhoto;
        if (isGif) {
          const res = await saveBlobLocally(file, 'kandy-and-hope.gif');
          if (res !== 'cancelled') showToast('💾 Saved animated GIF locally as kandy-and-hope.gif!');
        } else {
          const processed = await processImageBlob(file, true);
          const res = await saveBlobLocally(processed.blob, 'kandy-and-hope.jpg');
          if (res !== 'cancelled') showToast('💾 Saved locally as kandy-and-hope.jpg!');
        }
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

  function escSvg(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function generateCustomCardSvgUri(card) {
    const isLand = card.orientation === 'landscape';
    const w = isLand ? 420 : 300;
    const h = isLand ? 300 : 420;
    const isNeon = (card.set || '').toLowerCase().includes('neon');
    const isSapphire = (card.set || '').toLowerCase().includes('sapphire');
    const c1 = isNeon ? '#06b6d4' : (isSapphire ? '#2563eb' : '#ec4899');
    const c2 = isNeon ? '#8b5cf6' : (isSapphire ? '#38bdf8' : '#f59e0b');
    const serial = getCardSerial(card);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#131932"/>
          <stop offset="100%" stop-color="#090d1b"/>
        </linearGradient>
        <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${c1}"/>
          <stop offset="100%" stop-color="${c2}"/>
        </linearGradient>
      </defs>
      <rect width="${w}" height="${h}" rx="18" fill="url(#bg)"/>
      <rect x="8" y="8" width="${w - 16}" height="${h - 16}" rx="14" fill="none" stroke="url(#rim)" stroke-width="4"/>
      <text x="${w / 2}" y="${isLand ? 58 : 74}" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="13" font-weight="700" letter-spacing="1.2">${escSvg((card.set || '2026 TOPPS MARVEL').toUpperCase())}</text>
      <text x="${w / 2}" y="${isLand ? 132 : 185}" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="24" font-weight="800">${escSvg((card.character || 'New Card').slice(0, 22))}</text>
      <text x="${w / 2}" y="${isLand ? 166 : 220}" text-anchor="middle" fill="${c1}" font-family="sans-serif" font-size="15" font-weight="700">${escSvg((card.parallel || card.subset || '').slice(0, 30))}</text>
      <rect x="${w / 2 - 74}" y="${isLand ? 198 : 262}" width="148" height="34" rx="17" fill="url(#rim)" opacity="0.22"/>
      <text x="${w / 2}" y="${isLand ? 220 : 284}" text-anchor="middle" fill="#facc15" font-family="monospace" font-size="15" font-weight="800">${escSvg(card.cardNum || '#')} · ${escSvg(serial)}</text>
      <text x="${w / 2}" y="${h - 26}" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="11" font-weight="700">CLICK CARD TO ADD PHOTO</text>
    </svg>`;
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
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
    const fallbackUrl = isCardMissing(card)
      ? 'assets/cards/missing-card-icon.svg'
      : (card.placeholderSvg || generateCustomCardSvgUri(card));

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

  // Render Collapsible Character Biography Dossier (starts collapsed by default)
  function renderCharacterBioSection(container, bioKey) {
    const bio = BIOS[bioKey];
    if (!bio) return;

    const isOpen = Boolean(state.expandedBios[bioKey]);
    const sec = document.createElement('section');
    sec.className = `bio-accordion ${bio.accentClass || ''}` + (isOpen ? ' is-open' : '');

    const triggerStickerHTML = bio.sticker
      ? `<img src="${bio.sticker}" alt="${bio.stickerAlt || bio.title}" class="comic-sticker bio-trigger-sticker" loading="lazy" />`
      : '';

    sec.innerHTML = `
      <button type="button" class="bio-trigger" aria-expanded="${isOpen ? 'true' : 'false'}">
        <div class="bio-trigger-left">
          <span class="bio-chevron" aria-hidden="true">▸</span>
          ${triggerStickerHTML}
          <div>
            <span class="bio-eyebrow">${bio.eyebrow}</span>
            <span class="bio-heading-title">${bio.title}</span>
            <span class="bio-heading-sub">${bio.subtitle}</span>
          </div>
        </div>
        <div class="bio-trigger-right">
          <span class="bio-toggle-pill">${isOpen ? '📖 Hide Bio' : '📖 ' + bio.badgeText}</span>
        </div>
      </button>
      <div class="bio-body"></div>
    `;

    const trigger = sec.querySelector('.bio-trigger');
    const bodyEl = sec.querySelector('.bio-body');
    const pillEl = sec.querySelector('.bio-toggle-pill');

    function populateBioBody() {
      const factsHTML = bio.facts.map(f => `
        <div class="bio-fact-card">
          <span class="bio-fact-label">${f.label}</span>
          <div class="bio-fact-value">${f.value}</div>
        </div>
      `).join('');

      const originHTML = bio.originParagraphs.map(p => `<p>${p}</p>`).join('');

      const creatorsHTML = bio.creators.map(cr => `
        <div class="bio-creator-card">
          <div class="bio-creator-name">${cr.name}</div>
          <div class="bio-creator-role">${cr.role}</div>
          <p class="bio-creator-detail">${cr.detail}</p>
        </div>
      `).join('');

      const issuesHTML = bio.seminalIssues.map(iss => `
        <div class="bio-issue-card">
          <div class="bio-issue-top">
            <span class="bio-issue-code">${iss.issue}</span>
            <span class="bio-issue-date">${iss.date}</span>
          </div>
          <div class="bio-issue-title">${iss.title}</div>
          <p class="bio-issue-detail">${iss.detail}</p>
        </div>
      `).join('');

      const alliesHTML = bio.interactions.allies.map(a =>
        `<li><strong>${a.name}:</strong> ${a.note}</li>`
      ).join('');

      const villainsHTML = bio.interactions.villains.map(v =>
        `<li><strong>${v.name}:</strong> ${v.note}</li>`
      ).join('');

      const storiesHTML = bio.bestStoriesAndArt.map(st => `
        <div class="bio-story-card">
          <h5>${st.title}</h5>
          <p>${st.detail}</p>
        </div>
      `).join('');

      const spotlightHTML = bio.spotlightSticker
        ? `<div class="bio-spotlight-row">
             <blockquote class="bio-quote">${bio.leadQuote}</blockquote>
             <div class="bio-spotlight-art">
               <img src="${bio.spotlightSticker}" alt="${bio.spotlightStickerAlt || bio.title}" class="comic-sticker bio-spotlight-sticker" loading="lazy" />
             </div>
           </div>`
        : `<blockquote class="bio-quote">${bio.leadQuote}</blockquote>`;

      bodyEl.innerHTML = `
        ${spotlightHTML}

        <div class="bio-facts-grid">${factsHTML}</div>

        <div class="bio-block">
          <h4 class="bio-block-title">📰 Origin &amp; Comic Book History</h4>
          <div class="bio-prose">${originHTML}</div>
        </div>

        <div class="bio-block">
          <h4 class="bio-block-title">🎨 Creators, Writers &amp; Key Artists</h4>
          <div class="bio-creators-grid">${creatorsHTML}</div>
        </div>

        <div class="bio-block">
          <h4 class="bio-block-title">📚 Seminal Issues &amp; Key Milestones</h4>
          <div class="bio-issues-grid">${issuesHTML}</div>
        </div>

        <div class="bio-block">
          <h4 class="bio-block-title">🤝 Marvel Universe Interactions</h4>
          <div class="bio-relations-grid">
            <div class="bio-rel-col">
              <h5>🦸 Allies, Partners &amp; Team-Ups</h5>
              <ul class="bio-rel-list">${alliesHTML}</ul>
            </div>
            <div class="bio-rel-col">
              <h5>⚡ Villains, Rivals &amp; Cosmic Foes</h5>
              <ul class="bio-rel-list">${villainsHTML}</ul>
            </div>
          </div>
        </div>

        <div class="bio-block">
          <h4 class="bio-block-title">🌟 Best Stories, Iconic Art &amp; Beyond Comics</h4>
          <div class="bio-stories-grid">${storiesHTML}</div>
        </div>
      `;
    }

    if (isOpen) {
      populateBioBody();
    }

    trigger.addEventListener('click', () => {
      const nowOpen = !state.expandedBios[bioKey];
      state.expandedBios[bioKey] = nowOpen;
      sec.classList.toggle('is-open', nowOpen);
      trigger.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      pillEl.textContent = nowOpen ? '📖 Hide Bio' : '📖 ' + bio.badgeText;
      if (nowOpen && !bodyEl.hasChildNodes()) {
        populateBioBody();
      }
    });

    container.appendChild(sec);
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

    // Sort controls ONLY on Kandy's sections (Pull Rarity, Card Serial # & Name — removed on Hope's sections)
    const sortControlHTML = !isHopeSection ? `
      <div class="sort-controls">
        <span class="sort-label">Sort by:</span>
        <div class="segmented">
          <button class="${sortMode === 'rarity' ? 'active' : ''}" data-sort="rarity">🎯 Pull Rarity</button>
          <button class="${sortMode === 'cardnum' ? 'active' : ''}" data-sort="cardnum">🔢 Card #</button>
          <button class="${sortMode === 'name' ? 'active' : ''}" data-sort="name">🔤 Name</button>
        </div>
      </div>` : '';

    const countBadgeText = isRainbowDisplay
      ? `${ownedSectionCards.length} Owned · ${missingSectionCards.length} Missing`
      : `${ownedSectionCards.length} Cards`;

    const dispSticker = DISPLAY_STICKERS[displayId] || null;
    const titleBlockHTML = dispSticker
      ? (dispSticker.isGif
          ? `<div class="display-title-with-sticker">
               <button type="button" class="gif-cinema-btn gif-frame-square"
                 data-gif-src="${dispSticker.src}"
                 data-gif-title="${dispSticker.title}"
                 data-gif-caption="${dispSticker.caption}"
                 aria-label="Enlarge ${dispSticker.title} animation">
                 <img class="vault-anim-gif"
                   src="${state.animationsPaused ? dispSticker.poster : dispSticker.src}"
                   data-gif="${dispSticker.src}"
                   data-poster="${dispSticker.poster}"
                   alt="${dispSticker.alt}"
                   width="${dispSticker.width}" height="${dispSticker.height}" loading="lazy" decoding="async" />
                 <span class="gif-zoom-pill" aria-hidden="true">🔍</span>
                 <span class="gif-paused-pill" aria-hidden="true">▶</span>
               </button>
               <div class="display-title-group">
                 <h2>${meta.title}</h2>
                 <p>${meta.subtitle}</p>
               </div>
             </div>`
          : `<div class="display-title-with-sticker">
               <img src="${dispSticker.src}" alt="${dispSticker.alt}" class="comic-sticker section-header-sticker ${dispSticker.cls || ''}" loading="lazy" />
               <div class="display-title-group">
                 <h2>${meta.title}</h2>
                 <p>${meta.subtitle}</p>
               </div>
             </div>`)
      : `<div class="display-title-group">
           <h2>${meta.title}</h2>
           <p>${meta.subtitle}</p>
         </div>`;

    sec.innerHTML = `
      <div class="display-header">
        ${titleBlockHTML}
        <div class="display-badges">
          <span class="pill ${meta.owner === 'Hope' ? 'pill-pink' : 'pill-cyan'}">${countBadgeText}</span>
          <button type="button" class="btn btn-primary btn-add-inline gh-only" data-add-display="${displayId}">➕ Add Card</button>
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

    const addInlineBtn = sec.querySelector('[data-add-display]');
    if (addInlineBtn) {
      addInlineBtn.addEventListener('click', () => openAddCardModal(displayId));
    }

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
  function getSectionChecklistStats(secCards) {
    const ownedCards = secCards.filter(c => !isCardMissing(c));
    const missingCards = secCards.filter(c => isCardMissing(c));
    const uniqueTotal = new Set(secCards.map(c => String(c.cardNum || c.id).toUpperCase())).size;
    const uniqueOwned = new Set(ownedCards.map(c => String(c.cardNum || c.id).toUpperCase())).size;
    const pct = Math.min(100, Math.round((uniqueOwned / Math.max(1, uniqueTotal)) * 100));
    return { ownedCards, missingCards, uniqueTotal, uniqueOwned, pct };
  }

  function populateAccordionBody(bodyEl, meta) {
    const displayId = meta.id;
    const allSectionCards = CARDS.filter(c => c.display === displayId);
    const { ownedCards: ownedSectionCards, missingCards: missingSectionCards, uniqueTotal, uniqueOwned, pct } = getSectionChecklistStats(allSectionCards);
    const statusFilter = state.sectionStatusFilter[displayId] || 'owned';
    // Default: Pull Rarity for Owned, exact Card # Checklist Order for All/Missing (respects user override)
    const explicitSort = state.sectionSort[displayId];
    const effectiveSort = explicitSort || (statusFilter === 'owned' ? 'rarity' : 'cardnum');

    let visibleCards = ownedSectionCards;
    if (statusFilter === 'all') visibleCards = allSectionCards;
    else if (statusFilter === 'missing') visibleCards = missingSectionCards;

    const sortedCards = sortCards(visibleCards, effectiveSort);
    const extraVariantNote = ownedSectionCards.length > uniqueOwned
      ? ` · ${ownedSectionCards.length} Total Owned`
      : '';

    bodyEl.innerHTML = `
      <div class="rainbow-bar-box" style="margin-top:12px;margin-bottom:16px;">
        <div class="rainbow-bar-top">
          <span>✨ ${meta.title} Progress — ${uniqueOwned} of ${uniqueTotal} Checklist Slots Filled${extraVariantNote} (${missingSectionCards.length} Empty Slots)</span>
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
              <button class="${effectiveSort === 'cardnum' ? 'active' : ''}" data-sort="cardnum">🔢 Card #</button>
              <button class="${effectiveSort === 'rarity' ? 'active' : ''}" data-sort="rarity">🎯 Pull Rarity</button>
              <button class="${effectiveSort === 'name' ? 'active' : ''}" data-sort="name">🔤 Name</button>
            </div>
          </div>
          <button type="button" class="btn btn-primary btn-add-inline gh-only" data-add-sub="${displayId}">➕ Add Card</button>
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
        // Reset to natural default for All/Missing so proper checklist order kicks in automatically
        if (btn.dataset.sfilter !== 'owned' && state.sectionSort[displayId] === 'rarity') {
          delete state.sectionSort[displayId];
        }
        populateAccordionBody(bodyEl, meta);
      });
    });

    const addSubBtn = bodyEl.querySelector('[data-add-sub]');
    if (addSubBtn) {
      addSubBtn.addEventListener('click', () => openAddCardModal(displayId));
    }

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
      const { ownedCards, uniqueTotal, uniqueOwned, pct } = getSectionChecklistStats(secCards);
      const ownedPillText = ownedCards.length > uniqueOwned
        ? `${ownedCards.length} Owned (${uniqueOwned}/${uniqueTotal})`
        : `${ownedCards.length} / ${uniqueTotal} Owned`;
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
            <span class="pill ${ownedCards.length > 0 ? 'pill-owned-hit' : 'pill-zero'}">${ownedPillText}</span>
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
    const markOwnedCb = document.getElementById('opt-mark-owned');
    if (markOwnedCb) markOwnedCb.checked = false;
    syncModalStatusUI(card, missing, false);

    document.getElementById('modal-filepath').textContent = card.recommendedPath;
    const customActions = document.getElementById('custom-card-actions');
    if (customActions) customActions.hidden = !Boolean(card.isCustom);
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
    updateDriftIndicatorUI();
  }


  // ==========================================================================
  // ADD CARD STUDIO MODAL (SET -> SUB-SECTION -> SERIAL -> PHOTO)
  // ==========================================================================
  function slugifyStr(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/['’"]/g, '')
      .replace(/&/g, 'and')
      .replace(/\//g, '-')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'card';
  }

  function parseNumberedInput(rawText) {
    const cleaned = String(rawText || '').trim();
    if (!cleaned || cleaned.toLowerCase() === 'unnumbered') {
      return { serial: 'Unnumbered', printRun: null };
    }
    const m = cleaned.match(/^(\d*)\s*\/\s*(\d+)$/);
    if (m) {
      const pr = parseInt(m[2], 10);
      const numPart = m[1] ? m[1] : '';
      return { serial: numPart ? `${numPart}/${pr}` : `/${pr}`, printRun: isNaN(pr) ? null : pr };
    }
    return { serial: cleaned, printRun: null };
  }

  function normalizeCardNumInput(rawText) {
    const cleaned = String(rawText || '').trim();
    if (!cleaned) return '';
    return cleaned.startsWith('#') ? cleaned : `#${cleaned}`;
  }

  function getDisplaysForSet(setName) {
    if (setName === '2026 Topps Neon Marvel') {
      return DISPLAYS.filter(d => d.id === 5 || d.id === 6 || d.isNeonInsert);
    }
    if (setName === '2026 Topps Chrome Marvel Sapphire') {
      return DISPLAYS.filter(d => d.id === 6 || d.id === 3);
    }
    // 2026 Topps Chrome Marvel
    return DISPLAYS.filter(d => d.id === 1 || d.id === 2 || d.id === 3 || d.isChromeInsert);
  }

  function getDefaultSetForDisplay(displayId) {
    const d = DISPLAYS.find(x => x.id === displayId);
    if (!d) return '2026 Topps Chrome Marvel';
    if (d.id === 5 || d.isNeonInsert) return '2026 Topps Neon Marvel';
    if (d.id === 6) return '2026 Topps Neon Marvel';
    return '2026 Topps Chrome Marvel';
  }

  function populateAddSubsections(setName, preselectDisplayId = null) {
    const sel = document.getElementById('add-subsection');
    const valid = getDisplaysForSet(setName);
    const groups = [];

    const hopeDisps = valid.filter(d => d.owner === 'Hope');
    const kandyBase = valid.filter(d => d.owner === 'Kandy' && !d.isChromeInsert && !d.isNeonInsert);
    const kandyIns = valid.filter(d => d.isChromeInsert || d.isNeonInsert);

    if (hopeDisps.length) groups.push({ label: "🌈 Hope's Sections", items: hopeDisps });
    if (kandyBase.length) groups.push({ label: "🏆 Kandy's Base Sections", items: kandyBase });
    if (kandyIns.length) groups.push({ label: `📚 Kandy's Insert & Auto Sub-Sections (${kandyIns.length})`, items: kandyIns });

    sel.innerHTML = groups.map(g => `
      <optgroup label="${g.label}">
        ${g.items.map(d => `<option value="${d.id}">${d.title}</option>`).join('')}
      </optgroup>
    `).join('');

    if (preselectDisplayId && valid.some(d => d.id === Number(preselectDisplayId))) {
      sel.value = String(preselectDisplayId);
    }
    populateAddChecklistAndSuggestions();
  }

  function populateAddChecklistAndSuggestions() {
    const setName = document.getElementById('add-set').value;
    const displayId = Number(document.getElementById('add-subsection').value);
    const disp = DISPLAYS.find(d => d.id === displayId);

    // 1. Populate Quick-Fill Checklist dropdown for this sub-section (unique cardNum slots)
    const pickSel = document.getElementById('add-checklist-pick');
    const pickWrap = document.getElementById('add-checklist-wrap');
    const secCards = CARDS.filter(c => c.display === displayId);
    const seenNums = new Map();
    sortCards(secCards, 'cardnum').forEach(c => {
      const key = `${c.cardNum}|||${c.character}`;
      if (!seenNums.has(key)) seenNums.set(key, c);
    });

    const uniqueSlots = [...seenNums.values()];
    if (uniqueSlots.length > 0 && displayId !== 1 && displayId !== 2) {
      pickWrap.style.display = 'block';
      pickSel.innerHTML = '<option value="">— Type manually or pick an existing card # to clone —</option>' +
        uniqueSlots.map(c => {
          const tag = c.artist ? ` (${c.artist})` : '';
          return `<option value="${c.id}">${c.cardNum} — ${c.character}${tag}</option>`;
        }).join('');
    } else {
      pickWrap.style.display = 'none';
      pickSel.innerHTML = '<option value="">—</option>';
    }

    // 2. Smart auto-fill for dedicated character rainbows & horizontal sets
    const numEl = document.getElementById('add-card-num');
    const charEl = document.getElementById('add-character');
    const oriEl = document.getElementById('add-orientation');

    if (displayId === 1) {
      numEl.value = '#138';
      charEl.value = 'Moon Girl';
    } else if (displayId === 2) {
      numEl.value = '#110';
      charEl.value = 'Devil Dinosaur';
    }
    if (displayId === 206) {
      oriEl.value = 'landscape';
    } else if (oriEl.value === 'landscape' && displayId !== 206) {
      oriEl.value = 'portrait';
    }

    // 3. Populate parallel autocomplete suggestions relevant to the chosen set
    const parList = document.getElementById('vault-parallels-list');
    const parSet = new Set();
    if (disp && (disp.isChromeInsert || disp.isNeonInsert)) {
      parSet.add(disp.title);
      parSet.add(`${disp.title} — Gold Refractor`);
      parSet.add(`${disp.title} — Orange Refractor`);
      parSet.add(`${disp.title} — Black Refractor`);
      parSet.add(`${disp.title} — Red Refractor`);
      parSet.add(`${disp.title} — Purple Refractor`);
      parSet.add(`${disp.title} — Green Refractor`);
      parSet.add(`${disp.title} — Gold Foil`);
    }
    BASE_CARDS.filter(c => c.set === setName).forEach(c => {
      if (c.parallel) parSet.add(c.parallel);
    });
    parList.innerHTML = [...parSet].sort().map(p => `<option value="${escSvg(p)}"></option>`).join('');

    // 4. Populate character autocomplete datalist
    const charList = document.getElementById('vault-characters-list');
    if (!charList.hasChildNodes()) {
      const chars = [...new Set(BASE_CARDS.map(c => c.character).filter(Boolean))].sort();
      charList.innerHTML = chars.map(ch => `<option value="${escSvg(ch)}"></option>`).join('');
    }

    updateAddCardPreview();
  }

  function buildCardObjectFromAddForm() {
    const setName = document.getElementById('add-set').value;
    const displayId = Number(document.getElementById('add-subsection').value);
    const disp = DISPLAYS.find(d => d.id === displayId) || DISPLAYS[0];
    const cardNum = normalizeCardNumInput(document.getElementById('add-card-num').value) || '#1';
    const character = (document.getElementById('add-character').value || '').trim() || 'New Card';
    const { serial, printRun } = parseNumberedInput(document.getElementById('add-numbered').value);
    const rawPar = (document.getElementById('add-parallel').value || '').trim();
    const isInsert = Boolean(disp.isChromeInsert || disp.isNeonInsert);
    const parallel = rawPar || (isInsert ? disp.title : (printRun ? `Numbered Parallel /${printRun}` : 'Base Card'));
    const grade = document.getElementById('add-grade').value || null;
    const orientation = document.getElementById('add-orientation').value || 'portrait';
    const artist = (document.getElementById('add-artist').value || '').trim() || null;
    const valLow = Math.max(0, parseInt(document.getElementById('add-val-low').value || '0', 10) || 0);
    const rawHigh = parseInt(document.getElementById('add-val-high').value || '0', 10) || 0;
    const valHigh = Math.max(valLow, rawHigh);

    const tags = [];
    if (setName.includes('Neon')) tags.push('Neon');
    if (setName.includes('Sapphire')) tags.push('Sapphire');
    if (isInsert) tags.push('Insert');
    if (grade) tags.push(grade.includes('10') ? 'ACE 10' : 'ACE 9');
    if (printRun && printRun <= 10) tags.push('Ultra Rare', `/${printRun} Hit`);
    else if (printRun && printRun <= 25) tags.push('Low Numbered');
    else if (printRun === 50) tags.push('Gold /50');
    if (serial.startsWith('1/') || serial.startsWith('01/') || serial.startsWith('001/')) tags.push('Alpha #1');
    if (printRun && serial === `${printRun}/${printRun}`) tags.push('Bookend');
    if ((disp.title || '').toLowerCase().includes('autograph') || parallel.toLowerCase().includes('auto')) tags.push('Autograph');
    if (['1-UP', 'Neon Heroines', 'Neon Villains', 'Neon Tarots', 'Marvel Murals', 'Topps Originals', 'Varied Visage AoA', 'Astonishing', 'Marvel Reflections'].includes(disp.title)) {
      tags.push('Case Hit');
    }
    if (orientation === 'landscape') tags.push('Horizontal');

    const folder = disp.folder || 'display-3-chrome-hits';
    const uniqueSuffix = Date.now().toString(36).slice(-5);
    const numSlug = slugifyStr(cardNum);
    const charSlug = slugifyStr(character);
    const parSlug = slugifyStr(parallel).slice(0, 28);
    const serSlug = slugifyStr(serial);
    const baseFilename = `custom_d${displayId}_${numSlug}_${charSlug}_${parSlug}_${serSlug}_${uniqueSuffix}`;

    const subset = isInsert
      ? disp.title
      : (setName.includes('Neon') ? 'Neon Parallel' : (setName.includes('Sapphire') ? 'Sapphire Parallel' : 'Base Parallel'));

    return {
      id: `custom-${displayId}-${uniqueSuffix}-${Math.random().toString(36).slice(2, 6)}`,
      display: displayId,
      row: 98,
      col: 1,
      slot: cardNum.replace(/^#/, ''),
      owner: disp.owner,
      set: setName,
      cardNum,
      character,
      artist,
      subset,
      parallel,
      serial,
      printRun,
      format: 'All Formats',
      odds: printRun ? `Numbered /${printRun}` : (isInsert ? 'Insert' : 'Base / Parallel'),
      valLow,
      valHigh,
      grade,
      tags: [...new Set(tags)],
      theme: setName.includes('Neon') ? 'neon-cyan' : 'purple',
      pattern: isInsert ? 'insert' : 'smooth',
      orientation,
      folder,
      baseFilename,
      recommendedPath: `assets/cards/${folder}/${baseFilename}.jpg`,
      placeholderSvg: null,
      missing: false,
      isCustom: true,
      updatedAt: Date.now()
    };
  }

  function updateAddCardPreview() {
    const draft = buildCardObjectFromAddForm();
    const previewTile = document.getElementById('add-drop-zone');
    const preview3d = document.getElementById('add-preview-3d');
    const imgEl = document.getElementById('add-preview-img');
    const gradeBadge = document.getElementById('add-preview-grade-badge');

    previewTile.classList.toggle('is-landscape', draft.orientation === 'landscape');
    const isSlab = Boolean(draft.grade);
    const slabTier = isSlab ? (draft.grade.includes('10') ? 'ace-10' : 'ace-9') : '';
    preview3d.className = 'card-3d' + (isSlab ? ` is-slab ${slabTier}` : '');

    if (isSlab) {
      gradeBadge.style.display = 'inline-flex';
      gradeBadge.className = `ace-floating-badge ${slabTier}`;
      const labelBrand = draft.grade.startsWith('PSA') ? 'PSA' : 'ACE';
      const labelNum = draft.grade.includes('10') ? '10' : '9';
      gradeBadge.innerHTML = `<span>${labelBrand}</span><span class="grade-num">${labelNum}</span>`;
    } else {
      gradeBadge.style.display = 'none';
    }

    document.getElementById('add-prev-char').textContent = draft.character;
    document.getElementById('add-prev-par').textContent = draft.artist
      ? `${draft.parallel} · ${draft.artist}`
      : draft.parallel;
    document.getElementById('add-prev-num').textContent = draft.cardNum;

    const serEl = document.getElementById('add-prev-serial');
    const isNum = draft.serial !== 'Unnumbered';
    serEl.textContent = draft.serial;
    serEl.className = 'serial-chip' + (isNum ? '' : ' serial-unnumbered');

    if (state.stagedAddPhoto && state.stagedAddPhoto.previewUrl) {
      previewTile.classList.add('has-real-photo');
      imgEl.src = state.stagedAddPhoto.previewUrl;
    } else {
      previewTile.classList.remove('has-real-photo');
      imgEl.src = generateCustomCardSvgUri(draft);
    }
  }

  function clearStagedAddPhoto() {
    if (state.stagedAddPhoto && state.stagedAddPhoto.previewUrl) {
      URL.revokeObjectURL(state.stagedAddPhoto.previewUrl);
    }
    state.stagedAddPhoto = null;
    document.getElementById('add-clear-photo-btn').style.display = 'none';
    document.getElementById('add-photo-meta').innerHTML =
      'Drop an image above, pick from phone/Google Photos, or press <strong>Ctrl+V</strong>. Optional — you can add or swap the photo later too.';
    updateAddCardPreview();
  }

  async function stageAddCardPhotoBlob(blob) {
    if (!blob) return;
    const metaEl = document.getElementById('add-photo-meta');
    metaEl.textContent = 'Optimising photo preview...';
    try {
      const processed = await processImageBlob(blob, true);
      if (state.stagedAddPhoto && state.stagedAddPhoto.previewUrl) {
        URL.revokeObjectURL(state.stagedAddPhoto.previewUrl);
      }
      const previewUrl = URL.createObjectURL(processed.blob);
      state.stagedAddPhoto = {
        previewUrl,
        outBlob: processed.blob,
        outBase64: processed.base64
      };
      document.getElementById('add-clear-photo-btn').style.display = 'inline-flex';
      metaEl.textContent = `✅ Photo ready · ${processed.width}×${processed.height}px (${fmtKB(processed.blob.size)})`;
      updateAddCardPreview();
    } catch (err) {
      metaEl.textContent = `❌ Could not process image: ${err.message}`;
    }
  }

  function openAddCardModal(preselectDisplayId = null) {
    if (!hasGitHubEditPermissions()) {
      openGHModal('Connect GitHub Sync with write permissions to add cards to the vault.');
      return;
    }

    // Reset form cleanly
    document.getElementById('add-card-form').reset();
    clearStagedAddPhoto();
    const st = document.getElementById('add-card-status');
    st.textContent = '';
    st.className = 'upload-status';

    let targetDisplayId = preselectDisplayId;
    if (!targetDisplayId) {
      if (state.activeTab === 'chrome') targetDisplayId = 3;
      else if (state.activeTab === 'neon') targetDisplayId = 5;
      else targetDisplayId = 1;
    }

    const defaultSet = getDefaultSetForDisplay(Number(targetDisplayId));
    document.getElementById('add-set').value = defaultSet;
    populateAddSubsections(defaultSet, targetDisplayId);

    document.getElementById('add-card-modal').classList.add('open');
  }

  function closeAddCardModal() {
    clearStagedAddPhoto();
    document.getElementById('add-card-modal').classList.remove('open');
  }

  async function commitNewCard(saveToGitHub = false) {
    const numVal = (document.getElementById('add-card-num').value || '').trim();
    const charVal = (document.getElementById('add-character').value || '').trim();
    const st = document.getElementById('add-card-status');

    if (!numVal || !charVal) {
      st.textContent = 'Please enter both a Card Serial # (e.g. #FF-46) and Character Name.';
      st.className = 'upload-status err';
      return;
    }

    if (saveToGitHub && !hasGitHubEditPermissions()) {
      openGHModal('Connect your GitHub token to save new cards directly to GitHub!');
      return;
    }

    const newCard = buildCardObjectFromAddForm();
    const ghBtn = document.getElementById('add-save-gh-btn');
    const locBtn = document.getElementById('add-save-local-btn');

    ghBtn.disabled = true;
    locBtn.disabled = true;

    try {
      // 1. If a photo was staged, handle local IndexedDB + optional GitHub upload
      if (state.stagedAddPhoto) {
        const keepUrl = URL.createObjectURL(state.stagedAddPhoto.outBlob);
        state.sessionPhotos[newCard.id] = keepUrl;
        state.realPhotoLoaded[newCard.id] = true;
        await saveLocalPhotoBlob(newCard.id, state.stagedAddPhoto.outBlob);

        if (saveToGitHub) {
          st.textContent = `⏳ Uploading photo (${newCard.recommendedPath}) to GitHub...`;
          st.className = 'upload-status';
          await uploadToGitHub(
            newCard.recommendedPath,
            state.stagedAddPhoto.outBase64,
            `Add card photo: ${newCard.character} (${newCard.cardNum} ${newCard.serial})`
          );
          markRecentUpload(newCard.recommendedPath);
          state.recentUploads = loadRecentUploads();
        }
      }

      // 2. Append card to customStore WITHOUT touching any existing cards or empty slots!
      state.customStore.cards.push(newCard);
      state.customStore.deletedIds = (state.customStore.deletedIds || []).filter(id => id !== newCard.id);
      saveLocalCustomStore(state.customStore);
      syncCardsArray();

      // 3. Commit js/custom-cards.json to GitHub if requested
      if (saveToGitHub) {
        st.textContent = '⏳ Saving js/custom-cards.json to GitHub...';
        st.className = 'upload-status';
        await saveCustomCardsToGitHub(
          `Add card to vault: ${newCard.character} (${newCard.cardNum} ${newCard.serial})`
        );
      }

      // Expand the target accordion automatically if it's an insert section so Kandy sees his new card immediately!
      if (ALL_INSERT_IDS.has(newCard.display)) {
        state.expandedInserts[newCard.display] = true;
      }

      renderActiveTab();
      updatePhotoCounter();
      burstConfetti();

      const msg = saveToGitHub
        ? `✅ Added ${newCard.character} (${newCard.cardNum} · ${newCard.serial}) & saved to GitHub!`
        : `💾 Added ${newCard.character} (${newCard.cardNum} · ${newCard.serial}) locally!`;
      st.textContent = msg;
      st.className = 'upload-status ok';
      showToast(msg);

      setTimeout(() => closeAddCardModal(), 1050);
    } catch (err) {
      st.textContent = `❌ Could not save card: ${err.message}`;
      st.className = 'upload-status err';
    } finally {
      ghBtn.disabled = false;
      locBtn.disabled = false;
    }
  }

  async function deleteCustomCard(card) {
    if (!card || !card.isCustom) return;
    if (!confirm(`Remove added card "${card.character} (${card.cardNum} · ${getCardSerial(card)})" from the vault?`)) return;

    state.customStore.cards = (state.customStore.cards || []).filter(c => c.id !== card.id);
    if (!state.customStore.deletedIds) state.customStore.deletedIds = [];
    if (!state.customStore.deletedIds.includes(card.id)) state.customStore.deletedIds.push(card.id);
    saveLocalCustomStore(state.customStore);
    delete state.sessionPhotos[card.id];
    delete state.realPhotoLoaded[card.id];
    await deleteLocalPhotoBlob(card.id);

    syncCardsArray();
    renderActiveTab();
    updatePhotoCounter();

    if (hasGitHubEditPermissions()) {
      try {
        await saveCustomCardsToGitHub(`Remove custom card: ${card.character} (${card.cardNum})`);
        showToast(`☁️ Removed ${card.character} & synced to GitHub.`);
      } catch (err) {
        showToast(`Removed locally (GitHub sync error: ${err.message})`);
      }
    } else {
      showToast(`Removed ${card.character} locally.`);
    }
    closeCardModal();
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

  function openAboutModal() {
    const verEl = document.getElementById('about-version-num');
    if (verEl) verEl.textContent = APP_VERSION;
    document.getElementById('about-modal').classList.add('open');
  }

  function closeAboutModal() {
    document.getElementById('about-modal').classList.remove('open');
  }

  function syncAnimationsState() {
    const paused = Boolean(state.animationsPaused);
    document.body.classList.toggle('anims-paused', paused);
    const btn = document.getElementById('anim-toggle-btn');
    if (btn) {
      btn.textContent = paused ? '▶️ Animations: Paused' : '🎬 Animations: On';
      btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    }
    document.querySelectorAll('img.vault-anim-gif').forEach(img => {
      const target = paused ? img.dataset.poster : img.dataset.gif;
      if (target && img.getAttribute('src') !== target) {
        img.setAttribute('src', target);
      }
    });
  }

  function openGifLightbox(gifSrc, title, caption) {
    if (!gifSrc) return;
    const modal = document.getElementById('gif-lightbox-modal');
    const img = document.getElementById('gif-lightbox-img');
    document.getElementById('gif-lightbox-title').textContent = title || 'Vault Animation';
    document.getElementById('gif-lightbox-caption').textContent = caption || '';
    img.src = gifSrc;
    img.alt = title || 'Vault animation';
    modal.classList.add('open');
  }

  function closeGifLightbox() {
    const modal = document.getElementById('gif-lightbox-modal');
    if (modal) modal.classList.remove('open');
  }

  // Batch Folder Photo Loader
  function handleFolderUpload(files) {
    let matched = 0;
    const mapByStem = {};
    CARDS.forEach(c => { mapByStem[c.baseFilename.toLowerCase()] = c; });

    Array.from(files).forEach(file => {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return;
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
      renderCharacterBioSection(wrap, 'moon-girl');
      renderDisplaySection(wrap, 1);
      renderCharacterBioSection(wrap, 'devil-dinosaur');
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
    syncAnimationsState();
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
  // Auto-resolve Sets/Odds banner artwork (.jpg / .jpeg / .png / .webp with graceful fallback)
  function initOddsBannerArt() {
    const img = document.getElementById('sets-odds-banner-img');
    const btn = document.getElementById('sets-odds-banner-btn');
    if (!img) return;
    const candidates = [
      'assets/illustrations/kandy-hope-odds-confused.jpg',
      'assets/illustrations/kandy-hope-odds-confused.jpeg',
      'assets/illustrations/kandy-hope-odds-confused.png',
      'assets/illustrations/kandy-hope-odds-confused.webp',
      'assets/illustrations/kandy-hope-waving.jpg'
    ];
    let idx = 0;
    function tryNext() {
      if (idx >= candidates.length) return;
      const url = candidates[idx++];
      img.onload = () => {
        if (btn) btn.dataset.gifSrc = url;
      };
      img.src = url;
    }
    img.onerror = tryNext;
    tryNext();
  }

  document.addEventListener('DOMContentLoaded', () => {
    initHeroPhoto();
    initOddsBannerArt();
    updateGHButtonState();

    // Sync version labels & About modal controls
    const topVerPill = document.getElementById('app-version-pill');
    const modalVerNum = document.getElementById('about-version-num');
    if (topVerPill) topVerPill.textContent = APP_VERSION;
    if (modalVerNum) modalVerNum.textContent = APP_VERSION;

    document.getElementById('about-btn').addEventListener('click', openAboutModal);
    document.getElementById('add-card-btn').addEventListener('click', () => openAddCardModal(null));
    document.getElementById('add-card-close-btn').addEventListener('click', closeAddCardModal);
    document.getElementById('add-card-modal').addEventListener('click', (e) => {
      if (e.target.id === 'add-card-modal') closeAddCardModal();
    });

    document.getElementById('add-set').addEventListener('change', (e) => {
      populateAddSubsections(e.target.value, null);
    });
    document.getElementById('add-subsection').addEventListener('change', populateAddChecklistAndSuggestions);

    document.getElementById('add-checklist-pick').addEventListener('change', (e) => {
      const pickedId = e.target.value;
      if (!pickedId) return;
      const src = CARDS.find(c => c.id === pickedId);
      if (!src) return;
      document.getElementById('add-card-num').value = src.cardNum || '';
      document.getElementById('add-character').value = src.character || '';
      if (src.artist) document.getElementById('add-artist').value = src.artist;
      document.getElementById('add-orientation').value = src.orientation || 'portrait';
      updateAddCardPreview();
    });

    ['add-card-num', 'add-character', 'add-numbered', 'add-parallel', 'add-grade', 'add-orientation', 'add-artist'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updateAddCardPreview);
        el.addEventListener('change', updateAddCardPreview);
      }
    });

    document.getElementById('add-choose-photo-btn').addEventListener('click', () => {
      document.getElementById('add-card-photo-input').click();
    });
    document.getElementById('add-card-photo-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) stageAddCardPhotoBlob(file);
      e.target.value = '';
    });
    document.getElementById('add-clear-photo-btn').addEventListener('click', clearStagedAddPhoto);

    document.getElementById('add-paste-photo-btn').addEventListener('click', async () => {
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
            await stageAddCardPhotoBlob(blob);
            return;
          }
        }
        showToast('No image found on clipboard — copy an image first, then click Paste!');
      } catch (_) {
        showToast('Tip: Press Ctrl+V on your keyboard to paste your copied image!');
      }
    });

    const addDropZone = document.getElementById('add-drop-zone');
    addDropZone.addEventListener('dragover', (e) => {
      if (!hasGitHubEditPermissions()) return;
      e.preventDefault();
      addDropZone.classList.add('drag-over');
    });
    addDropZone.addEventListener('dragleave', () => addDropZone.classList.remove('drag-over'));
    addDropZone.addEventListener('drop', (e) => {
      if (!hasGitHubEditPermissions()) return;
      e.preventDefault();
      addDropZone.classList.remove('drag-over');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) stageAddCardPhotoBlob(file);
    });

    document.getElementById('add-save-gh-btn').addEventListener('click', () => commitNewCard(true));
    document.getElementById('add-save-local-btn').addEventListener('click', () => commitNewCard(false));
    document.getElementById('modal-delete-custom-btn').addEventListener('click', () => deleteCustomCard(currentModalCard));
    if (topVerPill) topVerPill.addEventListener('click', openAboutModal);
    document.getElementById('about-close-btn').addEventListener('click', closeAboutModal);
    document.getElementById('about-modal').addEventListener('click', (e) => {
      if (e.target.id === 'about-modal') closeAboutModal();
    });

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

    // Animations Play/Pause toggle (accessible + reduced-motion friendly)
    document.getElementById('anim-toggle-btn').addEventListener('click', () => {
      state.animationsPaused = !state.animationsPaused;
      try { localStorage.setItem(ANIM_PREF_KEY, String(state.animationsPaused)); } catch (_) {}
      syncAnimationsState();
      showToast(state.animationsPaused ? '⏸️ Animations paused (click any scene to watch!)' : '🎬 Vault animations playing!');
    });

    // Delegated click handler for all Animated Cinema Frames (including dynamic Display 6)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.gif-cinema-btn');
      if (!btn) return;
      openGifLightbox(btn.dataset.gifSrc, btn.dataset.gifTitle, btn.dataset.gifCaption);
    });

    document.getElementById('gif-lightbox-close-btn').addEventListener('click', closeGifLightbox);
    document.getElementById('gif-lightbox-modal').addEventListener('click', (e) => {
      if (e.target.id === 'gif-lightbox-modal') closeGifLightbox();
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
    document.getElementById('gh-drift-btn').addEventListener('click', () => openGHModal('Review and push your local changes so all browsers stay in sync!'));

    document.getElementById('gh-push-local-btn').addEventListener('click', async () => {
      if (!hasGitHubEditPermissions()) return;
      const btn = document.getElementById('gh-push-local-btn');
      const st = document.getElementById('gh-test-status');
      btn.disabled = true;
      btn.textContent = '⏳ Pushing...';
      st.textContent = 'Syncing local card statuses & custom cards to GitHub...';
      st.className = 'upload-status';
      try {
        await saveStatusOverridesToGitHub('Sync local card statuses to GitHub');
        await saveCustomCardsToGitHub('Sync local custom cards to GitHub');
        renderActiveTab();
        st.textContent = '✅ All local changes synced to GitHub! Live site refreshes in ~45s.';
        st.className = 'upload-status ok';
        showToast('✅ Local changes pushed to GitHub!');
      } catch (err) {
        st.textContent = `❌ Sync failed: ${err.message}`;
        st.className = 'upload-status err';
      } finally {
        btn.disabled = false;
        btn.textContent = '☁️ Push Local Changes to GitHub';
      }
    });

    document.getElementById('gh-reset-local-btn').addEventListener('click', async () => {
      if (!confirm('Reset local browser status & custom card cache to match GitHub Pages exactly?')) return;
      state.statusOverrides = { ...state.remoteStatusOverrides };
      saveLocalStatusOverrides(state.statusOverrides);
      state.customStore = {
        cards: [...(state.remoteCustomStore.cards || [])],
        deletedIds: [...(state.remoteCustomStore.deletedIds || [])]
      };
      saveLocalCustomStore(state.customStore);
      syncCardsArray();
      renderActiveTab();
      updateDriftIndicatorUI();
      const st = document.getElementById('gh-test-status');
      st.textContent = '🔄 Local cache reset to match GitHub Pages exactly.';
      st.className = 'upload-status ok';
      showToast('🔄 Local browser cache synced with GitHub!');
    });
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
      if (state.remoteStatusLoaded) {
        state.statusOverrides = { ...state.remoteStatusOverrides };
        saveLocalStatusOverrides(state.statusOverrides);
      }
      if (state.remoteCustomLoaded) {
        state.customStore = {
          cards: [...(state.remoteCustomStore.cards || [])],
          deletedIds: [...(state.remoteCustomStore.deletedIds || [])]
        };
        saveLocalCustomStore(state.customStore);
        syncCardsArray();
      }
      renderActiveTab();
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
      if (e.key === 'Escape') { closeCardModal(); closeGHModal(); closeAboutModal(); closeAddCardModal(); closeGifLightbox(); }
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
      const isCardOpen = document.getElementById('card-modal').classList.contains('open');
      const isAddOpen = document.getElementById('add-card-modal').classList.contains('open');
      if (!isCardOpen && !isAddOpen) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            if (isAddOpen) stageAddCardPhotoBlob(blob);
            else stageCardPhotoBlob(blob);
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
        await saveLocalPhotoBlob(currentModalCard.id, state.stagedCardPhoto.outBlob);
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
    hydrateLocalPhotoBlobs();
    loadRemoteStatusOverrides();
    loadRemoteCustomCards();
    verifyStoredGitHubPermissions();
  });
})();
