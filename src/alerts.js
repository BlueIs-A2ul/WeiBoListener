const DAY_MS = 24 * 3600 * 1000;

/** Cookie 剩余天数小于等于这个值就推送预警。 */
export const COOKIE_ALERT_DAYS = 7;
/** 连续失败多少轮开始告警。 */
export const FAIL_ALERT_THRESHOLD = 3;
/** 连续失败告警的最小间隔。 */
export const FAIL_ALERT_WINDOW_MS = DAY_MS;
/** 启动失败告警的最小间隔（任务计划每分钟重试，没有这个窗口会刷屏）。 */
export const STARTUP_ALERT_WINDOW_MS = 6 * 3600 * 1000;
/** Cookie 失效告警的最小间隔。 */
export const AUTH_ALERT_WINDOW_MS = 12 * 3600 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function errorLine(lastError) {
  if (!lastError || !lastError.message) return null;
  return lastError.name ? `[${lastError.name}] ${lastError.message}` : String(lastError.message);
}

/**
 * 心跳正文。原则是「如实」：这一轮的成功/失败数、最近一次成功的时间，
 * 异常时直接用告警口吻，不再出现「状态：正常」。
 */
export function buildHeartbeatContent({ config, state, cycle, now }) {
  const ok = Number(cycle?.ok) || 0;
  const failed = Number(cycle?.failed) || 0;
  const failStreak = Number(state.failStreak) || 0;
  const abnormal = failStreak > 0 || failed > 0;
  const enabledPosts = config.posts.filter((post) => post.enabled).length;

  const lines = [abnormal ? '微博监听心跳（异常）' : '微博监听心跳'];
  lines.push(abnormal ? `状态：异常（连续 ${failStreak || 1} 轮失败）` : '状态：正常');

  const detail = abnormal ? errorLine(cycle?.lastError) : null;
  if (detail) lines.push(`异常：${detail}`);

  lines.push(`监控：${enabledPosts} 条微博`);
  lines.push(`本轮：${ok} 成功 / ${failed} 失败`);
  lines.push(`最近成功：${formatLocalDateTime(state.lastSuccessAt) || '尚未成功'}`);

  const lastPush = formatLocalDateTime(state.lastPushAt);
  if (lastPush) lines.push(`最近推送：${lastPush}`);

  return lines.join('\n');
}

export async function maybeHeartbeat({ config, state, cycle, logger, dryRun = false, sendMessage, now }) {
  if (config.heartbeatHour === null || config.heartbeatHour === undefined) return false;

  const current = now();
  if (current.getHours() < config.heartbeatHour) return false;

  const today = localDate(current);
  if (state.lastHeartbeatDate === today) return false;

  const content = buildHeartbeatContent({ config, state, cycle, now: current });
  const abnormal = (Number(state.failStreak) || 0) > 0 || (Number(cycle?.failed) || 0) > 0;
  const summary = abnormal ? '微博监听异常' : '微博监听正常运行';

  if (dryRun) {
    logger.info(`[dry-run] 将发送每日心跳：\n${content}`);
    state.lastHeartbeatDate = today;
    return false;
  }

  try {
    await sendMessage({ content, summary });
    state.lastHeartbeatDate = today;
    logger.info('每日心跳已发送');
    return true;
  } catch (err) {
    logger.error('每日心跳发送失败', { error: err.message });
    return false;
  }
}

/** 连续失败告警：同一次故障里由 auth/backoff 告警负责，这里不叠加。 */
export async function maybeFailureAlert({ state, cycle, logger, dryRun = false, sendMessage, now }) {
  const failStreak = Number(state.failStreak) || 0;
  if (failStreak < FAIL_ALERT_THRESHOLD) return false;
  if (state.authPausedUntil || state.backoffUntil) return false;

  const current = now();
  const lastAlert = state.failAlertAt ? new Date(state.failAlertAt).getTime() : 0;
  if (current.getTime() - lastAlert < FAIL_ALERT_WINDOW_MS) return false;

  const lines = ['微博监听连续失败', `已连续 ${failStreak} 轮轮询失败`];
  const detail = errorLine(cycle?.lastError);
  if (detail) lines.push(`最近错误：${detail}`);
  lines.push(`最近成功：${formatLocalDateTime(state.lastSuccessAt) || '尚未成功'}`);
  lines.push('请检查网络连接、Cookie 是否有效，或查看 logs 目录。');
  const content = lines.join('\n');

  if (dryRun) {
    logger.warn(`[dry-run] 将发送连续失败告警：\n${content}`);
    state.failAlertAt = current.toISOString();
    return false;
  }

  try {
    await sendMessage({ content, summary: `微博监听连续失败 ${failStreak} 轮` });
    state.failAlertAt = current.toISOString();
    logger.warn(`连续失败告警已发送（第 ${failStreak} 轮）`);
    return true;
  } catch (err) {
    logger.error('连续失败告警发送失败', { error: err.message });
    return false;
  }
}

/** Cookie 临期预警：同一个过期时间只提醒一次，换新 Cookie 后会重新提醒。 */
export async function maybeCookieExpiryAlert({ state, expiry, logger, dryRun = false, sendMessage, now }) {
  if (!expiry) return false;
  const expiresAt = expiry instanceof Date ? expiry : new Date(expiry);
  if (Number.isNaN(expiresAt.getTime())) return false;

  const current = now();
  const daysLeft = Math.floor((expiresAt.getTime() - current.getTime()) / DAY_MS);
  if (!Number.isFinite(daysLeft) || daysLeft > COOKIE_ALERT_DAYS) return false;

  const signature = expiresAt.toISOString();
  if (state.cookieAlertFor === signature) return false;

  const when = formatLocalDateTime(expiresAt);
  const lines = [
    '微博 Cookie 即将过期',
    daysLeft >= 0 ? `剩余 ${daysLeft} 天：${when}` : `已于 ${when} 过期`,
    '过期后将无法抓取待审评论，监听会停止推送。',
    '更新方法：配置面板 → 凭据 → 粘贴新的 Cookie → 保存。',
  ];
  const content = lines.join('\n');

  if (dryRun) {
    logger.warn(`[dry-run] 将发送 Cookie 临期告警：\n${content}`);
    state.cookieAlertFor = signature;
    return false;
  }

  try {
    await sendMessage({ content, summary: `微博 Cookie 剩余 ${daysLeft} 天` });
    state.cookieAlertFor = signature;
    logger.warn(`Cookie 临期告警已发送（剩余 ${daysLeft} 天）`);
    return true;
  } catch (err) {
    logger.error('Cookie 临期告警发送失败', { error: err.message });
    return false;
  }
}

/** 启动失败告警：配置缺失时进程会退出，任务计划每分钟重试，靠窗口去重。 */
export async function maybeStartupAlert({
  state,
  reason,
  logger,
  dryRun = false,
  sendMessage,
  now,
  saveState = async () => {},
}) {
  const current = now();
  const last = state.startupAlertAt ? new Date(state.startupAlertAt).getTime() : 0;
  if (current.getTime() - last < STARTUP_ALERT_WINDOW_MS) return false;

  const content = [
    '微博监听启动失败',
    `原因：${reason}`,
    `时间：${formatLocalDateTime(current)}`,
    '修好后监听会自动恢复（任务计划每分钟重试）。',
  ].join('\n');

  if (dryRun) {
    logger.warn(`[dry-run] 将发送启动失败告警：\n${content}`);
    return false;
  }

  try {
    await sendMessage({ content, summary: '微博监听启动失败' });
    state.startupAlertAt = current.toISOString();
    await saveState();
    logger.warn('启动失败告警已发送');
    return true;
  } catch (err) {
    logger.error('启动失败告警发送失败', { error: err.message });
    return false;
  }
}

export async function maybeAuthAlert({ state, logger, dryRun, sendMessage, now, error }) {
  const lastAlert = state.authAlertAt ? new Date(state.authAlertAt).getTime() : 0;
  if (now().getTime() - lastAlert < AUTH_ALERT_WINDOW_MS) return false;

  const content = [
    '微博监听 Cookie 失效',
    error.message,
    '请更新 .env 中的 WEIBO_COOKIE，然后重启程序。',
  ].join('\n');

  if (dryRun) {
    logger.warn('[dry-run] 将发送 Cookie 失效告警');
    state.authAlertAt = now().toISOString();
    return false;
  }

  try {
    await sendMessage({ content, summary: '微博监听 Cookie 失效' });
    state.authAlertAt = now().toISOString();
    logger.warn('Cookie 失效告警已发送');
    return true;
  } catch (err) {
    logger.error('Cookie 失效告警发送失败', { error: err.message });
    return false;
  }
}
