import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

const TABLE = 'app_data'
const STALE_KEYS = ['result', 'confirmedShift']

// ── 起動時に不正なキーを削除
export async function cleanupStaleKeys() {
  for (const key of STALE_KEYS) {
    try { await supabase.from(TABLE).delete().eq('key', key) } catch(_) {}
  }
}

// ── 全データを取得してオブジェクトに変換
async function fetchAllData() {
  const { data, error } = await supabase.from(TABLE).select('key, value')
  if (error) { console.error('fetchAll error', error); return {} }
  const result = {}
  for (const row of data || []) result[row.key] = row.value
  return result
}

// ── 全データをリアルタイム購読
export function subscribeAll(callback) {
  const notify = async () => {
    const data = await fetchAllData()
    try { callback(data) } catch(e) { console.error('subscribeAll callback error', e) }
  }

  // 初回取得
  notify()

  // リアルタイム購読（変更があるたびに全取得して通知）
  const channel = supabase
    .channel('app_data_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, notify)
    .subscribe()

  return () => supabase.removeChannel(channel)
}

// ── キーに値を書き込む
export async function saveKey(key, value) {
  await supabase.from(TABLE).upsert({ key, value, updated_at: new Date().toISOString() })
}

// ── 初回取得（一度だけ）
export async function fetchAll() {
  return fetchAllData()
}
