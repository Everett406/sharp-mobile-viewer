/**
 * SharpView - 3D Viewer Module (Spark + Three.js)
 * Loaded as ES module via importmap. All libs are bundled locally.
 * Communicates with app.js via window events:
 *   - sharpview:load-ply      (app → viewer) load PLY from ArrayBuffer
 *   - sharpview:reset-view    (app → viewer) reset camera
 *   - sharpview:apply-settings(app → viewer) apply viewer settings
 *   - sharpview:dispose       (app → viewer) cleanup
 *   - sharpview:status        (viewer → app) loading/error status updates
 */

import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const Viewer = {
  scene: null,
  camera: null,
  renderer: null,
  spark: null,
  controls: null,
  splat: null,
  canvas: null,
  container: null,
  placeholder: null,
  fpsEl: null,
  infoEl: null,
  initialized: false,
  animationId: null,
  fpsCounter: { frames: 0, lastTime: 0 },
  settings: {
    bgColor: '#2b2928',
    fov: 75,
    splatScale: 1.0,
    alphaThreshold: 0,
    pointCloudMode: false,
    maxScreenSpaceSize: 512,
  },

  /**
   * Send status update to app.js so it can show the user what's happening.
   */
  _notifyStatus(type, message, detail) {
    window.dispatchEvent(new CustomEvent('sharpview:status', {
      detail: { type, message, detail: detail || '' }
    }));
  },

  init() {
    if (this.initialized) return true;

    try {
      this.container = document.getElementById('viewer-canvas-container');
      this.placeholder = document.getElementById('viewer-placeholder');
      this.canvas = document.getElementById('viewer-canvas');
      this.infoEl = document.getElementById('viewer-info');
      this.fpsEl = document.getElementById('viewer-fps');

      if (!this.container || !this.canvas) {
        this._notifyStatus('error', '找不到 Canvas 容器');
        return false;
      }

      // Check container dimensions
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (w < 10 || h < 10) {
        this._notifyStatus('error', 'Canvas 容器尺寸异常', `${w}x${h}`);
        return false;
      }

      // Scene
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(this.settings.bgColor);

      // Camera
      this.camera = new THREE.PerspectiveCamera(this.settings.fov, w / h, 0.01, 1000);
      this.camera.position.set(0, 0, 3);

      // Renderer
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: false,
        alpha: false,
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setSize(w, h);

      // Spark renderer
      this.spark = new SparkRenderer({
        renderer: this.renderer,
        sortRadial: true,
      });
      this.scene.add(this.spark);

      // Controls
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.1;
      this.controls.target.set(0, 0, 0);
      this.controls.minDistance = 0.1;
      this.controls.maxDistance = 50;
      this.controls.enablePan = true;
      this.controls.rotateSpeed = 0.5;
      this.controls.zoomSpeed = 1.0;

      // Handle resize
      window.addEventListener('resize', () => this.onResize());

      this.initialized = true;
      console.log('[Viewer] Initialized successfully', `${w}x${h}`);
      return true;
    } catch (e) {
      console.error('[Viewer] Init failed:', e);
      this._notifyStatus('error', '渲染器初始化失败', e.message);
      return false;
    }
  },

  onResize() {
    if (!this.container || !this.camera || !this.renderer) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w < 10 || h < 10) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  },

  /**
   * Load a PLY file from an ArrayBuffer.
   */
  async loadPLY(arrayBuffer, fileName = 'model.ply') {
    console.log('[Viewer] loadPLY called:', fileName, arrayBuffer.byteLength, 'bytes');

    if (!this.init()) {
      console.error('[Viewer] Cannot load PLY: init failed');
      return;
    }

    // Remove existing splat
    if (this.splat) {
      try { this.splat.dispose(); } catch (e) {}
      this.scene.remove(this.splat);
      this.splat = null;
    }

    // Show canvas, hide placeholder
    if (this.placeholder) this.placeholder.style.display = 'none';
    this.canvas.style.display = 'block';
    if (this.infoEl) this.infoEl.style.display = 'block';

    this._notifyStatus('loading', '正在解析 PLY 数据...');

    try {
      // Create SplatMesh from raw bytes
      console.log('[Viewer] Creating SplatMesh...');
      this.splat = new SplatMesh({
        fileBytes: new Uint8Array(arrayBuffer),
        fileName: fileName,
        onLoad: (mesh) => {
          console.log('[Viewer] PLY onLoad callback fired');
          this.autoFrame();
          this._notifyStatus('ready', '3D 场景已就绪');
        },
        onProgress: (e) => {
          if (e && e.total > 0) {
            const pct = Math.round((e.loaded / e.total) * 100);
            console.log('[Viewer] PLY parsing:', pct + '%');
          }
        },
      });

      // Common orientation fix for SHARP output
      this.splat.quaternion.set(1, 0, 0, 0);
      this.scene.add(this.splat);

      console.log('[Viewer] SplatMesh added to scene, awaiting initialization...');

      // Await the initialized promise (Spark API: splat.initialized)
      if (this.splat.initialized) {
        await this.splat.initialized;
        console.log('[Viewer] SplatMesh initialized promise resolved');
      }

      // Start render loop
      this.startRenderLoop();

      // Auto-frame after a short delay to ensure data is ready
      setTimeout(() => {
        this.autoFrame();
        this._notifyStatus('ready', '3D 场景已就绪');
      }, 200);

    } catch (e) {
      console.error('[Viewer] PLY load failed:', e);
      this._notifyStatus('error', 'PLY 解析失败', e.message || String(e));

      // Show error in placeholder
      if (this.placeholder) {
        this.placeholder.style.display = 'flex';
        this.canvas.style.display = 'none';
        if (this.infoEl) this.infoEl.style.display = 'none';
      }
    }
  },

  /**
   * Auto-frame camera to fit the splat bounding box.
   */
  autoFrame() {
    if (!this.splat || !this.camera) return;

    try {
      const box = this.splat.getBoundingBox();
      if (!box) {
        console.log('[Viewer] No bounding box available');
        return;
      }

      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      const distance = maxDim * 1.5;

      this.camera.position.set(center.x, center.y, center.z + distance);
      this.controls.target.copy(center);
      this.controls.update();

      console.log('[Viewer] Auto-framed:', { center, size, distance });
    } catch (e) {
      console.log('[Viewer] Auto-frame failed:', e.message);
      // Fallback: default camera position
      this.camera.position.set(0, 0, 3);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  },

  resetView() {
    if (this.splat) {
      this.autoFrame();
    } else if (this.camera) {
      this.camera.position.set(0, 0, 3);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  },

  startRenderLoop() {
    if (this.animationId) return;

    this.fpsCounter.lastTime = performance.now();
    this.fpsCounter.frames = 0;

    const animate = () => {
      this.animationId = requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);

      // FPS counter
      this.fpsCounter.frames++;
      const now = performance.now();
      const elapsed = now - this.fpsCounter.lastTime;
      if (elapsed >= 1000) {
        const fps = Math.round((this.fpsCounter.frames * 1000) / elapsed);
        if (this.fpsEl) this.fpsEl.textContent = `FPS: ${fps}`;
        this.fpsCounter.frames = 0;
        this.fpsCounter.lastTime = now;
      }
    };
    animate();
    console.log('[Viewer] Render loop started');
  },

  stopRenderLoop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  },

  /**
   * Apply settings from the settings panel.
   */
  applySettings(settings) {
    Object.assign(this.settings, settings);
    if (!this.initialized) return;

    this.scene.background = new THREE.Color(this.settings.bgColor);
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();

    if (this.spark) {
      this.spark.maxStdDev = Math.sqrt(8) * this.settings.splatScale;
    }
    if (this.splat) {
      this.splat.opacity = this.settings.pointCloudMode ? 0.3 : 1.0;
    }
  },

  /**
   * Clean up viewer resources.
   */
  dispose() {
    this.stopRenderLoop();
    if (this.splat) {
      try { this.splat.dispose(); } catch (e) {}
      this.scene.remove(this.splat);
      this.splat = null;
    }
    if (this.placeholder) this.placeholder.style.display = 'flex';
    if (this.canvas) this.canvas.style.display = 'none';
    if (this.infoEl) this.infoEl.style.display = 'none';
  },
};

// Export to window for app.js access
window.SharpViewViewer = Viewer;

// Also export as ES module (for dynamic import())
export { Viewer as SharpViewViewer };
export default Viewer;

// ═══════════════════════════════════════════════════════════
// Event listeners — app.js dispatches these
// ═══════════════════════════════════════════════════════════

window.addEventListener('sharpview:load-ply', async (e) => {
  const { arrayBuffer, fileName } = e.detail;
  await Viewer.loadPLY(arrayBuffer, fileName);
});

window.addEventListener('sharpview:reset-view', () => {
  Viewer.resetView();
});

window.addEventListener('sharpview:apply-settings', (e) => {
  Viewer.applySettings(e.detail);
});

window.addEventListener('sharpview:dispose', () => {
  Viewer.dispose();
});

console.log('[Viewer] SharpView Viewer module loaded (Spark + Three.js, local)');
