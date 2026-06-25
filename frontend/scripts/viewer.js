/**
 * SharpView - 3D Viewer Module (Spark + Three.js)
 * Loaded as ES module via importmap.
 * Communicates with app.js via window events.
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

  init() {
    if (this.initialized) return;

    this.container = document.getElementById('viewer-canvas-container');
    this.placeholder = document.getElementById('viewer-placeholder');
    this.canvas = document.getElementById('viewer-canvas');
    this.infoEl = document.getElementById('viewer-info');
    this.fpsEl = document.getElementById('viewer-fps');

    if (!this.container) return;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.settings.bgColor);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      this.settings.fov,
      this.container.clientWidth / this.container.clientHeight,
      0.01, 1000
    );
    this.camera.position.set(0, 0, 3);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);

    // Spark renderer (Spark 2.0 API: only renderer + sortRadial are used here)
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
    console.log('Viewer initialized');
  },

  onResize() {
    if (!this.container || !this.camera || !this.renderer) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  },

  /**
   * Load a PLY file from an ArrayBuffer.
   */
  async loadPLY(arrayBuffer, fileName = 'model.ply') {
    this.init();
    if (!this.initialized) {
      console.error('Viewer not initialized');
      return;
    }

    // Remove existing splat
    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat = null;
    }

    // Show canvas, hide placeholder
    this.placeholder.style.display = 'none';
    this.canvas.style.display = 'block';
    this.infoEl.style.display = 'block';

    console.log('Loading PLY:', fileName, 'size:', arrayBuffer.byteLength, 'bytes');

    // Create SplatMesh from raw bytes
    this.splat = new SplatMesh({
      fileBytes: new Uint8Array(arrayBuffer),
      fileName: fileName,
      onLoad: (mesh) => {
        console.log('PLY loaded successfully');
        // Auto-frame the scene after load
        this.autoFrame();
      },
      onProgress: (e) => {
        if (e.total > 0) {
          const pct = Math.round((e.loaded / e.total) * 100);
          console.log(`Loading: ${pct}%`);
        }
      },
    });

    // Common orientation fix for SHARP output
    this.splat.quaternion.set(1, 0, 0, 0);
    this.scene.add(this.splat);

    // Start render loop
    this.startRenderLoop();
  },

  /**
   * Auto-frame camera to fit the splat bounding box.
   */
  autoFrame() {
    if (!this.splat || !this.camera) return;

    try {
      const box = this.splat.getBoundingBox();
      if (!box) return;

      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const distance = maxDim * 1.5 || 3;

      this.camera.position.set(center.x, center.y, center.z + distance);
      this.controls.target.copy(center);
      this.controls.update();

      console.log('Auto-framed:', { center, size, distance });
    } catch (e) {
      console.log('Auto-frame failed:', e);
    }
  },

  resetView() {
    if (this.splat) {
      this.autoFrame();
    } else {
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

    // Background color
    this.scene.background = new THREE.Color(this.settings.bgColor);

    // FOV
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();

    // Spark renderer settings (Spark 2.0: maxStdDev controls splat rendering size)
    if (this.spark) {
      this.spark.maxStdDev = Math.sqrt(8) * this.settings.splatScale;
    }

    // Splat opacity for point cloud mode
    if (this.splat) {
      this.splat.opacity = this.settings.pointCloudMode ? 0.3 : 1.0;
    }

    console.log('Settings applied:', this.settings);
  },

  /**
   * Clean up viewer resources.
   */
  dispose() {
    this.stopRenderLoop();
    if (this.splat) {
      try { this.splat.dispose(); } catch (e) { console.log('Splat dispose:', e); }
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

// Listen for events from app.js
window.addEventListener('sharpview:load-ply', (e) => {
  const { arrayBuffer, fileName } = e.detail;
  Viewer.loadPLY(arrayBuffer, fileName);
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

console.log('SharpView Viewer module loaded (Spark + Three.js)');
