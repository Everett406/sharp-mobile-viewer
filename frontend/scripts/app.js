/**
 * SharpView - Main Application Logic
 * Version: 0.1.0
 *
 * Page routing, settings management, GitHub API integration.
 */

// ═══════════════════════════════════════════════════════════
// App State
// ═══════════════════════════════════════════════════════════
const APP_VERSION = '0.1.0';

const App = {
  currentPage: 'welcome',
  config: null,
  jobs: [],
  history: [],
  currentImage: null,   // { dataUrl, originalSize, compressedSize, width, height }
  currentJobId: null,
  pollTimer: null,
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
  darkMode: 'system',
};

// ═══════════════════════════════════════════════════════════
// Storage
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

  navigate(pageId) {
    // Hide all pages
    this.pages.forEach(id => {
      const el = document.getElementById(`page-${id}`);
      if (el) el.classList.remove('active');
    });

    // Show target page
    const target = document.getElementById(`page-${pageId}`);
    if (target) {
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
      darkMode: App.config?.darkMode || 'system',
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
    this.updateDarkModeToggle(c.darkMode || 'system');
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
    } else if (mode === 'light') {
      toggle.classList.remove('on');
      label.textContent = '浅色模式';
    } else {
      toggle.classList.remove('on');
      label.textContent = '跟随系统';
    }
  },

  async isConfigured() {
    const c = App.config;
    return !!(c && c.githubToken && c.repoOwner && c.repoName);
  },

  async testConnection() {
    const c = App.config;
    if (!c || !c.githubToken || !c.repoOwner || !c.repoName) {
      return { success: false, error: 'CONFIG_INVALID', message: '请填写完整配置' };
    }
    try {
      const resp = await fetch(`https://api.github.com/repos/${c.repoOwner}/${c.repoName}`, {
        headers: {
          'Authorization': `token ${c.githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      });
      if (resp.ok) {
        return { success: true, message: '连接成功' };
      } else if (resp.status === 401) {
        return { success: false, error: 'CONFIG_INVALID', message: 'Token 无效' };
      } else if (resp.status === 404) {
        return { success: false, error: 'CONFIG_INVALID', message: '仓库不存在或无权限' };
      } else {
        return { success: false, error: 'UNKNOWN_ERROR', message: `HTTP ${resp.status}` };
      }
    } catch (e) {
      return { success: false, error: 'UNKNOWN_ERROR', message: e.message };
    }
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
// Image Processing (Phase 2 stubs)
// ═══════════════════════════════════════════════════════════
const ImageProc = {
  generateJobId() {
    const now = new Date();
    const ts = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const rand = Math.random().toString(36).substring(2, 6);
    return `sharp_${ts}_${rand}`;
  },

  async selectFromAlbum() {
    // Phase 2: Use Capacitor Camera or file input
    // For now, use a file input as fallback
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
          resolve(file);
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  },

  async compress(file, maxEdge, quality) {
    // Phase 2: Full implementation with EXIF handling
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
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
          resolve({
            dataUrl,
            originalSize: file.size,
            compressedSize: Math.round(dataUrl.length * 0.75),
            width,
            height,
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
    if (App.pollTimer) { clearInterval(App.pollTimer); App.pollTimer = null; }
    Router.navigate('home');
  });
  document.getElementById('status-cancel')?.addEventListener('click', () => {
    if (App.pollTimer) { clearInterval(App.pollTimer); App.pollTimer = null; }
    Router.navigate('home');
  });

  // ── Viewer page ──
  document.getElementById('viewer-back')?.addEventListener('click', () => Router.navigate('home'));
  document.getElementById('viewer-settings-btn')?.addEventListener('click', () => {
    document.getElementById('viewer-settings-overlay').style.display = 'block';
  });
  document.getElementById('viewer-settings-close')?.addEventListener('click', () => {
    document.getElementById('viewer-settings-overlay').style.display = 'none';
  });
  document.getElementById('viewer-reset')?.addEventListener('click', () => {
    console.log('Reset view');
    showToast('视角已重置');
  });
  document.getElementById('viewer-download')?.addEventListener('click', () => {
    console.log('Download PLY');
    showToast('开始下载 PLY');
  });
  document.getElementById('viewer-delete')?.addEventListener('click', () => {
    console.log('Delete local cache');
    showToast('已删除本地缓存');
  });

  // ── Viewer settings panel ──
  document.querySelectorAll('[data-bg]')?.forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-bg]').forEach(b => b.style.borderColor = 'transparent');
      btn.style.borderColor = 'var(--brand-500)';
      App.viewerSettings.bgColor = btn.dataset.bg;
    });
  });
  document.getElementById('viewer-fov')?.addEventListener('input', (e) => {
    App.viewerSettings.fov = parseInt(e.target.value);
    document.getElementById('viewer-fov-value').textContent = `${e.target.value}°`;
  });
  document.getElementById('viewer-scale')?.addEventListener('input', (e) => {
    App.viewerSettings.splatScale = parseFloat(e.target.value);
    document.getElementById('viewer-scale-value').textContent = e.target.value;
  });
  document.getElementById('viewer-alpha')?.addEventListener('input', (e) => {
    App.viewerSettings.alphaThreshold = parseFloat(e.target.value);
    document.getElementById('viewer-alpha-value').textContent = e.target.value;
  });
  document.getElementById('viewer-maxsize')?.addEventListener('input', (e) => {
    App.viewerSettings.maxScreenSpaceSize = parseInt(e.target.value);
    document.getElementById('viewer-maxsize-value').textContent = e.target.value;
  });
  document.getElementById('viewer-pointcloud-toggle')?.addEventListener('click', () => {
    const toggle = document.getElementById('viewer-pointcloud-toggle');
    toggle.classList.toggle('on');
    App.viewerSettings.pointCloudMode = toggle.classList.contains('on');
  });

  // ── Error page ──
  document.getElementById('error-back')?.addEventListener('click', () => Router.navigate('home'));
  document.getElementById('error-retry')?.addEventListener('click', () => {
    // Retry logic depends on where the error occurred
    Router.navigate('home');
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

  // ── Dark mode toggle ──
  document.getElementById('dark-mode-toggle')?.addEventListener('click', () => {
    const toggle = document.getElementById('dark-mode-toggle');
    const label = document.getElementById('dark-mode-label');
    const isOn = toggle.classList.contains('on');
    if (isOn) {
      toggle.classList.remove('on');
      label.textContent = '跟随系统';
      App.config.darkMode = 'system';
      Theme.apply('system');
    } else {
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
// Image Selection Handlers (Phase 2 stubs)
// ═══════════════════════════════════════════════════════════
async function handleSelectImage() {
  const file = await ImageProc.selectFromAlbum();
  if (!file) return;

  const c = App.config;
  const compressed = await ImageProc.compress(file, c.maxEdge, c.jpegQuality);
  App.currentImage = compressed;

  // Update preview page
  document.getElementById('preview-image').src = compressed.dataUrl;
  document.getElementById('preview-image').style.display = 'block';
  document.getElementById('preview-placeholder').style.display = 'none';
  document.getElementById('preview-original-size').textContent = formatBytes(compressed.originalSize);
  document.getElementById('preview-compressed-size').textContent = formatBytes(compressed.compressedSize);
  document.getElementById('preview-resolution').textContent = `${compressed.width} x ${compressed.height}`;

  Router.navigate('preview');
}

async function handleTakePhoto() {
  // Phase 2: Use Capacitor Camera plugin
  // For now, same as album selection
  await handleSelectImage();
}

async function handleLoadPly() {
  // Phase 4: Load local PLY file
  showToast('加载本地 PLY 功能将在 Phase 4 实现');
}

// ═══════════════════════════════════════════════════════════
// Generation Handler (Phase 2/3 stub)
// ═══════════════════════════════════════════════════════════
async function handleStartGeneration() {
  if (!App.currentImage) {
    ErrorPage.show('UNKNOWN_ERROR', 'No image selected');
    return;
  }

  const jobId = ImageProc.generateJobId();
  App.currentJobId = jobId;

  // Update status page
  document.getElementById('status-job-id').textContent = jobId;

  // Reset steps to initial state
  updateStepStatus(1, 'done', '已完成');
  updateStepStatus(2, 'done', '已完成');
  updateStepStatus(3, 'active', '已等待 00:00');
  updateStepStatus(4, 'pending', '等待中');
  updateStepStatus(5, 'pending', '等待中');

  Router.navigate('status');

  // Phase 2: Actually upload and trigger Actions
  // For now, just simulate waiting
  startWaitTimer();
}

function startWaitTimer() {
  const startTime = Date.now();
  const maxTimeout = (App.config?.maxTimeout || 30) * 60 * 1000;

  App.pollTimer = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    document.getElementById('status-step-3-time').textContent = `已等待 ${timeStr}`;

    if (elapsed > maxTimeout) {
      clearInterval(App.pollTimer);
      App.pollTimer = null;
      ErrorPage.show('JOB_TIMEOUT', `等待超时 (${App.config.maxTimeout} 分钟)`);
    }
  }, 1000);
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
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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

// ═══════════════════════════════════════════════════════════
// App Initialization
// ═══════════════════════════════════════════════════════════
async function initApp() {
  await Settings.load();
  Theme.apply(App.config.darkMode || 'system');
  Settings.populateUI();
  setupEventListeners();

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
