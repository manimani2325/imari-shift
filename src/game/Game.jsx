import { useState, useEffect, useRef, useCallback } from 'react'
import Scenery, { skyTopColor } from './Scenery.jsx'
import { PLACES, PLACE_BY_ID, TIMES, SENSES } from './data/places.js'
import { YOKAI } from './data/yokai.js'
import {
  TITLE, SUBTITLE, MAX_DAY, INTRO, RULES, YOSHI, GRANDMA_IDLE,
  SLEEP, FINALE, EPILOGUE, endingFor,
} from './data/story.js'

const SAVE_KEY = 'oumagatoki.save.v1'

// まちがった感覚を使ったときの、ちいさなヒント
const NUDGE = {
  miru:   'なにかが、目のはしに ひっかかっている。もういちど、じっと 見たほうがいい。',
  kiku:   '耳のおくが、じんとする。なにか 聞こえそうで、聞こえない。',
  kagu:   'このあたりの空気に、ひとつだけ、まざっているにおいがある。',
  sawaru: '手のひらが、そわそわする。なにかに さわってみたほうがいい。',
  yobu:   'ここは、こっちから 声を出さないと、なにも はじまらない気がする。',
}

const INITIAL = {
  day: 1,
  timeIdx: 0,
  placeId: 'engawa',
  captured: {},
  items: [],
  yoshiIdx: 0,
  hintIdx: 0,
  cleared: false,
  endingKind: null,
}

function useTypewriter(text, speed = 26) {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    if (!text) return undefined
    const id = setInterval(() => {
      setN((v) => {
        if (v >= text.length) { clearInterval(id); return v }
        return v + 1
      })
    }, speed)
    return () => clearInterval(id)
  }, [text, speed])
  return [text ? text.slice(0, n) : '', !text || n >= text.length, () => setN(text ? text.length : 0)]
}

export default function Game() {
  const [phase, setPhase] = useState('title')       // title|intro|play|mondo|finale|ending
  const [st, setSt] = useState(INITIAL)
  const [scene, setScene] = useState({ lines: [], idx: 0, done: false })
  const [mondo, setMondo] = useState(null)          // { yokaiId, round }
  const [overlay, setOverlay] = useState(null)      // 'zukan'|'move'|null
  const [shaken, setShaken] = useState(false)
  const afterRef = useRef(null)
  const bodyRef = useRef(null)
  const [hasSave, setHasSave] = useState(false)

  useEffect(() => {
    try { setHasSave(!!localStorage.getItem(SAVE_KEY)) } catch { /* 読めなくてもいい */ }
  }, [])

  // オートセーブ
  useEffect(() => {
    if (phase === 'title' || phase === 'intro') return
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ st, phase: phase === 'mondo' ? 'play' : phase })) }
    catch { /* 保存できなくても遊べる */ }
  }, [st, phase])

  const place = PLACE_BY_ID[st.placeId]
  const time = TIMES[st.timeIdx]
  const capturedCount = Object.keys(st.captured).length

  const say = useCallback((lines, after) => {
    afterRef.current = after || null
    setScene({ lines: Array.isArray(lines) ? lines : [lines], idx: 0, done: false })
  }, [])

  const current = scene.lines[scene.idx] ?? ''
  const [typed, done, finishTyping] = useTypewriter(scene.done ? '' : current)
  const talking = scene.lines.length > 0 && !scene.done

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scene.idx, typed])

  function advance() {
    if (!talking) return
    if (!done) { finishTyping(); return }
    if (scene.idx < scene.lines.length - 1) {
      setScene((s) => ({ ...s, idx: s.idx + 1 }))
      return
    }
    // 読み終わった文はそのまま残す（あとから読みかえせるように）
    const f = afterRef.current
    afterRef.current = null
    setScene((sc) => ({ ...sc, done: true }))
    if (f) f()
  }

  const shake = () => { setShaken(true); setTimeout(() => setShaken(false), 620) }

  /* ───────── 進行 ───────── */

  function arrive(placeId, timeIdx, extra = []) {
    const p = PLACE_BY_ID[placeId]
    const t = TIMES[timeIdx]
    say([`── ${p.name}　／　${t.label}`, p.ambient[t.id], ...extra])
  }

  function nextDay(nextSt) {
    const day = nextSt.day + 1
    if (day > MAX_DAY) {
      setSt({ ...nextSt, day: MAX_DAY, timeIdx: 3 })
      say([SLEEP[Math.min(SLEEP.length - 1, nextSt.day - 1)], '', 'そして、夏がおわった。'], startFinale)
      return
    }
    const s2 = { ...nextSt, day, timeIdx: 0, placeId: 'engawa' }
    setSt(s2)
    say([
      SLEEP[Math.min(SLEEP.length - 1, nextSt.day - 1)],
      '',
      `── なつやすみ ${day}日目。のこり ${MAX_DAY - day + 1}日。`,
      PLACE_BY_ID.engawa.ambient.asa,
    ])
  }

  function move(placeId) {
    setOverlay(null)
    if (placeId === st.placeId) {
      say(['おなじところを、ぐるっと まわっただけだった。'])
      return
    }
    if (st.timeIdx >= TIMES.length - 1) {
      // よふけに歩きだすと、朝になっている
      say(['歩いているうちに、まぶたが おもくなった。', '気がついたら、ふとんの中だった。'],
        () => nextDay(st))
      return
    }
    const timeIdx = st.timeIdx + 1
    setSt((s) => ({ ...s, placeId, timeIdx }))
    arrive(placeId, timeIdx)
  }

  function senseAt(senseId) {
    if (talking) return
    const y = YOKAI.find(
      (k) => k.place === st.placeId && k.time === time.id && !st.captured[k.id],
    )
    if (y && y.sense === senseId) {
      shake()
      say(y.appear, () => { setMondo({ yokaiId: y.id, round: 0 }); setPhase('mondo') })
      return
    }
    const base = place.senses[senseId]
    say(y ? [base, NUDGE[y.sense]] : [base])
  }

  function choose(choice) {
    const y = YOKAI.find((k) => k.id === mondo.yokaiId)
    const lines = choice.r.split('\n')
    if (choice.kind !== 'mitomeru') {
      say([...lines, '', `${y.name}は、いなくなった。`], () => {
        setMondo(null); setPhase('play')
      })
      return
    }
    const nextRound = mondo.round + 1
    if (nextRound < y.rounds.length) {
      say(lines, () => setMondo((m) => ({ ...m, round: nextRound })))
      return
    }
    // 図鑑に記録
    const tail = ['', '── 図鑑に、あたらしいページが ふえた。', `　「${y.name}（${y.kanji}）」`]
    if (y.reward) tail.push(`　もちもの に「${y.reward}」が ふえた。`)
    say([...lines, ...tail], () => {
      setSt((s) => ({
        ...s,
        captured: { ...s.captured, [y.id]: true },
        items: y.reward && !s.items.includes(y.reward) ? [...s.items, y.reward] : s.items,
      }))
      setMondo(null)
      setPhase('play')
    })
  }

  /* ───────── 場所ごとの特別なこと ───────── */

  function talkGrandma() {
    if (talking) return
    const rest = YOKAI.filter((y) => !st.captured[y.id])
    const gotOmamori = st.items.includes('おまもり')
    if (!gotOmamori) {
      setSt((s) => ({ ...s, items: [...s.items, 'おまもり'] }))
      say([
        'ばあちゃんは、ぼくの手に、小さい布の袋をにぎらせた。',
        '「これ、持っときない。この村は、日の暮れたあとが ながかけん」',
        '　もちもの に「おまもり」が ふえた。',
      ])
      return
    }
    if (rest.length === 0) {
      say(['ばあちゃんは、ぼくのノートを見て、「よう集めたね」と言った。', 'なにを集めたのかは、きかなかった。'])
      return
    }
    const y = rest[st.hintIdx % rest.length]
    setSt((s) => ({ ...s, hintIdx: s.hintIdx + 1 }))
    say([
      y.hint,
      '',
      `（${PLACE_BY_ID[y.place].name}　／　${TIMES.find((t) => t.id === y.time).label}）`,
    ])
  }

  function rest() {
    if (talking) return
    if (st.timeIdx < TIMES.length - 1) {
      say(['まだ、寝るには はやい。', GRANDMA_IDLE[(st.day - 1) % GRANDMA_IDLE.length]])
      return
    }
    say(['蚊帳をつって、ふとんにもぐった。'], () => nextDay(st))
  }

  function talkYoshi() {
    if (talking) return
    if (time.id === 'asa' || time.id === 'yoru') {
      say(['シャッターが閉まっている。', '中で、ラジオだけが鳴っている気がした。'])
      return
    }
    const first = !st.items.includes('ラムネ')
    const idx = Math.min(st.yoshiIdx, YOSHI.length - 1)
    const lines = [...YOSHI[idx].lines]
    if (first) lines.push('', 'おばちゃんが、ラムネを一本くれた。ビー玉が、底でからから鳴った。', '　もちもの に「ラムネ」が ふえた。')
    setSt((s) => ({
      ...s,
      yoshiIdx: Math.min(s.yoshiIdx + 1, YOSHI.length - 1),
      items: first ? [...s.items, 'ラムネ'] : s.items,
    }))
    say(lines)
  }

  /* ───────── 終章 ───────── */

  function startFinale() {
    setSt((s) => ({ ...s, placeId: 'basutei', timeIdx: 0 }))
    // 駄菓子屋で一度も会っていないと、ヨシは「知らない子」としてあらわれる
    const intro = st.yoshiIdx > 0
      ? FINALE.intro
      : [...FINALE.intro.slice(0, -1), ...FINALE.introStranger.split('\n')]
    say(intro, () => setPhase('finale'))
  }

  function chooseFinale(c) {
    say(FINALE.results[c.kind], () => {
      const e = endingFor(capturedCount)
      say([...FINALE.bus, '', `── ${e.title} ──`, ...e.lines, '', ...EPILOGUE], () => {
        setSt((s) => ({ ...s, cleared: true, endingKind: c.kind }))
        setPhase('ending')
        setOverlay('zukan')
      })
    })
  }

  /* ───────── 画面 ───────── */

  if (phase === 'title') {
    return (
      <div className="og-root og-title">
        <div className="og-view og-view-title" style={{ background: skyTopColor('yuu', 'azemichi') }}>
          <Scenery art="azemichi" time="yuu" />
        </div>
        <div className="og-title-inner">
          <p className="og-title-sub">{SUBTITLE}</p>
          <h1 className="og-title-main">{TITLE}</h1>
          <div className="og-title-rule">
            {RULES.map((r, i) => <p key={i}>{r || ' '}</p>)}
          </div>
          <button className="og-btn og-btn-lead" onClick={() => {
            setSt(INITIAL)
            setPhase('intro')
            say([...INTRO, '', `── なつやすみ 1日目。のこり ${MAX_DAY}日。`], () => {
              setPhase('play')
              arrive('engawa', 0)
            })
          }}>はじめる</button>
          {hasSave && (
            <button className="og-btn og-btn-ghost" onClick={() => {
              try {
                const raw = JSON.parse(localStorage.getItem(SAVE_KEY))
                if (raw && raw.st) {
                  setSt({ ...INITIAL, ...raw.st })
                  setPhase(raw.phase === 'ending' ? 'ending' : 'play')
                  arrive(raw.st.placeId, raw.st.timeIdx)
                }
              } catch { /* こわれていたら、はじめから */ }
            }}>つづきから</button>
          )}
        </div>
      </div>
    )
  }

  const y = mondo ? YOKAI.find((k) => k.id === mondo.yokaiId) : null
  const round = y ? y.rounds[mondo.round] : null
  const showChoices = !talking && ((phase === 'mondo' && round) || phase === 'finale')
  const question = phase === 'finale' ? FINALE.q : (phase === 'mondo' && round ? round.q : null)

  return (
    <div className="og-root">
      <div className={`og-view og-t-${time.id}`} style={{ background: skyTopColor(time.id, place.art) }}>
        <Scenery art={place.art} time={time.id} shaken={shaken} />
        <div className="og-hud">
          <span className="og-hud-place">{place.name}</span>
          <span className="og-hud-time">{st.day}日目・{time.label}</span>
          <span className="og-hud-count">図鑑 {capturedCount}/{YOKAI.length}</span>
        </div>
      </div>

      <div className="og-panel" onClick={advance}>
        <div className="og-body" ref={bodyRef}>
          {scene.lines.slice(0, scene.idx).map((l, i) => (
            <p key={i} className="og-line og-line-past">{l || ' '}</p>
          ))}
          {scene.lines.length > 0 && (
            <p className="og-line">{(talking ? typed : current) || ' '}</p>
          )}
          {!talking && question && question.split('\n').map((l, i) => (
            <p key={i} className="og-line og-line-q">{l || ' '}</p>
          ))}
          {!talking && !question && scene.lines.length === 0 && (
            <p className="og-line og-line-idle">{time.note}</p>
          )}
        </div>
        {talking && <div className={`og-next${done ? ' og-next-on' : ''}`}>▼</div>}
      </div>

      {showChoices && (
        <div className="og-choices">
          {(phase === 'finale' ? FINALE.choices : round.choices)
            .filter((c) => !c.requiresItem || st.items.includes(c.requiresItem))
            .map((c, i) => (
              <button key={i} className="og-choice"
                onClick={() => (phase === 'finale' ? chooseFinale(c) : choose(c))}>
                {c.t}
                {c.requiresItem && <span className="og-choice-item">［{c.requiresItem}］</span>}
              </button>
            ))}
        </div>
      )}

      {phase === 'play' && !talking && (
        <div className="og-actions">
          <div className="og-senses">
            {SENSES.map((s) => (
              <button key={s.id} className="og-btn og-sense" onClick={() => senseAt(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="og-subactions">
            <button className="og-btn og-btn-move" onClick={() => setOverlay('move')}>あるく</button>
            {st.placeId === 'engawa' && (
              <>
                <button className="og-btn" onClick={talkGrandma}>ばあちゃん</button>
                <button className="og-btn" onClick={rest}>ねる</button>
              </>
            )}
            {st.placeId === 'dagashiya' && (
              <button className="og-btn" onClick={talkYoshi}>店の中</button>
            )}
            <button className="og-btn" onClick={() => setOverlay('zukan')}>ずかん</button>
          </div>
        </div>
      )}

      {phase === 'ending' && !talking && (
        <div className="og-actions">
          <div className="og-subactions">
            <button className="og-btn og-btn-move" onClick={() => setOverlay('zukan')}>図鑑をひらく</button>
            <button className="og-btn" onClick={() => { setPhase('title'); setScene({ lines: [], idx: 0, done: false }) }}>
              タイトルへ
            </button>
          </div>
        </div>
      )}

      {overlay === 'move' && (
        <div className="og-sheet" onClick={() => setOverlay(null)}>
          <div className="og-sheet-inner" onClick={(e) => e.stopPropagation()}>
            <h2 className="og-sheet-title">どこへ</h2>
            <p className="og-sheet-note">歩けば、日がかたむく。</p>
            {PLACES.map((p) => (
              <button key={p.id} className="og-btn og-row"
                disabled={p.id === st.placeId} onClick={() => move(p.id)}>
                {p.name}{p.id === st.placeId && '（いまここ）'}
              </button>
            ))}
            <button className="og-btn og-btn-ghost" onClick={() => setOverlay(null)}>やめる</button>
          </div>
        </div>
      )}

      {overlay === 'zukan' && (
        <Zukan st={st} onClose={() => setOverlay(null)} />
      )}
    </div>
  )
}

function Zukan({ st, onClose }) {
  const [open, setOpen] = useState(null)
  return (
    <div className="og-sheet" onClick={onClose}>
      <div className="og-sheet-inner og-zukan" onClick={(e) => e.stopPropagation()}>
        <h2 className="og-sheet-title">おうまがとき　図鑑</h2>
        <p className="og-sheet-note">
          {Object.keys(st.captured).length} / {YOKAI.length}
          {st.cleared ? '　── おとなの註が よめる' : ''}
        </p>
        <div className="og-zukan-list">
          {YOKAI.map((y) => {
            const got = !!st.captured[y.id]
            const isOpen = open === y.id
            return (
              <div key={y.id} className={`og-card${got ? '' : ' og-card-empty'}`}
                onClick={() => got && setOpen(isOpen ? null : y.id)}>
                <div className="og-card-head">
                  <span className="og-card-name">{got ? y.name : '？？？'}</span>
                  <span className="og-card-kanji">{got ? y.kanji : '未'}</span>
                </div>
                {got ? (
                  <>
                    <p className="og-card-where">
                      {PLACE_BY_ID[y.place].name} ／ {TIMES.find((t) => t.id === y.time).label}
                    </p>
                    <p className="og-card-child">{y.zukan.child}</p>
                    {st.cleared && isOpen && (
                      <p className="og-card-adult">{y.zukan.adult}</p>
                    )}
                    {st.cleared && !isOpen && <p className="og-card-more">＋ おとなの註</p>}
                  </>
                ) : (
                  <p className="og-card-child">まだ、会っていない。</p>
                )}
              </div>
            )
          })}
        </div>
        {st.items.length > 0 && (
          <>
            <h3 className="og-sheet-title og-sheet-title-sm">もちもの</h3>
            <p className="og-items">{st.items.join('　／　')}</p>
          </>
        )}
        <button className="og-btn og-btn-ghost" onClick={onClose}>とじる</button>
      </div>
    </div>
  )
}
