/**
 * SharpView - 3D Viewer Module (Spark + Three.js)
 * All libs bundled locally in /lib/.
 *
 * Key fixes (v0.4.4):
 * - Use ResizeObserver + requestAnimationFrame delay to ensure container has dimensions
 * - Always `await splat.initialized` (it's a Promise, not boolean)
 * - Use blob URL approach (like reference project) instead of fileBytes
 * - Clean PLY header (strip non-vertex elements for Spark compatibility)
 * - Add 30s timeout for SplatMesh initialization
 * - Fix camera position to [0,0,0] with lookAt [0,0,-1]
 * - SparkRenderer: enableLod=false, sortRadial=false (per reference project)
 */

import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const LOAD_TIMEOUT_MS = 30000;

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
  resizeObserver: null,
  fpsCounter: { frames: 0, lastTime: 0 },
  settings: {
    bgColor: '#2b2928',
    fov: 75,
    splatScale: 1.0,
    alphaThreshold: 0,
    pointCloudMode: false,
    maxScreenSpaceSize: 512,
  },

  _notifyStatus(type, message, detail) {
    window.dispatchEvent(new CustomEvent('sharpview:status', {
      detail: { type, message, detail: detail || '' }
    }));
  },

  /**
   * Wait for container to have non-zero dimensions.
   * In Capacitor WebView, the container may be 0x0 right after page switch.
   */
  _waitForContainer() {
    return new Promise((resolve) => {
      const check = () => {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (w > 10 && h > 10) {
          resolve({ w, h });
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  },

  async init() {
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

      // Wait for container to have real dimensions (Capacitor layout delay)
      this._notifyStatus('loading', '初始化渲染器...');
      const { w, h } = await this._waitForContainer();
      console.log('[Viewer] Container dimensions:', w, 'x', h);

      // Scene
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(this.settings.bgColor);

      // Camera — match reference project: position [0,0,0], lookAt [0,0,-1]
      this.camera = new THREE.PerspectiveCamera(this.settings.fov, w / h, 0.01, 100000);
      this.camera.position.set(0, 0, 0);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, -1);

      // Renderer
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setSize(w, h, false);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;

      // Spark renderer — match reference project settings
      this.spark = new SparkRenderer({
        renderer: this.renderer,
        sortRadial: false,
        enableLod: false,
        minAlpha: 0.5 / 255,
        maxPixelRadius: this.settings.maxScreenSpaceSize,
      });
      this.scene.add(this.spark);

      // Controls — match reference project defaults
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.1;
      this.controls.target.set(0, 0, -1);
      this.controls.enablePan = true;
      this.controls.enableZoom = true;
      this.controls.zoomToCursor = true;
      this.controls.rotateSpeed = 1.0;
      this.controls.zoomSpeed = 1.0;
      this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

      // Use ResizeObserver instead of window.resize (more reliable in Capacitor)
      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const rw = entry.contentRect.width;
          const rh = entry.contentRect.height;
          if (rw < 10 || rh < 10) return;
          this.camera.aspect = rw / rh;
          this.camera.updateProjectionMatrix();
          this.renderer.setSize(rw, rh, false);
        }
      });
      this.resizeObserver.observe(this.container);

      // Start render loop immediately (like reference project)
      this.startRenderLoop();

      this.initialized = true;
      console.log('[Viewer] Initialized successfully');
      return true;
    } catch (e) {
      console.error('[Viewer] Init failed:', e);
      this._notifyStatus('error', '渲染器初始化失败', e.message);
      return false;
    }
  },

  /**
   * Clean PLY header: keep only 'vertex' element.
   * Some PLY files have extra elements (like 'camera') that Spark can't parse.
   */
  _cleanPlyHeader(uint8) {
    try {
      // Find end of header
      const headerEndStr = 'end_header\n';
      const decoder = new TextDecoder();
      // Read first 4KB to find header
      const headerBytes = uint8.slice(0, Math.min(4096, uint8.length));
      const headerStr = decoder.decode(headerBytes);
      const endIdx = headerStr.indexOf('end_header\n');
      if (endIdx < 0) return null; // Can't find header, return as-is

      // Check if there are non-vertex elements
      const lines = headerStr.split('\n');
      const hasNonVertex = lines.some(l =>
        l.startsWith('element ') && !l.startsWith('element vertex')
      );
      if (!hasNonVertex) return null; // Clean already, no need to modify

      console.log('[Viewer] PLY has non-vertex elements, cleaning header...');

      // Rebuild header with only vertex element
      const newLines = [];
      let vertexCount = 0;
      let inVertexProps = false;

      for (const line of lines) {
        if (line.startsWith('format ') || line.startsWith('comment ') || line === 'ply') {
          newLines.push(line);
        } else if (line.startsWith('element vertex')) {
          vertexCount = parseInt(line.split(/\s+/)[2]);
          newLines.push(line);
          inVertexProps = true;
        } else if (line.startsWith('element ')) {
          inVertexProps = false; // Skip non-vertex elements
        } else if (line.startsWith('property ') && inVertexProps) {
          newLines.push(line);
        } else if (line === 'end_header') {
          newLines.push(line);
          break;
        }
      }

      const newHeader = newLines.join('\n') + '\n';
      const headerBytesNew = new TextEncoder().encode(newHeader);

      // Find where original vertex data starts
      const origHeaderEnd = endIdx + headerEndStr.length;
      const vertexData = uint8.slice(origHeaderEnd);

      // Combine new header + vertex data
      const result = new Uint8Array(headerBytesNew.length + vertexData.length);
      result.set(headerBytesNew, 0);
      result.set(vertexData, headerBytesNew.length);

      console.log('[Viewer] PLY header cleaned, vertex count:', vertexCount);
      return result;
    } catch (e) {
      console.log('[Viewer] PLY header cleaning failed:', e.message);
      return null;
    }
  },

  /**
   * Load a PLY file from an ArrayBuffer.
   */
  async loadPLY(arrayBuffer, fileName = 'model.ply') {
    console.log('[Viewer] loadPLY:', fileName, arrayBuffer.byteLength, 'bytes');

    if (!await this.init()) {
      console.error('[Viewer] Cannot load PLY: init failed');
      return;
    }

    // Ensure render loop is running (might have been stopped by dispose)
    this.startRenderLoop();

    // Remove existing splat
    if (this.splat) {
      try { this.splat.dispose(); } catch (e) {}
      this.scene.remove(this.splat);
      this.splat = null;
    }

    if (this.placeholder) this.placeholder.style.display = 'none';
    this.canvas.style.display = 'block';
    if (this.infoEl) this.infoEl.style.display = 'block';

    this._notifyStatus('loading', '正在解析 PLY 数据...');

    try {
      // Clean PLY header if needed
      const rawBytes = new Uint8Array(arrayBuffer);
      const cleanedBytes = this._cleanPlyHeader(rawBytes);
      const finalBytes = cleanedBytes || rawBytes;

      // Use blob URL approach (like reference project — more reliable than fileBytes)
      const blob = new Blob([finalBytes], { type: 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      console.log('[Viewer] Created blob URL:', blobUrl, 'size:', finalBytes.length);

      this._notifyStatus('loading', '正在加载高斯模型...');

      // Create SplatMesh from blob URL
      this.splat = new SplatMesh({
        url: blobUrl,
        fileName: fileName,
        editable: false,
        enableLod: false,
        onLoad: (mesh) => {
          console.log('[Viewer] onLoad callback fired');
          URL.revokeObjectURL(blobUrl);
        },
        onProgress: (e) => {
          if (e && e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            console.log('[Viewer] PLY progress:', pct + '%');
            this._notifyStatus('loading', `解析中... ${pct}%`);
          }
        },
      });

      // Critical: quaternion fix for OpenCV → OpenGL coordinate system
      this.splat.quaternion.set(1, 0, 0, 0);
      this.scene.add(this.splat);

      console.log('[Viewer] SplatMesh added to scene, awaiting initialization...');

      // Await initialization with timeout (initialized is a PROMISE, not boolean!)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('加载超时 (30s)')), LOAD_TIMEOUT_MS)
      );

      await Promise.race([
        this.splat.initialized,
        timeoutPromise,
      ]);

      console.log('[Viewer] SplatMesh initialized successfully');

      // Auto-frame after load
      this.autoFrame();
      this._notifyStatus('ready', '3D 场景已就绪');

    } catch (e) {
      console.error('[Viewer] PLY load failed:', e);
      this._notifyStatus('error', '模型加载失败', e.message || String(e));

      if (this.placeholder) {
        this.placeholder.style.display = 'flex';
        this.canvas.style.display = 'none';
        if (this.infoEl) this.infoEl.style.display = 'none';
      }
    }
  },

  /**
   * Frame the model to fill the viewport nicely.
   * Uses the bounding box to determine the best viewing direction and distance.
   * The camera looks at the model center from a direction that shows the
   * largest face of the bounding box.
   */
  autoFrame() {
    if (!this.splat || !this.camera) return;

    try {
      if (!this.splat.isInitialized) {
        console.log('[Viewer] Splat not yet initialized, skipping autoFrame');
        return;
      }

      const box = this.splat.getBoundingBox();
      if (!box) return;

      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      console.log('[Viewer] Bounding box:', {
        center: [center.x.toFixed(3), center.y.toFixed(3), center.z.toFixed(3)],
        size: [size.x.toFixed(3), size.y.toFixed(3), size.z.toFixed(3)]
      });

      // Determine the best viewing direction:
      // Look along the axis with the SMALLEST dimension (shows the largest face).
      // For SHARP output, the model typically faces the camera along Z,
      // so we look from +Z towards -Z by default.
      const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
      const aspect = this.camera.aspect;

      // The visible height at distance d is: h = 2 * d * tan(fov/2)
      // The visible width is: w = h * aspect
      // We want the model's largest "face" dimension to fill ~90% of the viewport.
      
      // For looking along Z (default): visible dimensions are X (width) and Y (height)
      const visibleWidth = size.x;
      const visibleHeight = size.y;
      
      // Calculate distance needed to fit both dimensions
      // height fit: d = (visibleHeight / 2) / tan(fov/2) / fillFactor
      // width fit: d = (visibleWidth / 2) / tan(fov/2 * aspect) / fillFactor
      // Use the larger of the two distances
      const fillFactor = 0.9; // Fill 90% of viewport
      const distHeight = (visibleHeight / 2) / Math.tan(fovRad / 2) / fillFactor;
      const distWidth = (visibleWidth / 2) / (Math.tan(fovRad / 2) * aspect) / fillFactor;
      const distance = Math.max(distHeight, distWidth);

      // Camera looks from +Z towards model center
      this.camera.position.set(center.x, center.y, center.z + distance);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(center);
      this.controls.target.copy(center);
      this.controls.update();

      console.log('[Viewer] Auto-framed:', {
        distance: distance.toFixed(3),
        fov: this.camera.fov,
        aspect: aspect.toFixed(2)
      });
    } catch (e) {
      console.log('[Viewer] Auto-frame failed:', e.message);
      this.camera.position.set(0, 0, 1);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  },

  resetView() {
    if (this.splat && this.splat.isInitialized) {
      this.autoFrame();
    } else if (this.camera) {
      this.camera.position.set(0, 0, 1);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
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
      if (this.controls) this.controls.update();
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
      }

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

  applySettings(settings) {
    Object.assign(this.settings, settings);
    if (!this.initialized) return;

    this.scene.background = new THREE.Color(this.settings.bgColor);
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();

    if (this.splat) {
      this.splat.opacity = this.settings.pointCloudMode ? 0.3 : 1.0;
    }
  },

  /**
   * Clean up current model but keep renderer alive for reuse.
   * Called when switching models or leaving viewer page.
   */
  dispose() {
    // Only stop render loop and remove splat, keep renderer/scene alive
    if (this.splat) {
      try { this.splat.dispose(); } catch (e) {}
      this.scene.remove(this.splat);
      this.splat = null;
    }
    this.stopRenderLoop();
    if (this.placeholder) this.placeholder.style.display = 'flex';
    if (this.canvas) this.canvas.style.display = 'none';
    if (this.infoEl) this.infoEl.style.display = 'none';
  },
};

// Export to window for app.js access
window.SharpViewViewer = Viewer;
export { Viewer as SharpViewViewer };
export default Viewer;

// ═══════════════════════════════════════════════════════════
// Event listeners
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
