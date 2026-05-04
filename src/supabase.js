const URL  = import.meta.env.VITE_SUPABASE_URL
const KEY  = import.meta.env.VITE_SUPABASE_ANON_KEY
const TABLE = 'app_data'
const STALE_KEYS = ['result', 'confirmedShift']
const POLL_INTERVAL = 4000

function headers(extra = {}) {
  return {
    'apikey': KEY,
    'Authorization': `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

// ── 起動時に不正なキーを削除
export async function cleanupStaleKeys() {
  for (const key of STALE_KEYS) {
    try {
      await fetch(`${URL}/rest/v1/${TABLE}?key=eq.${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: headers(),
      })
    } catch(_) {}
  }
}

// ── 全データを取得してオブジェクトに変換
async function fetchAllData() {
  try {
    const res = await fetch(`${URL}/rest/v1/${TABLE}?select=key,value`, {
      headers: headers(),
    })
    if (!res.ok) return {}
    const rows = await res.json()
    const result = {}
    for (const row of rows) result[row.key] = row.value
    return result
  } catch(_) {
    return {}
  }
}

// ── ポーリングで全データを購読（4秒ごと）
export function subscribeAll(callback) {
  const notify = async () => {
    const data = await fetchAllData()
    try { callback(data) } catch(e) { console.error('subscribeAll callback error', e) }
  }

  notify()
  const timer = setInterval(notify, POLL_INTERVAL)
  return () => clearInterval(timer)
}

// ── キーに値を書き込む
export async function saveKey(key, value) {
  await fetch(`${URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: headers({ 'Prefer': 'resolution=merge-duplicates' }),
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  })
}

// ── 初回取得（一度だけ）
export async function fetchAll() {
  return fetchAllData()
}
