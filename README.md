# SharpView

> 将照片转化为 3D 高斯泼溅场景的 Android App

**当前版本: v0.4.1**

SharpView 基于 Apple 开源的 [SHARP](https://github.com/apple/ml-sharp) 模型，通过 GitHub Actions 云端推理，将单张照片重建为 3D Gaussian Splatting 场景，并在手机端实时渲染查看。

## 核心特性

- **单图转 3D**：一张照片生成 3D 高斯泼溅场景（.ply）
- **云端推理**：利用 GitHub Actions 免费 runner 运行 SHARP 模型，手机端零算力
- **模型缓存**：Actions 工作流缓存 2GB 模型 + Python 环境，首次后推理启动更快
- **实时查看**：基于 Spark 2.1 + Three.js 的 WebGL 渲染器，支持旋转、缩放、重置视角
- **查看器设置**：背景色、FOV、Splat 缩放、Alpha 剔除、点云模式等实时调节
- **下载进度**：PLY 下载显示文件大小和百分比进度
- **本地加载**：支持直接加载手机本地 .ply 文件预览
- **任务持久化**：历史记录保存，支持后台轮询、重试、删除（含本地缓存清理）
- **深色模式**：全局主题切换，默认跟随系统
- **全白嫖**：推理和 APK 打包均使用 GitHub Actions 免费额度

## 技术架构

```
手机 App (Capacitor)
  ├── 压缩图片 → 上传到 GitHub Release Asset
  ├── 触发 workflow_dispatch → GitHub Actions 调用 SHARP CLI
  ├── 轮询 Release Assets → 下载 .ply
  └── Spark 渲染器 → 实时 3D 查看
```

| 组件 | 技术选型 |
|---|---|
| 前端框架 | Capacitor 6 + Vanilla JS |
| 3D 渲染器 | Spark (@sparkjsdev/spark) + Three.js |
| 推理引擎 | Apple SHARP (ml-sharp) |
| 云端推理 | GitHub Actions (Ubuntu, CPU) |
| APK 构建 | GitHub Actions + Gradle |
| 包名 | com.sharpmobile.app |

## 快速开始

### 前置要求

- Node.js 18+
- GitHub 账号（建议公开仓库，Actions 免费且无分钟限制）
- GitHub Personal Access Token（需 `repo` 权限）

### 安装

```bash
# 克隆仓库
git clone https://github.com/Everett406/sharp-mobile-viewer.git
cd sharp-mobile-viewer

# 安装依赖
npm install

# 添加 Android 平台
npx cap add android

# 本地开发预览
npm run dev
```

### 配置

1. 在 App 设置页填写 GitHub Token、仓库 Owner、仓库名
2. 点击"测试连接"确认配置有效
3. 设置图片压缩参数（默认最长边 1536px，JPEG 质量 0.9）
4. 设置云端保留天数（默认 3 天）和最大等待时间（默认 30 分钟）

### 构建 APK

APK 通过 GitHub Actions 自动构建：

1. 在 GitHub 仓库 Settings → Secrets 中添加：
   - `KEYSTORE_BASE64`：签名密钥的 Base64 编码
   - `KEYSTORE_PASSWORD`：密钥库密码
   - `KEY_ALIAS`：密钥别名
   - `KEY_PASSWORD`：密钥密码
2. 推送 `v*` 标签触发构建：
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. 构建完成后从 GitHub Release 下载 APK

## 项目结构

```
sharp-mobile-viewer/
├── .github/workflows/
│   ├── sharp.yml          # SHARP 推理工作流
│   ├── build-apk.yml      # APK 自动构建签名发布
│   └── cleanup.yml        # 定时清理旧 asset
├── frontend/
│   ├── index.html         # 应用入口
│   ├── styles/
│   │   ├── theme.css      # 设计系统色彩/字体 Token
│   │   └── components.css  # 组件样式
│   ├── scripts/
│   │   ├── app.js         # 主应用逻辑
│   │   ├── github.js      # GitHub API 模块
│   │   └── viewer.js      # 3D 查看器 (Spark + Three.js)
│   ├── manifest.json      # PWA 清单
│   └── sw.js              # Service Worker
├── capacitor.config.json  # Capacitor 配置
├── package.json
└── README.md
```

## 使用流程

1. 打开 App，首次启动进入设置页配置 GitHub 连接
2. 在首页选择图片（相册/拍照）或加载本地 .ply
3. 确认图片后点击"开始生成 3D 场景"
4. 等待 GitHub Actions 推理完成（约 5-15 分钟）
5. 自动下载 .ply 并打开 3D 查看器
6. 支持旋转、缩放、重置视角、下载 PLY、删除本地缓存

## 错误码

| 错误码 | 说明 |
|---|---|
| `CONFIG_INVALID` | Token/Owner/Repo 配置无效 |
| `UPLOAD_FAILED` | 图片上传失败 |
| `DISPATCH_FAILED` | Actions 触发失败 |
| `JOB_TIMEOUT` | 推理超时 |
| `JOB_FAILED` | 推理失败 |
| `DOWNLOAD_FAILED` | PLY 下载失败 |
| `PLY_PARSE_ERROR` | PLY 文件解析失败 |
| `WEBGL_UNSUPPORTED` | 设备不支持 WebGL2 |
| `FILE_TOO_LARGE` | 文件过大 |
| `UNKNOWN_ERROR` | 未知错误 |

## 开源许可

MIT License

## 致谢

- [Apple SHARP](https://github.com/apple/ml-sharp) - 核心推理模型
- [Spark](https://github.com/sparkjsdev/spark) - WebGL 高斯泼溅渲染器
- [Photo-Reframing](https://github.com/henjicc/Photo-Reframing) - 桌面端参考实现
- [Capacitor](https://capacitorjs.com) - Web 到原生打包方案
