import { initializeApp } from 'firebase/app'
import { getDatabase, ref, set, remove, onValue, get } from 'firebase/database'

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL:       import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)
const db  = getDatabase(app)

// ── 起動時に不正なキーを削除（過去の不具合で書き込まれた大容量データ）
const STALE_KEYS = ['result', 'confirmedShift', 'savedResult']  // savedResultはlocalStorage移行済みのため削除対象
export async function cleanupStaleKeys() {
  for (const key of STALE_KEYS) {
    try { await remove(ref(db, `shiftmaster/${key}`)) } catch(_) {}
  }
}

// ── 全データをリアルタイム購読
export function subscribeAll(callback) {
  const r = ref(db, 'shiftmaster')
  return onValue(r, (snap) => {
    try { callback(snap.exists() ? snap.val() : {}) } catch(e) { console.error('subscribeAll callback error', e) }
  })
}

// ── キーに値を書き込む
export async function saveKey(key, value) {
  await set(ref(db, `shiftmaster/${key}`), value)
}

// ── 初回取得（一度だけ）
export async function fetchAll() {
  const snap = await get(ref(db, 'shiftmaster'))
  return snap.exists() ? snap.val() : {}
}
