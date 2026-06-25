/**
 * SharpView - GitHub API Module
 * Handles Release Asset upload/download and Actions workflow dispatch/polling.
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
   * Returns { id, uploadUrl }
   */
  async ensureRelease(config) {
    // Try to get existing release
    const resp = await fetch(`${this._repoUrl(config)}/releases/tags/${config.releaseTag}`, {
      headers: this._headers(config),
    });
    if (resp.ok) {
      const data = await resp.json();
      return { id: data.id, uploadUrl: data.upload_url };
    }
    if (resp.status !== 404) {
      const err = await resp.json().catch(() => ({}));
      throw new GitHubError('UPLOAD_FAILED', `获取 Release 失败: ${resp.status} ${err.message || ''}`);
    }
    // Need to create the tag + release. First create a tag.
    const tagResp = await fetch(`${this._repoUrl(config)}/git/refs`, {
      method: 'POST',
      headers: { ...this._headers(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: `refs/tags/${config.releaseTag}`,
        sha: await this._getDefaultBranchSha(config),
      }),
    });
    // If tag already exists (race condition), ignore error
    if (!tagResp.ok && tagResp.status !== 422) {
      const err = await tagResp.json().catch(() => ({}));
      throw new GitHubError('UPLOAD_FAILED', `创建 Tag 失败: ${tagResp.status} ${err.message || ''}`);
    }
    // Create release
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
      // Maybe release was created concurrently, try fetching again
      const retryResp = await fetch(`${this._repoUrl(config)}/releases/tags/${config.releaseTag}`, {
        headers: this._headers(config),
      });
      if (retryResp.ok) {
        const data = await retryResp.json();
        return { id: data.id, uploadUrl: data.upload_url };
      }
      const err = await createResp.json().catch(() => ({}));
      throw new GitHubError('UPLOAD_FAILED', `创建 Release 失败: ${createResp.status} ${err.message || ''}`);
    }
    const data = await createResp.json();
    return { id: data.id, uploadUrl: data.upload_url };
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
   * Upload a binary asset to the release.
   * Returns the asset info.
   */
  async uploadAsset(config, releaseId, filename, blob) {
    const url = `https://uploads.github.com/repos/${config.repoOwner}/${config.repoName}/releases/${releaseId}/assets?name=${encodeURIComponent(filename)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${config.githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/octet-stream',
      },
      body: blob,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new GitHubError('UPLOAD_FAILED', `上传图片失败: ${resp.status} ${err.message || ''}`);
    }
    return await resp.json();
  },

  /**
   * Delete an existing asset (for re-uploads with same name).
   */
  async deleteAsset(config, releaseId, assetId) {
    const resp = await fetch(`${this._repoUrl(config)}/releases/${releaseId}/assets/${assetId}`, {
      method: 'DELETE',
      headers: this._headers(config),
    });
    return resp.ok;
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
    // 204 = success (no content)
    if (resp.status !== 204) {
      const err = await resp.json().catch(() => ({}));
      throw new GitHubError('DISPATCH_FAILED', `触发 Actions 失败: ${resp.status} ${err.message || ''}`);
    }
  },

  /**
   * Find the workflow run for our job, created after the given timestamp.
   * Returns the run object or null.
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
   * Returns { status, conclusion, htmlUrl }
   */
  async getRunStatus(config, runId) {
    const url = `${this._repoUrl(config)}/actions/runs/${runId}`;
    const resp = await fetch(url, { headers: this._headers(config) });
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      status: data.status,       // 'queued' | 'in_progress' | 'completed'
      conclusion: data.conclusion, // 'success' | 'failure' | 'cancelled' | null
      htmlUrl: data.html_url,
    };
  },

  /**
   * Check if the job's output files exist on the release.
   * Returns { plyAsset, errorAsset }
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
   * Download an asset's binary content.
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
   * Download an error log text.
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

/**
 * Custom error class with error code.
 */
class GitHubError {
  constructor(code, message) {
    this.code = code;
    this.message = message;
  }
  toString() {
    return `[${this.code}] ${this.message}`;
  }
}
