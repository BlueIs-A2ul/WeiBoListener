export function idToBigInt(id) {
  const value = String(id ?? '').trim();
  if (!/^\d+$/.test(value)) throw new Error(`非法评论 ID：${value}`);
  return BigInt(value);
}

export function compareIds(a, b) {
  const left = idToBigInt(a);
  const right = idToBigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function uniqueById(comments) {
  const map = new Map();
  for (const comment of comments) {
    const id = String(comment.id);
    if (!map.has(id)) map.set(id, comment);
  }
  return [...map.values()];
}

export function findNewComments(comments, seenSet) {
  return uniqueById(comments)
    .filter((comment) => !seenSet.has(String(comment.id)))
    .sort((a, b) => compareIds(a.id, b.id));
}

export function minId(comments) {
  if (!comments || comments.length === 0) return null;
  return comments.reduce((lowest, comment) => {
    if (lowest === null) return String(comment.id);
    return compareIds(comment.id, lowest) < 0 ? String(comment.id) : lowest;
  }, null);
}

export function isAtOrOlderThanBaseline(id, baselineMinId) {
  if (!baselineMinId) return false;
  return compareIds(id, baselineMinId) <= 0;
}

export function isDeepScanDue(postState, now, intervalHours) {
  if (!intervalHours || intervalHours <= 0) return false;
  if (!postState.lastDeepScanAt) return true;
  const last = new Date(postState.lastDeepScanAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalHours * 3600 * 1000;
}

export function partitionExcluded(comments, keywords = []) {
  const list = keywords
    .map((keyword) => String(keyword).trim().toLowerCase())
    .filter(Boolean);

  if (list.length === 0) return { included: comments, excluded: [] };

  const included = [];
  const excluded = [];
  for (const comment of comments) {
    const text = String(comment.text ?? '').toLowerCase();
    if (list.some((keyword) => text.includes(keyword))) excluded.push(comment);
    else included.push(comment);
  }
  return { included, excluded };
}
