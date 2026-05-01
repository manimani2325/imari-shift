import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { subscribeAll, saveKey } from './firebase.js'

// ── 祝日データ 2024〜2026
const HOLIDAYS = new Set([
  "2024-01-01","2024-01-08","2024-02-11","2024-02-12","2024-02-23","2024-03-20",
  "2024-04-29","2024-05-03","2024-05-04","2024-05-05","2024-05-06","2024-07-15",
  "2024-08-11","2024-08-12","2024-09-16","2024-09-22","2024-09-23","2024-10-14",
  "2024-11-03","2024-11-04","2024-11-23","2025-01-01","2025-01-13","2025-02-11",
  "2025-02-23","2025-02-24","2025-03-20","2025-04-29","2025-05-03","2025-05-04",
  "2025-05-05","2025-05-06","2025-07-21","2025-08-11","2025-09-15","2025-09-21",
  "2025-09-22","2025-09-23","2025-10-13","2025-11-03","2025-11-23","2025-11-24",
  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20","2026-04-29",
  "2026-05-03","2026-05-04","2026-05-05","2026-05-06","2026-07-20","2026-08-11",
  "2026-09-21","2026-09-22","2026-09-23","2026-10-12","2026-11-03","2026-11-23",
]);

// ── 等級定義
// J=新人相当, L=中堅, M=中堅〜ベテラン間, SM=ベテラン相当, GM=管理者
const GRADES = ["J","L","M","SM","GM"];
const GRADE_COLOR = { J:"#34d399", L:"#60a5fa", M:"#facc15", SM:"#f97316", GM:"#e879f9" };
const GRADE_LABEL = { J:"J", L:"L", M:"M", SM:"SM", GM:"GM" };
// 新人相当: J  中堅相当: L,M  ベテラン相当: SM,GM
const isJunior  = g => g==="J";
const isSenior  = g => g==="SM"||g==="GM";
const isMid     = g => g==="L"||g==="M";

// ── 夜時間
const NIGHT_TIMES = ["17:00","17:15","17:30","18:00"];
const NIGHT_ORDER = ["17:00","17:15","17:30","18:00"];
const NIGHT_TC = {"17:00":"#f43f5e","17:15":"#f97316","17:30":"#8b5cf6","18:00":"#3b82f6"};
const DOW_JP = ["日","月","火","水","木","金","土"];

// ── ユーティリティ
const toStr = (y,m,d) => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const getDow = (y,m,d) => new Date(y,m,d).getDay();
const isHol  = (y,m,d) => HOLIDAYS.has(toStr(y,m,d));
const isSpec = (y,m,d) => { const w=getDow(y,m,d); return w===0||w===5||w===6||isHol(y,m,d); };
const daysIn = (y,m)   => new Date(y,m+1,0).getDate();
const isClosed=(y,m,d) => { const w=getDow(y,m,d); return w===2||w===3; };
const nightCompat=(cand,slot)=>NIGHT_ORDER.indexOf(cand)<=NIGHT_ORDER.indexOf(slot);

// ── 候補ウェイト計算（1日単位ではなく重み付き）
// 朝:1, 朝仕込:2, 夜:1, 朝+夜:1, 朝仕込+夜:2
function calcCandWeight(hasMorning, hasPrep, hasNight) {
  if (hasPrep && hasNight) return 2;
  if (hasPrep) return 2;
  if (hasMorning && hasNight) return 1;
  if (hasMorning) return 1;
  if (hasNight) return 1;
  return 0;
}

// ── 自動生成
function generateShifts(staff, year, month, avail, nightSlotConfig, aisaniConfig) {
  const days = daysIn(year, month);
  const result  = {};
  const worked  = {};
  const candW   = {}; // 候補ウェイト累計
  staff.forEach(s=>{ worked[s.id]=0; candW[s.id]=0; });

  const isAvail = (sid,key) => !!avail[sid]?.[key];

  // pick: 候補から count 人選ぶ（ルール付き）
  const pick = (candidates, count, opts={}) => {
    const { maxJunior=99, needSeniorIfJunior=false } = opts;
    const sorted = [...candidates].sort((a,b)=>{
      // 朝夜両方出してる人は朝・夜どちらか一方に偏らないよう worked で均等化
      const wd = worked[a.id]-worked[b.id]; if(wd!==0) return wd;
      const lo = {J:3,L:2,M:1,SM:0,GM:0}; return lo[a.grade]-lo[b.grade];
    });
    const res=[]; let nb=0;
    for(const s of sorted){
      if(res.length>=count) break;
      if(isJunior(s.grade)&&nb>=maxJunior) continue;
      res.push(s); if(isJunior(s.grade)) nb++;
    }
    // 新人いてシニアいない→シニアに差し替え
    if(needSeniorIfJunior&&res.some(s=>isJunior(s.grade))&&!res.some(s=>isSenior(s.grade))){
      const vet=candidates.find(s=>isSenior(s.grade)&&!res.includes(s));
      if(vet){ const ri=res.findLastIndex(s=>isMid(s.grade)); if(ri>=0) res[ri]=vet; else{ res.pop(); res.push(vet); } }
    }
    return res.slice(0,count);
  };

  const shortage={}; const warnings={};

  // 翌日の朝・朝仕込みが人員不足になりそうか予測（簡易: 候補者数が必要数以下なら不足リスク）
  const morningRisk=(d)=>{
    if(d>days||isClosed(year,month,d)) return false;
    const mc=staff.filter(s=>isAvail(s.id,`${d}_morning`)).length;
    const pc=staff.filter(s=>isAvail(s.id,`${d}_prep`)).length;
    return mc<2||pc<1;
  };

  for(let d=1;d<=days;d++){
    if(isClosed(year,month,d)){
      result[d]={morning:[],prep:[],night:{},aisani:null};
      shortage[d]={morning:0,prep:0,night:{},aisani:0};
      warnings[d]=[];
      continue;
    }
    const spec=isSpec(year,month,d);
    const dayR={morning:[],prep:[],night:{},aisani:null};
    const dayS={morning:0,prep:0,night:{},aisani:0};
    const dayW=[];
    const slots=nightSlotConfig[d]||[];

    // 前日夜ワーカー
    const prevNight=new Set(d>1?Object.values(result[d-1]?.night||{}).filter(Boolean):[]);
    // 翌日リスク確認（前日夜に入れると翌朝が不足する可能性）
    const nextDayRisk=morningRisk(d+1);

    // 候補ウェイト加算
    staff.forEach(s=>{
      const hM=isAvail(s.id,`${d}_morning`);
      const hP=isAvail(s.id,`${d}_prep`);
      const hN=NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`));
      const hA=s.aisaniOK&&isAvail(s.id,`${d}_aisani`);
      candW[s.id]+=calcCandWeight(hM,hP,hN)+(hA?1:0);
    });

    // ── 朝仕込み優先（前日夜NG、翌日朝確定者NG）
    const pStrict=staff.filter(s=>
      isAvail(s.id,`${d}_prep`)&&
      !prevNight.has(s.id)
    );
    const pAll=staff.filter(s=>isAvail(s.id,`${d}_prep`));
    const pCands=pStrict.length>=1?pStrict:pAll;
    const pPick=pick(pCands,1);
    if(pPick[0]&&prevNight.has(pPick[0].id)) dayW.push(`${pPick[0].name}：前日夜→朝仕込み（人手不足）`);
    dayR.prep=pPick.map(s=>s.id);
    pPick.forEach(s=>{worked[s.id]++;});
    dayS.prep=Math.max(0,1-pPick.length);

    // ── 朝 ×2（朝仕込済み除外、前日夜NG、翌日朝確定NG、新人2人以上NG）
    const mStrict=staff.filter(s=>
      isAvail(s.id,`${d}_morning`)&&
      !dayR.prep.includes(s.id)&&
      !prevNight.has(s.id)
    );
    const mAll=staff.filter(s=>isAvail(s.id,`${d}_morning`)&&!dayR.prep.includes(s.id));
    const mCands=mStrict.length>=2?mStrict:(mStrict.length>0?mAll:mAll);
    const mPick=pick(mCands,2,{maxJunior:1});
    mPick.forEach(s=>{ if(prevNight.has(s.id)) dayW.push(`${s.name}：前日夜→朝（人手不足）`); });
    dayR.morning=mPick.map(s=>s.id);
    mPick.forEach(s=>{worked[s.id]++;});
    dayS.morning=Math.max(0,2-mPick.length);

    // ── 夜
    const prepW=new Set(dayR.prep);
    const morningW=new Set(dayR.morning);
    const assignedNight=new Set();

    // 翌日朝確定者は夜に入れない（翌日が不足リスクの場合）
    const tomorrowMorningConfirmed=new Set();
    if(nextDayRisk&&d<days&&!isClosed(year,month,d+1)){
      // 翌日の朝候補が少ない場合、その候補者を今日の夜から除外
      staff.filter(s=>isAvail(s.id,`${d+1}_morning`)||isAvail(s.id,`${d+1}_prep`))
        .forEach(s=>tomorrowMorningConfirmed.add(s.id));
    }

    slots.forEach(slotTime=>{
      // 段階的に緩和しながら候補探し
      const baseCands=(relaxJunior,relaxMorning)=>staff.filter(s=>{
        if(prepW.has(s.id)) return false; // 朝仕込→夜は常にNG
        if(assignedNight.has(s.id)) return false;
        if(tomorrowMorningConfirmed.has(s.id)&&nextDayRisk) return false;
        if(!relaxMorning&&morningW.has(s.id)) return false; // 朝夜連続
        if(!relaxJunior&&isJunior(s.grade)&&spec) return false; // 新人特別夜NG
        return NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`)&&nightCompat(t,slotTime));
      });

      // 新人は同じ夜に1人まで
      const currentNightJuniors=[...assignedNight].filter(id=>isJunior(staffById_local(staff,id)?.grade));
      const maxJ=currentNightJuniors.length>=1?0:1;

      let nCands=baseCands(false,false);
      let relaxed="";
      if(!nCands.length){ nCands=baseCands(false,true); relaxed="朝夜連続"; }
      if(!nCands.length){ nCands=baseCands(true,false); relaxed="新人特別夜"; }
      if(!nCands.length){ nCands=baseCands(true,true); relaxed="朝夜連続+新人特別夜"; }

      const nPick=pick(nCands,1,{maxJunior:maxJ,needSeniorIfJunior:true});
      dayR.night[slotTime]=nPick[0]?.id||null;
      if(nPick[0]){
        worked[nPick[0].id]++;
        assignedNight.add(nPick[0].id);
        if(relaxed){
          const r=[];
          if(morningW.has(nPick[0].id)) r.push("朝夜連続");
          if(isJunior(nPick[0].grade)&&spec) r.push("新人特別夜");
          if(r.length) dayW.push(`${nPick[0].name}：${r.join("・")}（人手不足）`);
        }
      }
      dayS.night[slotTime]=nPick[0]?0:1;
    });

    // ── アイサニ（GMが枠をONかつスタッフが候補を出している人を割り当て）
    const aiConf=aisaniConfig[d];
    if(aiConf&&aiConf.enabled){
      const alreadyInNight=new Set(Object.values(dayR.night).filter(Boolean));
      // 第1優先：アイサニ候補を出している人
      const aiCandsStrict=staff.filter(s=>
        s.aisaniOK&&
        isAvail(s.id,`${d}_aisani`)&&
        !dayR.morning.includes(s.id)&&
        !dayR.prep.includes(s.id)&&
        !alreadyInNight.has(s.id)
      );
      // 第2優先（不足時）：夜に候補を出していてアイサニOKな人
      const aiCandsNightFallback=staff.filter(s=>
        s.aisaniOK&&
        !dayR.morning.includes(s.id)&&
        !dayR.prep.includes(s.id)&&
        !alreadyInNight.has(s.id)&&
        NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`))
      );
      const aiCands=aiCandsStrict.length>0?aiCandsStrict:aiCandsNightFallback;
      const usingFallback=aiCandsStrict.length===0&&aiCandsNightFallback.length>0;
      const aiPick=pick(aiCands,1);
      dayR.aisani=aiPick[0]?.id||null;
      if(aiPick[0]){
        worked[aiPick[0].id]++;
        if(usingFallback) dayW.push(`${aiPick[0].name}：アイサニ（夜候補から補填）`);
      }
      dayS.aisani=aiPick[0]?0:1;
    }

    result[d]=dayR;
    shortage[d]=dayS;
    warnings[d]=dayW;
  }

  // 達成率
  const totalW=Object.values(worked).reduce((a,b)=>a+b,0);
  const totalC=Object.values(candW).reduce((a,b)=>a+b,0);
  const avgRate=totalC>0?Math.round(totalW/totalC*100):0;

  return {shifts:result,worked,candW,shortage,warnings,avgRate};
}

function staffById_local(staffArr,id){ return staffArr.find(s=>s.id===id); }

// ══════════════════════════════════════════════════════
export default function App(){
  const now=new Date();
  const [year,setYear]=useState(now.getFullYear());
  const [month,setMonth]=useState(now.getMonth());
  const [staff,setStaff]=useState([
    {id:1,name:"田中 蓮",grade:"SM",aisaniOK:true},
    {id:2,name:"佐藤 彩",grade:"SM",aisaniOK:true},
    {id:3,name:"鈴木 翔",grade:"M",aisaniOK:false},
    {id:4,name:"高橋 美咲",grade:"L",aisaniOK:false},
    {id:5,name:"伊藤 大輝",grade:"J",aisaniOK:false},
    {id:6,name:"渡辺 ひな",grade:"J",aisaniOK:false},
  ]);
  const [avail,setAvail]=useState({});
  const [nightSlotConfig,setNightSlotConfig]=useState({});
  const [aisaniConfig,setAisaniConfig]=useState({}); // { d: {enabled:bool} }
  const [result,setResult]=useState(null);
  const [view,setView]=useState("slots"); // slots|avail|result
  const [gmMode,setGmMode]=useState(false);
  const [loginStaff,setLoginStaff]=useState(null); // スタッフモードで選択中
  const [newStaff,setNewStaff]=useState({name:"",grade:"L",aisaniOK:false});
  const [staffPanelOpen,setStaffPanelOpen]=useState(false);
  const [generating,setGenerating]=useState(false);
  const [exporting,setExporting]=useState(false);
  const shiftRef=useRef(null);

  const days=daysIn(year,month);
  const firstDow=getDow(year,month,1);
  const staffMap=useMemo(()=>{const m={};staff.forEach(s=>m[s.id]=s);return m;},[staff]);

  const prevMonth=()=>{if(month===0)updateYearMonth(year-1,11);else updateYearMonth(year,month-1);setResult(null);};
  const nextMonth=()=>{if(month===11)updateYearMonth(year+1,0);else updateYearMonth(year,month+1);setResult(null);};

  const toggleNightSlot=(d,time)=>{
    const cur=nightSlotConfig[d]||[];
    const next=cur.includes(time)?cur.filter(t=>t!==time):[...cur,time].sort();
    updateNightSlot({...nightSlotConfig,[d]:next});
  };
  const toggleAisani=(d)=>updateAisaniCfg({...aisaniConfig,[d]:{enabled:!aisaniConfig[d]?.enabled}});

  // 候補入力（GM: 任意のスタッフ, スタッフ: 自分のみ）
  const targetSid=gmMode?null:(loginStaff?.id);

  const toggleAvail=(sid,key)=>updateAvail({...avail,[sid]:{...(avail[sid]||{}),[key]:!avail[sid]?.[key]}});
  const toggleNightAvail=(sid,d,time)=>{
    const cur=avail[sid]||{};
    const next={...cur};
    NIGHT_TIMES.forEach(t=>{next[`${d}_night_${t}`]=false;});
    if(!cur[`${d}_night_${time}`]) next[`${d}_night_${time}`]=true;
    updateAvail({...avail,[sid]:next});
  };
  const setAllAvail=(sid,type,val)=>{
    const cur=avail[sid]||{};const next={...cur};
    for(let d=1;d<=days;d++) if(!isClosed(year,month,d)) next[`${d}_${type}`]=val;
    updateAvail({...avail,[sid]:next});
  };

  const handleGenerate=()=>{
    setGenerating(true);
    setTimeout(()=>{
      const r=generateShifts(staff,year,month,avail,nightSlotConfig,aisaniConfig);
      setResult(r);setView("result");setGenerating(false);
    },500);
  };

  const handleExport=async()=>{
    if(!shiftRef.current)return;
    setExporting(true);
    try{
      if(!window.html2canvas){
        await new Promise((res,rej)=>{
          const s=document.createElement("script");
          s.src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
          s.onload=res;s.onerror=rej;document.head.appendChild(s);
        });
      }
      const canvas=await window.html2canvas(shiftRef.current,{backgroundColor:"#030712",scale:2,useCORS:true,logging:false});
      const a=document.createElement("a");
      a.download=`シフト表_${year}年${month+1}月.png`;
      a.href=canvas.toDataURL("image/png");a.click();
    }catch{alert("画像出力に失敗しました");}
    setExporting(false);
  };

  const addStaff=()=>{
    if(!newStaff.name.trim())return;
    updateStaff([...staff,{...newStaff,id:Date.now()}]);
    setNewStaff({name:"",grade:"L",aisaniOK:false});
  };

  // スタッフモード: 自分の名前でログイン
  const staffModeStaff=staff.filter(s=>s.grade!=="GM");

  // GMパスワード
  const GM_PASSWORD="20130125";
  const [pwModal,setPwModal]=useState(false);
  const [pwInput,setPwInput]=useState("");
  const [pwError,setPwError]=useState(false);
  const [loading,setLoading]=useState(true);
  const [syncing,setSyncing]=useState(false);
  const saveTimers=useRef({});
  const pendingKeys=useRef(new Set());

  // ── Firebase リアルタイム購読
  useEffect(()=>{
    const unsub=subscribeAll((data)=>{
      if(data.staff          &&!pendingKeys.current.has('staff'))          setStaff(data.staff);
      if(data.avail          &&!pendingKeys.current.has('avail'))          setAvail(data.avail);
      if(data.nightSlotConfig&&!pendingKeys.current.has('nightSlotConfig'))setNightSlotConfig(data.nightSlotConfig);
      if(data.aisaniConfig   &&!pendingKeys.current.has('aisaniConfig'))   setAisaniConfig(data.aisaniConfig);
      if(data.yearMonth      &&!pendingKeys.current.has('yearMonth'))      {setYear(data.yearMonth.y);setMonth(data.yearMonth.m);}
      setLoading(false);
    });
    const t=setTimeout(()=>setLoading(false),5000);
    return()=>{unsub();clearTimeout(t);};
  },[]);

  // ── デバウンス付き保存
  const debounceSave=useCallback((key,val)=>{
    clearTimeout(saveTimers.current[key]);
    setSyncing(true);
    pendingKeys.current.add(key);
    saveTimers.current[key]=setTimeout(async()=>{
      try{await saveKey(key,val);}catch(e){console.warn('save error',e);}
      pendingKeys.current.delete(key);
      setSyncing(pendingKeys.current.size>0);
    },600);
  },[]);

  // ── 状態変更 → Firebase保存
  const updateStaff=val=>{setStaff(val);debounceSave('staff',val);};
  const updateAvail=val=>{setAvail(val);debounceSave('avail',val);};
  const updateNightSlot=val=>{setNightSlotConfig(val);debounceSave('nightSlotConfig',val);};
  const updateAisaniCfg=val=>{setAisaniConfig(val);debounceSave('aisaniConfig',val);};
  const updateYearMonth=(y,m)=>{setYear(y);setMonth(m);debounceSave('yearMonth',{y,m});};
  const handleGmLogin=()=>{
    if(pwInput===GM_PASSWORD){
      setGmMode(true);setView("slots");
      setPwModal(false);setPwInput("");setPwError(false);
    } else {
      setPwError(true);setPwInput("");
    }
  };

  // ── スタイル
  const C={
    bg:"#080c18",text:"#e2e8f0",muted:"#475569",accent:"#6366f1",
  };
  const btn=(on,c=C.accent)=>({
    padding:"8px 16px",borderRadius:999,border:on?"none":"1px solid rgba(255,255,255,0.07)",
    cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:700,transition:"all .2s",
    background:on?c:"rgba(255,255,255,0.04)",color:on?"#fff":C.muted,
    boxShadow:on?`0 2px 16px ${c}55`:"none",
  });
  const glass={background:"rgba(13,19,35,0.82)",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)",borderRadius:18,border:"1px solid rgba(99,102,241,0.15)",padding:18};

  const [selectedStaffTab,setSelectedStaffTab]=useState(null);
  const availViewStaff=gmMode
    ?(selectedStaffTab?staff.find(s=>s.id===selectedStaffTab):staff[0])
    :loginStaff;

  if(loading) return(
    <div style={{minHeight:"100vh",background:"#080c18",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <div style={{position:"relative",width:72,height:72}}>
        <div style={{width:72,height:72,borderRadius:36,background:"linear-gradient(135deg,#6366f1,#8b5cf6)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,boxShadow:"0 0 48px #6366f155"}}>🍶</div>
        <div style={{position:"absolute",inset:-5,borderRadius:41,border:"2px solid rgba(99,102,241,0.4)",animation:"spin 1.8s linear infinite"}}/>
      </div>
      <div style={{color:"#475569",fontSize:12,letterSpacing:3,fontFamily:"sans-serif"}}>LOADING...</div>
    </div>
  );

  return(
    <div style={{fontFamily:"'Zen Kaku Gothic New',sans-serif",minHeight:"100vh",background:C.bg,color:C.text}}>
      <link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;700;900&display=swap" rel="stylesheet"/>
      <style>{`
        *{box-sizing:border-box}
        body{background:#080c18;background-image:radial-gradient(ellipse 80% 60% at 10% 10%,rgba(99,102,241,0.07) 0%,transparent 60%),radial-gradient(ellipse 60% 50% at 90% 90%,rgba(139,92,246,0.06) 0%,transparent 60%)}
        button{transition:all .2s;font-family:inherit}
        button:active{transform:scale(.92)!important}
        button:hover{filter:brightness(1.15)}
        .fi{animation:fi .28s cubic-bezier(.22,1,.36,1)}
        @keyframes fi{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .sth{position:sticky;top:0;background:rgba(10,14,26,0.95);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:5}
        .avail-row:hover td{background:rgba(99,102,241,0.04)!important}
        .inp{outline:none;transition:border-color .2s,box-shadow .2s}
        .inp:focus{border-color:#6366f1!important;box-shadow:0 0 0 3px rgba(99,102,241,0.18)!important}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:rgba(99,102,241,0.25);border-radius:4px}
      `}</style>

      {/* GMパスワードモーダル */}
      {pwModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(10px)",WebkitBackdropFilter:"blur(10px)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={e=>{if(e.target===e.currentTarget){setPwModal(false);setPwInput("");setPwError(false);}}}>
          <div className="fi" style={{...glass,padding:"32px 28px",width:320,boxShadow:"0 32px 64px rgba(0,0,0,0.6),0 0 0 1px rgba(99,102,241,0.2)"}}>
            <div style={{textAlign:"center",marginBottom:22}}>
              <div style={{width:52,height:52,borderRadius:26,background:"linear-gradient(135deg,#e879f9,#8b5cf6)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:12,boxShadow:"0 0 28px #e879f955"}}>🔐</div>
              <div style={{fontSize:16,fontWeight:900,color:"#e879f9"}}>GMモード</div>
              <div style={{fontSize:11,color:C.muted,marginTop:4}}>パスワードを入力してください</div>
            </div>
            <input className="inp" type="password" value={pwInput}
              onChange={e=>{setPwInput(e.target.value);setPwError(false);}}
              onKeyDown={e=>e.key==="Enter"&&handleGmLogin()}
              placeholder="パスワード" autoFocus
              style={{width:"100%",padding:"12px 16px",borderRadius:12,border:`1.5px solid ${pwError?"#ef4444":"rgba(255,255,255,0.1)"}`,
                background:"rgba(255,255,255,0.04)",color:C.text,fontSize:14,marginBottom:8}}/>
            {pwError&&<div style={{fontSize:11,color:"#ef4444",marginBottom:10,textAlign:"center"}}>パスワードが違います</div>}
            <div style={{display:"flex",gap:8,marginTop:8}}>
              <button onClick={()=>{setPwModal(false);setPwInput("");setPwError(false);}}
                style={{...btn(false),flex:1,padding:"11px",borderRadius:12,fontSize:13}}>キャンセル</button>
              <button onClick={handleGmLogin}
                style={{flex:1,padding:"11px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#e879f9,#8b5cf6)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:800,boxShadow:"0 4px 20px #e879f945"}}>
                ログイン
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ヘッダー */}
      <div style={{background:"rgba(8,12,24,0.88)",backdropFilter:"blur(24px)",WebkitBackdropFilter:"blur(24px)",borderBottom:"1px solid rgba(99,102,241,0.1)",padding:"12px 16px",position:"sticky",top:0,zIndex:30}}>
        <div style={{maxWidth:900,margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:(gmMode||(!gmMode&&loginStaff)||(!gmMode&&!loginStaff))?10:0}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:38,height:38,borderRadius:11,background:"linear-gradient(135deg,#6366f1,#8b5cf6)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:19,boxShadow:"0 0 18px #6366f145",flexShrink:0}}>🍶</div>
              <div>
                <div style={{fontSize:8,letterSpacing:5,fontWeight:800,textTransform:"uppercase",background:"linear-gradient(90deg,#6366f1,#8b5cf6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Shift Master</div>
                <div style={{fontSize:18,fontWeight:900,lineHeight:1.15}}>{year}年{month+1}月</div>
              </div>
              <div style={{display:"flex",gap:3,marginLeft:2}}>
                <button onClick={prevMonth} style={{...btn(false),padding:"5px 12px",fontSize:16,borderRadius:10}}>‹</button>
                <button onClick={nextMonth} style={{...btn(false),padding:"5px 12px",fontSize:16,borderRadius:10}}>›</button>
              </div>
            </div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <div style={{display:"flex",background:"rgba(255,255,255,0.04)",borderRadius:999,padding:3,gap:2,border:"1px solid rgba(255,255,255,0.06)"}}>
                <button onClick={()=>{if(gmMode)return;setPwModal(true);}} style={{...btn(gmMode,"linear-gradient(135deg,#e879f9,#8b5cf6)"),fontSize:11,padding:"5px 14px",borderRadius:999}}>GM</button>
                <button onClick={()=>{setGmMode(false);setView("avail");setLoginStaff(null);}} style={{...btn(!gmMode,"linear-gradient(135deg,#3b82f6,#6366f1)"),fontSize:11,padding:"5px 14px",borderRadius:999}}>スタッフ</button>
              </div>
              {gmMode&&<button onClick={()=>setStaffPanelOpen(v=>!v)} style={{...btn(staffPanelOpen,"rgba(99,102,241,0.35)"),fontSize:11,padding:"7px 14px",border:staffPanelOpen?"none":"1px solid rgba(255,255,255,0.07)"}}>👥 スタッフ</button>}
            </div>
          </div>

          {!gmMode&&!loginStaff&&(
            <div style={{paddingBottom:6}}>
              <div style={{fontSize:11,color:C.muted,marginBottom:8}}>名前を選んでください</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {staffModeStaff.map(s=>(
                  <button key={s.id} onClick={()=>setLoginStaff(s)} style={{...btn(false),fontSize:12,padding:"8px 18px",borderRadius:999}}>{s.name}</button>
                ))}
              </div>
            </div>
          )}
          {!gmMode&&loginStaff&&(
            <div style={{display:"flex",alignItems:"center",gap:8,paddingBottom:4}}>
              <div style={{width:7,height:7,borderRadius:4,background:"#34d399",boxShadow:"0 0 8px #34d399"}}/>
              <span style={{fontSize:11,color:C.muted}}>ログイン中：</span>
              <span style={{fontWeight:800,fontSize:13}}>{loginStaff.name}</span>
              <button onClick={()=>setLoginStaff(null)} style={{...btn(false),fontSize:10,padding:"3px 10px"}}>変更</button>
            </div>
          )}

          {gmMode&&(
            <div style={{display:"flex",gap:3,marginTop:8,background:"rgba(255,255,255,0.03)",borderRadius:13,padding:3,border:"1px solid rgba(255,255,255,0.05)"}}>
              {[["slots","① 夜枠設定"],["avail","② 候補日入力"],["result","③ シフト表"]].map(([v,l])=>(
                <button key={v} onClick={()=>setView(v)}
                  style={{flex:1,padding:"9px 4px",borderRadius:11,border:"none",cursor:"pointer",fontSize:11,fontWeight:700,transition:"all .2s",
                    background:view===v?"linear-gradient(135deg,#6366f1,#8b5cf6)":"transparent",
                    color:view===v?"#fff":C.muted,
                    boxShadow:view===v?"0 2px 14px #6366f145":"none"}}>
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"16px 12px"}}>

        {/* ── スタッフ管理パネル */}
        {gmMode&&staffPanelOpen&&(
          <div className="fi" style={{...glass,marginBottom:16}}>
            <div style={{fontSize:13,fontWeight:900,background:"linear-gradient(90deg,#6366f1,#8b5cf6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:14}}>スタッフ管理</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12,padding:14,background:"rgba(99,102,241,0.04)",borderRadius:12,border:"1px solid rgba(99,102,241,0.1)"}}>
              <input className="inp" placeholder="名前" value={newStaff.name} onChange={e=>setNewStaff(p=>({...p,name:e.target.value}))}
                style={{flex:"1 1 130px",padding:"10px 14px",borderRadius:10,border:"1.5px solid rgba(255,255,255,0.08)",background:"rgba(255,255,255,0.04)",color:C.text,fontSize:13}}/>
              <select value={newStaff.grade} onChange={e=>setNewStaff(p=>({...p,grade:e.target.value}))}
                style={{padding:"10px 12px",borderRadius:10,border:"1.5px solid rgba(255,255,255,0.08)",background:"rgba(20,30,50,0.95)",color:C.text,fontSize:13}}>
                {GRADES.map(g=><option key={g} value={g}>{g}</option>)}
              </select>
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:C.muted,cursor:"pointer"}}>
                <input type="checkbox" checked={newStaff.aisaniOK} onChange={e=>setNewStaff(p=>({...p,aisaniOK:e.target.checked}))}/>アイサニOK
              </label>
              <button onClick={addStaff} style={{padding:"10px 20px",borderRadius:10,border:"none",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:800,boxShadow:"0 4px 16px #6366f145"}}>追加</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {staff.map(s=>(
                <div key={s.id} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:"rgba(255,255,255,0.02)",borderRadius:12,border:"1px solid rgba(255,255,255,0.05)",flexWrap:"wrap"}}>
                  <span style={{flex:1,fontWeight:700,fontSize:13,minWidth:80}}>{s.name}</span>
                  <span style={{fontSize:10,padding:"3px 10px",borderRadius:999,fontWeight:700,background:GRADE_COLOR[s.grade]+"22",color:GRADE_COLOR[s.grade],border:`1px solid ${GRADE_COLOR[s.grade]}40`}}>{s.grade}</span>
                  <div style={{display:"flex",gap:3}}>
                    {GRADES.map(g=>(
                      <button key={g} onClick={()=>updateStaff(staff.map(x=>x.id===s.id?{...x,grade:g}:x))}
                        style={{...btn(s.grade===g,GRADE_COLOR[g]),fontSize:10,padding:"3px 8px",borderRadius:999}}>{g}</button>
                    ))}
                  </div>
                  <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:s.aisaniOK?"#34d399":C.muted,cursor:"pointer"}}>
                    <input type="checkbox" checked={!!s.aisaniOK} onChange={e=>updateStaff(staff.map(x=>x.id===s.id?{...x,aisaniOK:e.target.checked}:x))}/>アイサニ
                  </label>
                  <button onClick={()=>updateStaff(staff.filter(x=>x.id!==s.id))}
                    style={{padding:"4px 10px",borderRadius:999,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.06)",color:"#ef4444",cursor:"pointer",fontSize:11,fontWeight:700}}>削除</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── ① 夜枠設定 */}
        {gmMode&&view==="slots"&&(
          <div className="fi">
            <div style={{...glass,marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:900,background:"linear-gradient(90deg,#6366f1,#8b5cf6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:4}}>日ごとの夜・アイサニ枠を設定</div>
              <div style={{fontSize:11,color:C.muted,marginBottom:12}}>夜枠（複数可）とアイサニ（系列店ヘルプ）を日ごとに設定</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {NIGHT_TIMES.map(t=>(
                  <span key={t} style={{fontSize:10,display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:999,background:NIGHT_TC[t]+"14",border:`1px solid ${NIGHT_TC[t]}30`}}>
                    <span style={{width:6,height:6,borderRadius:3,background:NIGHT_TC[t],display:"inline-block",boxShadow:`0 0 6px ${NIGHT_TC[t]}`}}/>
                    <span style={{color:NIGHT_TC[t],fontWeight:700}}>{t}</span>
                  </span>
                ))}
                <span style={{fontSize:10,display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:999,background:"#34d39914",border:"1px solid #34d39930"}}>
                  <span style={{width:6,height:6,borderRadius:3,background:"#34d399",display:"inline-block",boxShadow:"0 0 6px #34d399"}}/>
                  <span style={{color:"#34d399",fontWeight:700}}>アイサニ</span>
                </span>
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3,marginBottom:12}}>
              {DOW_JP.map((d,i)=>(
                <div key={i} style={{textAlign:"center",fontSize:10,padding:"6px 0",fontWeight:800,color:i===0?"#f87171":i===6?"#60a5fa":C.muted}}>{d}</div>
              ))}
              {Array(firstDow).fill(null).map((_,i)=><div key={`e${i}`}/>)}
              {Array(days).fill(null).map((_,i)=>{
                const d=i+1,dow=getDow(year,month,d),hol=isHol(year,month,d);
                const closed=isClosed(year,month,d);
                const slots=nightSlotConfig[d]||[];
                const aiOn=aisaniConfig[d]?.enabled;
                const active=slots.length>0||aiOn;
                return(
                  <div key={d} style={{borderRadius:12,padding:"5px 3px",transition:"all .2s",
                    background:closed?"rgba(255,255,255,0.01)":active?"rgba(99,102,241,0.07)":"rgba(13,19,35,0.7)",
                    border:`1px solid ${closed?"rgba(255,255,255,0.03)":active?"rgba(99,102,241,0.3)":hol?"rgba(99,102,241,0.15)":dow===0?"rgba(248,113,113,0.15)":dow===6?"rgba(96,165,250,0.15)":"rgba(255,255,255,0.05)"}`,
                    minHeight:74,opacity:closed?0.22:1,
                    boxShadow:active?"0 0 12px rgba(99,102,241,0.12)":"none"}}>
                    <div style={{textAlign:"center",fontSize:11,fontWeight:800,marginBottom:3,
                      color:closed?"#374151":hol?"#818cf8":dow===0?"#f87171":dow===6?"#60a5fa":C.text}}>
                      {d}{hol?"🎌":""}{closed?"🔒":""}
                    </div>
                    {!closed&&(
                      <>
                        <div style={{display:"flex",flexWrap:"wrap",gap:2,justifyContent:"center",marginBottom:3}}>
                          {NIGHT_TIMES.map(t=>{
                            const on=slots.includes(t);
                            return(
                              <button key={t} onClick={()=>toggleNightSlot(d,t)}
                                style={{padding:"2px 3px",borderRadius:5,border:"none",cursor:"pointer",fontSize:7,fontWeight:800,
                                  background:on?NIGHT_TC[t]:"rgba(255,255,255,0.06)",color:on?"#fff":"#4b5563",
                                  boxShadow:on?`0 0 8px ${NIGHT_TC[t]}70`:"none",transition:"all .15s"}}>
                                {t}
                              </button>
                            );
                          })}
                        </div>
                        <div style={{textAlign:"center"}}>
                          <button onClick={()=>toggleAisani(d)}
                            style={{padding:"2px 7px",borderRadius:5,border:"none",cursor:"pointer",fontSize:7,fontWeight:800,
                              background:aiOn?"#34d399":"rgba(255,255,255,0.06)",color:aiOn?"#07080f":"#4b5563",
                              boxShadow:aiOn?"0 0 8px #34d39970":"none",transition:"all .15s"}}>
                            アイサニ
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{...glass,marginBottom:14}}>
              <div style={{fontSize:11,color:C.muted,marginBottom:8,fontWeight:600}}>一括設定</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {NIGHT_TIMES.map(t=>(
                  <button key={t} onClick={()=>{
                    const next={...nightSlotConfig};
                    for(let d=1;d<=days;d++){
                      if(isClosed(year,month,d))continue;
                      const cur=next[d]||[];
                      next[d]=cur.includes(t)?cur.filter(x=>x!==t):[...cur,t].sort();
                    }
                    updateNightSlot(next);
                  }} style={{fontSize:10,padding:"6px 12px",borderRadius:999,border:`1px solid ${NIGHT_TC[t]}40`,background:NIGHT_TC[t]+"12",color:NIGHT_TC[t],cursor:"pointer",fontWeight:700}}>
                    {t} 全日切替
                  </button>
                ))}
                <button onClick={()=>updateNightSlot({})} style={{...btn(false),fontSize:10,padding:"6px 14px"}}>全クリア</button>
              </div>
            </div>

            <button onClick={()=>setView("avail")} style={{width:"100%",padding:"15px",borderRadius:14,border:"none",cursor:"pointer",fontSize:14,fontWeight:900,background:"linear-gradient(135deg,#6366f1,#8b5cf6)",color:"#fff",boxShadow:"0 8px 28px #6366f148"}}>
              次へ：候補日入力 →
            </button>
          </div>
        )}

        {/* ── ② 候補日入力 */}
        {(gmMode?view==="avail":(!gmMode&&loginStaff))&&(
          <div className="fi">
            {gmMode&&(
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:14}}>
                {staff.map(s=>(
                  <button key={s.id} onClick={()=>setSelectedStaffTab(s.id)}
                    style={{...btn((selectedStaffTab===s.id)||(selectedStaffTab===null&&s.id===staff[0]?.id),GRADE_COLOR[s.grade]),fontSize:12,padding:"7px 16px",borderRadius:999}}>
                    {s.name}
                  </button>
                ))}
              </div>
            )}

            {availViewStaff&&(()=>{
              const sid=availViewStaff.id;
              const a=avail[sid]||{};
              const isJ=isJunior(availViewStaff.grade);
              return(
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
                    <span style={{fontWeight:900,fontSize:16}}>{availViewStaff.name}</span>
                    {gmMode&&<span style={{fontSize:10,padding:"3px 10px",borderRadius:999,fontWeight:700,background:GRADE_COLOR[availViewStaff.grade]+"20",color:GRADE_COLOR[availViewStaff.grade],border:`1px solid ${GRADE_COLOR[availViewStaff.grade]}40`}}>{availViewStaff.grade}</span>}
                    {isJ&&<span style={{fontSize:10,color:"#f87171",background:"rgba(248,113,113,0.08)",borderRadius:999,padding:"3px 10px",border:"1px solid rgba(248,113,113,0.2)"}}>金土日祝の夜は原則NG</span>}
                  </div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:12}}>
                    {[
                      {label:"朝 全ON",color:"#f59e0b",onClick:()=>setAllAvail(sid,"morning",true)},
                      {label:"朝仕込 全ON",color:"#10b981",onClick:()=>setAllAvail(sid,"prep",true)},
                      ...NIGHT_TIMES.map(t=>({label:`夜${t} 全ON`,color:NIGHT_TC[t],onClick:()=>setAllAvail(sid,`night_${t}`,true)})),
                      ...(availViewStaff.aisaniOK?[{label:"アイサニ 全ON",color:"#34d399",onClick:()=>setAllAvail(sid,"aisani",true)}]:[]),
                    ].map(({label,color,onClick})=>(
                      <button key={label} onClick={onClick}
                        style={{fontSize:10,padding:"5px 12px",borderRadius:999,border:`1px solid ${color}30`,background:color+"10",color,cursor:"pointer",fontWeight:700}}>
                        {label}
                      </button>
                    ))}
                    <button onClick={()=>setAvail(p=>({...p,[sid]:{}}))} style={{...btn(false),fontSize:10,padding:"5px 12px"}}>クリア</button>
                  </div>
                  <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"58vh",borderRadius:14,border:"1px solid rgba(99,102,241,0.15)"}}>
                    <table style={{borderCollapse:"collapse",width:"100%",minWidth:540}}>
                      <thead>
                        <tr>
                          <th className="sth" style={{fontSize:10,color:C.muted,fontWeight:600,padding:"9px 4px",textAlign:"center",width:30}}>日</th>
                          <th className="sth" style={{fontSize:10,color:C.muted,fontWeight:600,width:22,textAlign:"center"}}>曜</th>
                          <th className="sth" style={{fontSize:10,color:"#f59e0b",fontWeight:700,padding:"9px 8px",textAlign:"center"}}>朝<br/><span style={{fontSize:8,opacity:.6}}>7:00〜</span></th>
                          <th className="sth" style={{fontSize:10,color:"#10b981",fontWeight:700,padding:"9px 8px",textAlign:"center"}}>朝仕込<br/><span style={{fontSize:8,opacity:.6}}>8:30〜</span></th>
                          {NIGHT_TIMES.map(t=>(
                            <th key={t} className="sth" style={{fontSize:10,color:NIGHT_TC[t],fontWeight:700,padding:"9px 4px",textAlign:"center"}}>
                              {t}〜<br/><span style={{fontSize:8,opacity:.6}}>夜</span>
                            </th>
                          ))}
                          {availViewStaff.aisaniOK&&(
                            <th className="sth" style={{fontSize:10,color:"#34d399",fontWeight:700,padding:"9px 4px",textAlign:"center"}}>
                              アイサニ<br/><span style={{fontSize:8,opacity:.6}}>系列店</span>
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({length:days},(_,i)=>i+1).map(d=>{
                          const dow=getDow(year,month,d),hol=isHol(year,month,d);
                          const closed=isClosed(year,month,d);
                          const slots=nightSlotConfig[d]||[];
                          const rowBg=closed?"rgba(255,255,255,0.005)":hol?"rgba(129,140,248,0.04)":dow===0?"rgba(248,113,113,0.04)":dow===6?"rgba(96,165,250,0.04)":"transparent";
                          return(
                            <tr key={d} className="avail-row" style={{borderBottom:"1px solid rgba(255,255,255,0.04)",opacity:closed?0.28:1}}>
                              <td style={{background:rowBg,textAlign:"center",fontSize:12,fontWeight:800,padding:"5px 2px",
                                color:closed?"#374151":hol?"#818cf8":dow===0?"#f87171":dow===6?"#60a5fa":C.text}}>
                                {d}{hol?"🎌":""}{closed?"🔒":""}
                              </td>
                              <td style={{background:rowBg,textAlign:"center",fontSize:10,color:closed?"#374151":C.muted}}>{DOW_JP[dow]}</td>
                              {closed?(
                                <td colSpan={availViewStaff.aisaniOK?7:6} style={{background:rowBg,textAlign:"center",fontSize:10,color:"#374151",padding:"6px"}}>定休日</td>
                              ):(
                                <>
                                  {["morning","prep"].map(type=>{
                                    const on=!!a[`${d}_${type}`];
                                    const col=type==="morning"?"#f59e0b":"#10b981";
                                    return(
                                      <td key={type} style={{background:rowBg,textAlign:"center",padding:"3px 5px"}}>
                                        <button onClick={()=>toggleAvail(sid,`${d}_${type}`)}
                                          style={{width:34,height:28,borderRadius:8,border:"none",cursor:"pointer",fontSize:13,fontWeight:800,
                                            background:on?col:"rgba(255,255,255,0.05)",
                                            color:on?"#fff":"rgba(255,255,255,0.18)",
                                            boxShadow:on?`0 0 12px ${col}55`:"none",transition:"all .15s"}}>
                                          {on?"✓":""}
                                        </button>
                                      </td>
                                    );
                                  })}
                                  {NIGHT_TIMES.map(t=>{
                                    const key=`${d}_night_${t}`;
                                    const slotExists=slots.includes(t);
                                    const on=!!a[key]&&slotExists;
                                    const otherOn=slots.some(ot=>ot!==t&&!!a[`${d}_night_${ot}`]);
                                    const dis=!on&&otherOn;
                                    return(
                                      <td key={t} style={{background:rowBg,textAlign:"center",padding:"3px 3px"}}>
                                        {slotExists?(
                                          <button onClick={()=>!dis&&toggleNightAvail(sid,d,t)}
                                            style={{width:34,height:28,borderRadius:8,border:"none",cursor:dis?"not-allowed":"pointer",
                                              fontSize:13,fontWeight:800,transition:"all .15s",
                                              background:on?NIGHT_TC[t]:dis?"rgba(255,255,255,0.01)":"rgba(255,255,255,0.05)",
                                              color:on?"#fff":dis?"rgba(255,255,255,0.04)":"rgba(255,255,255,0.18)",
                                              boxShadow:on?`0 0 12px ${NIGHT_TC[t]}55`:"none",opacity:dis?0.3:1}}>
                                            {on?"✓":""}
                                          </button>
                                        ):(
                                          <div style={{width:34,height:28,borderRadius:8,background:"rgba(255,255,255,0.01)",margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                            <span style={{fontSize:9,color:"rgba(255,255,255,0.07)"}}>—</span>
                                          </div>
                                        )}
                                      </td>
                                    );
                                  })}
                                  {availViewStaff.aisaniOK&&(
                                    <td style={{background:rowBg,textAlign:"center",padding:"3px 3px"}}>
                                      <button onClick={()=>toggleAvail(sid,`${d}_aisani`)}
                                        style={{width:34,height:28,borderRadius:8,border:"none",cursor:"pointer",fontSize:13,fontWeight:800,transition:"all .15s",
                                          background:!!a[`${d}_aisani`]?"#34d399":"rgba(255,255,255,0.05)",
                                          color:!!a[`${d}_aisani`]?"#fff":"rgba(255,255,255,0.18)",
                                          boxShadow:!!a[`${d}_aisani`]?"0 0 12px #34d39955":"none"}}>
                                        {!!a[`${d}_aisani`]?"✓":""}
                                      </button>
                                    </td>
                                  )}
                                </>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{marginTop:8,fontSize:10,color:C.muted,opacity:.5}}>— は夜枠未設定 ／ 夜は1日1枠のみ選択可</div>
                </div>
              );
            })()}

            {gmMode&&(
              <button onClick={handleGenerate} disabled={generating}
                style={{width:"100%",marginTop:20,padding:"16px",borderRadius:14,border:"none",cursor:generating?"not-allowed":"pointer",
                  fontSize:15,fontWeight:900,transition:"all .3s",
                  background:generating?"rgba(255,255,255,0.04)":"linear-gradient(135deg,#6366f1,#8b5cf6)",
                  color:generating?"#475569":"#fff",boxShadow:generating?"none":"0 8px 28px #6366f150"}}>
                {generating?"⏳ 生成中...":"✨ シフトを自動生成する"}
              </button>
            )}
            {!gmMode&&loginStaff&&(
              <div style={{marginTop:14,padding:"13px 16px",borderRadius:12,background:"rgba(52,211,153,0.06)",border:"1px solid rgba(52,211,153,0.2)",fontSize:12,color:"#34d399",textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                <div style={{width:7,height:7,borderRadius:4,background:"#34d399",boxShadow:"0 0 8px #34d399"}}/>
                入力内容は自動で保存されます
              </div>
            )}
          </div>
        )}

        {!gmMode&&!loginStaff&&(
          <div style={{textAlign:"center",padding:"80px 20px",color:C.muted}}>
            <div style={{width:80,height:80,borderRadius:40,background:"rgba(99,102,241,0.07)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:34,marginBottom:18,border:"1px solid rgba(99,102,241,0.15)"}}>👤</div>
            <div style={{fontSize:14}}>上のリストから名前を選んでください</div>
          </div>
        )}

        {/* ── ③ シフト表 */}
        {gmMode&&view==="result"&&(
          <div className="fi">
            {!result?(
              <div style={{textAlign:"center",padding:"80px 20px",color:C.muted}}>
                <div style={{width:80,height:80,borderRadius:40,background:"rgba(99,102,241,0.07)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:34,marginBottom:18,border:"1px solid rgba(99,102,241,0.15)"}}>📋</div>
                <div style={{marginBottom:20,fontSize:14}}>シフトがまだ生成されていません</div>
                <button onClick={()=>setView("slots")} style={{padding:"11px 28px",borderRadius:999,border:"none",background:"linear-gradient(135deg,#6366f1,#8b5cf6)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:800,boxShadow:"0 4px 16px #6366f148"}}>夜枠を設定する</button>
              </div>
            ):(
              <div>
                <div style={{display:"flex",gap:8,marginBottom:16}}>
                  <button onClick={handleGenerate} style={{flex:1,padding:"12px",borderRadius:12,border:"1px solid rgba(99,102,241,0.3)",background:"rgba(99,102,241,0.06)",color:"#818cf8",cursor:"pointer",fontSize:13,fontWeight:700}}>
                    🔄 再生成
                  </button>
                  <button onClick={handleExport} disabled={exporting}
                    style={{flex:1,padding:"12px",borderRadius:12,border:"none",cursor:exporting?"wait":"pointer",fontSize:13,fontWeight:700,
                      background:exporting?"rgba(255,255,255,0.04)":"linear-gradient(135deg,#0ea5e9,#6366f1)",
                      color:exporting?"#475569":"#fff",boxShadow:exporting?"none":"0 4px 16px rgba(14,165,233,0.35)"}}>
                    {exporting?"⏳ 出力中...":"📷 画像で保存"}
                  </button>
                </div>

                <div ref={shiftRef} style={{background:C.bg,padding:16,borderRadius:18}}>
                  <div style={{textAlign:"center",marginBottom:18}}>
                    <div style={{fontSize:10,letterSpacing:6,fontWeight:700,background:"linear-gradient(90deg,#6366f1,#8b5cf6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:4}}>🍶 SHIFT TABLE</div>
                    <div style={{fontSize:22,fontWeight:900}}>{year}年{month+1}月 シフト表</div>
                  </div>

                  <div style={{...glass,marginBottom:16}}>
                    <div style={{fontSize:11,fontWeight:700,background:"linear-gradient(90deg,#6366f1,#8b5cf6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:12}}>勤務実績 / 候補ウェイト（達成率）</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                      {staff.map(s=>{
                        const w=result.worked[s.id]||0;
                        const c=result.candW[s.id]||0;
                        const pct=c>0?Math.round(w/c*100):0;
                        const avg=result.avgRate;
                        const dc=pct>avg?"#34d399":pct<avg?"#f87171":C.muted;
                        return(
                          <div key={s.id} style={{background:"rgba(255,255,255,0.03)",borderRadius:12,padding:"10px 14px",textAlign:"center",border:`1px solid ${GRADE_COLOR[s.grade]}22`,minWidth:84}}>
                            <div style={{fontSize:10,fontWeight:700,color:GRADE_COLOR[s.grade]}}>{s.name}</div>
                            <div style={{fontSize:19,fontWeight:900,marginTop:4}}>{w}<span style={{fontSize:10,color:C.muted,fontWeight:400}}>/{c}</span></div>
                            <div style={{fontSize:12,fontWeight:800,color:dc}}>{pct}%</div>
                            <div style={{fontSize:8,color:C.muted,opacity:.6,marginTop:2}}>実績/候補</div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{fontSize:10,color:C.muted,marginTop:10,opacity:.6}}>平均達成率：{result.avgRate}%</div>
                  </div>

                  {Array.from({length:days},(_,i)=>i+1).map(d=>{
                    const dow=getDow(year,month,d),hol=isHol(year,month,d);
                    if(isClosed(year,month,d)) return null;
                    const day=result.shifts[d];
                    if(!day) return null;
                    const slots=nightSlotConfig[d]||[];
                    const aiOn=aisaniConfig[d]?.enabled;
                    const sh=result.shortage[d]||{};
                    const warns=result.warnings[d]||[];
                    const totalS=(sh.morning||0)+(sh.prep||0)+slots.reduce((s,t)=>s+(sh.night?.[t]||0),0)+(aiOn?sh.aisani||0:0);
                    const bc=totalS>0?"rgba(239,68,68,0.3)":warns.length?"rgba(245,158,11,0.22)":hol?"rgba(99,102,241,0.22)":dow===0?"rgba(248,113,113,0.14)":dow===6?"rgba(96,165,250,0.14)":"rgba(255,255,255,0.05)";
                    return(
                      <div key={d} style={{background:"rgba(13,19,35,0.72)",borderRadius:14,border:`1px solid ${bc}`,padding:14,marginBottom:8}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8,flexWrap:"wrap"}}>
                          <span style={{fontWeight:900,fontSize:15,color:hol?"#818cf8":dow===0?"#f87171":dow===6?"#60a5fa":C.text}}>
                            {month+1}/{d}（{DOW_JP[dow]}）{hol?"🎌":""}
                          </span>
                          {isSpec(year,month,d)&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(99,102,241,0.1)",color:"#818cf8",fontWeight:700,border:"1px solid rgba(99,102,241,0.2)"}}>特別夜</span>}
                          {totalS>0&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(239,68,68,0.1)",color:"#ef4444",fontWeight:700,border:"1px solid rgba(239,68,68,0.2)"}}>⚠ 不足{totalS}名</span>}
                          {warns.length>0&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(245,158,11,0.08)",color:"#f59e0b",fontWeight:700,border:"1px solid rgba(245,158,11,0.2)"}}>⚡ 例外あり</span>}
                        </div>
                        {warns.length>0&&(
                          <div style={{marginBottom:8,padding:"8px 12px",background:"rgba(245,158,11,0.05)",borderRadius:10,border:"1px solid rgba(245,158,11,0.15)"}}>
                            {warns.map((w,i)=><div key={i} style={{fontSize:10,color:"#f59e0b"}}>⚡ {w}</div>)}
                          </div>
                        )}
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          <SRow label="朝" time="7:00〜11:00" color="#f59e0b" people={day.morning.map(id=>staffMap[id]).filter(Boolean)} shortage={sh.morning||0}/>
                          <SRow label="朝仕込" time="8:30〜16:00" color="#10b981" people={day.prep.map(id=>staffMap[id]).filter(Boolean)} shortage={sh.prep||0}/>
                          {slots.map(t=>{
                            const p=day.night[t];
                            return <SRow key={t} label={`夜 ${t}〜`} time="" color={NIGHT_TC[t]} people={p?[staffMap[p]].filter(Boolean):[]} shortage={sh.night?.[t]||0}/>;
                          })}
                          {aiOn&&<SRow label="アイサニ" time="系列店" color="#34d399" people={day.aisani?[staffMap[day.aisani]].filter(Boolean):[]} shortage={sh.aisani||0}/>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SRow({label,time,color,people,shortage=0}){
  return(
    <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
      <div style={{minWidth:70,fontSize:10,fontWeight:700,color,background:color+"16",borderRadius:999,padding:"3px 10px",textAlign:"center",flexShrink:0,border:`1px solid ${color}28`}}>{label}</div>
      {time&&<div style={{fontSize:9,color:"#475569",minWidth:76,flexShrink:0}}>{time}</div>}
      <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
        {people.map(s=>(
          <span key={s.id} style={{fontSize:12,padding:"4px 14px",borderRadius:999,background:"rgba(255,255,255,0.06)",color:"#e2e8f0",fontWeight:600,border:"1px solid rgba(255,255,255,0.08)"}}>
            {s.name}
          </span>
        ))}
        {shortage>0&&(
          <span style={{fontSize:10,padding:"3px 10px",borderRadius:999,background:"rgba(239,68,68,0.1)",color:"#ef4444",fontWeight:700,border:"1px solid rgba(239,68,68,0.22)"}}>
            あと{shortage}名不足
          </span>
        )}
        {people.length===0&&shortage===0&&<span style={{fontSize:11,color:"rgba(255,255,255,0.09)"}}>—</span>}
      </div>
    </div>
  );
}
