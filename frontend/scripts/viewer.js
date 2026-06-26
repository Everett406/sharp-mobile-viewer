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

// Access native Gyroscope plugin via global Capacitor object (injected by native runtime).
// Do NOT import from @capacitor/core — esbuild bundling breaks the bridge connection.
function getGyroPlugin() {
  if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins) {
    return window.Capacitor.Plugins.Gyroscope || null;
  }
  return null;
}

const LOAD_TIMEOUT_MS = 30000;

const Viewer = {
  scene: null,
  camera: null,
  cameraPivot: null, // Parent group for gyroscope parallax
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
  _landscape: false,
  cameraInfo: null,
  cameraMode: 'orbit', // 'orbit' or 'free'
  freeMove: {
    velocity: new THREE.Vector3(),
    targetVelocity: new THREE.Vector3(),
    damping: 0.85,
  },
  gyro: {
    enabled: false,
    // Quaternion-based: no gimbal lock, no Euler angle jumps
    rawQuat: new THREE.Quaternion(),      // Current device quaternion
    refQuat: new THREE.Quaternion(),      // Reference quaternion (captured on enable)
    deltaQuat: new THREE.Quaternion(),    // ref⁻¹ * raw = relative rotation
    refReady: false,
    // Smoothing
    smoothYaw: 0,
    smoothPitch: 0,
    targetYaw: 0,
    targetPitch: 0,
    // Settings
    maxAngle: 0.35,    // Max look angle ~20° in each direction
    lerpFactor: 0.12,  // Smoothing speed
    deadzone: 0.02,    // Radians (~1.1°)
    // Base look direction (where camera initially points)
    baseTarget: new THREE.Vector3(0, 0, -1),
    // State
    nativeHandle: null,
    webHandler: null,
    motionHandler: null,
  },
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

      // Pivot group for gyroscope parallax: camera is child of pivot.
      // OrbitControls controls the camera, gyroscope tilts the pivot.
      // Both compose without conflict.
      this.cameraPivot = new THREE.Group();
      this.cameraPivot.add(this.camera);
      this.scene.add(this.cameraPivot);

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
      this.controls.rotateSpeed = 0.15;
      this.controls.zoomSpeed = 0.6;
      // Allow very close zoom for detail inspection
      this.controls.minDistance = 0.001;
      this.controls.maxDistance = 1000;
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
   * Extract camera intrinsics from SHARP PLY header.
   * SHARP stores focal length in 'intrinsic' element (3x3 matrix, f_px at [0] and [4])
   * and image dimensions in 'image_size' element ([width, height]).
   * Must be called BEFORE _cleanPlyHeader strips non-vertex elements.
   */
  _extractCameraInfo(uint8) {
    try {
      const decoder = new TextDecoder();
      const headerBytes = uint8.slice(0, Math.min(8192, uint8.length));
      const headerStr = decoder.decode(headerBytes);
      const endIdx = headerStr.indexOf('end_header\n');
      if (endIdx < 0) return null;

      const lines = headerStr.split('\n');
      let fPx = 0, imgWidth = 0, imgHeight = 0;

      // Parse element sizes to locate intrinsic and image_size data
      let elementOffsets = {};
      let currentElement = null;
      let vertexStride = 0;
      let dataOffset = 0;

      for (const line of lines) {
        if (line.startsWith('element ')) {
          const parts = line.split(/\s+/);
          currentElement = { name: parts[1], count: parseInt(parts[2]), stride: 0 };
          elementOffsets[parts[1]] = currentElement;
        } else if (line.startsWith('property ') && currentElement) {
          // Calculate property size
          const parts = line.split(/\s+/);
          const typeMap = { 'char':1,'uchar':1,'int8':1,'uint8':1,'short':2,'ushort':2,'int16':2,'uint16':2,'int':4,'uint':4,'int32':4,'uint32':4,'float':4,'float32':4,'double':8,'float64':8 };
          const size = typeMap[parts[1]] || 4;
          currentElement.stride += size;
        } else if (line === 'end_header') {
          break;
        }
      }

      // Calculate data offset for each element
      let offset = new TextEncoder().encode(headerStr.slice(0, endIdx + 'end_header\n'.length)).length;
      for (const elem of Object.values(elementOffsets)) {
        elem.dataOffset = offset;
        offset += elem.count * elem.stride;
      }

      // Read intrinsic (9 floats: [f_px, 0, cx, 0, f_px, cy, 0, 0, 1])
      if (elementOffsets['intrinsic']) {
        const elem = elementOffsets['intrinsic'];
        const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
        fPx = view.getFloat32(elem.dataOffset, true); // f_px at position [0]
        console.log('[Viewer] Extracted f_px:', fPx);
      }

      // Read image_size (2 uints: [width, height])
      if (elementOffsets['image_size']) {
        const elem = elementOffsets['image_size'];
        const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
        imgWidth = view.getUint32(elem.dataOffset, true);
        imgHeight = view.getUint32(elem.dataOffset + 4, true);
        console.log('[Viewer] Extracted image size:', imgWidth, 'x', imgHeight);
      }

      if (fPx > 0 && imgWidth > 0 && imgHeight > 0) {
        return { fPx, imgWidth, imgHeight };
      }
      return null;
    } catch (e) {
      console.log('[Viewer] Could not extract camera info:', e.message);
      return null;
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
      // Extract camera intrinsics BEFORE cleaning header
      const rawBytes = new Uint8Array(arrayBuffer);
      this.cameraInfo = this._extractCameraInfo(rawBytes);

      // Clean PLY header if needed
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

      // OpenCV → OpenGL coordinate conversion: rotate 180° around X axis
      // SHARP outputs OpenCV coords (Y down, Z forward into scene).
      // Three.js uses OpenGL (Y up, Z toward viewer).
      // Rotating 180° around X flips both Y and Z, moving scene from +Z to -Z.
      this.splat.rotation.x = Math.PI;
      this.splat.updateMatrixWorld(true);
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
   * Frame the model using the original camera parameters.
   *
   * SHARP captures the photo with camera at origin (0,0,0) in OpenCV space.
   * The PLY contains the focal length (f_px) and image dimensions.
   * By using these to set the camera FOV and placing the camera at origin,
   * we EXACTLY reproduce the original photo viewpoint.
   *
   * After rotation.x = PI (OpenCV→OpenGL), the scene moves to -Z.
   * Camera at origin looking at -Z with the original FOV = perfect match.
   */
  autoFrame() {
    if (!this.splat || !this.camera) return;

    try {
      if (!this.splat.isInitialized) {
        console.log('[Viewer] Splat not yet initialized, skipping autoFrame');
        return;
      }

      this.splat.updateMatrixWorld(true);

      // Get world-space bounding box for near/far calculation
      const localBox = this.splat.getBoundingBox();
      if (localBox) {
        const worldBox = localBox.clone().applyMatrix4(this.splat.matrixWorld);
        const size = worldBox.getSize(new THREE.Vector3());
        const radius = size.length() / 2;
        console.log('[Viewer] World bounding box radius:', radius.toFixed(3));
      }

      if (this.cameraInfo) {
        // Use original camera focal length to calculate FOV
        // This exactly reproduces the original photo viewpoint
        const { fPx, imgWidth, imgHeight } = this.cameraInfo;
        const fovRad = 2 * Math.atan(imgHeight / (2 * fPx));
        const fovDeg = THREE.MathUtils.radToDeg(fovRad);

        // Adjust FOV for viewport aspect ratio (contain mode)
        const imgAspect = imgWidth / imgHeight;
        const viewAspect = this.camera.aspect;
        let finalFov = fovDeg;
        if (viewAspect < imgAspect) {
          // Viewport is narrower than image — use horizontal FOV to derive vertical
          const hFovRad = 2 * Math.atan(imgWidth / (2 * fPx));
          finalFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hFovRad / 2) / viewAspect));
        }

        this.camera.fov = THREE.MathUtils.clamp(finalFov, 10, 100);
        this.camera.position.set(0, 0, 0);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(0, 0, -1);
        this.camera.near = 0.0001;
        this.camera.far = 10000;
        this.camera.updateProjectionMatrix();

        this.controls.target.set(0, 0, -1);
        this.controls.update();

        console.log('[Viewer] Camera set from PLY intrinsics:', {
          fPx, imgWidth, imgHeight, fov: this.camera.fov.toFixed(1)
        });
      } else {
        // Fallback: use bounding box if no camera info
        console.log('[Viewer] No camera info in PLY, using bounding box fallback');
        const worldBox = localBox?.clone().applyMatrix4(this.splat.matrixWorld);
        if (!worldBox) return;

        const center = worldBox.getCenter(new THREE.Vector3());
        const size = worldBox.getSize(new THREE.Vector3());
        const radius = size.length() / 2;

        const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
        const distance = (radius / Math.sin(fovRad / 2)) * 1.1;

        this.camera.position.set(0, 0, center.z + distance);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(0, 0, center.z);
        this.camera.near = Math.max(distance / 1000, 0.001);
        this.camera.far = distance * 100;
        this.camera.updateProjectionMatrix();

        this.controls.target.set(0, 0, center.z);
        this.controls.update();
      }
    } catch (e) {
      console.log('[Viewer] Auto-frame failed:', e.message);
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

    // Pre-allocated objects for gyroscope (avoid GC pressure)
    const gyroEuler = new THREE.Euler();
    const tempQuat = new THREE.Quaternion();
    const refInverse = new THREE.Quaternion();
    const lookDir = new THREE.Vector3();

    const animate = () => {
      this.animationId = requestAnimationFrame(animate);

      if (this.controls) {
        this.controls.update();
      }

      // Apply gyroscope: modify OrbitControls target so camera looks around
      // like a panorama viewer (limited range, no gimbal lock via quaternion)
      if (this.gyro.enabled && this.gyro.refReady && this.controls) {
        const g = this.gyro;

        // Compute relative quaternion: delta = ref⁻¹ * raw
        refInverse.copy(g.refQuat).invert();
        g.deltaQuat.copy(refInverse).multiply(g.rawQuat);

        // Extract yaw (left/right) and pitch (up/down) from delta quaternion
        // Convert quaternion to Euler YXZ order: yaw=Y, pitch=X
        gyroEuler.setFromQuaternion(g.deltaQuat, 'YXZ');
        let yaw = gyroEuler.y;   // left-right rotation
        let pitch = gyroEuler.x; // up-down rotation

        // Clamp to max look angle (limited panorama range ~20° each way)
        yaw = THREE.MathUtils.clamp(yaw, -g.maxAngle, g.maxAngle);
        pitch = THREE.MathUtils.clamp(pitch, -g.maxAngle, g.maxAngle);

        // Deadzone
        if (Math.abs(yaw) < g.deadzone) yaw = 0;
        if (Math.abs(pitch) < g.deadzone) pitch = 0;

        g.targetYaw = yaw;
        g.targetPitch = pitch;

        // Smooth toward target
        g.smoothYaw += (g.targetYaw - g.smoothYaw) * g.lerpFactor;
        g.smoothPitch += (g.targetPitch - g.smoothPitch) * g.lerpFactor;

        // Compute new look direction: rotate base target by yaw + pitch
        // This moves the OrbitControls target on a sphere around the camera,
        // making it look left/right/up/down like a panorama viewer.
        lookDir.copy(g.baseTarget);
        // Apply yaw (around Y axis) then pitch (around X axis)
        tempQuat.setFromEuler(gyroEuler.set(g.smoothPitch, g.smoothYaw, 0, 'YXZ'));
        lookDir.applyQuaternion(tempQuat);

        // Set target = camera position + look direction * distance
        // Use the original camera-to-target distance
        const dist = this.camera.position.distanceTo(g.baseTarget);
        this.controls.target.copy(this.camera.position).add(
          lookDir.normalize().multiplyScalar(Math.max(dist, 0.5))
        );
      }

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
   * Toggle gyroscope parallax on/off.
   * Uses native Capacitor plugin (direct SensorManager access) for reliability.
   * Falls back to Web APIs if native plugin unavailable.
   */
  async toggleGyro() {
    if (this.gyro.enabled) {
      this._disableGyro();
      return false;
    }

    // Reset state
    this.gyro.refReady = false;
    this.gyro.smoothYaw = 0;
    this.gyro.smoothPitch = 0;
    this.gyro.targetYaw = 0;
    this.gyro.targetPitch = 0;

    // Store current controls target as base
    if (this.controls) {
      this.gyro.baseTarget.copy(this.controls.target);
      // Disable touch rotate while gyro is on (zoom/pan still work)
      this.controls.enableRotate = false;
    }

    // Process quaternion data from sensor
    const processQuat = (qx, qy, qz, qw) => {
      const q = new THREE.Quaternion(qx, qy, qz, qw);
      this.gyro.rawQuat.copy(q);

      if (!this.gyro.refReady) {
        this.gyro.refQuat.copy(q);
        this.gyro.refReady = true;
        console.log('[Viewer] Gyro reference quaternion captured');
      }
    };

    // Strategy 1: Native Capacitor plugin
    const Gyroscope = getGyroPlugin();
    if (Gyroscope) {
      try {
        const result = await Gyroscope.start();
        if (result && result.started) {
          const handle = await Gyroscope.addListener("orientation", (data) => {
            if (data.qx != null) {
              processQuat(data.qx, data.qy, data.qz, data.qw);
            }
          });
          this.gyro.nativeHandle = handle;
          this.gyro.enabled = true;
          this.gyro.method = result.method || "native";
          console.log("[Viewer] Gyroscope enabled via native plugin:", result.method);
          return true;
        }
      } catch (nativeErr) {
        console.log("[Viewer] Native plugin error:", nativeErr.message || nativeErr);
      }
    }

    // Strategy 2: Web API fallback
    return this._enableWebFallback();
  },

  _disableGyro() {
    this.gyro.enabled = false;
    this.gyro.refReady = false;
    // Stop native plugin
    const Gyroscope = getGyroPlugin();
    if (Gyroscope) {
      try { Gyroscope.stop(); } catch (e) {}
    }
    if (this.gyro.nativeHandle) {
      try { this.gyro.nativeHandle.remove(); } catch (e) {}
      this.gyro.nativeHandle = null;
    }
    if (this.gyro.webHandler) {
      window.removeEventListener("deviceorientation", this.gyro.webHandler);
      this.gyro.webHandler = null;
    }
    if (this.gyro.motionHandler) {
      window.removeEventListener("devicemotion", this.gyro.motionHandler);
      this.gyro.motionHandler = null;
    }
    // Restore controls
    if (this.controls) {
      this.controls.enableRotate = true;
      // Reset target to base
      this.controls.target.copy(this.gyro.baseTarget);
    }
    console.log("[Viewer] Gyroscope disabled");
  },

  _enableWebFallback() {
    let gotData = false;

    // DeviceOrientationEvent: gives absolute beta/gamma angles
    // Convert to quaternion manually
    this.gyro.webHandler = (e) => {
      if (e.beta != null && e.gamma != null && e.alpha != null) {
        // Convert Euler (alpha, beta, gamma) to quaternion
        const alpha = THREE.MathUtils.degToRad(e.alpha);
        const beta = THREE.MathUtils.degToRad(e.beta);
        const gamma = THREE.MathUtils.degToRad(e.gamma);
        // Web API uses ZXY order
        const euler = new THREE.Euler(beta, alpha, gamma, 'YXZ');
        const q = new THREE.Quaternion().setFromEuler(euler);
        this.gyro.rawQuat.copy(q);
        gotData = true;

        if (!this.gyro.refReady) {
          this.gyro.refQuat.copy(q);
          this.gyro.refReady = true;
        }
      }
    };
    window.addEventListener('deviceorientation', this.gyro.webHandler);

    this.gyro.enabled = true;
    console.log('[Viewer] Gyroscope enabled (deviceorientation Web API)');

    setTimeout(() => {
      if (this.gyro.enabled && !gotData) {
        console.log('[Viewer] WARNING: No sensor data after 2s');
      }
    }, 2000);

    return true;
  },

  /**
   * Toggle landscape/portrait orientation using native plugin.
   */
  async toggleLandscape() {
    const Gyroscope = getGyroPlugin();
    if (!Gyroscope) return null;
    try {
      if (this._landscape) {
        await Gyroscope.lockPortrait();
        this._landscape = false;
        return false;
      } else {
        await Gyroscope.lockLandscape();
        this._landscape = true;
        return true;
      }
    } catch (e) {
      console.error('[Viewer] Landscape toggle failed:', e);
      return null;
    }
  },

  async resetOrientation() {
    if (this._landscape) {
      const Gyroscope = getGyroPlugin();
      if (Gyroscope) {
        try {
          await Gyroscope.lockPortrait();
          this._landscape = false;
        } catch (e) {}
      }
    }
  },

  /**
   * Toggle between orbit mode and free-move mode.
   * Orbit: rotate around a target point, zoom toward target (gets slower close up)
   * Free: pan/move freely, zoom translates camera forward/back at constant rate
   */
  toggleCameraMode() {
    if (this.cameraMode === 'orbit') {
      // Switch to free mode
      this.cameraMode = 'free';
      if (this.controls) {
        // In free mode: disable rotate, enable pan, custom zoom
        this.controls.enableRotate = false;
        this.controls.enablePan = true;
        // Override zoom to use constant-speed translation instead of dolly
        this._originalZoomSpeed = this.controls.zoomSpeed;
        this.controls.zoomSpeed = 1.2;
        // Set a very small minDistance to allow getting very close
        this.controls.minDistance = 0.0001;
      }
      console.log('[Viewer] Camera mode: free');
    } else {
      // Switch back to orbit mode
      this.cameraMode = 'orbit';
      if (this.controls) {
        this.controls.enableRotate = true;
        this.controls.enablePan = true;
        if (this._originalZoomSpeed) {
          this.controls.zoomSpeed = this._originalZoomSpeed;
        }
      }
      console.log('[Viewer] Camera mode: orbit');
    }
    return this.cameraMode;
  },

  /**
   * Clean up current model but keep renderer alive for reuse.
   * Called when switching models or leaving viewer page.
   */
  dispose() {
    // Disable gyroscope if active
    if (this.gyro.enabled) {
      this.toggleGyro();
    }
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

// Assign Viewer directly to window. 
// NOTE: esbuild --global-name creates a top-level var that overwrites window assignment.
// The build command must use --global-name=__sv_bundle (unused) to avoid this conflict.
window.SharpViewViewer = Viewer;

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
