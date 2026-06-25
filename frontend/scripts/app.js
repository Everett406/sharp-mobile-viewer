/**
 * SharpView - Main Application Logic
 * Version: 0.1.0
 *
 * Page routing, settings management, GitHub API integration.
 */

// ═══════════════════════════════════════════════════════════
// App State
// ═══════════════════════════════════════════════════════════
const App = {
  currentPage: 'welcome',
  config: null,
  jobs: [],
  history: [],
};

// Default configuration
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
  darkMode: 'system', // 'system' | 'light' | 'dark'
};

// ═══════════════════════════════════════════════════════════
// Storage (abstraction layer for Capacitor Preferences)
// ═══════════════════════════════════════════════════════════
const Storage = {
  async get(key) {
    // TODO: Switch to @capacitor/preferences when running in native
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
  pages: ['welcome', 'home', 'settings', 'about'],
  pagesWithTabBar: ['home', 'settings'],

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
      // Update active tab
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

    // Quality display
    const q = c.jpegQuality || 0.9;
    document.getElementById('quality-value').textContent = q.toFixed(1);
    document.getElementById('quality-fill').style.width = `${q * 100}%`;

    // Segmented controls
    this.updateSegmented('settings-repo-type', c.repoType || 'public');
    this.updateSegmented('settings-image-source', c.imageSource || 'album');

    // Dark mode toggle
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
      // System
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      html.classList.toggle('dark', prefersDark);
      html.classList.toggle('light', !prefersDark);
    }
  },
};

// ═══════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════
function setupEventListeners() {
  // Welcome page
  document.getElementById('welcome-go-settings')?.addEventListener('click', () => {
    Router.navigate('settings');
  });
  document.getElementById('welcome-go-home')?.addEventListener('click', () => {
    Router.navigate('home');
  });

  // Home page
  document.getElementById('home-go-settings')?.addEventListener('click', () => {
    Router.navigate('settings');
  });
  document.getElementById('home-select-image')?.addEventListener('click', () => {
    // TODO: Implement image selection
    console.log('Select image from album');
  });
  document.getElementById('home-take-photo')?.addEventListener('click', () => {
    // TODO: Implement camera
    console.log('Take photo');
  });
  document.getElementById('home-load-ply')?.addEventListener('click', () => {
    // TODO: Implement local PLY loading
    console.log('Load local PLY');
  });

  // Settings page
  document.getElementById('settings-back')?.addEventListener('click', () => {
    Router.navigate('home');
  });
  document.getElementById('settings-go-about')?.addEventListener('click', () => {
    Router.navigate('about');
  });
  document.getElementById('settings-save')?.addEventListener('click', async () => {
    await Settings.save();
    // Show feedback
    console.log('Settings saved');
  });
  document.getElementById('settings-test-connection')?.addEventListener('click', async () => {
    await Settings.save();
    const result = await Settings.testConnection();
    const statusEl = document.getElementById('connection-status');
    if (result.success) {
      statusEl.style.display = 'flex';
      statusEl.querySelector('span').textContent = '已连接';
      statusEl.style.color = 'var(--success-500)';
    } else {
      statusEl.style.display = 'flex';
      statusEl.querySelector('span').textContent = result.message;
      statusEl.style.color = 'var(--error-500)';
    }
  });

  // About page
  document.getElementById('about-back')?.addEventListener('click', () => {
    Router.navigate('settings');
  });

  // Tab bar
  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => {
      Router.navigate(tab.dataset.page);
    });
  });

  // Segmented controls
  document.querySelectorAll('.segmented').forEach(container => {
    container.querySelectorAll('.segment').forEach((seg, idx) => {
      seg.addEventListener('click', () => {
        const indicator = container.querySelector('.segment-indicator');
        container.querySelectorAll('.segment').forEach(s => s.classList.remove('active'));
        seg.classList.add('active');
        if (indicator) {
          indicator.style.transform = `translateX(${idx * 100}%)`;
        }
      });
    });
  });

  // Dark mode toggle
  document.getElementById('dark-mode-toggle')?.addEventListener('click', () => {
    const toggle = document.getElementById('dark-mode-toggle');
    const label = document.getElementById('dark-mode-label');
    const isOn = toggle.classList.contains('on');

    if (isOn) {
      // Currently dark, switch to system
      toggle.classList.remove('on');
      label.textContent = '跟随系统';
      App.config.darkMode = 'system';
      Theme.apply('system');
    } else {
      // Currently system/light, switch to dark
      toggle.classList.add('on');
      label.textContent = '深色模式';
      App.config.darkMode = 'dark';
      Theme.apply('dark');
    }
  });

  // System theme change listener
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (App.config?.darkMode === 'system') {
      Theme.apply('system');
    }
  });
}

// ═══════════════════════════════════════════════════════════
// App Initialization
// ═══════════════════════════════════════════════════════════
async function initApp() {
  // Load configuration
  await Settings.load();

  // Apply theme
  Theme.apply(App.config.darkMode || 'system');

  // Populate settings UI
  Settings.populateUI();

  // Setup event listeners
  setupEventListeners();

  // Determine initial page
  const configured = await Settings.isConfigured();
  if (configured) {
    Router.navigate('home');
  } else {
    Router.navigate('welcome');
  }

  // Initialize icons
  if (window.lucide) lucide.createIcons();

  console.log('SharpView initialized', { version: '0.1.0', configured });
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);
