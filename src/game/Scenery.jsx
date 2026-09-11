// 『おうまがとき』── 風景。ぜんぶSVGの影絵で描く。
// 時間帯（ひる／ゆうやけ／おうまがとき／よふけ）でパレットごと入れ替わる。

const PALETTES = {
  asa: {
    skyTop: '#8ec9dd', skyMid: '#d2e8e4', skyBot: '#f8f3da',
    far: '#9fb7ac', mid: '#77997b', near: '#47624d', ink: '#27341f',
    glow: '#fffbe8', orb: '#fff7d4', orbGlow: 0.45, cloud: '#ffffff', cloudOp: 0.8,
    lamp: '#ffe9a8', lampOp: 0,
  },
  hiru: {
    skyTop: '#79c3e6', skyMid: '#bfe0ea', skyBot: '#eef3dd',
    far: '#93b3ab', mid: '#6d9272', near: '#3c5a45', ink: '#23341f',
    glow: '#fffbe0', orb: '#fff8cf', orbGlow: 0.55, cloud: '#ffffff', cloudOp: 0.9,
    lamp: '#ffe9a8', lampOp: 0,
  },
  yuu: {
    skyTop: '#5b4a86', skyMid: '#d4736a', skyBot: '#ffb865',
    far: '#7d6480', mid: '#4e3d58', near: '#2c2334', ink: '#1a1420',
    glow: '#ffd18a', orb: '#fff0b8', orbGlow: 0.75, cloud: '#ffd2a1', cloudOp: 0.5,
    lamp: '#ffdf9c', lampOp: 0.5,
  },
  ouma: {
    skyTop: '#25254a', skyMid: '#6e3f5c', skyBot: '#d4643a',
    far: '#443a5e', mid: '#2d2843', near: '#1a1729', ink: '#0e0d1a',
    glow: '#e8794a', orb: '#ffd7a0', orbGlow: 0.4, cloud: '#8b5a6b', cloudOp: 0.35,
    lamp: '#ffcf7a', lampOp: 0.85,
  },
  yoru: {
    skyTop: '#070c20', skyMid: '#111c3c', skyBot: '#25375c',
    far: '#1c2542', mid: '#141c33', near: '#0a0f1d', ink: '#05080f',
    glow: '#cfe0ff', orb: '#f2f6ff', orbGlow: 0.5, cloud: '#2a3a5e', cloudOp: 0.3,
    lamp: '#ffe6a6', lampOp: 1,
  },
}

const STARS = [
  [28, 22], [63, 40], [96, 16], [131, 33], [158, 12], [192, 28], [214, 47],
  [246, 19], [281, 36], [309, 14], [341, 30], [372, 48], [47, 58], [123, 60],
  [268, 58], [356, 66], [15, 44], [180, 52], [227, 8], [327, 52],
]

const FIREFLIES = [
  [52, 176, 0], [88, 192, 1.4], [141, 168, 2.6], [186, 199, 0.7],
  [233, 174, 3.3], [271, 195, 1.9], [318, 180, 2.2], [355, 201, 0.4],
]

function Sky({ p, time }) {
  return (
    <>
      <defs>
        <linearGradient id="og-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={p.skyTop} />
          <stop offset="55%" stopColor={p.skyMid} />
          <stop offset="100%" stopColor={p.skyBot} />
        </linearGradient>
        <radialGradient id="og-orb">
          <stop offset="0%" stopColor={p.orb} stopOpacity="0.95" />
          <stop offset="45%" stopColor={p.glow} stopOpacity={p.orbGlow * 0.5} />
          <stop offset="100%" stopColor={p.glow} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="400" height="240" fill="url(#og-sky)" />

      {time === 'yoru' && (
        <g className="og-stars">
          {STARS.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 1.3 : 0.8}
              fill="#ffffff" opacity={0.5 + (i % 4) * 0.14}
              style={{ animationDelay: `${(i % 7) * 0.6}s` }} />
          ))}
        </g>
      )}

      {/* 太陽・月 */}
      {(() => {
        const pos = { asa: [58, 104], hiru: [320, 40], yuu: [300, 120], ouma: [300, 120], yoru: [76, 44] }
        const [cx, cy] = pos[time] || pos.hiru
        return (
          <>
            <circle cx={cx} cy={cy} r="46" fill="url(#og-orb)" />
            <circle cx={cx} cy={cy} r={time === 'yoru' ? 11 : 15} fill={p.orb}
              opacity={time === 'ouma' ? 0.8 : 0.95} />
            {time === 'yoru' && <circle cx={cx - 5} cy={cy - 4} r="9" fill={p.skyTop} opacity="0.85" />}
          </>
        )
      })()}

      {/* 入道雲 */}
      {(time === 'asa' || time === 'hiru' || time === 'yuu') && (
        <g className="og-cloud" fill={p.cloud} opacity={p.cloudOp}>
          <circle cx="82" cy="58" r="26" />
          <circle cx="112" cy="44" r="32" />
          <circle cx="148" cy="60" r="24" />
          <circle cx="128" cy="72" r="26" />
          <circle cx="96" cy="76" r="22" />
          <rect x="78" y="66" width="80" height="20" rx="10" />
        </g>
      )}
      {time === 'ouma' && (
        <g fill={p.cloud} opacity={p.cloudOp}>
          <rect x="30" y="62" width="150" height="7" rx="3.5" />
          <rect x="70" y="80" width="200" height="5" rx="2.5" />
          <rect x="200" y="52" width="130" height="6" rx="3" />
        </g>
      )}
    </>
  )
}

function Mountains({ p }) {
  return (
    <>
      <path fill={p.far} d="M0,148 L38,118 L68,137 L112,98 L150,131 L192,108 L242,139 L292,110 L342,135 L400,116 L400,240 L0,240 Z" />
      <path fill={p.mid} d="M0,170 L58,146 L118,163 L182,140 L252,166 L320,147 L400,167 L400,240 L0,240 Z" />
    </>
  )
}

/* ───────── 場所ごとの前景 ───────── */

function Azemichi({ p, time }) {
  const poles = [[336, 74], [252, 52], [199, 37], [168, 26], [150, 18]]
  return (
    <g>
      {/* 田んぼ */}
      <path fill={p.near} d="M0,172 L400,168 L400,240 L0,240 Z" />
      <g stroke={p.ink} strokeOpacity="0.35" fill="none">
        {[178, 188, 202, 220].map((y, i) => (
          <path key={i} d={`M0,${y} Q200,${y - 3 - i} 400,${y - 1}`} strokeWidth={0.8 + i * 0.4} />
        ))}
      </g>
      {/* あぜ道（消失点へ） */}
      <path fill={p.mid} opacity="0.85" d="M138,170 L152,170 L250,240 L90,240 Z" />
      {/* 電柱 */}
      {poles.map(([x, h], i) => (
        <g key={i} fill={p.ink}>
          <rect x={x} y={172 - h} width={2.6 - i * 0.4} height={h} />
          <rect x={x - 6 + i} y={174 - h} width={14 - i * 2} height={1.6} />
        </g>
      ))}
      {/* 稲 */}
      <g stroke={p.ink} strokeWidth="0.9" opacity="0.38" className="og-sway">
        {Array.from({ length: 44 }, (_, i) => {
          const x = 3 + i * 9.2
          const h = 11 + (i % 3) * 4
          return <path key={i} d={`M${x},240 q${i % 2 ? 3 : -3},-${h * 0.6} ${i % 2 ? 1 : -1},-${h}`} fill="none" />
        })}
      </g>
      {/* 案山子 */}
      <g fill={p.ink} opacity={time === 'ouma' ? 1 : 0.88}>
        <rect x="62" y="150" width="2.6" height="36" />
        <path d="M49,162 L78,160 L78,163.6 L49,165.6 Z" />
        <path d="M54,165 L73,164 L70,186 L57,186 Z" />
        <circle cx="63.3" cy="153" r="5" />
        <path d="M51,151 q12,-10 25,0 z" />
        <g stroke={p.ink} strokeWidth="1.3" fill="none">
          <path d="M57,186 l3,6 M63,186 l1,7 M69,186 l3,6" />
        </g>
      </g>
    </g>
  )
}

function Basutei({ p, time }) {
  return (
    <g>
      <path fill={p.near} d="M0,170 L400,166 L400,240 L0,240 Z" />
      {/* 道路 */}
      <path fill={p.mid} d="M0,196 L400,178 L400,214 L0,240 Z" />
      <g stroke={p.glow} strokeOpacity="0.35" strokeWidth="2" strokeDasharray="14 12">
        <path d="M0,222 L400,196" fill="none" />
      </g>
      {/* ガードレール */}
      <g fill={p.ink} opacity="0.8">
        <rect x="0" y="172" width="400" height="3" />
        {Array.from({ length: 9 }, (_, i) => <rect key={i} x={12 + i * 46} y="172" width="2.4" height="14" />)}
      </g>
      {/* バス停のポールと丸看板 */}
      <g>
        <rect x="272" y="112" width="3.6" height="86" fill={p.ink} />
        <circle cx="273.8" cy="106" r="17" fill={p.ink} />
        <circle cx="273.8" cy="106" r="13" fill={time === 'yoru' ? p.lamp : '#f3ead4'} opacity={time === 'hiru' || time === 'asa' ? 0.95 : 0.8} />
        <text x="273.8" y="110" textAnchor="middle" fontSize="11" fontWeight="700" fill="#2e4a6b">バス</text>
      </g>
      {/* ベンチ */}
      <g fill={p.ink}>
        <rect x="296" y="176" width="72" height="5" rx="2" />
        <rect x="300" y="181" width="4" height="18" />
        <rect x="360" y="181" width="4" height="18" />
        <rect x="296" y="160" width="72" height="4" rx="2" opacity="0.85" />
        <rect x="300" y="160" width="3" height="18" opacity="0.85" />
        <rect x="361" y="160" width="3" height="18" opacity="0.85" />
      </g>
      {/* 時刻表 */}
      <rect x="250" y="130" width="18" height="24" fill={p.ink} />
      <rect x="252" y="132" width="14" height="20" fill={p.glow} opacity="0.5" />
      {/* 電柱と草 */}
      <rect x="96" y="96" width="3.4" height="78" fill={p.ink} />
      <rect x="86" y="100" width="24" height="2" fill={p.ink} />
      <g stroke={p.ink} strokeWidth="1.2" opacity="0.6" className="og-sway">
        {Array.from({ length: 14 }, (_, i) => {
          const x = 8 + i * 13
          return <path key={i} d={`M${x},240 q${i % 2 ? 5 : -5},-12 ${i % 2 ? 2 : -2},-22`} fill="none" />
        })}
      </g>
    </g>
  )
}

function Chinju({ p, time }) {
  const cedar = (x, h, w) => (
    <path key={x} fill={p.ink}
      d={`M${x},${172 - h} L${x + w},${172 - h * 0.42} L${x + w * 0.55},${172 - h * 0.45} L${x + w * 1.15},172 L${x - w * 1.15},172 L${x - w * 0.55},${172 - h * 0.45} L${x - w},${172 - h * 0.42} Z`} />
  )
  return (
    <g>
      <path fill={p.near} d="M0,168 L400,164 L400,240 L0,240 Z" />
      {/* 杉 */}
      <g opacity="0.95">
        {cedar(26, 150, 20)}{cedar(74, 178, 24)}{cedar(120, 134, 18)}
        {cedar(300, 162, 22)}{cedar(348, 186, 26)}{cedar(386, 140, 20)}
      </g>
      {/* 石段 */}
      <g fill={p.mid}>
        {Array.from({ length: 7 }, (_, i) => (
          <rect key={i} x={152 - i * 9} y={196 + i * 7} width={96 + i * 18} height="7" rx="1" />
        ))}
      </g>
      {/* 鳥居 */}
      <g fill={time === 'yoru' || time === 'ouma' ? p.ink : '#b5442f'} opacity={time === 'hiru' || time === 'asa' ? 0.92 : 1}>
        <path d="M136,120 L264,120 L268,127 L132,127 Z" />
        <rect x="140" y="134" width="120" height="7" />
        <rect x="148" y="120" width="9" height="78" />
        <rect x="243" y="120" width="9" height="78" />
      </g>
      {/* 灯籠 */}
      {[96, 304].map((x) => (
        <g key={x}>
          <rect x={x - 9} y="190" width="18" height="10" fill={p.ink} />
          <rect x={x - 4} y="177" width="8" height="13" fill={p.ink} />
          <rect x={x - 8.5} y="166" width="17" height="12" fill={p.ink} />
          <rect x={x - 5.5} y="168" width="11" height="8" fill={p.lamp} opacity={p.lampOp} />
          <path d={`M${x - 12},166 L${x + 12},166 L${x + 7.5},158 L${x - 7.5},158 Z`} fill={p.ink} />
          <circle cx={x} cy="155.5" r="2.4" fill={p.ink} />
        </g>
      ))}
    </g>
  )
}

function Yousui({ p, time }) {
  return (
    <g>
      <path fill={p.near} d="M0,160 L400,156 L400,240 L0,240 Z" />
      {/* 用水路 */}
      <path fill={p.ink} d="M0,182 L400,168 L400,182 L0,198 Z" />
      <path fill={time === 'yoru' ? p.mid : p.glow} opacity={time === 'hiru' || time === 'asa' ? 0.55 : 0.4}
        d="M0,198 L400,182 L400,206 L0,224 Z" />
      <path fill={p.ink} d="M0,224 L400,206 L400,222 L0,240 Z" />
      {/* 水面のきらめき */}
      <g className="og-flow" stroke={p.glow} strokeOpacity={time === 'yoru' ? 0.35 : 0.7} strokeWidth="1.4" fill="none">
        <path d="M-40,206 q26,-4 52,0 t52,0 t52,0 t52,0 t52,0 t52,0 t52,0" />
        <path d="M-40,214 q30,4 60,0 t60,0 t60,0 t60,0 t60,0 t60,0" opacity="0.6" />
      </g>
      {/* 看板 */}
      <g>
        <rect x="304" y="130" width="3" height="48" fill={p.ink} />
        <rect x="278" y="112" width="56" height="26" rx="2" fill="#efe6cf" stroke={p.ink} strokeWidth="1.6" />
        <text x="306" y="124" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#b5442f">あぶない</text>
        <text x="306" y="134" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#3a3026">はいるな</text>
      </g>
      {/* 草 */}
      <g stroke={p.ink} strokeWidth="1.3" opacity="0.7" className="og-sway">
        {Array.from({ length: 20 }, (_, i) => {
          const x = 4 + i * 21
          return <path key={i} d={`M${x},240 q${i % 2 ? 7 : -7},-16 ${i % 2 ? 3 : -3},-30`} fill="none" />
        })}
      </g>
      {/* 赤とんぼ */}
      {(time === 'yuu' || time === 'hiru' || time === 'asa') && (
        <g className="og-tonbo" fill="none" stroke={time === 'yuu' ? '#c8452f' : p.ink} strokeWidth="1.2">
          <g transform="translate(120,150)"><path d="M-7,0 L8,0" /><path d="M-1,-4 L3,4" /><path d="M1,-4 L-3,4" /></g>
          <g transform="translate(230,138)"><path d="M-6,0 L7,0" /><path d="M-1,-3 L3,3" /><path d="M1,-3 L-3,3" /></g>
        </g>
      )}
    </g>
  )
}

function Akiya({ p, time }) {
  const lit = time === 'ouma'
  return (
    <g>
      <path fill={p.near} d="M0,178 L400,150 L400,240 L0,240 Z" />
      {/* 坂道 */}
      <path fill={p.mid} opacity="0.8" d="M0,240 L150,176 L182,178 L96,240 Z" />
      {/* 家 */}
      <g>
        <path fill={p.ink} d="M188,106 L286,78 L384,110 L384,118 L188,118 Z" />
        <rect x="200" y="116" width="172" height="62" fill={p.ink} />
        <rect x="206" y="128" width="34" height="30" fill={lit ? p.lamp : p.mid} opacity={lit ? 0.9 : 0.65} />
        <rect x="250" y="128" width="34" height="30" fill={lit ? p.lamp : p.mid} opacity={lit ? 0.55 : 0.6} />
        <rect x="300" y="126" width="46" height="52" fill={p.mid} opacity="0.7" />
        <g stroke={p.ink} strokeWidth="1.6">
          <path d="M223,128 L223,158" /><path d="M267,128 L267,158" /><path d="M323,126 L323,178" />
          <path d="M206,143 L240,143" /><path d="M250,143 L284,143" />
        </g>
      </g>
      {/* 塀 */}
      <g fill={p.ink} opacity="0.9">
        <rect x="150" y="160" width="240" height="20" />
        <rect x="148" y="156" width="244" height="5" />
      </g>
      {/* 柿の木 */}
      <g>
        <path fill={p.ink} d="M96,180 L100,122 L104,180 Z" />
        <path fill={p.ink} d="M100,126 q-32,-6 -40,-24 q30,4 38,14 q-4,-26 8,-40 q10,16 4,40 q12,-14 36,-14 q-14,22 -42,26 Z" />
        <g fill={time === 'yoru' ? p.mid : '#d97432'} opacity={time === 'yoru' ? 0.6 : 0.9}>
          <circle cx="78" cy="110" r="3.4" /><circle cx="118" cy="98" r="3.4" />
          <circle cx="126" cy="122" r="3" /><circle cx="88" cy="196" r="3" />
        </g>
      </g>
    </g>
  )
}

function Tunnel({ p, time }) {
  return (
    <g>
      {/* 山 */}
      <path fill={p.mid} d="M0,240 L0,120 Q90,36 200,42 Q312,36 400,124 L400,240 Z" />
      <g fill={p.near} opacity="0.45">
        {Array.from({ length: 22 }, (_, i) => {
          const x = 6 + i * 18
          const base = 132 - Math.round(46 * Math.sin((x / 400) * Math.PI))
          const h = 14 + (i % 3) * 7
          return <path key={i} d={`M${x},${base} L${x + 6},${base - h} L${x + 12},${base} Z`} />
        })}
      </g>
      <path fill={p.near} opacity="0.5" d="M0,240 L0,152 Q100,96 200,100 Q302,96 400,154 L400,240 Z" />

      {/* 道（手前から坑口へ） */}
      <path fill={p.mid} opacity="0.9" d="M112,240 L160,196 L240,196 L288,240 Z" />
      <path fill={p.ink} opacity="0.35" d="M196,240 L199,196 L201,196 L204,240 Z" />

      {/* 坑口 */}
      <path fill={p.ink} d="M126,240 L126,150 Q200,104 274,150 L274,240 Z" />
      <path fill="#04050b" d="M142,240 L142,157 Q200,118 258,157 L258,240 Z" />

      {/* むこう側の光 */}
      {time !== 'yoru' && (
        <ellipse cx="200" cy="178" rx="5.5" ry="4.5" fill={p.glow}
          opacity={time === 'hiru' || time === 'asa' ? 0.85 : time === 'yuu' ? 0.5 : 0.2} />
      )}

      {/* 扁額 */}
      <rect x="176" y="128" width="48" height="17" rx="1.5" fill={p.mid} stroke={p.ink} strokeWidth="1.2" />
      <text x="200" y="141" textAnchor="middle" fontSize="11" fill={p.glow} opacity="0.6"
        style={{ letterSpacing: '2px' }}>無事</text>

      {/* 草 */}
      <g stroke={p.ink} strokeWidth="1.2" opacity="0.65" className="og-sway">
        {Array.from({ length: 9 }, (_, i) => {
          const x = 12 + i * 13
          return <path key={i} d={`M${x},240 q${i % 2 ? 5 : -5},-11 ${i % 2 ? 2 : -2},-20`} fill="none" />
        })}
        {Array.from({ length: 9 }, (_, i) => {
          const x = 282 + i * 13
          return <path key={`r${i}`} d={`M${x},240 q${i % 2 ? 5 : -5},-11 ${i % 2 ? 2 : -2},-20`} fill="none" />
        })}
      </g>
    </g>
  )
}

function Engawa({ p, time }) {
  return (
    <g>
      {/* 軒の裏（天井） */}
      <rect x="0" y="0" width="400" height="80" fill="#31200f" />
      <g stroke="#22150a" strokeWidth="3" opacity="0.8">
        {[36, 104, 172, 240, 308, 376].map((x) => <path key={x} d={`M${x},0 L${x},76`} />)}
      </g>
      {/* 庭 */}
      <path fill={p.near} d="M0,166 L400,162 L400,204 L0,208 Z" />
      <g fill={p.ink} opacity="0.9">
        {[[112, 1], [204, 0.78], [284, 1.1]].map(([x, k], i) => (
          <g key={i}>
            <path d={`M${x - 2.4},172 L${x},${172 - 44 * k} L${x + 2.4},172 Z`} />
            <ellipse cx={x - 11 * k} cy={172 - 40 * k} rx={13 * k} ry={9 * k} />
            <ellipse cx={x + 12 * k} cy={172 - 36 * k} rx={12 * k} ry={8.5 * k} />
            <ellipse cx={x} cy={172 - 50 * k} rx={15 * k} ry={10 * k} />
            <ellipse cx={x + 2} cy={172 - 30 * k} rx={9 * k} ry={7 * k} />
          </g>
        ))}
      </g>
      <g stroke={p.ink} strokeWidth="1" opacity="0.4">
        {Array.from({ length: 30 }, (_, i) => (
          <path key={i} d={`M${4 + i * 13.5},200 q${i % 2 ? 3 : -3},-5 ${i % 2 ? 1 : -1},-9`} fill="none" />
        ))}
      </g>
      {/* 縁側の板 */}
      <rect x="0" y="204" width="400" height="36" fill="#5a3a24" />
      <g stroke="#3c2416" strokeWidth="1.2" opacity="0.8">
        {[210, 218, 226, 234].map((y) => <path key={y} d={`M0,${y} L400,${y}`} />)}
      </g>
      <rect x="0" y="200" width="400" height="5" fill="#43291a" />
      {/* 障子（両端） */}
      <g>
        <rect x="0" y="96" width="86" height="108" fill="#3a2718" />
        <rect x="6" y="102" width="74" height="96" fill={time === 'yoru' || time === 'ouma' ? '#f3dfa8' : '#efe8d2'}
          opacity={time === 'yoru' ? 0.95 : 0.85} />
        <rect x="314" y="96" width="86" height="108" fill="#3a2718" />
        <rect x="320" y="102" width="74" height="96" fill={time === 'yoru' || time === 'ouma' ? '#f3dfa8' : '#efe8d2'}
          opacity={time === 'yoru' ? 0.95 : 0.85} />
        <g stroke="#3a2718" strokeWidth="2.4">
          <path d="M43,102 L43,198" /><path d="M6,134 L80,134" /><path d="M6,166 L80,166" />
          <path d="M357,102 L357,198" /><path d="M320,134 L394,134" /><path d="M320,166 L394,166" />
        </g>
      </g>
      {/* 軒 */}
      <rect x="0" y="76" width="400" height="22" fill="#2e1d12" />
      <rect x="0" y="94" width="400" height="5" fill="#1f130b" />
      {/* 風鈴 */}
      <g className="og-furin">
        <path d="M256,98 L256,112" stroke="#1f130b" strokeWidth="1.4" />
        <path d="M248,112 q8,-14 16,0 z" fill="#cfe6ee" opacity="0.92" />
        <path d="M256,118 L256,132" stroke="#9aa7ad" strokeWidth="1" />
        <rect x="253" y="132" width="6" height="14" fill="#e8e2cd" />
      </g>
      {/* 蚊取り線香 */}
      <g>
        <ellipse cx="130" cy="226" rx="15" ry="5" fill="#241b12" />
        <ellipse cx="130" cy="224" rx="12" ry="4" fill="#3f6b46" />
        <ellipse cx="130" cy="224" rx="6.5" ry="2.2" fill="#241b12" />
        <circle cx="141" cy="223" r="1.6" fill="#ff9a4d" />
        <path className="og-smoke" d="M130,220 q7,-16 -3,-28 q-8,-14 3,-26" stroke="#dcdcdc" strokeOpacity="0.55"
          strokeWidth="1.6" fill="none" />
      </g>
      {/* 麦茶 */}
      <g>
        <rect x="212" y="208" width="17" height="22" rx="2" fill="#8a5a2a" opacity="0.85" />
        <rect x="212" y="208" width="17" height="6" rx="2" fill="#c8a06a" opacity="0.7" />
      </g>
    </g>
  )
}

function Dagashiya({ p, time }) {
  const open = time !== 'yoru'
  return (
    <g>
      <path fill={p.near} d="M0,172 L400,168 L400,240 L0,240 Z" />
      {/* 店 */}
      <rect x="46" y="72" width="286" height="106" fill={p.ink} />
      <rect x="58" y="104" width="262" height="74" fill={open ? '#f0d79a' : p.mid} opacity={open ? 0.92 : 0.8} />
      {/* 軒 */}
      <path fill="#3a2718" d="M32,76 L348,76 L338,96 L42,96 Z" />
      <rect x="32" y="70" width="316" height="8" fill="#26170e" />
      {/* のれん */}
      <g className="og-noren">
        <rect x="104" y="96" width="172" height="32" fill="#2e4a6b" opacity="0.96" />
        <text x="190" y="119" textAnchor="middle" fontSize="17" fontWeight="700" fill="#f4efe2"
          style={{ letterSpacing: '5px' }}>だがしや</text>
        <g stroke="#1d3049" strokeWidth="1.4">
          <path d="M147,96 L147,128" /><path d="M190,96 L190,128" /><path d="M233,96 L233,128" />
        </g>
      </g>
      {/* 駄菓子のケース */}
      <g fill="#6b4a2c">
        <rect x="76" y="146" width="60" height="32" />
        <rect x="146" y="146" width="60" height="32" />
        <rect x="216" y="146" width="60" height="32" />
      </g>
      <g>
        {[76, 146, 216].map((bx) => (
          <g key={bx}>
            <rect x={bx + 6} y="151" width="48" height="12" fill={p.glow} opacity="0.35" />
            {[0, 1, 2, 3].map((j) => (
              <rect key={j} x={bx + 9 + j * 12} y="153" width="8" height="8" rx="1.5"
                fill={['#c8452f', '#e0a33c', '#4e7f5c', '#c06a9a'][j]} opacity="0.85" />
            ))}
          </g>
        ))}
      </g>
      {/* 自販機 */}
      <g>
        <rect x="344" y="106" width="48" height="72" fill={p.ink} />
        <rect x="350" y="112" width="36" height="34" fill={p.lamp} opacity={time === 'yoru' ? 1 : 0.7} />
        <g fill="#c8452f" opacity="0.85">
          <rect x="354" y="118" width="8" height="13" rx="1.5" />
          <rect x="366" y="118" width="8" height="13" rx="1.5" />
          <rect x="378" y="118" width="4" height="13" rx="1.5" />
        </g>
        <rect x="350" y="152" width="36" height="8" fill={p.mid} />
      </g>
      {/* 裸電球 */}
      <g>
        <path d="M76,96 L76,110" stroke={p.ink} strokeWidth="1.2" />
        <circle cx="76" cy="115" r="5.5" fill={p.lamp} opacity={time === 'hiru' || time === 'asa' ? 0.35 : 0.95} />
        {time !== 'hiru' && time !== 'asa' && <circle cx="76" cy="115" r="15" fill={p.lamp} opacity="0.16" />}
      </g>
    </g>
  )
}

const ART = {
  azemichi: Azemichi, basutei: Basutei, chinju: Chinju, yousui: Yousui,
  akiya: Akiya, tunnel: Tunnel, engawa: Engawa, dagashiya: Dagashiya,
}

// 風景の上に足りないぶんを塗る色（縁側だけは軒裏の色）
export function skyTopColor(time, art) {
  if (art === 'engawa') return '#31200f'
  return (PALETTES[time] || PALETTES.hiru).skyTop
}

export default function Scenery({ art, time, shaken }) {
  const p = PALETTES[time] || PALETTES.hiru
  const Fore = ART[art] || Azemichi
  const indoors = art === 'engawa'

  return (
    <svg className={`og-sky-svg${shaken ? ' og-shake' : ''}`} viewBox="0 0 400 240"
      preserveAspectRatio="xMidYMid slice" role="img" aria-label="風景">
      <Sky p={p} time={time} />
      {!indoors && <Mountains p={p} />}
      <Fore p={p} time={time} />

      {/* 蛍 */}
      {time === 'yoru' && (
        <g className="og-hotaru">
          {FIREFLIES.map(([x, y, d], i) => (
            <circle key={i} cx={x} cy={y} r="2" fill="#d8ff8c"
              style={{ animationDelay: `${d}s` }} />
          ))}
        </g>
      )}

      {/* おうまがとき：輪郭がほどける */}
      {time === 'ouma' && (
        <rect x="0" y="0" width="400" height="240" fill="#d4643a" opacity="0.1"
          style={{ mixBlendMode: 'overlay' }} />
      )}
    </svg>
  )
}
