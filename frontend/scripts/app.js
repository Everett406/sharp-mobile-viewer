/**
 * SharpView - Main Application Logic
 * Version: 0.1.0
 *
 * Page routing, settings management, GitHub API integration.
 */

// ═══════════════════════════════════════════════════════════
// App State
// ═══════════════════════════════════════════════════════════
const APP_VERSION = '0.12.2';

const App = {
  currentPage: 'welcome',
  config: null,
  jobs: [],          // In-memory job list (loaded from storage)
  currentImage: null,   // { dataUrl, blob, originalSize, compressedSize, width, height, fileName }
  currentJobId: null,
  pollTimer: null,
  displayTimer: null,
  dispatchTime: null,
  currentPlyBlob: null,
  currentPlySize: 0,
  currentViewJobId: null,
  viewerModuleLoaded: false,
  viewerModuleLoading: null,
  viewerSettings: {
    bgColor: '#2b2928',
    fov: 75,
    splatScale: 1.0,
    alphaThreshold: 0,
    pointCloudMode: false,
    maxScreenSpaceSize: 512,
  },
};

const DEFAULT_CONFIG = {
  githubToken: '',
  repoOwner: '',
  repoName: '',
  repoType: 'public',
  maxEdge: 1536,
  jpegQuality: 0.9,
  imageSource: 'album',
  releaseTag: 'splat-jobs',
  retentionDays: 3,
  maxTimeout: 30,
  darkMode: 'light',
};

// ═══════════════════════════════════════════════════════════
// Storage (localStorage for settings/jobs, IndexedDB for large PLY blobs)
// ═══════════════════════════════════════════════════════════
const Storage = {
  async get(key) {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  },
  async set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  async remove(key) {
    localStorage.removeItem(key);
  },
};

// IndexedDB wrapper for storing large PLY blobs (localStorage caps at ~5MB)
const PLYCache = {
  _db: null,

  async _getDb() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('sharpview_ply', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('ply')) {
          db.createObjectStore('ply');
        }
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async save(jobId, arrayBuffer) {
    const db = await this._getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('ply', 'readwrite');
      tx.objectStore('ply').put(arrayBuffer, jobId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async load(jobId) {
    const db = await this._getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('ply', 'readonly');
      const req = tx.objectStore('ply').get(jobId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async remove(jobId) {
    const db = await this._getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('ply', 'readwrite');
      tx.objectStore('ply').delete(jobId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async exists(jobId) {
    const db = await this._getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('ply', 'readonly');
      const req = tx.objectStore('ply').count(jobId);
      req.onsuccess = () => resolve(req.result > 0);
      req.onerror = () => reject(req.error);
    });
  },
};

// ═══════════════════════════════════════════════════════════
// Page Routing
// ═══════════════════════════════════════════════════════════
const Router = {
  // All page IDs
  pages: ['welcome', 'home', 'settings', 'about', 'preview', 'status', 'viewer', 'error'],
  // Pages that show the tab bar
  pagesWithTabBar: ['home', 'viewer', 'settings'],
  // Tab pages (mutually exclusive, persist as overlays)
  tabPages: ['home', 'viewer', 'settings'],
  // Tab order for slide direction
  tabBarOrder: ['home', 'viewer', 'settings'],

  navigate(pageId) {
    const prevPage = App.currentPage;

    // Hide all pages
    this.pages.forEach(id => {
      const el = document.getElementById(`page-${id}`);
      if (el) {
        el.classList.remove('active');
        // Remove any directional animation classes
        el.classList.remove('slide-from-right', 'slide-from-left');
      }
    });

    // Show target page
    const target = document.getElementById(`page-${pageId}`);
    if (target) {
      // Determine slide direction for tab pages
      if (this.tabBarOrder.includes(prevPage) && this.tabBarOrder.includes(pageId)) {
        const prevIdx = this.tabBarOrder.indexOf(prevPage);
        const nextIdx = this.tabBarOrder.indexOf(pageId);
        if (nextIdx > prevIdx) {
          target.classList.add('slide-from-right');
        } else {
          target.classList.add('slide-from-left');
        }
      }
      target.classList.add('active');
      App.currentPage = pageId;
    }

    // Show/hide tab bar
    const tabBar = document.getElementById('tab-bar');
    if (this.pagesWithTabBar.includes(pageId)) {
      tabBar.style.display = 'flex';
      document.querySelectorAll('.tab-item').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.page === pageId);
      });
    } else {
      tabBar.style.display = 'none';
    }

    // Refresh icons
    if (window.lucide) lucide.createIcons();
  },
};

// ═══════════════════════════════════════════════════════════
// Settings Management
// ═══════════════════════════════════════════════════════════
const Settings = {
  async load() {
    const saved = await Storage.get('sharpview_config');
    App.config = { ...DEFAULT_CONFIG, ...saved };
    // Migrate: 'system' mode was unreliable in Capacitor WebView, default to 'light'
    if (App.config.darkMode === 'system' || !App.config.darkMode) {
      App.config.darkMode = 'light';
      await Storage.set('sharpview_config', App.config);
    }
    return App.config;
  },

  async save() {
    const config = {
      githubToken: document.getElementById('settings-token').value,
      repoOwner: document.getElementById('settings-owner').value,
      repoName: document.getElementById('settings-repo').value,
      repoType: document.querySelector('#settings-repo-type .segment.active')?.dataset.value || 'public',
      maxEdge: parseInt(document.getElementById('settings-max-edge').value) || 1536,
      jpegQuality: parseFloat(document.getElementById('quality-value').textContent) || 0.9,
      imageSource: document.querySelector('#settings-image-source .segment.active')?.dataset.value || 'album',
      releaseTag: document.getElementById('settings-release-tag').value || 'splat-jobs',
      retentionDays: parseInt(document.getElementById('settings-retention').value) || 3,
      maxTimeout: parseInt(document.getElementById('settings-timeout').value) || 30,
      darkMode: App.config?.darkMode || 'light',
    };
    App.config = config;
    await Storage.set('sharpview_config', config);
    return config;
  },

  populateUI() {
    const c = App.config;
    if (!c) return;
    document.getElementById('settings-token').value = c.githubToken || '';
    document.getElementById('settings-owner').value = c.repoOwner || '';
    document.getElementById('settings-repo').value = c.repoName || '';
    document.getElementById('settings-max-edge').value = c.maxEdge || 1536;
    document.getElementById('settings-release-tag').value = c.releaseTag || 'splat-jobs';
    document.getElementById('settings-retention').value = c.retentionDays || 3;
    document.getElementById('settings-timeout').value = c.maxTimeout || 30;

    const q = c.jpegQuality || 0.9;
    document.getElementById('quality-value').textContent = q.toFixed(1);
    document.getElementById('quality-fill').style.width = `${q * 100}%`;

    this.updateSegmented('settings-repo-type', c.repoType || 'public');
    this.updateSegmented('settings-image-source', c.imageSource || 'album');
    this.updateDarkModeToggle(c.darkMode || 'light');
  },

  updateSegmented(containerId, value) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const segments = container.querySelectorAll('.segment');
    const indicator = container.querySelector('.segment-indicator');
    segments.forEach((seg, idx) => {
      const isActive = seg.dataset.value === value;
      seg.classList.toggle('active', isActive);
      if (isActive && indicator) {
        indicator.style.transform = `translateX(${idx * 100}%)`;
      }
    });
  },

  updateDarkModeToggle(mode) {
    const toggle = document.getElementById('dark-mode-toggle');
    const label = document.getElementById('dark-mode-label');
    if (mode === 'dark') {
      toggle.classList.add('on');
      label.textContent = '深色模式';
    } else {
      toggle.classList.remove('on');
      label.textContent = '亮色模式';
    }
  },

  async isConfigured() {
    const c = App.config;
    return !!(c && c.githubToken && c.repoOwner && c.repoName);
  },

  async testConnection() {
    if (typeof GitHubAPI !== 'undefined') {
      return GitHubAPI.testConnection(App.config);
    }
    // Fallback if github.js not loaded
    const c = App.config;
    if (!c || !c.githubToken || !c.repoOwner || !c.repoName) {
      return { success: false, error: 'CONFIG_INVALID', message: '请填写完整配置' };
    }
    try {
      const resp = await fetch(`https://api.github.com/repos/${c.repoOwner}/${c.repoName}`, {
        headers: { 'Authorization': `token ${c.githubToken}`, 'Accept': 'application/vnd.github.v3+json' },
      });
      if (resp.ok) return { success: true, message: '连接成功' };
      if (resp.status === 401) return { success: false, error: 'CONFIG_INVALID', message: 'Token 无效' };
      if (resp.status === 404) return { success: false, error: 'CONFIG_INVALID', message: '仓库不存在或无权限' };
      return { success: false, error: 'UNKNOWN_ERROR', message: `HTTP ${resp.status}` };
    } catch (e) {
      return { success: false, error: 'UNKNOWN_ERROR', message: e.message };
    }
  },
};

// ═══════════════════════════════════════════════════════════
// Job Manager — persist and track jobs across sessions
// ═══════════════════════════════════════════════════════════
const JobManager = {
  // Job states: 'uploading' | 'dispatching' | 'running' | 'downloading' | 'completed' | 'failed' | 'timeout'
  async loadAll() {
    const data = await Storage.get('sharpview_jobs');
    App.jobs = Array.isArray(data) ? data : [];
    return App.jobs;
  },

  async saveAll() {
    await Storage.set('sharpview_jobs', App.jobs);
  },

  create(jobId, imageData) {
    const job = {
      id: jobId,
      status: 'uploading',
      createdAt: new Date().toISOString(),
      imageThumbnail: imageData.dataUrl.substring(0, 100), // small preview
      imageDataUrl: imageData.dataUrl, // full preview for history
      originalSize: imageData.originalSize,
      compressedSize: imageData.compressedSize,
      width: imageData.width,
      height: imageData.height,
      runId: null,
      plySize: null,
      errorLog: null,
      completedAt: null,
    };
    App.jobs.unshift(job);
    this.saveAll();
    return job;
  },

  update(jobId, updates) {
    const job = App.jobs.find(j => j.id === jobId);
    if (job) {
      Object.assign(job, updates);
      this.saveAll();
    }
    return job;
  },

  get(jobId) {
    return App.jobs.find(j => j.id === jobId);
  },

  getActiveJobs() {
    return App.jobs.filter(j =>
      j.status === 'uploading' || j.status === 'dispatching' ||
      j.status === 'running' || j.status === 'downloading'
    );
  },

  getStatusText(status) {
    const map = {
      'uploading': '上传中',
      'dispatching': '触发中',
      'running': '推理中',
      'downloading': '下载中',
      'completed': '已完成',
      'failed': '失败',
      'timeout': '超时',
    };
    return map[status] || status;
  },

  getStatusBadgeClass(status) {
    if (status === 'completed') return 'badge-success';
    if (status === 'failed' || status === 'timeout') return 'badge-error';
    return 'badge-running';
  },

  renderHistoryList() {
    const container = document.getElementById('home-history-list');
    if (!container) return;

    if (App.jobs.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12">
          <div class="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full" style="background:var(--muted)">
            <i data-lucide="image-off" class="w-6 h-6" style="color:var(--muted-foreground)"></i>
          </div>
          <p class="text-sm" style="color:var(--muted-foreground)">暂无生成记录</p>
          <p class="text-xs mt-1" style="color:var(--muted-foreground)">选择图片开始你的第一个 3D 场景</p>
        </div>`;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = App.jobs.map(job => {
      const statusText = this.getStatusText(job.status);
      const badgeClass = this.getStatusBadgeClass(job.status);
      const time = new Date(job.createdAt);
      const timeStr = `${time.getMonth()+1}/${time.getDate()} ${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`;
      const isActive = ['uploading','dispatching','running','downloading'].includes(job.status);

      return `
        <div class="card card-press" data-job-id="${job.id}" style="cursor:pointer;flex-direction:row;align-items:center;gap:12px;padding:14px">
          <div class="w-14 h-14 rounded-xl overflow-hidden shrink-0" style="background:var(--bg-300)">
            <img src="${job.imageDataUrl || ''}" class="w-full h-full object-cover" alt="">
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="status-badge ${badgeClass}">${statusText}</span>
              <span style="font:400 11px var(--font-mono);color:var(--muted-foreground)">${timeStr}</span>
            </div>
            <p style="font:600 13px var(--font-mono);color:var(--foreground);margin:0 0 2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${job.id}</p>
            <p style="font:400 12px var(--font-sans);color:var(--muted-foreground);margin:0">
              ${job.plySize ? formatBytes(job.plySize) + ' PLY' : formatBytes(job.compressedSize) + ' 图片'}
            </p>
          </div>
          <div class="shrink-0 flex items-center gap-1.5">
            ${isActive
              ? `<button class="btn secondary" style="min-height:32px;padding:0 12px;font-size:12px;border-radius:10px" data-action="resume">查看进度</button>`
              : job.status === 'completed'
                ? `<button class="btn primary" style="min-height:32px;padding:0 12px;font-size:12px;border-radius:10px" data-action="view">查看 3D</button>`
                : `<button class="btn secondary" style="min-height:32px;padding:0 12px;font-size:12px;border-radius:10px" data-action="retry">重试</button>`
            }
            <button class="inline-flex items-center justify-center w-8 h-8 rounded-lg shrink-0" data-action="delete" style="color:var(--muted-foreground);background:none;border:none;cursor:pointer">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </div>`;
    }).join('');

    if (window.lucide) lucide.createIcons();

    // Stagger animation for list items
    container.querySelectorAll('[data-job-id]').forEach((card, i) => {
      card.style.animation = `slideUp 0.3s ease-out ${i * 0.05}s both`;
    });

    // Attach click handlers
    container.querySelectorAll('[data-job-id]').forEach(card => {
      const jobId = card.dataset.jobId;
      const job = this.get(jobId);

      // Attach click handlers to ALL action buttons (not just the first one)
      card.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = e.currentTarget.dataset.action;
          if (action === 'resume') {
            this.resumeJob(jobId);
          } else if (action === 'view') {
            viewJob3D(jobId);
          } else if (action === 'retry') {
            this.retryJob(jobId);
          } else if (action === 'delete') {
            this.deleteJob(jobId);
          }
        });
      });

      card.addEventListener('click', () => {
        if (job && ['uploading','dispatching','running','downloading'].includes(job.status)) {
          this.resumeJob(jobId);
        }
      });
    });
  },

  async deleteJob(jobId) {
    const job = this.get(jobId);
    if (!job) return;

    const isActive = ['uploading','dispatching','running','downloading'].includes(job.status);
    const isCompleted = job.status === 'completed';

    // Build confirmation message
    let confirmMsg = '确定删除这条记录？';
    if (isActive) {
      confirmMsg = '确定停止并删除这条记录？正在进行的推理将被取消。';
    } else if (isCompleted && job.plySize) {
      confirmMsg = `确定删除？将清除本地缓存的 PLY 文件（${formatBytes(job.plySize)}）。`;
    }

    const confirmed = await showConfirm('删除记录', confirmMsg);
    if (!confirmed) return;

    // Stop polling if this is the active job
    if (isActive && App.currentJobId === jobId) {
      if (App.pollTimer) { clearInterval(App.pollTimer); App.pollTimer = null; }
      if (App.displayTimer) { clearInterval(App.displayTimer); App.displayTimer = null; }
    }

    // Clear local PLY cache (IndexedDB) if downloaded
    if (isCompleted) {
      try {
        await PLYCache.remove(jobId);
      } catch (e) {
        console.log('No PLY cache to remove:', e);
      }
    }

    // Remove from job list
    App.jobs = App.jobs.filter(j => j.id !== jobId);
    await this.saveAll();

    // Refresh UI
    this.renderHistoryList();
    showToast('已删除');
  },

  resumeJob(jobId) {
    const job = this.get(jobId);
    if (!job) return;

    App.currentJobId = jobId;
    App.dispatchTime = new Date(job.createdAt);

    // Update status page
    document.getElementById('status-job-id').textContent = jobId;

    // Restore step display based on job status
    if (job.status === 'uploading') {
      updateStepStatus(1, 'done', '已完成');
      updateStepStatus(2, 'active', '上传中...');
      updateStepStatus(3, 'pending', '等待中');
      updateStepStatus(4, 'pending', '等待中');
      updateStepStatus(5, 'pending', '等待中');
    } else if (job.status === 'dispatching') {
      updateStepStatus(1, 'done', '已完成');
      updateStepStatus(2, 'done', formatBytes(job.compressedSize));
      updateStepStatus(3, 'active', '触发中...');
      updateStepStatus(4, 'pending', '等待中');
      updateStepStatus(5, 'pending', '等待中');
    } else if (job.status === 'running') {
      updateStepStatus(1, 'done', '已完成');
      updateStepStatus(2, 'done', formatBytes(job.compressedSize));
      updateStepStatus(3, 'active', '已等待 --:--');
      updateStepStatus(4, 'pending', '等待中');
      updateStepStatus(5, 'pending', '等待中');
    } else if (job.status === 'downloading') {
      updateStepStatus(1, 'done', '已完成');
      updateStepStatus(2, 'done', formatBytes(job.compressedSize));
      updateStepStatus(3, 'done', '完成');
      updateStepStatus(4, 'active', '下载中...');
      updateStepStatus(5, 'pending', '等待中');
    }

    // Reset status buttons (show cancel, hide view 3D)
    document.getElementById('status-cancel').style.display = '';
    document.getElementById('status-view-3d').style.display = 'none';

    Router.navigate('status');

    // Resume polling if still active
    if (['dispatching','running'].includes(job.status)) {
      startJobPolling();
    }
  },

  retryJob(jobId) {
    const job = this.get(jobId);
    if (!job) return;
    // Reset job status and restart the flow
    this.update(jobId, { status: 'uploading', errorLog: null, runId: null });
    App.currentJobId = jobId;
    App.currentImage = {
      dataUrl: job.imageDataUrl,
      originalSize: job.originalSize,
      compressedSize: job.compressedSize,
      width: job.width,
      height: job.height,
    };
    // Re-convert dataUrl to blob
    App.currentImage.blob = dataURLtoBlob(job.imageDataUrl);
    handleStartGenerationWithJobId(jobId);
  },
};

// ═══════════════════════════════════════════════════════════
// Dark Mode
// ═══════════════════════════════════════════════════════════
const Theme = {
  apply(mode) {
    const html = document.documentElement;
    if (mode === 'dark') {
      html.classList.add('dark');
      html.classList.remove('light');
    } else if (mode === 'light') {
      html.classList.add('light');
      html.classList.remove('dark');
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      html.classList.toggle('dark', prefersDark);
      html.classList.toggle('light', !prefersDark);
    }
  },
};

// ═══════════════════════════════════════════════════════════
// Image Processing
// ═══════════════════════════════════════════════════════════
const ImageProc = {
  generateJobId() {
    const now = new Date();
    const ts = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const rand = Math.random().toString(36).substring(2, 6);
    return `sharp_${ts}_${rand}`;
  },

  _pickFile(capture) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (capture) {
        input.setAttribute('capture', 'environment');
      }
      input.onchange = (e) => {
        const file = e.target.files[0];
        resolve(file || null);
      };
      // Also handle cancel
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  },

  async selectFromAlbum() {
    return this._pickFile(false);
  },

  async takePhoto() {
    return this._pickFile(true);
  },

  async compress(file, maxEdge, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error('Failed to load image'));
        img.onload = () => {
          let { width, height } = img;
          // Scale down if larger than maxEdge
          if (width > height) {
            if (width > maxEdge) {
              height = Math.round(height * (maxEdge / width));
              width = maxEdge;
            }
          } else {
            if (height > maxEdge) {
              width = Math.round(width * (maxEdge / height));
              height = maxEdge;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          // Convert dataURL to blob for accurate size measurement
          const blob = dataURLtoBlob(dataUrl);
          resolve({
            dataUrl,
            blob,
            originalSize: file.size,
            compressedSize: blob.size,
            width,
            height,
            fileName: file.name,
          });
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  },
};

// ═══════════════════════════════════════════════════════════
// Error Handling
// ═══════════════════════════════════════════════════════════
const ERROR_MESSAGES = {
  CONFIG_INVALID: { title: '配置无效', detail: '请检查 GitHub 设置并测试连接' },
  UPLOAD_FAILED: { title: '上传失败', detail: '请检查网络或 Token 权限' },
  DISPATCH_FAILED: { title: '触发失败', detail: '无法触发 Actions，请检查工作流文件' },
  JOB_TIMEOUT: { title: '生成超时', detail: '请检查 Actions 状态或稍后重试' },
  JOB_FAILED: { title: '推理失败', detail: '点击查看详情日志' },
  DOWNLOAD_FAILED: { title: '下载失败', detail: '请检查网络连接' },
  PLY_PARSE_ERROR: { title: '文件解析失败', detail: 'PLY 文件可能已损坏，尝试重新下载' },
  WEBGL_UNSUPPORTED: { title: '不支持 WebGL2', detail: '当前设备无法渲染 3D 场景' },
  FILE_TOO_LARGE: { title: '文件过大', detail: '请换一张图或降低压缩尺寸' },
  UNKNOWN_ERROR: { title: '发生未知错误', detail: '请重试或查看日志信息' },
};

const ErrorPage = {
  show(code, log) {
    const msg = ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR;
    document.getElementById('error-code').textContent = code;
    document.getElementById('error-message').textContent = msg.title;
    document.getElementById('error-detail').textContent = msg.detail;
    document.getElementById('error-log').textContent = log || '无日志信息';
    Router.navigate('error');
  },
};

// ═══════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════
function setupEventListeners() {
  // ── Welcome page ──
  document.getElementById('welcome-go-settings')?.addEventListener('click', () => Router.navigate('settings'));
  document.getElementById('welcome-go-home')?.addEventListener('click', () => Router.navigate('home'));

  // ── Home page ──
  document.getElementById('home-go-settings')?.addEventListener('click', () => Router.navigate('settings'));
  document.getElementById('home-select-image')?.addEventListener('click', handleSelectImage);
  document.getElementById('home-take-photo')?.addEventListener('click', handleTakePhoto);
  document.getElementById('home-load-ply')?.addEventListener('click', handleLoadPly);

  // ── Settings page ──
  document.getElementById('settings-back')?.addEventListener('click', () => Router.navigate('home'));
  document.getElementById('settings-go-about')?.addEventListener('click', () => Router.navigate('about'));

  // Auto-save: any settings input change triggers save automatically
  const autoSave = async () => {
    await Settings.save();
    console.log('[App] Settings auto-saved');
  };

  // Attach auto-save to all settings inputs
  ['settings-token', 'settings-owner', 'settings-repo', 'settings-max-edge',
   'settings-release-tag', 'settings-retention', 'settings-timeout'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', autoSave);
    document.getElementById(id)?.addEventListener('blur', autoSave);
  });

  // Quality slider auto-save
  document.getElementById('quality-slider')?.addEventListener('change', autoSave);

  // Segmented controls auto-save
  document.querySelectorAll('#settings-repo-type .segment, #settings-image-source .segment').forEach(seg => {
    seg.addEventListener('click', autoSave);
  });

  // Dark mode auto-save (already handled in toggle, but ensure persistence)
  document.getElementById('dark-mode-toggle')?.addEventListener('click', autoSave);

  // Keep save button as visual feedback only (auto-saves anyway)
  document.getElementById('settings-save')?.addEventListener('click', async () => {
    await Settings.save();
    showToast('配置已保存');
  });
  document.getElementById('settings-test-connection')?.addEventListener('click', async () => {
    await Settings.save();
    const result = await Settings.testConnection();
    const statusEl = document.getElementById('connection-status');
    if (result.success) {
      statusEl.style.display = 'flex';
      statusEl.querySelector('span').textContent = '已连接';
      statusEl.style.color = 'var(--success-500)';
      statusEl.querySelector('i').style.color = 'var(--success-500)';
    } else {
      statusEl.style.display = 'flex';
      statusEl.querySelector('span').textContent = result.message;
      statusEl.style.color = 'var(--error-500)';
    }
  });

  // ── About page ──
  document.getElementById('about-back')?.addEventListener('click', () => Router.navigate('settings'));

  // ── Preview page ──
  document.getElementById('preview-back')?.addEventListener('click', () => Router.navigate('home'));
  document.getElementById('preview-reselect')?.addEventListener('click', () => Router.navigate('home'));
  document.getElementById('preview-start')?.addEventListener('click', handleStartGeneration);

  // ── Status page ──
  document.getElementById('status-back')?.addEventListener('click', () => {
    // Don't stop polling — let it run in background
    Router.navigate('home');
    JobManager.renderHistoryList();
  });
  document.getElementById('status-cancel')?.addEventListener('click', () => {
    if (App.pollTimer) { clearInterval(App.pollTimer); App.pollTimer = null; }
    if (App.displayTimer) { clearInterval(App.displayTimer); App.displayTimer = null; }
    if (App.currentJobId) {
      JobManager.update(App.currentJobId, { status: 'failed', errorLog: '用户取消等待' });
    }
    Router.navigate('home');
    JobManager.renderHistoryList();
  });
  document.getElementById('status-view-3d')?.addEventListener('click', () => {
    if (App.currentJobId) viewJob3D(App.currentJobId);
  });

  // ── Viewer page ──
  document.getElementById('viewer-back')?.addEventListener('click', () => {
    // Navigate first, dispose in background for instant response
    Router.navigate('home');
    if (App.viewerModuleLoaded) {
      setTimeout(() => window.dispatchEvent(new Event('sharpview:dispose')), 0);
    }
  });
  document.getElementById('viewer-settings-btn')?.addEventListener('click', () => {
    syncViewerSettingsUI();
    document.getElementById('viewer-settings-overlay').style.display = 'block';
  });
  document.getElementById('viewer-settings-close')?.addEventListener('click', () => {
    document.getElementById('viewer-settings-overlay').style.display = 'none';
  });
  document.getElementById('viewer-reset')?.addEventListener('click', () => {
    if (App.viewerModuleLoaded) window.dispatchEvent(new Event('sharpview:reset-view'));
    showToast('视角已重置');
  });
  document.getElementById('viewer-delete')?.addEventListener('click', () => {
    deleteCurrentViewerCache();
  });

  // ── Gyroscope toggle ──
  window._gyroToggling = false;
  window.toggleGyro = async function() {
    if (window._gyroToggling) return;
    window._gyroToggling = true;

    const btn = document.getElementById('viewer-gyro');
    const label = document.getElementById('viewer-gyro-label');

    if (!btn || !window.SharpViewViewer || typeof window.SharpViewViewer.toggleGyro !== 'function') {
      showToast('渲染器未就绪');
      window._gyroToggling = false;
      return;
    }

    const isCurrentlyOn = window.SharpViewViewer.gyro && window.SharpViewViewer.gyro.enabled;

    try {
      if (!isCurrentlyOn) showToast('正在开启陀螺仪...');
      const enabled = await window.SharpViewViewer.toggleGyro();
      if (enabled) {
        btn.style.background = 'rgba(201,100,66,0.4)';
        label.textContent = '陀螺仪 ON';
        showToast('陀螺仪已开启');
      } else {
        btn.style.background = 'rgba(255,255,255,0.15)';
        label.textContent = '陀螺仪';
        showToast('陀螺仪已关闭');
      }
    } catch (e) {
      showToast('陀螺仪异常');
    } finally {
      window._gyroToggling = false;
    }
  };

  document.getElementById('viewer-gyro')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.toggleGyro();
  });

  // ── Camera mode toggle ──
  window.toggleCameraMode = function() {
    if (!window.SharpViewViewer || typeof window.SharpViewViewer.toggleCameraMode !== 'function') {
      showToast('渲染器未就绪');
      return;
    }
    try {
      const mode = window.SharpViewViewer.toggleCameraMode();
      const btn = document.getElementById('viewer-mode');
      if (btn) {
        btn.textContent = mode === 'free' ? '自由' : '轨道';
        btn.style.background = mode === 'free' ? 'rgba(201,100,66,0.4)' : 'rgba(255,255,255,0.15)';
      }
      showToast(mode === 'free' ? '自由移动模式' : '轨道模式');
    } catch (e) {
      showToast('切换失败');
    }
  };
  document.getElementById('viewer-mode')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.toggleCameraMode();
  });

  // ── Viewer status listener (receives loading/error/ready from viewer.js) ──
  window.addEventListener('sharpview:status', (e) => {
    const { type, message, detail } = e.detail;
    const placeholder = document.getElementById('viewer-placeholder');
    if (!placeholder) return;

    if (type === 'loading') {
      placeholder.innerHTML = `
        <div class="w-16 h-16 mb-4 rounded-2xl flex items-center justify-center stepper-pulse" style="background:rgba(255,255,255,0.1)">
          <i data-lucide="loader" class="w-8 h-8" style="color:rgba(255,255,255,0.6)"></i>
        </div>
        <p style="font:500 14px var(--font-sans);color:rgba(255,255,255,0.7);margin:0 0 6px 0">${message}</p>
        ${detail ? `<p style="font:400 12px var(--font-mono);color:rgba(255,255,255,0.4);margin:0">${detail}</p>` : ''}`;
      placeholder.style.display = 'flex';
      if (window.lucide) lucide.createIcons();
    } else if (type === 'error') {
      placeholder.innerHTML = `
        <div class="w-16 h-16 mb-4 rounded-2xl flex items-center justify-center" style="background:rgba(255,80,80,0.15)">
          <i data-lucide="alert-triangle" class="w-8 h-8" style="color:rgba(255,120,120,0.8)"></i>
        </div>
        <p style="font:500 14px var(--font-sans);color:rgba(255,255,255,0.7);margin:0 0 6px 0">${message}</p>
        ${detail ? `<p style="font:400 12px var(--font-mono);color:rgba(255,255,255,0.4);margin:0">${detail}</p>` : ''}`;
      placeholder.style.display = 'flex';
      if (window.lucide) lucide.createIcons();
    } else if (type === 'ready') {
      placeholder.style.display = 'none';
    }
  });

  // ── Viewer settings panel ──
  document.querySelectorAll('[data-bg]')?.forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-bg]').forEach(b => b.style.borderColor = 'transparent');
      btn.style.borderColor = 'var(--brand-500)';
      App.viewerSettings.bgColor = btn.dataset.bg;
      dispatchViewerSettings();
    });
  });
  document.getElementById('viewer-fov')?.addEventListener('input', (e) => {
    App.viewerSettings.fov = parseInt(e.target.value);
    document.getElementById('viewer-fov-value').textContent = `${e.target.value}°`;
    dispatchViewerSettings();
  });
  document.getElementById('viewer-scale')?.addEventListener('input', (e) => {
    App.viewerSettings.splatScale = parseFloat(e.target.value);
    document.getElementById('viewer-scale-value').textContent = e.target.value;
    dispatchViewerSettings();
  });
  document.getElementById('viewer-alpha')?.addEventListener('input', (e) => {
    App.viewerSettings.alphaThreshold = parseFloat(e.target.value);
    document.getElementById('viewer-alpha-value').textContent = e.target.value;
    dispatchViewerSettings();
  });
  document.getElementById('viewer-maxsize')?.addEventListener('input', (e) => {
    App.viewerSettings.maxScreenSpaceSize = parseInt(e.target.value);
    document.getElementById('viewer-maxsize-value').textContent = e.target.value;
    dispatchViewerSettings();
  });
  document.getElementById('viewer-pointcloud-toggle')?.addEventListener('click', () => {
    const toggle = document.getElementById('viewer-pointcloud-toggle');
    toggle.classList.toggle('on');
    App.viewerSettings.pointCloudMode = toggle.classList.contains('on');
    dispatchViewerSettings();
  });

  // ── Gyroscope settings ──
  document.getElementById('gyro-angle')?.addEventListener('input', (e) => {
    const deg = parseInt(e.target.value);
    document.getElementById('gyro-angle-value').textContent = `${deg}°`;
    if (window.SharpViewViewer) {
      window.SharpViewViewer.updateGyroSettings({ maxAngleDeg: deg });
    }
  });
  document.getElementById('gyro-sensitivity')?.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById('gyro-sensitivity-value').textContent = val.toFixed(1);
    if (window.SharpViewViewer) {
      window.SharpViewViewer.updateGyroSettings({ sensitivity: val });
    }
  });
  document.getElementById('gyro-invert')?.addEventListener('click', () => {
    const toggle = document.getElementById('gyro-invert');
    toggle.classList.toggle('on');
    const on = toggle.classList.contains('on');
    if (window.SharpViewViewer) {
      window.SharpViewViewer.updateGyroSettings({ invert: on });
    }
  });

  // ── Error page ──
  document.getElementById('error-back')?.addEventListener('click', () => Router.navigate('home'));
  document.getElementById('error-retry')?.addEventListener('click', () => {
    // Go back to preview if we have an image, otherwise home
    if (App.currentImage) {
      Router.navigate('preview');
    } else {
      Router.navigate('home');
    }
  });
  document.getElementById('error-go-home')?.addEventListener('click', () => Router.navigate('home'));

  // ── Tab bar ──
  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => Router.navigate(tab.dataset.page));
  });

  // ── Segmented controls ──
  document.querySelectorAll('.segmented').forEach(container => {
    container.querySelectorAll('.segment').forEach((seg, idx) => {
      seg.addEventListener('click', () => {
        const indicator = container.querySelector('.segment-indicator');
        container.querySelectorAll('.segment').forEach(s => s.classList.remove('active'));
        seg.classList.add('active');
        if (indicator) indicator.style.transform = `translateX(${idx * 100}%)`;
      });
    });
  });

  // ── Dark mode toggle: light → dark → light ──
  document.getElementById('dark-mode-toggle')?.addEventListener('click', () => {
    const toggle = document.getElementById('dark-mode-toggle');
    const label = document.getElementById('dark-mode-label');
    const isOn = toggle.classList.contains('on');
    if (isOn) {
      // Currently dark, switch to light
      toggle.classList.remove('on');
      label.textContent = '亮色模式';
      App.config.darkMode = 'light';
      Theme.apply('light');
    } else {
      // Currently light, switch to dark
      toggle.classList.add('on');
      label.textContent = '深色模式';
      App.config.darkMode = 'dark';
      Theme.apply('dark');
    }
  });

  // ── System theme change ──
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (App.config?.darkMode === 'system') Theme.apply('system');
  });
}

// ═══════════════════════════════════════════════════════════
// Image Selection Handlers
// ═══════════════════════════════════════════════════════════
async function handleSelectImage() {
  const file = await ImageProc.selectFromAlbum();
  if (!file) return;
  await processAndPreview(file);
}

async function handleTakePhoto() {
  const file = await ImageProc.takePhoto();
  if (!file) return;
  await processAndPreview(file);
}

async function processAndPreview(file) {
  try {
    const c = App.config;
    const compressed = await ImageProc.compress(file, c.maxEdge, c.jpegQuality);
    App.currentImage = compressed;

    document.getElementById('preview-image').src = compressed.dataUrl;
    document.getElementById('preview-image').style.display = 'block';
    document.getElementById('preview-placeholder').style.display = 'none';
    document.getElementById('preview-original-size').textContent = formatBytes(compressed.originalSize);
    document.getElementById('preview-compressed-size').textContent = formatBytes(compressed.compressedSize);
    document.getElementById('preview-resolution').textContent = `${compressed.width} x ${compressed.height}`;

    Router.navigate('preview');
  } catch (e) {
    ErrorPage.show('UNKNOWN_ERROR', `图片处理失败: ${e.message}`);
  }
}

async function handleLoadPly() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.ply';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    App.currentViewJobId = null;
    App.currentPlyBlob = file;
    App.currentPlySize = file.size;

    // Navigate to viewer page
    document.getElementById('viewer-title').textContent = file.name;
    const placeholder = document.getElementById('viewer-placeholder');
    placeholder.innerHTML = `
      <div class="w-16 h-16 mb-4 rounded-2xl flex items-center justify-center stepper-pulse" style="background:rgba(255,255,255,0.1)">
        <i data-lucide="loader" class="w-8 h-8" style="color:rgba(255,255,255,0.6)"></i>
      </div>
      <p style="font:500 14px var(--font-sans);color:rgba(255,255,255,0.7);margin:0 0 6px 0">初始化渲染器</p>
      <p style="font:400 12px var(--font-mono);color:rgba(255,255,255,0.4);margin:0">正在加载 Three.js + Spark...</p>
      <div style="margin-top:12px;width:120px;height:3px;border-radius:2px;background:rgba(255,255,255,0.1);overflow:hidden">
        <div style="width:33%;height:100%;background:var(--brand-500);transition:width 0.3s"></div>
      </div>`;
    placeholder.style.display = 'flex';
    if (window.lucide) lucide.createIcons();
    Router.navigate('viewer');

    // Load viewer module (Spark + Three.js, bundled locally) if not yet loaded
    try {
      await ensureViewerModule();
    } catch (e) {
      placeholder.innerHTML = `
        <div class="w-16 h-16 mb-4 rounded-2xl flex items-center justify-center" style="background:rgba(255,255,255,0.1)">
          <i data-lucide="alert-triangle" class="w-8 h-8" style="color:rgba(255,255,255,0.4)"></i>
        </div>
        <p style="font:500 14px var(--font-sans);color:rgba(255,255,255,0.5);margin:0 0 4px 0">3D 渲染器加载失败</p>
        <p style="font:400 12px var(--font-sans);color:rgba(255,255,255,0.3);margin:0">${e.message || '未知错误'}</p>`;
      if (window.lucide) lucide.createIcons();
      return;
    }

    // Read file as ArrayBuffer and dispatch to viewer
    const arrayBuffer = await file.arrayBuffer();
    window.dispatchEvent(new CustomEvent('sharpview:load-ply', {
      detail: { arrayBuffer, fileName: file.name }
    }));
    showToast(`已加载: ${file.name} (${formatBytes(file.size)})`);
  };
  input.click();
}

/**
 * View a completed job's 3D model in the viewer.
 * Loads PLY from localStorage cache, or re-downloads from GitHub if needed.
 */
async function viewJob3D(jobId) {
  const job = JobManager.get(jobId);
  if (!job) return;

  // CRITICAL: Reset previous model state to avoid showing stale data
  App.currentViewJobId = jobId;
  App.currentPlyBlob = null;
  App.currentPlySize = 0;

  // Navigate to viewer page FIRST for instant response
  document.getElementById('viewer-title').textContent = `${jobId}.ply`;

  // Show loading state with step indicator
  const placeholder = document.getElementById('viewer-placeholder');
  const renderLoadingStep = (step, detail) => {
    const steps = ['初始化渲染器', '加载 3D 模型', '就绪'];
    placeholder.innerHTML = `
      <div class="w-16 h-16 mb-4 rounded-2xl flex items-center justify-center stepper-pulse" style="background:rgba(255,255,255,0.1)">
        <i data-lucide="loader" class="w-8 h-8" style="color:rgba(255,255,255,0.6)"></i>
      </div>
      <p style="font:500 14px var(--font-sans);color:rgba(255,255,255,0.7);margin:0 0 6px 0">${steps[step] || '加载中...'}</p>
      ${detail ? `<p style="font:400 12px var(--font-mono);color:rgba(255,255,255,0.4);margin:0">${detail}</p>` : ''}
      <div style="margin-top:12px;width:120px;height:3px;border-radius:2px;background:rgba(255,255,255,0.1);overflow:hidden">
        <div style="width:${Math.round(((step+1)/3)*100)}%;height:100%;background:var(--brand-500);transition:width 0.3s"></div>
      </div>`;
    if (window.lucide) lucide.createIcons();
  };
  renderLoadingStep(0, '正在加载 Three.js + Spark...');
  placeholder.style.display = 'flex';
  if (window.lucide) lucide.createIcons();

  Router.navigate('viewer');

  // Dispose any existing viewer content in background (after navigation)
  if (App.viewerModuleLoaded) {
    window.dispatchEvent(new Event('sharpview:dispose'));
  }

  // Load viewer module (Spark + Three.js, bundled locally) in parallel with PLY data
  const modulePromise = ensureViewerModule().then(() => {
    renderLoadingStep(1, '准备加载 PLY 数据...');
    return true;
  }).catch(e => {
    console.error('Viewer module load failed:', e);
    placeholder.innerHTML = `
      <div class="w-16 h-16 mb-4 rounded-2xl flex items-center justify-center" style="background:rgba(255,255,255,0.1)">
        <i data-lucide="alert-triangle" class="w-8 h-8" style="color:rgba(255,255,255,0.4)"></i>
      </div>
      <p style="font:500 14px var(--font-sans);color:rgba(255,255,255,0.5);margin:0 0 4px 0">3D 渲染器加载失败</p>
      <p style="font:400 12px var(--font-sans);color:rgba(255,255,255,0.3);margin:0">${e.message || '未知错误'}</p>`;
    if (window.lucide) lucide.createIcons();
    return false;
  });

  // Try to load PLY from IndexedDB cache
  try {
    const cached = await PLYCache.load(jobId);
    if (cached) {
      const arrayBuffer = cached;
      App.currentPlySize = arrayBuffer.byteLength;
      if (!(await modulePromise)) return;
      window.dispatchEvent(new CustomEvent('sharpview:load-ply', {
        detail: { arrayBuffer, fileName: `${jobId}.ply` }
      }));
      console.log('Loaded PLY from IndexedDB cache:', arrayBuffer.byteLength, 'bytes');
      return;
    }
  } catch (e) {
    console.log('No cached PLY in IndexedDB:', e);
  }

  // Not cached — try to re-download from GitHub
  const configured = await Settings.isConfigured();
  if (!configured) {
    showToast('PLY 未缓存，且 GitHub 未配置');
    return;
  }

  try {
    const config = App.config;
    const assets = await GitHubAPI.checkJobAssets(config, jobId);
    if (!assets.plyAsset) {
      showToast('PLY 文件不存在于云端');
      return;
    }

    const totalSize = assets.plyAsset.size || 0;
    renderLoadingStep(1, `下载 PLY (共 ${formatBytes(totalSize)})...`);
    const plyBlob = await GitHubAPI.downloadAssetWithProgress(config, assets.plyAsset.id, (loaded, total, isReal) => {
      if (isReal && total > 0) {
        // Real progress from XHR
        const pct = Math.round((loaded / total) * 100);
        renderLoadingStep(1, `下载 PLY: ${formatBytes(loaded)} / ${formatBytes(total)} (${pct}%)`);
      } else {
        // No real progress (CapacitorHttp fetch fallback) — show honest status
        renderLoadingStep(1, `下载中 (共 ${formatBytes(totalSize)})...`);
      }
    }, totalSize);

    App.currentPlyBlob = plyBlob;
    App.currentPlySize = plyBlob.size;

    // Cache to IndexedDB for next time (handles large files, unlike localStorage)
    const arrayBuffer = await plyBlob.arrayBuffer();
    try {
      await PLYCache.save(jobId, arrayBuffer);
      console.log('PLY cached to IndexedDB:', arrayBuffer.byteLength, 'bytes');
    } catch (e) {
      console.log('Could not cache PLY to IndexedDB:', e);
    }

    if (!(await modulePromise)) return;
    window.dispatchEvent(new CustomEvent('sharpview:load-ply', {
      detail: { arrayBuffer, fileName: `${jobId}.ply` }
    }));
    showToast('PLY 下载完成');
  } catch (e) {
    console.error('Failed to download PLY:', e);
    placeholder.innerHTML = `
      <div class="w-16 h-16 mb-4 rounded-2xl flex items-center justify-center" style="background:rgba(255,255,255,0.1)">
        <i data-lucide="alert-triangle" class="w-8 h-8" style="color:rgba(255,255,255,0.4)"></i>
      </div>
      <p style="font:500 14px var(--font-sans);color:rgba(255,255,255,0.5);margin:0 0 4px 0">下载失败</p>
      <p style="font:400 12px var(--font-sans);color:rgba(255,255,255,0.3);margin:0">${e.message}</p>`;
    if (window.lucide) lucide.createIcons();
  }
}

// ═══════════════════════════════════════════════════════════
// Generation Handler (Phase 3: Upload + Trigger + Poll + Persist)
// ═══════════════════════════════════════════════════════════
async function handleStartGeneration() {
  if (!App.currentImage) {
    ErrorPage.show('UNKNOWN_ERROR', 'No image selected');
    return;
  }

  const configured = await Settings.isConfigured();
  if (!configured) {
    ErrorPage.show('CONFIG_INVALID', '请先在设置页配置 GitHub 连接');
    return;
  }

  const jobId = ImageProc.generateJobId();
  await handleStartGenerationWithJobId(jobId);
}

async function handleStartGenerationWithJobId(jobId) {
  App.currentJobId = jobId;
  App.dispatchTime = new Date();

  // Create job record
  JobManager.create(jobId, App.currentImage);

  // Update status page
  document.getElementById('status-job-id').textContent = jobId;

  // Reset all steps
  updateStepStatus(1, 'done', '已完成');
  updateStepStatus(2, 'active', '上传中...');
  updateStepStatus(3, 'pending', '等待中');
  updateStepStatus(4, 'pending', '等待中');
  updateStepStatus(5, 'pending', '等待中');

  // Reset status buttons (show cancel, hide view 3D)
  document.getElementById('status-cancel').style.display = '';
  document.getElementById('status-view-3d').style.display = 'none';

  Router.navigate('status');

  try {
    // Step 2: Upload image to repo via Contents API (base64 JSON)
    const config = App.config;
    await GitHubAPI.uploadInputImage(config, jobId, App.currentImage.blob);
    updateStepStatus(2, 'done', formatBytes(App.currentImage.compressedSize));
    JobManager.update(jobId, { status: 'dispatching' });

    // Step 3: Trigger workflow_dispatch
    updateStepStatus(3, 'active', '触发中...');
    await GitHubAPI.triggerWorkflow(config, jobId);
    JobManager.update(jobId, { status: 'running' });
    updateStepStatus(3, 'active', '已等待 00:00');

    // Start polling for workflow completion
    startJobPolling();
  } catch (e) {
    const code = (e instanceof GitHubError) ? e.code : 'UNKNOWN_ERROR';
    const log = e.message + '\n' + (e.stack || '');
    JobManager.update(jobId, { status: 'failed', errorLog: log });
    ErrorPage.show(code, log);
  }
}

function startJobPolling() {
  // Clear any existing timers
  if (App.pollTimer) { clearInterval(App.pollTimer); App.pollTimer = null; }
  if (App.displayTimer) { clearInterval(App.displayTimer); App.displayTimer = null; }

  // Use job's createdAt as the base time, so timer is always correct
  const job = JobManager.get(App.currentJobId);
  const baseTime = job ? new Date(job.createdAt).getTime() : Date.now();
  const maxTimeout = (App.config?.maxTimeout || 30) * 60 * 1000;
  let runId = job?.runId || null;
  let assetCheckCount = 0;

  // Separate 1-second timer for display updates (smooth counting)
  App.displayTimer = setInterval(() => {
    if (App.currentPage !== 'status') return;
    const elapsed = Date.now() - baseTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    const step3El = document.getElementById('status-step-3-time');
    if (step3El && !step3El.textContent.includes('完成') && !step3El.textContent.includes('触发中')) {
      step3El.textContent = `已等待 ${timeStr}`;
    }
  }, 1000);

  // 5-second interval for API polling
  App.pollTimer = setInterval(async () => {
    const elapsed = Date.now() - baseTime;

    // Check timeout
    if (elapsed > maxTimeout) {
      clearInterval(App.pollTimer);
      clearInterval(App.displayTimer);
      App.pollTimer = null;
      App.displayTimer = null;
      JobManager.update(App.currentJobId, { status: 'timeout' });
      ErrorPage.show('JOB_TIMEOUT', `等待超时 (${App.config.maxTimeout} 分钟)`);
      return;
    }

    try {
      const config = App.config;

      // Try to find the workflow run
      if (!runId) {
        const run = await GitHubAPI.findRun(config, App.dispatchTime);
        if (run) {
          runId = run.id;
          JobManager.update(App.currentJobId, { runId: runId });
          console.log('Found workflow run:', runId);
        }
      }

      // If we have a run ID, check its status
      if (runId) {
        const status = await GitHubAPI.getRunStatus(config, runId);
        if (status) {
          if (status.status === 'completed') {
            clearInterval(App.pollTimer);
            clearInterval(App.displayTimer);
            App.pollTimer = null;
            App.displayTimer = null;
            if (status.conclusion === 'success') {
              const timeStr = formatElapsed(Date.now() - baseTime);
              if (App.currentPage === 'status') updateStepStatus(3, 'done', `完成 (${timeStr})`);
              await handleJobComplete();
              return;
            } else {
              await handleJobError();
              return;
            }
          }
          // Still running — update label via display timer
          if (App.currentPage === 'status') {
            const step3El = document.getElementById('status-step-3-time');
            if (step3El && !step3El.textContent.includes('完成')) {
              const label = status.status === 'queued' ? '排队中' : '推理中';
              // Let the 1-second timer handle the time part
              // Just set a flag so the display timer knows the status
              step3El.dataset.statusLabel = label;
            }
          }
        }
      }

      // Also check for output assets periodically
      assetCheckCount++;
      if (assetCheckCount >= 5) {
        assetCheckCount = 0;
        const assets = await GitHubAPI.checkJobAssets(config, App.currentJobId);
        if (assets.plyAsset) {
          clearInterval(App.pollTimer);
          clearInterval(App.displayTimer);
          App.pollTimer = null;
          App.displayTimer = null;
          const timeStr = formatElapsed(Date.now() - baseTime);
          if (App.currentPage === 'status') updateStepStatus(3, 'done', `完成 (${timeStr})`);
          await handleJobComplete(assets.plyAsset);
          return;
        }
        if (assets.errorAsset) {
          clearInterval(App.pollTimer);
          clearInterval(App.displayTimer);
          App.pollTimer = null;
          App.displayTimer = null;
          await handleJobError(assets.errorAsset);
          return;
        }
      }
    } catch (e) {
      console.error('Polling error:', e);
    }
  }, 5000); // Poll every 5 seconds
}

async function handleJobComplete(plyAsset) {
  try {
    const config = App.config;
    JobManager.update(App.currentJobId, { status: 'downloading' });
    if (App.currentPage === 'status') updateStepStatus(4, 'active', '下载中...');

    if (!plyAsset) {
      const assets = await GitHubAPI.checkJobAssets(config, App.currentJobId);
      plyAsset = assets.plyAsset;
    }

    if (!plyAsset) {
      JobManager.update(App.currentJobId, { status: 'failed', errorLog: '未找到 PLY 文件' });
      if (App.currentPage === 'status') {
        ErrorPage.show('DOWNLOAD_FAILED', '未找到 PLY 文件，推理可能尚未完成');
      } else {
        showToast('推理失败：未找到 PLY 文件');
        JobManager.renderHistoryList();
      }
      return;
    }

    // Download PLY blob with progress
    const totalSize = plyAsset.size || 0;
    if (App.currentPage === 'status') updateStepStatus(4, 'active', `下载中 (共 ${formatBytes(totalSize)})...`);

    const plyBlob = await GitHubAPI.downloadAssetWithProgress(config, plyAsset.id, (loaded, total, isReal) => {
      if (App.currentPage === 'status') {
        if (isReal && total > 0) {
          const pct = Math.round((loaded / total) * 100);
          updateStepStatus(4, 'active', `下载中 ${formatBytes(loaded)} / ${formatBytes(total)} (${pct}%)`);
        } else {
          updateStepStatus(4, 'active', `下载中 (共 ${formatBytes(totalSize)})...`);
        }
      }
    }, totalSize);
    const plySize = plyBlob.size;
    if (App.currentPage === 'status') updateStepStatus(4, 'done', formatBytes(plySize));

    // Step 5: "Render"
    if (App.currentPage === 'status') updateStepStatus(5, 'active', '准备渲染...');

    App.currentPlyBlob = plyBlob;
    App.currentPlySize = plySize;

    // Store PLY in localStorage for persistence (Phase 4 will use IndexedDB)
    try {
      // Cache PLY to IndexedDB (handles large 60MB+ files, unlike localStorage)
      const arrayBuffer = await plyBlob.arrayBuffer();
      await PLYCache.save(App.currentJobId, arrayBuffer);
      console.log('PLY cached to IndexedDB:', arrayBuffer.byteLength, 'bytes');
    } catch (e) {
      console.log('Could not cache PLY to IndexedDB:', e);
    }

    // Mark job as completed
    JobManager.update(App.currentJobId, {
      status: 'completed',
      plySize: plySize,
      completedAt: new Date().toISOString(),
    });

    if (App.currentPage === 'status') {
      updateStepStatus(5, 'done', '就绪');
      // Show "查看 3D" button, hide cancel button
      const cancelBtn = document.getElementById('status-cancel');
      const viewBtn = document.getElementById('status-view-3d');
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (viewBtn) viewBtn.style.display = 'flex';
      if (window.lucide) lucide.createIcons();
      showToast('3D 场景生成成功！');
    } else {
      showToast('3D 场景生成成功！');
      JobManager.renderHistoryList();
    }

  } catch (e) {
    const code = (e instanceof GitHubError) ? e.code : 'DOWNLOAD_FAILED';
    JobManager.update(App.currentJobId, { status: 'failed', errorLog: e.message });
    if (App.currentPage === 'status') {
      ErrorPage.show(code, e.message);
    } else {
      showToast('下载失败：' + e.message);
      JobManager.renderHistoryList();
    }
  }
}

async function handleJobError(errorAsset) {
  try {
    const config = App.config;
    let errorLog = '推理过程出错';

    if (errorAsset) {
      errorLog = await GitHubAPI.downloadErrorLog(config, errorAsset.id);
    } else {
      const assets = await GitHubAPI.checkJobAssets(config, App.currentJobId);
      if (assets.errorAsset) {
        errorLog = await GitHubAPI.downloadErrorLog(config, assets.errorAsset.id);
      }
    }

    JobManager.update(App.currentJobId, { status: 'failed', errorLog });

    if (App.currentPage === 'status') {
      ErrorPage.show('JOB_FAILED', errorLog);
    } else {
      showToast('推理失败');
      JobManager.renderHistoryList();
    }
  } catch (e) {
    JobManager.update(App.currentJobId, { status: 'failed', errorLog: '推理失败，无法获取详细日志' });
    if (App.currentPage === 'status') {
      ErrorPage.show('JOB_FAILED', '推理失败，无法获取详细日志');
    } else {
      showToast('推理失败');
      JobManager.renderHistoryList();
    }
  }
}

function updateStepStatus(stepNum, status, timeText) {
  const step = document.getElementById(`status-step-${stepNum}`);
  if (!step) return;
  const icon = step.querySelector('.step-icon');
  const timeEl = document.getElementById(`status-step-${stepNum}-time`);
  const titleEl = step.querySelector('p:nth-child(1)');

  if (status === 'done') {
    icon.style.background = 'var(--success-500)';
    icon.innerHTML = '<i data-lucide="check" class="w-4 h-4" style="color:#fff"></i>';
    if (titleEl) titleEl.style.color = 'var(--foreground)';
    if (timeEl) { timeEl.style.color = 'var(--muted-foreground)'; timeEl.textContent = timeText; }
    icon.classList.remove('stepper-pulse');
  } else if (status === 'active') {
    icon.style.background = 'var(--brand-500)';
    icon.innerHTML = '<i data-lucide="loader" class="w-4 h-4" style="color:#fff"></i>';
    icon.classList.add('stepper-pulse');
    if (titleEl) titleEl.style.color = 'var(--foreground)';
    if (timeEl) { timeEl.style.color = 'var(--muted-foreground)'; timeEl.textContent = timeText; }
  } else {
    icon.style.background = 'var(--bg-300)';
    icon.innerHTML = `<i data-lucide="${stepNum === 4 ? 'download' : 'box'}" class="w-4 h-4" style="color:var(--muted-foreground)"></i>`;
    icon.classList.remove('stepper-pulse');
    if (titleEl) titleEl.style.color = 'var(--muted-foreground)';
    if (timeEl) { timeEl.style.color = 'var(--muted-foreground)'; timeEl.textContent = timeText; }
  }
  if (window.lucide) lucide.createIcons();
}

// ═══════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════
function dataURLtoBlob(dataURL) {
  const [header, base64] = dataURL.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatElapsed(ms) {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function showToast(message) {
  // Simple toast notification
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--text-800);color:var(--bg-50);padding:10px 20px;border-radius:12px;font-size:13px;font-family:var(--font-sans);z-index:9999;opacity:0;transition:opacity .3s ease;pointer-events:none;';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 2000);
}

function showConfirm(title, message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirm-dialog');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    titleEl.textContent = title || '确认';
    msgEl.textContent = message || '确定要执行此操作吗？';
    dialog.style.display = 'block';

    const cleanup = () => {
      dialog.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// ═══════════════════════════════════════════════════════════
// Viewer Helper Functions
// ═══════════════════════════════════════════════════════════

/**
 * Wait for the viewer.js module to be loaded.
 * viewer-bundle.js is loaded via <script defer> before app.js,
 * so window.SharpViewViewer should be available immediately.
 * Falls back to polling in case of slow parsing.
 */
async function ensureViewerModule() {
  if (App.viewerModuleLoaded) return;
  if (App.viewerModuleLoading) return App.viewerModuleLoading;

  App.viewerModuleLoading = (async () => {
    // Check immediately first (bundle loaded via defer before app.js)
    if (window.SharpViewViewer) {
      App.viewerModuleLoaded = true;
      console.log('[App] Viewer module ready (immediate)');
      return;
    }

    // Fallback: poll for window.SharpViewViewer
    const maxWait = 30000;
    const start = Date.now();
    while (!window.SharpViewViewer) {
      if (Date.now() - start > maxWait) {
        throw new Error('3D 渲染器加载超时 (30s)，请检查应用完整性');
      }
      await new Promise(r => setTimeout(r, 100));
    }
    App.viewerModuleLoaded = true;
    console.log('[App] Viewer module ready (polled)');
  })();

  return App.viewerModuleLoading;
}

/**
 * Dispatch viewer settings to the viewer module.
 */
function dispatchViewerSettings() {
  if (!App.viewerModuleLoaded) return;
  window.dispatchEvent(new CustomEvent('sharpview:apply-settings', {
    detail: { ...App.viewerSettings }
  }));
}

/**
 * Sync App.viewerSettings to the settings panel UI controls.
 */
function syncViewerSettingsUI() {
  const s = App.viewerSettings;
  // Background color
  document.querySelectorAll('[data-bg]').forEach(btn => {
    btn.style.borderColor = btn.dataset.bg === s.bgColor ? 'var(--brand-500)' : 'transparent';
  });
  // FOV
  const fovEl = document.getElementById('viewer-fov');
  if (fovEl) fovEl.value = s.fov;
  document.getElementById('viewer-fov-value').textContent = `${s.fov}°`;
  // Scale
  const scaleEl = document.getElementById('viewer-scale');
  if (scaleEl) scaleEl.value = s.splatScale;
  document.getElementById('viewer-scale-value').textContent = s.splatScale.toFixed(1);
  // Alpha
  const alphaEl = document.getElementById('viewer-alpha');
  if (alphaEl) alphaEl.value = s.alphaThreshold;
  document.getElementById('viewer-alpha-value').textContent = s.alphaThreshold;
  // Max size
  const maxsizeEl = document.getElementById('viewer-maxsize');
  if (maxsizeEl) maxsizeEl.value = s.maxScreenSpaceSize;
  document.getElementById('viewer-maxsize-value').textContent = s.maxScreenSpaceSize;
  // Point cloud
  const pcToggle = document.getElementById('viewer-pointcloud-toggle');
  if (pcToggle) pcToggle.classList.toggle('on', s.pointCloudMode);
}

/**
 * Delete the current viewer's local PLY cache.
 */
async function deleteCurrentViewerCache() {
  if (!App.currentViewJobId) {
    showToast('本地文件无需删除缓存');
    return;
  }
  const confirmed = await showConfirm('删除缓存', '确定删除本地缓存的 PLY 文件？');
  if (!confirmed) return;

  try {
    await PLYCache.remove(App.currentViewJobId);
  } catch (e) {
    console.log('No cache to remove:', e);
  }
  App.currentPlyBlob = null;
  App.currentPlySize = 0;
  if (App.viewerModuleLoaded) window.dispatchEvent(new Event('sharpview:dispose'));
  showToast('已删除本地缓存');
  Router.navigate('home');
  JobManager.renderHistoryList();
}

// ═══════════════════════════════════════════════════════════
// App Initialization
// ═══════════════════════════════════════════════════════════
async function initApp() {
  await Settings.load();
  await JobManager.loadAll();
  Theme.apply(App.config.darkMode || 'light');
  Settings.populateUI();
  setupEventListeners();

  // Render history on home page
  JobManager.renderHistoryList();

  // Resume any active jobs in background
  const activeJobs = JobManager.getActiveJobs();
  if (activeJobs.length > 0) {
    const job = activeJobs[0];
    App.currentJobId = job.id;
    App.dispatchTime = new Date(job.createdAt);
    console.log('Resuming active job:', job.id, job.status);
    startJobPolling();
  }

  const configured = await Settings.isConfigured();
  if (configured) {
    Router.navigate('home');
  } else {
    Router.navigate('welcome');
  }

  if (window.lucide) lucide.createIcons();
  console.log(`SharpView v${APP_VERSION} initialized`, { configured });
}

document.addEventListener('DOMContentLoaded', initApp);
