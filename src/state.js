import fs from 'node:fs/promises';
import path from 'node:path';

export function createPostState() {
  return {
    baselineDone: false,
    baselineAt: null,
    baselineMinId: null,
    seen: [],
    total: null,
    lastPollAt: null,
    lastNewAt: null,
    lastPushAt: null,
    lastDeepScanAt: null,
    lastError: null,
  };
}

export function createSiteState() {
  return {
    baselineDone: false,
    baselineAt: null,
    baselineCount: null,
    seen: [],
    lastPollAt: null,
    lastNewAt: null,
    lastPushAt: null,
    lastError: null,
    authPausedUntil: null,
    backoffUntil: null,
    authAlertAt: null,
  };
}

export function createEmptyState() {
  return {
    version: 2,
    updatedAt: null,
    posts: {},
    sites: {},
    authPausedUntil: null,
    authAlertAt: null,
    backoffUntil: null,
    lastHeartbeatDate: null,
    // 健康度：最近一轮的结果、连续失败轮数、各类告警的去重时间
    failStreak: 0,
    lastCycleAt: null,
    lastSuccessAt: null,
    lastPushAt: null,
    failAlertAt: null,
    cookieAlertFor: null,
    startupAlertAt: null,
  };
}

const OPTIONAL_STRING_FIELDS = [
  'authPausedUntil',
  'authAlertAt',
  'backoffUntil',
  'lastHeartbeatDate',
  'lastCycleAt',
  'lastSuccessAt',
  'lastPushAt',
  'failAlertAt',
  'cookieAlertFor',
  'startupAlertAt',
];

function normalizePostState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    ...createPostState(),
    ...state,
    baselineDone: Boolean(state.baselineDone),
    seen: Array.isArray(state.seen) ? state.seen.map((id) => String(id)) : [],
    lastError: state.lastError && typeof state.lastError === 'object' ? state.lastError : null,
  };
}

function normalizeSiteState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    ...createSiteState(),
    ...state,
    baselineDone: Boolean(state.baselineDone),
    baselineCount: Number.isFinite(state.baselineCount) ? state.baselineCount : null,
    seen: Array.isArray(state.seen) ? state.seen.map((id) => String(id)) : [],
    lastError: state.lastError && typeof state.lastError === 'object' ? state.lastError : null,
  };
}

export function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const state = createEmptyState();
  state.updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : null;
  for (const key of OPTIONAL_STRING_FIELDS) {
    state[key] = typeof source[key] === 'string' ? source[key] : null;
  }
  state.failStreak = Number.isInteger(source.failStreak) && source.failStreak > 0 ? source.failStreak : 0;

  if (source.posts && typeof source.posts === 'object' && !Array.isArray(source.posts)) {
    for (const [postId, postState] of Object.entries(source.posts)) {
      state.posts[String(postId)] = normalizePostState(postState);
    }
  }

  if (source.sites && typeof source.sites === 'object' && !Array.isArray(source.sites)) {
    for (const [siteId, siteState] of Object.entries(source.sites)) {
      state.sites[String(siteId)] = normalizeSiteState(siteState);
    }
  }
  return state;
}

export async function loadState(file, { logger } = {}) {
  const candidates = [file, `${file}.bak`];

  for (const candidate of candidates) {
    let text;
    try {
      text = await fs.readFile(candidate, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger?.warn(`读取状态文件失败：${candidate}`, { error: err.message });
      }
      continue;
    }

    try {
      const parsed = JSON.parse(text);
      return {
        state: normalizeState(parsed),
        recoveredFrom: candidate === file ? null : candidate,
      };
    } catch (err) {
      logger?.warn(`状态文件不是合法 JSON：${candidate}`, { error: err.message });
    }
  }

  return { state: createEmptyState(), recoveredFrom: null };
}

export async function saveState(file, state) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });

  state.version = 2;
  state.updatedAt = new Date().toISOString();
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const tmpFile = `${file}.tmp`;
  const backupFile = `${file}.bak`;

  await fs.writeFile(tmpFile, text, 'utf8');

  try {
    await fs.copyFile(file, backupFile);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  try {
    await fs.rename(tmpFile, file);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EPERM') {
      await fs.rm(file, { force: true });
      await fs.rename(tmpFile, file);
    } else {
      throw err;
    }
  }
}

export function ensurePostState(state, postId) {
  const key = String(postId);
  if (!state.posts[key]) state.posts[key] = createPostState();
  return state.posts[key];
}

export function seenSet(postState) {
  return new Set((postState.seen || []).map((id) => String(id)));
}

export function ensureSiteState(state, siteId) {
  const key = String(siteId);
  if (!state.sites) state.sites = {};
  if (!state.sites[key]) state.sites[key] = createSiteState();
  return state.sites[key];
}

export function siteSeenSet(siteState) {
  return new Set((siteState.seen || []).map((id) => String(id)));
}

export function markSiteSeen(siteState, ids, maxSeen = 20000) {
  markSeen(siteState, ids, maxSeen);
}

export function markSeen(postState, ids, maxSeen = 20000) {
  const set = new Set((postState.seen || []).map((id) => String(id)));
  for (const id of ids) set.add(String(id));
  postState.seen = [...set].slice(-maxSeen);
}
