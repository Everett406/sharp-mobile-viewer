/**
 * SharpView - GitHub API Module
 * Uses Contents API for upload (base64 JSON, CapacitorHttp-compatible).
 * Uses Release Assets API for PLY output (CI-side, no CORS issues).
 */

const GitHubAPI = {
  _headers(config) {
    return {
      'Authorization': `token ${config.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
    };
  },

  _repoUrl(config) {
    return `https://api.github.com/repos/${config.repoOwner}/${config.repoName}`;
  },

  /**
   * Ensure the splat-jobs release exists. Create if missing.
   * Returns { id }
   */
  async ensureRelease(config) {
    const resp = await fetch(`${this._repoUrl(config)}/releases/tags/${config.releaseTag}`, {
      headers: this._headers(config),
    });
    if (resp.ok) {
      const data = await resp.json();
      return { id: data.id };
    }
    if (resp.status !== 404) {
      const err = await resp.json().catch(() => ({}));
      throw new GitHubError('UPLOAD_FAILED', `获取 Release 失败: ${resp.status} ${err.message || ''}`);
    }
    // Create tag + release
    const tagResp = await fetch(`${this._repoUrl(config)}/git/refs`, {
      method: 'POST',
      headers: { ...this._headers(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: `refs/tags/${config.releaseTag}`,
        sha: await this._getDefaultBranchSha(config),
      }),
    });
    if (!tagResp.ok && tagResp.status !== 422) {
      const err = await tagResp.json().catch(() => ({}));
      throw new GitHubError('UPLOAD_FAILED', `创建 Tag 失败: ${tagResp.status} ${err.message || ''}`);
    }
    const createResp = await fetch(`${this._repoUrl(config)}/releases`, {
      method: 'POST',
      headers: { ...this._headers(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: config.releaseTag,
        name: 'SHARP Splat Jobs',
        body: 'Auto-generated release for SHARP inference jobs',
        draft: false,
        prerelease: true,
      }),
    });
    if (!createResp.ok) {
      const retryResp = await fetch(`${this._repoUrl(config)}/releases/tags/${config.releaseTag}`, {
        headers: this._headers(config),
      });
      if (retryResp.ok) {
        const data = await retryResp.json();
        return { id: data.id };
      }
      const err = await createResp.json().catch(() => ({}));
      throw new GitHubError('UPLOAD_FAILED', `创建 Release 失败: ${createResp.status} ${err.message || ''}`);
    }
    const data = await createResp.json();
    return { id: data.id };
  },

  async _getDefaultBranchSha(config) {
    const resp = await fetch(`${this._repoUrl(config)}/git/refs/heads/main`, {
      headers: this._headers(config),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new GitHubError('UPLOAD_FAILED', `获取默认分支失败: ${resp.status} ${err.message || ''}`);
    }
    const data = await resp.json();
    return data.object.sha;
  },

  /**
   * Upload image to repo using Contents API (base64 JSON body).
   * CapacitorHttp handles JSON bodies correctly.
   * File path: jobs/input_{jobId}.jpg
   */
  async uploadInputImage(config, jobId, blob) {
    // Convert blob to base64
    const base64 = await this._blobToBase64(blob);
    const path = `jobs/input_${jobId}.jpg`;
    const url = `${this._repoUrl(config)}/contents/${path}`;

    const resp = await fetch(url, {
      method: 'PUT',
      headers: { ...this._headers(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `upload: input_${jobId}.jpg`,
        content: base64,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new GitHubError('UPLOAD_FAILED', `上传图片失败: ${resp.status} ${err.message || ''}`);
    }
    return await resp.json();
  },

  /**
   * Delete input file from repo after processing.
   */
  async deleteInputFile(config, jobId) {
    const path = `jobs/input_${jobId}.jpg`;
    // First get the file SHA
    const getResp = await fetch(`${this._repoUrl(config)}/contents/${path}`, {
      headers: this._headers(config),
    });
    if (!getResp.ok) return;
    const fileData = await getResp.json();
    const sha = fileData.sha;

    await fetch(`${this._repoUrl(config)}/contents/${path}`, {
      method: 'DELETE',
      headers: { ...this._headers(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `cleanup: remove input_${jobId}.jpg`,
        sha: sha,
      }),
    });
  },

  /**
   * Convert Blob to base64 string (without data: prefix).
   */
  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },

  /**
   * Trigger the SHARP inference workflow via workflow_dispatch.
   */
  async triggerWorkflow(config, jobId) {
    const url = `${this._repoUrl(config)}/actions/workflows/sharp.yml/dispatches`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...this._headers(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: 'main',
        inputs: { job_id: jobId },
      }),
    });
    if (resp.status !== 204) {
      const err = await resp.json().catch(() => ({}));
      throw new GitHubError('DISPATCH_FAILED', `触发 Actions 失败: ${resp.status} ${err.message || ''}`);
    }
  },

  /**
   * Find the workflow run created after the given timestamp.
   */
  async findRun(config, since) {
    const url = `${this._repoUrl(config)}/actions/runs?per_page=10&event=workflow_dispatch`;
    const resp = await fetch(url, { headers: this._headers(config) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const runs = data.workflow_runs || [];
    for (const run of runs) {
      if (new Date(run.created_at) >= since) {
        return run;
      }
    }
    return null;
  },

  /**
   * Get the status of a workflow run.
   */
  async getRunStatus(config, runId) {
    const url = `${this._repoUrl(config)}/actions/runs/${runId}`;
    const resp = await fetch(url, { headers: this._headers(config) });
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      status: data.status,
      conclusion: data.conclusion,
      htmlUrl: data.html_url,
    };
  },

  /**
   * Check if the job's output files exist on the release.
   */
  async checkJobAssets(config, jobId) {
    const resp = await fetch(`${this._repoUrl(config)}/releases/tags/${config.releaseTag}`, {
      headers: this._headers(config),
    });
    if (!resp.ok) return { plyAsset: null, errorAsset: null };
    const release = await resp.json();
    const assets = release.assets || [];
    return {
      plyAsset: assets.find(a => a.name === `${jobId}.ply`) || null,
      errorAsset: assets.find(a => a.name === `${jobId}.error.txt`) || null,
    };
  },

  /**
   * Download an asset's binary content (PLY file).
   */
  async downloadAsset(config, assetId) {
    const url = `${this._repoUrl(config)}/releases/assets/${assetId}`;
    const resp = await fetch(url, {
      headers: { ...this._headers(config), 'Accept': 'application/octet-stream' },
    });
    if (!resp.ok) {
      throw new GitHubError('DOWNLOAD_FAILED', `下载失败: ${resp.status}`);
    }
    return await resp.blob();
  },

  /**
   * Download error log text.
   */
  async downloadErrorLog(config, assetId) {
    const url = `${this._repoUrl(config)}/releases/assets/${assetId}`;
    const resp = await fetch(url, {
      headers: { ...this._headers(config), 'Accept': 'application/octet-stream' },
    });
    if (!resp.ok) return '无法获取错误日志';
    return await resp.text();
  },

  /**
   * Validate the GitHub connection.
   */
  async testConnection(config) {
    if (!config.githubToken || !config.repoOwner || !config.repoName) {
      return { success: false, error: 'CONFIG_INVALID', message: '请填写完整配置' };
    }
    try {
      const resp = await fetch(`${this._repoUrl(config)}`, {
        headers: this._headers(config),
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

class GitHubError {
  constructor(code, message) {
    this.code = code;
    this.message = message;
  }
  toString() {
    return `[${this.code}] ${this.message}`;
  }
}
