# 任务提示词：把 Apple SHARP 做成“手机拍照/选图 → GitHub Actions 生成 3D 高斯泼溅 → 手机查看”的 APK

> 状态：需求说明 + 可用开源资源 + 技术方案 + 产品流程 + 验收标准。
> **核心要求：不要从零开始写，优先复用下面列出的开源项目，只做必要的改造和集成。**
> **关键约束：推理放在 GitHub Actions 免费跑，APK 也用 GitHub Actions 打包，全程白嫖。**

---

## 1. 任务目标

实现一套端到端系统：

1. 用户在 **Android 手机** 上打开 App。
2. 从相册选一张图（默认），或在设置里切换成拍照。
3. 图片在手机上压缩后，上传到 GitHub Release Asset。
4. 触发 GitHub Actions 工作流，在 GitHub 免费 runner 上调用 **Apple SHARP（ml-sharp）** 生成 3D Gaussian Splat（`.ply`）。
5. GitHub Actions 把生成的 `.ply` 传回 GitHub Release Asset。
6. 手机端轮询到结果后下载 `.ply`，用 WebGL 查看器渲染，支持旋转、缩放、重置视角。
7. 最终产物：
   - 一个 GitHub 仓库（含 Actions 工作流 + 前端代码 + Capacitor 配置）。
   - 一个可打包成 **APK** 的前端项目。
   - APK 通过 GitHub Actions 自动构建并发布到 GitHub Release。

---

## 2. 背景与前因后果（必须理解）

### 2.1 Apple SHARP / ml-sharp（核心模型）

- 这是苹果开源的单目 3D Gaussian Splatting 模型。
- 输入：**一张普通 2D 图片**。
- 输出：一个 `.ply` 文件，包含约 120 万个 3D 高斯（参考官方论文）。
- 官方仓库：https://github.com/apple/ml-sharp
- 官方 CLI 用法：
  ```bash
  sharp predict -i /path/to/input/images -o /path/to/output/gaussians
  ```
- 模型文件 `sharp_2572gikvuh.pt` 约 **2.44 GB**，首次运行会自动下载到 `~/.cache/torch/hub/checkpoints/`。
- 推理在 GPU 上**不到 1 秒**，但 GitHub Actions 免费 runner 只有 CPU，所以会比较慢（一次可能 3~15 分钟），但能用。
- 手机端直接运行会 OOM，因此采用**云端（GitHub Actions）推理 + 手机仅查看**的方案。

### 2.2 Photo-Reframing（最重要的桌面参考实现）

- 仓库：https://github.com/henjicc/Photo-Reframing
- 这是一个 Electron 桌面应用，已经完整跑通了：
  - 图片上传（JPG/PNG/HEIC/HEIF/WEBP）
  - 本地 SHARP 推理
  - 用 `@sparkjsdev/spark` 做 Gaussian Splat 渲染器
  - Three.js 查看器：旋转、缩放、重置视角
  - 打包脚本（轻量包 / 完整离线包）
- **它的 `.exe` 是 Windows 安装包，不能直接被转成 APK。**
- **但它的前端渲染代码、Spark 接入方式、坐标转换逻辑可以直接参考甚至移植到 Capacitor 前端里。**

#### Photo-Reframing 功能 vs 本 Mobile 方案的对比与取舍

| 桌面功能 | 当前 Mobile 文档状态 | 建议 |
|---|---|---|
| 本地 ONNX Runtime 推理（模型 2.44GB） | 明确排除，改为 GitHub Actions 云端推理 | **保持排除**，手机端只做上传/查看。 |
| 多后端选择（WebGPU/DML/CUDA/CoreML/CPU） | 未提及 | **不加**，云端固定 CPU 后端。 |
| 图片上传格式 JPG/PNG/HEIC/HEIF/WEBP | 已提及 JPG/PNG/HEIC | **补全 HEIF/WEBP**。 |
| EXIF 方向修正 | 已简要提及 | **保留并强化**。 |
| 质量预设 balanced/high/full | 未提及 | **不建议作为生成参数**（SHARP CLI 不支持），但可作为查看器 LOD/输出压缩参考。 |
| 最大高斯数 / 透明度阈值 / 焦距覆盖 | 未提及 | **加入查看器高级设置**，不影响推理时间。 |
| KIE 二次图像重建（API key、模型、分辨率、修复遮罩） | 完全未提及 | **V2/可选扩展**，当前不加，避免引入第二个付费云 API。 |
| 参考图叠加 / 修复遮罩捕获 | 未提及 | **不加**，依赖 KIE。 |
| 查看器背景色 / FOV / 点云模式 / Splat Scale 等 | 未提及 | **加入可选高级设置**。 |
| 相机自动适配与坐标转换 | 已提及 | **保留**。 |
| 重置视角 / 缩放 / 旋转 | 已提及 | **保留**。 |
| 下载 PLY / 加载本地 PLY | 已提及 | **保留**。 |
| 错误代码体系 | 未系统定义 | **新增统一错误码表**。 |
| 深色模式 | 已提及 | **保留**。 |
| 历史列表与缩略图 | 已提及 | **保留**。 |
| 云端清理旧 asset | 已提及 | **保留**。 |
| 多平台安装包（Win/macOS/Linux） | 不适用 | **只出 Android APK**。 |
| 当前视角截图 | 未提及 | **作为可选加分项**。 |

### 2.3 为什么不用 issue 触发 Actions？

- 用户提到过想用 issue，因为之前有 issue 触发 Actions 的经验。
- 但 GitHub **没有公开的 API 可以把图片作为 issue 附件上传**（网页拖拽上传走的是内部未公开接口，需要浏览器 session，API token 调不了）。
- 所以最终采用：**App 直接把图片上传到 GitHub Release Asset，再调用 `workflow_dispatch` 触发 Actions**。
- 这样最稳、最标准、token 权限也最小（`repo` 或 `public_repo` 即可）。

---

## 3. 可复用的开源资源（不要从零开始）

### 3.1 后端 / SHARP 封装

| 项目 | 链接 | 能复用什么 |
|---|---|---|
| **apple/ml-sharp** | https://github.com/apple/ml-sharp | 核心模型和 `sharp` CLI。GitHub Actions 里直接 `git clone` 并安装。 |
| **Photo-Reframing** | https://github.com/henjicc/Photo-Reframing | 它的 `models/` 目录和推理脚本可以参考，尤其是它用 `sharp_web_predictor.onnx` 的方式。 |
| **neosun100/sharp** | https://github.com/neosun100/sharp | 已经把 SHARP 包成了 Docker + Web UI + REST API。如果想后续扩展成自建后端，可以参考它的 API 设计。 |
| **OpenMarble / MarbleOS** | https://github.com/mohamedsobhi777/OpenMarble | Next.js 前端 + FastAPI 后端调用 SHARP。它的前端上传/轮询/查看页面结构可以参考。 |
| **StereoSplatViewer** | https://github.com/amariichi/StereoSplatViewer | FastAPI 后端 + Vite/React 前端，生成 PLY 后浏览器查看。 |
| **ml-sharp-ez** | https://github.com/boutell/ml-sharp-ez | 脚本封装，批量转 PLY 并生成 WebXR 网站。 |

### 3.2 前端 / 3D 查看器

| 项目 | 链接 | 能复用什么 |
|---|---|---|
| **Photo-Reframing** | https://github.com/henjicc/Photo-Reframing | 最重要的参考。它的 `src/renderer` 里有 Spark + Three.js 查看器代码、相机控制、坐标转换，可以直接移植到 Capacitor 前端。 |
| **Spark 2.x** | https://github.com/sparkjsdev/spark / https://sparkjs.dev/docs/ | 推荐的 WebGL 渲染器，支持 PLY/SPZ/SPLAT/KSPLAT，移动端性能好。前端优先用它。 |
| **gaussian-splats-web-viewer** | https://github.com/candemiroguzhan/gaussian-splats-web-viewer | 一个极简的 Vite + Three.js 查看器，适合作为“只查看 PLY”的备选方案。 |
| **GaussianSplats3D** | https://github.com/mkkellogg/GaussianSplats3D | 另一个 Three.js 查看器，支持 `.ply`、`.splat`、`.ksplat`。如果 Spark 不合适，可以换这个。 |
| **SuperSplat Viewer** | https://github.com/playcanvas/supersplat-viewer | PlayCanvas 的查看器，也可以加载 PLY。 |

### 3.3 原生 App / APK 壳子

| 方案 | 说明 |
|---|---|
| **Capacitor** | https://capacitorjs.com/docs  把前端网页包成 APK 的官方推荐方案。 |
| **Cordova** | 老牌方案，备选。 |
| **Splat Studio** | App Store 上的 visionOS 应用，不开源，不能直接用，但证明了手机/头显本地查看 SHARP 结果是可行的。 |

---

## 4. 技术架构（GitHub Actions 为中心）

```
┌─────────────────┐
│   Android App   │
│   (Capacitor)   │
└────────┬────────┘
         │ 1. 压缩图片
         │ 2. 上传为 GitHub Release Asset (input_{job_id}.jpg)
         │ 3. 触发 workflow_dispatch(job_id)
         ▼
┌─────────────────────────────────────────────┐
│          GitHub Actions (sharp.yml)          │
│  - 下载输入图片                              │
│  - 缓存 SHARP 模型 (~2.44GB)                 │
│  - 调用 ml-sharp CLI 生成 .ply (CPU 慢但免费) │
│  - 把 {job_id}.ply 上传为 Release Asset      │
│  - 失败时上传 {job_id}.error.txt             │
└─────────────────────────────────────────────┘
         │
         │ 4. 轮询 Release Assets
         ▼
┌─────────────────┐
│   Android App   │  5. 下载 .ply，用 Spark 查看
└─────────────────┘
```

### 4.1 GitHub Actions 推理流程（核心）

仓库里需要三个工作流：

#### `.github/workflows/sharp.yml`

- 触发方式：`workflow_dispatch`，输入 `job_id`。
- 环境：Ubuntu-latest，CPU only。
- 步骤：
  1. Checkout 本仓库。
  2. 安装 Python 3.10+，安装 ml-sharp 依赖。
  3. 用 `actions/cache` 缓存 `~/.cache/torch/hub/checkpoints`（模型 2.44GB，避免每次下载）。
  4. 从 Release `splat-jobs` 下载输入图片 `input_{job_id}.jpg`。
  5. 运行 `sharp predict -i jobs/{job_id}/input -o jobs/{job_id}/output`。
  6. 如果成功，把 `jobs/{job_id}/output/*.ply` 上传到 Release `splat-jobs`，命名为 `{job_id}.ply`。
  7. 如果失败，上传 `{job_id}.error.txt`，包含错误信息。

#### `.github/workflows/build-apk.yml`

- 触发方式：推送 `v*` 标签，或手动触发。
- 步骤：
  1. Checkout 前端代码。
  2. `npm ci`。
  3. `npm run build`。
  4. `npx cap sync android`。
  5. 用 Android 签名密钥对 APK 签名（密钥存在 GitHub Secrets 里）。
  6. 上传签名 APK 到 GitHub Release。

#### `.github/workflows/cleanup.yml`

- 触发方式：`schedule` 每天一次，或手动触发。
- 功能：
  - 删除 Release `splat-jobs` 里超过 N 天的旧 asset（输入图片和 PLY）。
  - 默认保留 **2~3 天**。

### 4.2 前端

- **框架**：Capacitor + Vanilla JS/TS（越小越好，方便 GitHub Actions 快速构建）。
- **UI**：详见第 6 节“产品流程与 UI 原型”。
- **3D 查看器**：
  - 优先使用 **Spark 2.x**（`@sparkjsdev/spark`）。
  - Spark 示例代码核心：
    ```js
    import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);
    const splat = new SplatMesh({
      url: 'https://github.com/{owner}/{repo}/releases/download/splat-jobs/{job_id}.ply'
    });
    scene.add(splat);
    ```
- **本地 `.ply` 加载**：App 也要支持从手机存储直接选一个 `.ply` 文件预览，方便调试和反复查看。

### 4.3 APK 打包（全程 GitHub Actions）

- 不需要本地 Android Studio。
- 签名密钥以 Base64 形式存在 GitHub Secrets：`KEYSTORE_BASE64`、`KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`。
- GitHub Actions 里解码 keystore，对 APK 签名，发布 Release。
- 参考命令：
  ```bash
  echo $KEYSTORE_BASE64 | base64 -d > android/app/release-key.jks
  cd android && ./gradlew assembleRelease
  ```
- 包名先用 `com.sharpmobile.app`，应用名用 `SharpView`（后续正式发布前再改）。

---

## 5. 详细功能需求

### 5.1 GitHub 配置（用户在 App 内填写）

App 首次启动进入设置页，用户填写：

- **GitHub Token**：有 `repo`（私有库）或 `public_repo`（公开库）权限的 Personal Access Token。
- **仓库 Owner / Repo**：例如 `myname/sharp-mobile-viewer`。
- **仓库类型**：公开 / 私有。App 根据这个决定用哪个 token scope 请求（实际还是同一个 token，只是错误提示不同）。
- **Release Tag**：默认 `splat-jobs`，一般不用改。
- **最大超时时间**：默认 30 分钟。
- **图片压缩参数**：默认最长边 1536px、JPEG 质量 0.9，可手动调整。
- **云端保留天数**：默认 2~3 天。
- **深色模式**：默认跟随系统，可手动开关。
- **默认图片来源**：相册 或 相机。
- **高级查看器设置（可选，默认折叠）**：
  - 画布背景色（默认 `#2b2928`）。
  - FOV（默认 75°）。
  - Splat 缩放（默认 1.0）。
  - Alpha 剔除阈值（默认 0，即不剔除）。
  - 点云模式开关（默认关闭）。
  - 最大屏幕空间 splat 尺寸（默认 512）。
  > 这些参数只影响本地渲染，不影响 GitHub Actions 推理时间。

所有配置存在手机本地（Capacitor Preferences），不要写进代码仓库。

**本地缓存策略**：下载到本地的 `.ply` 一直保留，直到用户在历史列表里手动删除。不设置自动上限，避免误删用户想保留的场景。

### 5.2 GitHub 交互协议

#### 上传图片并触发

1. App 生成一个 `job_id`（格式：`sharp_{timestamp}_{random4位}`，方便看时间）。
2. 压缩图片（默认最长边 1536px，JPEG 质量 0.9，目标 < 2MB）。
3. 调用 GitHub API 上传图片到 Release `splat-jobs`，asset 名为 `input_{job_id}.jpg`。
   - 如果 Release `splat-jobs` 不存在，App 或 Actions 自动创建。
   - API：`POST https://uploads.github.com/repos/{owner}/{repo}/releases/{release_id}/assets?name=input_{job_id}.jpg`
4. 调用 GitHub API 触发 `workflow_dispatch`：
   - `POST /repos/{owner}/{repo}/actions/workflows/sharp.yml/dispatches`
   - body：`{"ref":"main","inputs":{"job_id":"xxx"}}`

#### 批量模式

- 用户在相册里一次选择多张图片（建议最多 5~10 张，防止排队太长）。
- 每张图独立生成 `job_id`、独立上传 `input_{job_id}.jpg`、独立触发 `workflow_dispatch`。
- GitHub Actions 免费账号默认支持一个仓库 **20 个并发 workflow**，所以多张图可以并行跑。
- App 端同时轮询多个 job，每个 job 的状态单独更新到历史列表。
- 如果用户批量选的图太多，App 可以提示“一次最多 X 张”。

#### 轮询结果

1. 每 10 秒调用 GitHub API 获取 Release `splat-jobs` 的 assets 列表。
2. 如果存在 `{job_id}.ply`，则下载。
3. 如果存在 `{job_id}.error.txt`，则显示错误。
4. 如果超过用户设置的超时时间（默认 30 分钟），提示失败。

#### 下载 PLY

- GitHub Release Asset 下载链接需要 `Authorization: token {GH_TOKEN}` 头。
- 下载后保存到手机本地缓存目录，再传给 Spark 查看器。
- 典型 `.ply` 大小约 **60MB**，下载时显示进度条。

### 5.3 查看器高级选项（可选）

在 3D 查看页顶部菜单或设置页里，提供“高级”折叠面板：

- **背景色**：Color picker，预设深色/浅色/透明格。
- **FOV**：滑动条 30°–120°。
- **Splat Scale**：滑动条 0.1–5.0。
- **Alpha Removal Threshold**：滑动条 0–1。
- **Point Cloud Mode**：开关，开启后只渲染点（如果 Spark 支持）。
- **Max Screen-Space Splat Size**：滑动条 64–2048。
- **显示信息浮层**：文件大小、高斯数（如果 PLY 头可读）、FPS。
- **截图当前视角**：可选，保存到相册。

这些设置只在当前查看会话生效，退出查看页后恢复默认值；如有必要可持久化到 Preferences。

### 5.4 手机端 UI 与产品流程

详见第 6 节。

---

## 6. 产品流程与 UI 原型

### 6.1 首次启动 / 设置页

```
┌─────────────────────────────┐
│  设置                        │
│                             │
│  GitHub Token     [______]  │
│  仓库 Owner       [______]  │
│  仓库名           [______]  │
│  公开/私有        [○公开]   │
│                             │
│  [测试连接]                 │
│                             │
│  图片压缩                        │
│  最长边           [1536]    │
│  质量             [0.9]     │
│                             │
│  云端保留天数     [3]       │
│  最大等待时间     [30分钟]  │
│                             │
│  深色模式         [开关]    │
│  默认图片来源     [相册]    │
│                             │
│  [保存]                     │
└─────────────────────────────┘
```

- 必须测试连接成功后才能进入首页。
- Token 存在本地，不要提交到仓库。
- **深色模式**：全局主题切换，默认跟随系统。
- **默认图片来源**：相册或相机，首页主按钮据此变化。

### 6.2 首页

```
┌─────────────────────────────┐
│  SharpView            [设置] │
│                             │
│  [   从相册选择图片   ]      │
│                             │
│  [   加载本地 .ply    ]      │
│                             │
│  ─── 最近生成 ───           │
│  ┌────┐  job_0625_8a3b    │
│  │缩略│  状态：已完成      │
│  │图  │  云端剩余 1 天     │
│  └────┘  [查看] [删除]     │
│                             │
│  ┌────┐  job_0624_7f2e    │
│  │缩略│  状态：Actions 中  │
│  │图  │  已等待 05:32      │
│  └────┘  [取消]            │
└─────────────────────────────┘
```

- **从相册选择图片**：默认入口。调用系统相册，支持多选（批量模式）。
- **拍照小按钮**：首页主按钮旁边放一个小的相机图标按钮，快速拍照。
- **加载本地 .ply**：直接选手机里的 `.ply` 文件预览。
- **历史列表**：每个 job 显示：
  - 输入图片缩略图（本地保存的压缩图）。
  - job_id。
  - 状态：上传中 / 排队中 / Actions 运行中 / 生成完成 / 下载中 / 失败 / 已过期。
  - 云端剩余时间（如果 PLY 还在 Release 上）。
  - 本地是否已下载。
- 点击已完成项：如果已下载本地就本地打开；如果没下载就从 Release 下载再打开。
- 左滑/长按删除本地记录（不影响云端 asset，等 cleanup 自动删）。

### 6.3 处理 / 状态页

```
┌─────────────────────────────┐
│  正在生成 3D 场景            │
│                             │
│  ✅ 压缩图片                 │
│  ✅ 上传到 GitHub            │
│  ⏳ Actions 运行中           │
│     已等待 04:12            │
│     （模型加载 / 推理中）    │
│  ⏸ 下载 .ply                 │
│  ⏸ 渲染场景                  │
│                             │
│  [取消]                     │
│                             │
│  提示：CPU 推理较慢，         │
│  首次运行还需下载 2.44GB 模型│
└─────────────────────────────┘
```

- 显示每一步的状态和耗时。
- 取消按钮：仅取消前端轮询，不停止已触发的 Actions（因为停了也白嫖不到，就算了）。
- 失败时跳转到错误详情页，显示 GitHub Actions 返回的错误文本。

### 6.4 3D 查看页

```
┌─────────────────────────────┐
│  [返回]  job_0625_8a3b  [⋮] │
│                             │
│                             │
│      ┌─────────────┐        │
│      │             │        │
│      │   3D 场景    │        │
│      │  (Spark)    │        │
│      │             │        │
│      └─────────────┘        │
│                             │
│  [重置视角] [下载PLY] [删除] │
└─────────────────────────────┘
```

- 全屏 Spark 渲染器。
- 默认竖屏，但允许跟随系统自动旋转（不锁定方向）。
- 手势：单指旋转、双指缩放、双指平移（Spark/OrbitControls 默认支持）。
- 底部悬浮按钮：
  - **重置视角**：回到初始相机位置。
  - **下载 PLY**：把当前 `.ply` 保存到手机 Downloads。
  - **删除本地**：删除本地缓存的 PLY，记录保留但显示“需重新下载”。
- 顶部菜单：
  - 显示信息：文件大小、splat 数量、渲染 FPS。
  - **高级设置**按钮：展开/折叠背景色、FOV、Splat Scale、Alpha 剔除、点云模式、最大屏幕空间 splat 尺寸。
  - **截图**按钮（可选）：保存当前 viewport 到相册。

### 6.5 完整闭环流程图（Mermaid + 文字说明）

> 本节是给实现者看的完整状态机。你可以不读图，但 AI 需要能读懂。

```mermaid
flowchart TD
    A[App启动] --> B{首次启动?}
    B -->|是| C[设置页]
    B -->|否| D{配置有效?}
    D -->|否| C
    D -->|是| E[首页]
    C --> F[测试GitHub连接]
    F -->|失败| C
    F -->|成功| G[保存配置]
    G --> E

    E --> H[用户操作]
    H -->|相册/拍照| I[选择图片]
    H -->|加载本地.ply| J[直接打开查看器]
    H -->|点击历史项| K{本地有PLY?}
    K -->|有| L[打开查看器]
    K -->|无| M{云端已完成?}
    M -->|是| N[下载PLY]
    M -->|否| O[状态页继续等待]
    N --> L
    H -->|批量选择| P[多图并行处理]

    I --> Q[压缩+EXIF处理]
    Q --> R[生成job_id]
    R --> S[上传input_{job_id}.jpg到Release]
    S --> T[触发workflow_dispatch]
    T --> U[加入历史列表/状态:上传完成]
    U --> V[轮询Release Assets]

    V --> W{发现{job_id}.ply?}
    W -->|是| X[下载到本地缓存]
    X --> Y[状态:完成]
    Y --> Z[可打开查看器]

    V --> AA{发现{job_id}.error.txt?}
    AA -->|是| AB[读取错误内容]
    AB --> AC[状态:失败/显示错误]

    V --> AD{超时?}
    AD -->|是| AE[状态:超时失败]

    P --> Q

    Z --> AF[用户打开查看器]
    AF --> AG[Spark渲染]
    AG --> AH[用户手势交互]
    AH --> AI[重置视角/下载/删除本地缓存]

    AJ[定时cleanup Actions] --> AK[删除N天前旧asset]
    AL[用户删除历史记录] --> AM[删除本地缓存+可选删除云端asset]
```

**关键分支说明**：

- **首次启动分支**：没有配置 → 强制设置页。
- **配置失效分支**：Token 过期 / 仓库不存在 / 网络不通 → 回到设置页并提示。
- **历史项分支**：
  - 已完成 + 本地有 PLY → 直接看。
  - 已完成 + 本地没有 → 从云端下载再看。
  - 未完成 → 进入状态页继续等待。
  - 已过期 → 显示“云端已删除”，可选重新上传原图再跑。
- **批量分支**：多张图各自生成独立 job_id，独立上传、独立触发 Actions、独立轮询。GitHub Actions 免费账号支持多个 workflow 并发跑（默认一个 repo 最多 20 个并发 job）。
- **错误分支**：每个阶段失败都要把状态写入历史列表，并允许用户重试或删除。
- **清理分支**：云端 asset 由 Actions 定时删；本地记录由用户手动删，本地 PLY 一直保留直到用户删除。

---

## 7. 推荐目录结构

```
sharp-mobile-viewer/
├── .github/
│   └── workflows/
│       ├── sharp.yml          # SHARP 推理工作流
│       ├── build-apk.yml      # APK 自动构建签名发布
│       └── cleanup.yml        # 定时清理旧 asset
├── frontend/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── manifest.json          # PWA
│   └── sw.js                  # PWA
├── android/                   # npx cap add android 生成
├── capacitor.config.json
├── package.json
└── README.md
```

---

## 8. 关键实现要点与避坑指南

### 8.1 GitHub Actions 端

1. **模型缓存**：
   - 用 `actions/cache` 缓存 `~/.cache/torch/hub/checkpoints`。
   - 如果缓存命中，首次推理就会很快；没命中时要下载 2.44GB，可能占满 Actions 磁盘或超时。
   - 缓存 7 天无访问会失效，偶尔用的话会重新下载。

2. **模型下载超时**：
   - Actions 单步默认 6 小时，但网络慢时模型下载可能失败。
   - 可以在工作流里先用 `wget` 断点续传下载模型到 `models/` 并缓存。

3. **CPU 推理时间**：
   - SHARP 官方说 GPU <1s，CPU 可能要几分钟到十几分钟。
   - 工作流 timeout 建议设 60 分钟。

4. **Release Asset 命名**：
   - 不能带 `/`，所以用 `input_{job_id}.jpg` 和 `{job_id}.ply`。
   - Release `splat-jobs` 需要存在，App 或 Actions 自动创建。

5. **错误信息回传**：
   - SHARP 失败时，把工作流日志里的关键错误写进 `{job_id}.error.txt` 上传到 Release，方便 App 显示。

### 8.2 前端

1. **GitHub Token 安全**：
   - Token 由用户在 App 设置页手动输入，存在 Capacitor Preferences 里。
   - 代码仓库里不放真实 token，只留 `.env.example` 或配置模板。
   - 因为 token 在 APK 里，理论上可被反编译提取。self-use 可接受，不要分发给别人。

2. **图片压缩**：
   - 必须在客户端压缩，否则上传慢且 GitHub API 可能限制。
   - 默认最长边 1536px，JPEG 质量 0.9。
   - **处理 EXIF Orientation**：上传前根据 Orientation 标签转正，避免生成场景歪。
   - HEIC/HEIF 图片需要先转成 JPEG（可用 `heic2any` 或让系统相册返回 JPEG）。
   - WEBP 如果带透明度，转成 JPEG 时背景填白。

3. **本地 .ply 加载**：
   - Capacitor 里读取本地文件需要 `@capacitor/filesystem` 或 `<input type="file">`。
   - Spark 的 `SplatMesh({ url })` 可以直接接收 `blob:` 或 `capacitor://` URL。

4. **坐标系转换**：
   - SHARP 输出使用 OpenCV 坐标系（x right, y down, z forward）。
   - Three.js/Spark 默认 y up。
   - 参考 Photo-Reframing 的处理方式，实现自动转正和相机 fit。

5. **深色模式**：
   - 设置页可开关，默认跟随系统。
   - UI 主题色、历史列表、状态页、设置页都要适配。
   - 3D 查看器画布背景建议用深色，和浅色模式区分开。

6. **错误显示**：
   - 因为用户不用 Android Studio，所有错误必须在 App UI 上显示出来。
   - 包括：网络错误、GitHub API 错误、Actions 失败、.ply 下载失败、WebGL2 不支持、文件过大等。

6. **缩略图**：
   - 历史列表的缩略图直接用本地保存的压缩后输入图，不需要额外生成。

### 8.3 错误代码与用户提示（必须）

定义统一错误码，方便 UI 显示和排查：

| 错误码 | 触发场景 | 用户提示建议 |
|---|---|---|
| `CONFIG_INVALID` | Token/Owner/Repo 为空或测试连接失败 | 请检查 GitHub 设置并测试连接。 |
| `UPLOAD_FAILED` | Release Asset 上传失败（网络、权限、重名） | 上传失败，请检查网络或 token 权限。 |
| `DISPATCH_FAILED` | workflow_dispatch 触发失败 | 无法触发 Actions，请检查仓库是否有该工作流文件。 |
| `JOB_TIMEOUT` | 超过用户设置的最大等待时间 | 生成超时，请检查 Actions 状态或稍后重试。 |
| `JOB_FAILED` | 发现 `{job_id}.error.txt` | 推理失败，点击查看详情。 |
| `DOWNLOAD_FAILED` | `.ply` 下载失败 | 下载失败，请检查网络。 |
| `PLY_PARSE_ERROR` | 下载的 `.ply` 损坏或无法解析 | 文件解析失败，可尝试重新下载。 |
| `WEBGL_UNSUPPORTED` | 设备不支持 WebGL2 | 当前设备无法渲染 3D 场景。 |
| `FILE_TOO_LARGE` | 压缩后图片仍 > GitHub 限制或 PLY > 2GB | 文件过大，请换一张图或降低压缩尺寸。 |
| `UNKNOWN_ERROR` | 其他未分类错误 | 发生未知错误，请重试或查看日志。 |

- 每个错误都要在 UI 上显示中文，并附带“重试 / 返回 / 查看日志”按钮。
- 错误日志可记录到本地文件，方便调试时导出。

### 8.4 APK 构建

1. **Capacitor 配置**：
   - `capacitor.config.json` 里设置 `webDir` 为 `frontend`。
   - Android 最低 API 26，targetSdk 按 Google 最新要求。

2. **权限**：
   - `CAMERA`
   - `READ_EXTERNAL_STORAGE` / `READ_MEDIA_IMAGES`
   - `INTERNET`
   - 在 `AndroidManifest.xml` 和 Capacitor 插件里声明。

3. **签名与发布**：
   - 本地生成 keystore：`keytool -genkey -v -keystore release-key.jks ...`
   - Base64 编码后存为 GitHub Secret `KEYSTORE_BASE64`。
   - Actions 里解码并签名 APK。
   - APK 发布到 GitHub Release，版本号跟随 Git tag。

4. **APK 大小**：
   - 前端代码 + Spark/Three 打包后 APK 可能 5~15MB，正常。
   - `.ply` 不打包进 APK，运行时从 Release 下载。

---

## 9. 非功能性需求

- **成本**：全程使用 GitHub Actions 免费额度。公开仓库 Actions 完全免费；私有仓库每月 2000 分钟，CPU 跑 SHARP 可能很快用完，建议用公开仓库。
- **推理时间**：CPU 推理 3~15 分钟可接受，App 要有耐心等待界面。
- **稳定性**：上传失败、Actions 失败、网络中断、WebGL 不支持都要有明确中文提示。
- **可部署性**：
  - 提供 GitHub Actions 工作流，一键跑 SHARP、一键构建 APK。
  - 前端 `npm install && npm run build` 即可出静态包。
- **可维护性**：代码注释清晰，关键配置抽离到配置文件或设置页。
- **隐私**：图片上传到 GitHub Release，公开仓库会公开。建议用私有仓库或接受公开。
- **深色模式**：全局支持，切换无闪烁。
- **批量处理**：UI 和逻辑都要支持一次选多张图并行生成。

---

## 10. 参考资源

- Apple SHARP：https://github.com/apple/ml-sharp
- Photo-Reframing（桌面参考，含 Spark 查看器代码）：https://github.com/henjicc/Photo-Reframing
- SHARP Docker + API 封装：https://github.com/neosun100/sharp
- OpenMarble（Next.js + FastAPI 封装 SHARP）：https://github.com/mohamedsobhi777/OpenMarble
- StereoSplatViewer（FastAPI + React 前端）：https://github.com/amariichi/StereoSplatViewer
- ml-sharp-ez（WebXR 生成脚本）：https://github.com/boutell/ml-sharp-ez
- Spark 渲染器：https://github.com/sparkjsdev/spark / https://sparkjs.dev/docs/
- GaussianSplats3D（备选查看器）：https://github.com/mkkellogg/GaussianSplats3D
- SuperSplat Viewer（备选查看器）：https://github.com/playcanvas/supersplat-viewer
- Capacitor 文档：https://capacitorjs.com/docs
- GitHub Actions 文档：https://docs.github.com/cn/actions
- GitHub Releases API：https://docs.github.com/cn/rest/releases

---

## 11. 验收标准

必须全部满足：

- [ ] GitHub Actions 工作流能成功从单张图片生成 `.ply`。
- [ ] 手机 App 能拍照/选图、上传、触发 Actions、轮询并下载 `.ply`。
- [ ] 下载的 `.ply` 能在 App 里用 Spark 正常渲染。
- [ ] 用户可以旋转、缩放、重置视角。
- [ ] App 支持加载本地 `.ply` 文件预览。
- [ ] GitHub Actions 能自动构建签名 APK 并发布到 Release。
- [ ] 所有关键错误都在 App UI 上显示。
- [ ] 支持深色模式切换。
- [ ] 提供 README，说明如何配置 GitHub Token、创建 Release、触发构建。

可选加分项：

- [ ] 定时清理旧 asset（2~3 天）。
- [ ] PWA 支持。
- [ ] 历史记录列表带缩略图和云端过期倒计时。
- [ ] 批量选择多张图片并行生成。
- [ ] 对 `.ply` 做压缩或转 `.spz`/`.ksplat`，提升手机加载速度。
- [ ] 查看器高级设置（背景色、FOV、Splat Scale、Alpha 剔除、点云模式、最大屏幕空间 splat 尺寸）。
- [ ] 截图当前视角并保存到相册。
- [ ] 统一的错误码体系与中文提示。
- [ ] 正式上线前完成 Google Play 要求的包名、隐私政策、截图等准备。

---

## 12. 已知风险与注意事项

1. **GitHub Actions 免费额度**：公开仓库 Actions 免费且无分钟限制，但 Release Asset 公开；私有仓库每月 2000 分钟，CPU 跑 SHARP 可能很快用完。
2. **模型下载稳定性**：2.44GB 模型在 Actions 里第一次下载可能失败，需要断点续传或预置缓存。
3. **CPU 推理慢**：一次 3~15 分钟，App 需要耐心等待界面。
4. **Release Asset 公开**：默认 Release 是公开的，所有生成的 PLY 和图片都能被他人下载。建议用私有仓库，或对 job_id 使用随机 UUID 增加不可猜测性。
5. **Token 泄漏风险**：APK 里存储的 GitHub Token 可以被反编译提取。self-use 可接受，不要分发给别人。
6. **GitHub API 速率限制**：上传和轮询要控制频率，避免触发 403。
7. **大文件限制**：GitHub Release 单个 Asset 最大 2GB，PLY 通常 60MB 左右，没问题。
8. **正式发布**：要上 Google Play 需要包名唯一、隐私政策、targetSdk 合规、内容分级等，现在先按“自己用 + 侧载”做，后续再补。
