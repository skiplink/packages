// Thin client for the Skiplink API. No dependencies — a CI tool that pulls a
// tree of HTTP libraries to make four requests is a supply-chain liability for
// everyone who installs it.

const DEFAULT_BASE = 'https://api.skiplink.dev';

export class ApiError extends Error {
  constructor(message, { status, code, param } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

export class Client {
  constructor({ token, baseUrl = DEFAULT_BASE, timeoutMs = 120000, userAgent = 'skiplink-cli' } = {}) {
    if (!token) {
      throw new ApiError(
        'No API key. Pass --token or set SKIPLINK_TOKEN. Get one at https://skiplink.dev/signup/',
      );
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError(`Request to ${this.baseUrl}${path} timed out.`);
      }
      // Node's own message here is usually just "fetch failed"; the cause has the
      // part a person can act on (ENOTFOUND, ECONNREFUSED, a certificate error).
      const cause = err.cause?.code || err.cause?.message || err.message;
      throw new ApiError(
        `Could not reach the Skiplink API at ${this.baseUrl} (${cause}). ` +
          'Check the network from this machine, or https://skiplink.dev/status/ for the API itself.',
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError(`${this.baseUrl}${path} returned a non-JSON response (${response.status}).`);
      }
    }

    if (!response.ok) {
      const err = payload?.error || {};
      throw new ApiError(err.message || `Request failed with status ${response.status}.`, {
        status: response.status,
        code: err.code,
        param: err.param,
      });
    }

    return payload;
  }

  /** Queue a batch and return the scan stubs. */
  scanBatch(urls, options = {}) {
    return this.request('POST', '/v1/scan/batch', { urls, ...options });
  }

  getScan(id) {
    return this.request('GET', `/v1/scans/${id}`);
  }

  /**
   * Wait for a set of scans to finish.
   *
   * Polls in passes with a small delay rather than per-scan retry loops. The API
   * rate-limits per key, and a CI job that hammers it just gets throttled into
   * looking slow — the same mistake the load generator made before it was fixed.
   */
  async waitForAll(ids, { onProgress, pollMs = 1500, timeoutMs = 600000 } = {}) {
    const results = new Map();
    const deadline = Date.now() + timeoutMs;
    let outstanding = [...ids];

    while (outstanding.length > 0) {
      if (Date.now() > deadline) {
        throw new ApiError(
          `Timed out waiting for ${outstanding.length} scan(s) to finish after ${Math.round(timeoutMs / 1000)}s.`,
        );
      }

      const stillOut = [];
      for (const id of outstanding) {
        let scan;
        try {
          scan = await this.getScan(id);
        } catch (err) {
          if (err.status === 429) {
            // Back off and keep the whole pass waiting, rather than treating a
            // throttled poll as an unfinished scan.
            await sleep(5000);
            stillOut.push(id);
            continue;
          }
          throw err;
        }

        if (scan.status === 'queued' || scan.status === 'running') {
          stillOut.push(id);
        } else {
          results.set(id, scan);
        }
      }

      outstanding = stillOut;
      if (onProgress) onProgress(results.size, ids.length);
      if (outstanding.length > 0) await sleep(pollMs);
    }

    return ids.map((id) => results.get(id));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
