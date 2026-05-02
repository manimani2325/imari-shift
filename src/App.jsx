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
    {id:1,name:"田中 蓮",grade:"SM",aisaniOK:true,password:""},
    {id:2,name:"佐藤 彩",grade:"SM",aisaniOK:true,password:""},
    {id:3,name:"鈴木 翔",grade:"M",aisaniOK:false,password:""},
    {id:4,name:"高橋 美咲",grade:"L",aisaniOK:false,password:""},
    {id:5,name:"伊藤 大輝",grade:"J",aisaniOK:false,password:""},
    {id:6,name:"渡辺 ひな",grade:"J",aisaniOK:false,password:""},
  ]);
  const [avail,setAvail]=useState({});
  const [nightSlotConfig,setNightSlotConfig]=useState({});
  const [aisaniConfig,setAisaniConfig]=useState({}); // { d: {enabled:bool} }
  const [result,setResult]=useState(null);
  const [view,setView]=useState("slots"); // slots|avail|result
  const [gmMode,setGmMode]=useState(false);
  const [loginStaff,setLoginStaff]=useState(null); // スタッフモードで選択中
  const [newStaff,setNewStaff]=useState({name:"",grade:"L",aisaniOK:false,password:""});
  const [staffPwModal,setStaffPwModal]=useState(null); // パスワード確認中のスタッフ
  const [staffPwInput,setStaffPwInput]=useState("");
  const [staffPwError,setStaffPwError]=useState(false);
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
  const handleStaffSelect=(s)=>{
    if(s.password){setStaffPwModal(s);setStaffPwInput("");setStaffPwError(false);}
    else setLoginStaff(s);
  };
  const handleStaffPwLogin=()=>{
    if(staffPwInput===staffPwModal.password){setLoginStaff(staffPwModal);setStaffPwModal(null);setStaffPwInput("");setStaffPwError(false);}
    else{setStaffPwError(true);setStaffPwInput("");}
  };

  // GMパスワード
  const GM_PASSWORD="0625";
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

  // ── スタイル（和風テーマ）
  const C={
    bg:"#fdfaf6",text:"#1a0a00",muted:"#8c7b6b",accent:"#8b1a1a",
    navy:"#1b2a5e",gold:"#b8860b",red:"#8b1a1a",cream:"#fdf6ec",
  };
  const btn=(on,c=C.accent)=>({
    padding:"8px 16px",borderRadius:999,border:on?"none":`1px solid ${C.accent}30`,
    cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:700,transition:"all .2s",
    background:on?c:"rgba(139,26,26,0.05)",color:on?"#fff":C.muted,
    boxShadow:on?`0 2px 12px ${c}44`:"none",
  });
  const card={background:"#fff",borderRadius:16,border:"1px solid rgba(139,26,26,0.1)",padding:18,boxShadow:"0 2px 16px rgba(139,26,26,0.06)"};

  const [selectedStaffTab,setSelectedStaffTab]=useState(null);
  const availViewStaff=gmMode
    ?(selectedStaffTab?staff.find(s=>s.id===selectedStaffTab):staff[0])
    :loginStaff;

  if(loading) return(
    <div style={{minHeight:"100vh",position:"relative",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:0}}>
      <div style={{position:"absolute",inset:0,backgroundImage:"url(/imari.jpeg)",backgroundSize:"cover",backgroundPosition:"center top",backgroundRepeat:"no-repeat"}}/>
      <div style={{position:"absolute",inset:0,background:"rgba(255,255,255,0.18)"}}/>
      <div style={{position:"relative",zIndex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:18,marginTop:"-15vh"}}>
        <div style={{background:"rgba(255,255,255,0.85)",borderRadius:999,padding:"10px 36px",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",boxShadow:"0 4px 24px rgba(139,26,26,0.12)"}}>
          <div style={{fontSize:13,letterSpacing:6,color:C.accent,fontWeight:700,fontFamily:"serif"}}>読み込み中...</div>
        </div>
        <div style={{fontSize:11,letterSpacing:4,color:"rgba(139,26,26,0.55)",fontFamily:"sans-serif",fontWeight:600}}>Loading...</div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  return(
    <div style={{fontFamily:"'Zen Kaku Gothic New',sans-serif",minHeight:"100vh",background:C.bg,color:C.text}}>
      <link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;700;900&display=swap" rel="stylesheet"/>
      <style>{`
        *{box-sizing:border-box}
        body{background:#fdfaf6}
        button{transition:all .2s;font-family:inherit}
        button:active{transform:scale(.93)!important}
        button:hover{filter:brightness(0.93)}
        .fi{animation:fi .28s cubic-bezier(.22,1,.36,1)}
        @keyframes fi{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .sth{position:sticky;top:0;background:rgba(253,250,246,0.97);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:5}
        .avail-row:hover td{background:rgba(139,26,26,0.03)!important}
        .inp{outline:none;transition:border-color .2s,box-shadow .2s}
        .inp:focus{border-color:#8b1a1a!important;box-shadow:0 0 0 3px rgba(139,26,26,0.12)!important}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:rgba(139,26,26,0.2);border-radius:4px}
      `}</style>

      {/* GMパスワードモーダル */}
      {pwModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={e=>{if(e.target===e.currentTarget){setPwModal(false);setPwInput("");setPwError(false);}}}>
          <div className="fi" style={{...card,padding:"32px 28px",width:320,boxShadow:"0 24px 64px rgba(0,0,0,0.18)"}}>
            <div style={{textAlign:"center",marginBottom:22}}>
              <div style={{width:52,height:52,borderRadius:26,background:"linear-gradient(135deg,#8b1a1a,#b8860b)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:12,boxShadow:"0 0 20px rgba(139,26,26,0.3)"}}>🔐</div>
              <div style={{fontSize:16,fontWeight:900,color:C.accent}}>GMモード</div>
              <div style={{fontSize:11,color:C.muted,marginTop:4}}>パスワードを入力してください</div>
            </div>
            <input className="inp" type="password" value={pwInput}
              onChange={e=>{setPwInput(e.target.value);setPwError(false);}}
              onKeyDown={e=>e.key==="Enter"&&handleGmLogin()}
              placeholder="パスワード" autoFocus
              style={{width:"100%",padding:"12px 16px",borderRadius:12,border:`1.5px solid ${pwError?"#ef4444":"rgba(139,26,26,0.15)"}`,
                background:"#fdfaf6",color:C.text,fontSize:14,marginBottom:8}}/>
            {pwError&&<div style={{fontSize:11,color:"#ef4444",marginBottom:10,textAlign:"center"}}>パスワードが違います</div>}
            <div style={{display:"flex",gap:8,marginTop:8}}>
              <button onClick={()=>{setPwModal(false);setPwInput("");setPwError(false);}}
                style={{...btn(false),flex:1,padding:"11px",borderRadius:12,fontSize:13}}>キャンセル</button>
              <button onClick={handleGmLogin}
                style={{flex:1,padding:"11px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#8b1a1a,#b8860b)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:800,boxShadow:"0 4px 16px rgba(139,26,26,0.3)"}}>
                ログイン
              </button>
            </div>
          </div>
        </div>
      )}

      {/* スタッフPINモーダル */}
      {staffPwModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={e=>{if(e.target===e.currentTarget){setStaffPwModal(null);setStaffPwInput("");setStaffPwError(false);}}}>
          <div className="fi" style={{...card,padding:"32px 28px",width:300,boxShadow:"0 24px 64px rgba(0,0,0,0.18)"}}>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{width:52,height:52,borderRadius:26,background:"linear-gradient(135deg,#8b1a1a,#b8860b)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:12,boxShadow:"0 0 20px rgba(139,26,26,0.25)"}}>🔑</div>
              <div style={{fontSize:15,fontWeight:900,color:C.text}}>{staffPwModal.name}</div>
              <div style={{fontSize:11,color:C.muted,marginTop:4}}>4桁のパスワードを入力</div>
            </div>
            <input className="inp" type="password" inputMode="numeric" maxLength={4} value={staffPwInput}
              onChange={e=>{setStaffPwInput(e.target.value.replace(/\D/g,"").slice(0,4));setStaffPwError(false);}}
              onKeyDown={e=>e.key==="Enter"&&handleStaffPwLogin()}
              placeholder="••••" autoFocus
              style={{width:"100%",padding:"14px 16px",borderRadius:12,border:`1.5px solid ${staffPwError?"#ef4444":"rgba(139,26,26,0.15)"}`,
                background:"#fdfaf6",color:C.text,fontSize:22,textAlign:"center",letterSpacing:8,marginBottom:8}}/>
            {staffPwError&&<div style={{fontSize:11,color:"#ef4444",marginBottom:10,textAlign:"center"}}>パスワードが違います</div>}
            <div style={{display:"flex",gap:8,marginTop:8}}>
              <button onClick={()=>{setStaffPwModal(null);setStaffPwInput("");setStaffPwError(false);}}
                style={{...btn(false),flex:1,padding:"11px",borderRadius:12,fontSize:13}}>戻る</button>
              <button onClick={handleStaffPwLogin}
                style={{flex:1,padding:"11px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#8b1a1a,#b8860b)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:800,boxShadow:"0 4px 16px rgba(139,26,26,0.3)"}}>
                確認
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ヘッダー */}
      <div style={{background:"rgba(253,250,246,0.95)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",borderBottom:"1px solid rgba(139,26,26,0.12)",padding:"12px 16px",position:"sticky",top:0,zIndex:30}}>
        <div style={{maxWidth:900,margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:(gmMode||(!gmMode&&loginStaff)||(!gmMode&&!loginStaff))?10:0}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:38,height:38,borderRadius:11,background:"linear-gradient(135deg,#8b1a1a,#b8860b)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:19,boxShadow:"0 2px 12px rgba(139,26,26,0.25)",flexShrink:0}}>🍶</div>
              <div>
                <div style={{fontSize:8,letterSpacing:5,fontWeight:800,textTransform:"uppercase",color:C.gold}}>旬菜 いまり</div>
                <div style={{fontSize:18,fontWeight:900,lineHeight:1.15,color:C.text}}>{year}年{month+1}月</div>
              </div>
              <div style={{display:"flex",gap:3,marginLeft:2}}>
                <button onClick={prevMonth} style={{...btn(false),padding:"5px 12px",fontSize:16,borderRadius:10}}>‹</button>
                <button onClick={nextMonth} style={{...btn(false),padding:"5px 12px",fontSize:16,borderRadius:10}}>›</button>
              </div>
            </div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <div style={{display:"flex",background:"rgba(139,26,26,0.05)",borderRadius:999,padding:3,gap:2,border:"1px solid rgba(139,26,26,0.1)"}}>
                <button onClick={()=>{if(gmMode)return;setPwModal(true);}} style={{...btn(gmMode,"linear-gradient(135deg,#8b1a1a,#b8860b)"),fontSize:11,padding:"5px 14px",borderRadius:999}}>GM</button>
                <button onClick={()=>{setGmMode(false);setView("avail");setLoginStaff(null);}} style={{...btn(!gmMode,"linear-gradient(135deg,#1b2a5e,#2d4a9e)"),fontSize:11,padding:"5px 14px",borderRadius:999}}>スタッフ</button>
              </div>
              {gmMode&&<button onClick={()=>setStaffPanelOpen(v=>!v)} style={{...btn(staffPanelOpen,"rgba(139,26,26,0.15)"),fontSize:11,padding:"7px 14px",border:staffPanelOpen?"none":`1px solid rgba(139,26,26,0.15)`}}>👥 スタッフ</button>}
            </div>
          </div>

          {!gmMode&&!loginStaff&&(
            <div style={{paddingBottom:6}}>
              <div style={{fontSize:11,color:C.muted,marginBottom:8}}>名前を選んでください</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {staffModeStaff.map(s=>(
                  <button key={s.id} onClick={()=>handleStaffSelect(s)} style={{...btn(false),fontSize:12,padding:"8px 18px",borderRadius:999}}>
                    {s.name}{s.password?<span style={{fontSize:9,marginLeft:4,opacity:.5}}>🔒</span>:""}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!gmMode&&loginStaff&&(
            <div style={{display:"flex",alignItems:"center",gap:8,paddingBottom:4}}>
              <div style={{width:7,height:7,borderRadius:4,background:C.accent,boxShadow:`0 0 6px ${C.accent}`}}/>
              <span style={{fontSize:11,color:C.muted}}>ログイン中：</span>
              <span style={{fontWeight:800,fontSize:13}}>{loginStaff.name}</span>
              <button onClick={()=>setLoginStaff(null)} style={{...btn(false),fontSize:10,padding:"3px 10px"}}>変更</button>
            </div>
          )}

          {gmMode&&(
            <div style={{display:"flex",gap:3,marginTop:8,background:"rgba(139,26,26,0.04)",borderRadius:13,padding:3,border:"1px solid rgba(139,26,26,0.08)"}}>
              {[["slots","① 夜枠設定"],["avail","② 候補日入力"],["result","③ シフト表"]].map(([v,l])=>(
                <button key={v} onClick={()=>setView(v)}
                  style={{flex:1,padding:"9px 4px",borderRadius:11,border:"none",cursor:"pointer",fontSize:11,fontWeight:700,transition:"all .2s",
                    background:view===v?"linear-gradient(135deg,#8b1a1a,#b8860b)":"transparent",
                    color:view===v?"#fff":C.muted,
                    boxShadow:view===v?"0 2px 10px rgba(139,26,26,0.25)":"none"}}>
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
          <div className="fi" style={{...card,marginBottom:16}}>
            <div style={{fontSize:13,fontWeight:900,background:"linear-gradient(90deg,#6366f1,#8b5cf6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:14}}>スタッフ管理</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12,padding:14,background:"rgba(99,102,241,0.04)",borderRadius:12,border:"1px solid rgba(99,102,241,0.1)"}}>
              <input className="inp" placeholder="名前" value={newStaff.name} onChange={e=>setNewStaff(p=>({...p,name:e.target.value}))}
                style={{flex:"1 1 130px",padding:"10px 14px",borderRadius:10,border:"1.5px solid rgba(139,26,26,0.15)",background:"#fdfaf6",color:C.text,fontSize:13}}/>
              <select value={newStaff.grade} onChange={e=>setNewStaff(p=>({...p,grade:e.target.value}))}
                style={{padding:"10px 12px",borderRadius:10,border:"1.5px solid rgba(139,26,26,0.15)",background:"#fff",color:C.text,fontSize:13}}>
                {GRADES.map(g=><option key={g} value={g}>{g}</option>)}
              </select>
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:C.muted,cursor:"pointer"}}>
                <input type="checkbox" checked={newStaff.aisaniOK} onChange={e=>setNewStaff(p=>({...p,aisaniOK:e.target.checked}))}/>アイサニOK
              </label>
              <input className="inp" placeholder="PW(4桁)" maxLength={4} value={newStaff.password||""}
                onChange={e=>setNewStaff(p=>({...p,password:e.target.value.replace(/\D/g,"").slice(0,4)}))}
                style={{width:80,padding:"10px 10px",borderRadius:10,border:"1.5px solid rgba(139,26,26,0.15)",background:"#fdfaf6",color:C.text,fontSize:13,textAlign:"center",letterSpacing:4}}/>
              <button onClick={addStaff} style={{padding:"10px 20px",borderRadius:10,border:"none",background:"linear-gradient(135deg,#8b1a1a,#b8860b)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:800,boxShadow:"0 4px 14px rgba(139,26,26,0.3)"}}>追加</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {staff.map(s=>(
                <div key={s.id} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:"#fdfaf6",borderRadius:12,border:"1px solid rgba(139,26,26,0.08)",flexWrap:"wrap"}}>
                  <span style={{flex:1,fontWeight:700,fontSize:13,minWidth:80}}>{s.name}</span>
                  <span style={{fontSize:10,padding:"3px 10px",borderRadius:999,fontWeight:700,background:GRADE_COLOR[s.grade]+"22",color:GRADE_COLOR[s.grade],border:`1px solid ${GRADE_COLOR[s.grade]}40`}}>{s.grade}</span>
                  <div style={{display:"flex",gap:3}}>
                    {GRADES.map(g=>(
                      <button key={g} onClick={()=>updateStaff(staff.map(x=>x.id===s.id?{...x,grade:g}:x))}
                        style={{...btn(s.grade===g,GRADE_COLOR[g]),fontSize:10,padding:"3px 8px",borderRadius:999}}>{g}</button>
                    ))}
                  </div>
                  <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:s.aisaniOK?C.accent:C.muted,cursor:"pointer"}}>
                    <input type="checkbox" checked={!!s.aisaniOK} onChange={e=>updateStaff(staff.map(x=>x.id===s.id?{...x,aisaniOK:e.target.checked}:x))}/>アイサニ
                  </label>
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    <span style={{fontSize:10,color:C.muted}}>🔒</span>
                    <input className="inp" type="text" inputMode="numeric" maxLength={4} value={s.password||""}
                      onChange={e=>updateStaff(staff.map(x=>x.id===s.id?{...x,password:e.target.value.replace(/\D/g,"").slice(0,4)}:x))}
                      placeholder="PW" title="4桁パスワード（空欄=なし）"
                      style={{width:56,padding:"4px 6px",borderRadius:8,border:"1.5px solid rgba(139,26,26,0.15)",background:"#fff",color:C.text,fontSize:13,textAlign:"center",letterSpacing:3}}/>
                  </div>
                  <button onClick={()=>updateStaff(staff.filter(x=>x.id!==s.id))}
                    style={{padding:"4px 10px",borderRadius:999,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.05)",color:"#ef4444",cursor:"pointer",fontSize:11,fontWeight:700}}>削除</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── ① 夜枠設定 */}
        {gmMode&&view==="slots"&&(
          <div className="fi">
            <div style={{...card,marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:900,color:C.accent,marginBottom:4}}>日ごとの夜・アイサニ枠を設定</div>
              <div style={{fontSize:11,color:C.muted,marginBottom:12}}>夜枠（複数可）とアイサニ（ヘルプ）を日ごとに設定</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {NIGHT_TIMES.map(t=>(
                  <span key={t} style={{fontSize:10,display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:999,background:NIGHT_TC[t]+"14",border:`1px solid ${NIGHT_TC[t]}30`}}>
                    <span style={{width:6,height:6,borderRadius:3,background:NIGHT_TC[t],display:"inline-block"}}/>
                    <span style={{color:NIGHT_TC[t],fontWeight:700}}>{t}</span>
                  </span>
                ))}
                <span style={{fontSize:10,display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:999,background:"rgba(139,26,26,0.08)",border:"1px solid rgba(139,26,26,0.2)"}}>
                  <span style={{width:6,height:6,borderRadius:3,background:C.accent,display:"inline-block"}}/>
                  <span style={{color:C.accent,fontWeight:700}}>アイサニ</span>
                </span>
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3,marginBottom:12}}>
              {DOW_JP.map((d,i)=>(
                <div key={i} style={{textAlign:"center",fontSize:10,padding:"6px 0",fontWeight:800,color:i===0?"#c0392b":i===6?"#1b2a5e":C.muted}}>{d}</div>
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
                    background:closed?"#f5f0eb":active?"rgba(139,26,26,0.05)":"#fff",
                    border:`1px solid ${closed?"rgba(139,26,26,0.06)":active?"rgba(139,26,26,0.25)":hol?"rgba(184,134,11,0.2)":dow===0?"rgba(192,57,43,0.18)":dow===6?"rgba(27,42,94,0.15)":"rgba(139,26,26,0.08)"}`,
                    minHeight:74,opacity:closed?0.35:1,
                    boxShadow:active?"0 2px 10px rgba(139,26,26,0.1)":"0 1px 4px rgba(0,0,0,0.04)"}}>
                    <div style={{textAlign:"center",fontSize:11,fontWeight:800,marginBottom:3,
                      color:closed?"#b0a090":hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
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
                                  background:on?NIGHT_TC[t]:"rgba(139,26,26,0.07)",color:on?"#fff":"#8c7b6b",
                                  transition:"all .15s"}}>
                                {t}
                              </button>
                            );
                          })}
                        </div>
                        <div style={{textAlign:"center"}}>
                          <button onClick={()=>toggleAisani(d)}
                            style={{padding:"2px 7px",borderRadius:5,border:"none",cursor:"pointer",fontSize:7,fontWeight:800,
                              background:aiOn?"#8b1a1a":"rgba(139,26,26,0.07)",color:aiOn?"#fff":"#8c7b6b",
                              transition:"all .15s"}}>
                            アイサニ
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{...card,marginBottom:14}}>
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

            <button onClick={()=>setView("avail")} style={{width:"100%",padding:"15px",borderRadius:14,border:"none",cursor:"pointer",fontSize:14,fontWeight:900,background:"linear-gradient(135deg,#8b1a1a,#b8860b)",color:"#fff",boxShadow:"0 6px 22px rgba(139,26,26,0.3)"}}>
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
                  <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"58vh",borderRadius:14,border:"1px solid rgba(139,26,26,0.1)"}}>
                    <table style={{borderCollapse:"collapse",width:"100%",minWidth:540,background:"#fff"}}>
                      <thead>
                        <tr>
                          <th className="sth" style={{fontSize:10,color:C.muted,fontWeight:600,padding:"9px 4px",textAlign:"center",width:30,background:"#fff"}}>日</th>
                          <th className="sth" style={{fontSize:10,color:C.muted,fontWeight:600,width:22,textAlign:"center",background:"#fff"}}>曜</th>
                          <th className="sth" style={{fontSize:10,color:"#b07d12",fontWeight:700,padding:"9px 8px",textAlign:"center",background:"#fff"}}>朝<br/><span style={{fontSize:8,opacity:.6}}>7:00〜</span></th>
                          <th className="sth" style={{fontSize:10,color:"#276749",fontWeight:700,padding:"9px 8px",textAlign:"center",background:"#fff"}}>朝仕込<br/><span style={{fontSize:8,opacity:.6}}>8:30〜</span></th>
                          {NIGHT_TIMES.map(t=>(
                            <th key={t} className="sth" style={{fontSize:10,color:NIGHT_TC[t],fontWeight:700,padding:"9px 4px",textAlign:"center",background:"#fff"}}>
                              {t}〜<br/><span style={{fontSize:8,opacity:.6}}>夜</span>
                            </th>
                          ))}
                          {availViewStaff.aisaniOK&&(
                            <th className="sth" style={{fontSize:10,color:C.accent,fontWeight:700,padding:"9px 4px",textAlign:"center",background:"#fff"}}>
                              アイサニ<br/><span style={{fontSize:8,opacity:.6}}>ヘルプ</span>
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({length:days},(_,i)=>i+1).map(d=>{
                          const dow=getDow(year,month,d),hol=isHol(year,month,d);
                          const closed=isClosed(year,month,d);
                          const slots=nightSlotConfig[d]||[];
                          const rowBg=closed?"#f5f0eb":hol?"rgba(184,134,11,0.04)":dow===0?"rgba(192,57,43,0.03)":dow===6?"rgba(27,42,94,0.03)":"#fff";
                          return(
                            <tr key={d} className="avail-row" style={{borderBottom:"1px solid rgba(139,26,26,0.06)",opacity:closed?0.4:1}}>
                              <td style={{background:rowBg,textAlign:"center",fontSize:12,fontWeight:800,padding:"5px 2px",
                                color:closed?"#b0a090":hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                                {d}{hol?"🎌":""}{closed?"🔒":""}
                              </td>
                              <td style={{background:rowBg,textAlign:"center",fontSize:10,color:closed?"#b0a090":C.muted}}>{DOW_JP[dow]}</td>
                              {closed?(
                                <td colSpan={availViewStaff.aisaniOK?7:6} style={{background:rowBg,textAlign:"center",fontSize:10,color:"#b0a090",padding:"6px"}}>定休日</td>
                              ):(
                                <>
                                  {["morning","prep"].map(type=>{
                                    const on=!!a[`${d}_${type}`];
                                    const col=type==="morning"?"#b07d12":"#276749";
                                    return(
                                      <td key={type} style={{background:rowBg,textAlign:"center",padding:"3px 5px"}}>
                                        <button onClick={()=>toggleAvail(sid,`${d}_${type}`)}
                                          style={{width:34,height:28,borderRadius:8,border:on?"none":`1px solid ${col}90`,cursor:"pointer",fontSize:13,fontWeight:800,
                                            background:on?col:"rgba(139,26,26,0.03)",
                                            color:on?"#fff":col+"99",
                                            boxShadow:on?`0 2px 8px ${col}44`:"none",transition:"all .15s"}}>
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
                                            style={{width:34,height:28,borderRadius:8,border:on?"none":`1px solid ${NIGHT_TC[t]}90`,cursor:dis?"not-allowed":"pointer",
                                              fontSize:13,fontWeight:800,transition:"all .15s",
                                              background:on?NIGHT_TC[t]:dis?"rgba(139,26,26,0.02)":"rgba(139,26,26,0.03)",
                                              color:on?"#fff":dis?"rgba(0,0,0,0.1)":NIGHT_TC[t]+"99",
                                              boxShadow:on?`0 2px 8px ${NIGHT_TC[t]}55`:"none",opacity:dis?0.3:1}}>
                                            {on?"✓":""}
                                          </button>
                                        ):(
                                          <div style={{width:34,height:28,borderRadius:8,background:"rgba(139,26,26,0.02)",margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                            <span style={{fontSize:9,color:"rgba(139,26,26,0.15)"}}>—</span>
                                          </div>
                                        )}
                                      </td>
                                    );
                                  })}
                                  {availViewStaff.aisaniOK&&(
                                    <td style={{background:rowBg,textAlign:"center",padding:"3px 3px"}}>
                                      {aisaniConfig[d]?.enabled?(
                                        <button onClick={()=>toggleAvail(sid,`${d}_aisani`)}
                                          style={{width:34,height:28,borderRadius:8,border:!!a[`${d}_aisani`]?"none":`1px solid ${C.accent}90`,cursor:"pointer",fontSize:13,fontWeight:800,transition:"all .15s",
                                            background:!!a[`${d}_aisani`]?C.accent:"rgba(139,26,26,0.03)",
                                            color:!!a[`${d}_aisani`]?"#fff":C.accent+"99",
                                            boxShadow:!!a[`${d}_aisani`]?`0 2px 8px ${C.accent}44`:"none"}}>
                                          {!!a[`${d}_aisani`]?"✓":""}
                                        </button>
                                      ):(
                                        <div style={{width:34,height:28,borderRadius:8,background:"rgba(139,26,26,0.02)",margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                          <span style={{fontSize:9,color:"rgba(139,26,26,0.15)"}}>—</span>
                                        </div>
                                      )}
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
                  background:generating?"#f5f0eb":"linear-gradient(135deg,#8b1a1a,#b8860b)",
                  color:generating?"#b0a090":"#fff",boxShadow:generating?"none":"0 6px 22px rgba(139,26,26,0.3)"}}>
                {generating?"⏳ 生成中...":"✨ シフトを自動生成する"}
              </button>
            )}
            {!gmMode&&loginStaff&&(
              <div style={{marginTop:14,padding:"13px 16px",borderRadius:12,background:"rgba(139,26,26,0.04)",border:"1px solid rgba(139,26,26,0.15)",fontSize:12,color:C.accent,textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                <div style={{width:7,height:7,borderRadius:4,background:C.accent}}/>
                入力内容は自動で保存されます
              </div>
            )}
          </div>
        )}

        {!gmMode&&!loginStaff&&(
          <div style={{textAlign:"center",padding:"80px 20px",color:C.muted}}>
            <div style={{width:80,height:80,borderRadius:40,background:"rgba(139,26,26,0.05)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:34,marginBottom:18,border:"1px solid rgba(139,26,26,0.1)"}}>👤</div>
            <div style={{fontSize:14}}>上のリストから名前を選んでください</div>
          </div>
        )}

        {/* ── ③ シフト表 */}
        {gmMode&&view==="result"&&(
          <div className="fi">
            {!result?(
              <div style={{textAlign:"center",padding:"80px 20px",color:C.muted}}>
                <div style={{width:80,height:80,borderRadius:40,background:"rgba(139,26,26,0.05)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:34,marginBottom:18,border:"1px solid rgba(139,26,26,0.1)"}}>📋</div>
                <div style={{marginBottom:20,fontSize:14}}>シフトがまだ生成されていません</div>
                <button onClick={()=>setView("slots")} style={{padding:"11px 28px",borderRadius:999,border:"none",background:"linear-gradient(135deg,#8b1a1a,#b8860b)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:800,boxShadow:"0 4px 14px rgba(139,26,26,0.3)"}}>夜枠を設定する</button>
              </div>
            ):(
              <div>
                <div style={{display:"flex",gap:8,marginBottom:16}}>
                  <button onClick={handleGenerate} style={{flex:1,padding:"12px",borderRadius:12,border:"1px solid rgba(139,26,26,0.2)",background:"rgba(139,26,26,0.04)",color:C.accent,cursor:"pointer",fontSize:13,fontWeight:700}}>
                    🔄 再生成
                  </button>
                  <button onClick={handleExport} disabled={exporting}
                    style={{flex:1,padding:"12px",borderRadius:12,border:"none",cursor:exporting?"wait":"pointer",fontSize:13,fontWeight:700,
                      background:exporting?"#f5f0eb":"linear-gradient(135deg,#1b2a5e,#8b1a1a)",
                      color:exporting?"#b0a090":"#fff",boxShadow:exporting?"none":"0 4px 14px rgba(27,42,94,0.3)"}}>
                    {exporting?"⏳ 出力中...":"📷 画像で保存"}
                  </button>
                </div>

                <div ref={shiftRef} style={{background:C.bg,padding:16,borderRadius:18}}>
                  <div style={{textAlign:"center",marginBottom:18}}>
                    <div style={{fontSize:10,letterSpacing:6,fontWeight:700,color:C.gold,marginBottom:4}}>🍶 旬菜いまり</div>
                    <div style={{fontSize:22,fontWeight:900,color:C.text}}>{year}年{month+1}月 シフト表</div>
                  </div>

                  <div style={{...card,marginBottom:16}}>
                    <div style={{fontSize:11,fontWeight:700,color:C.accent,marginBottom:12}}>勤務実績 / 候補ウェイト（達成率）</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                      {staff.map(s=>{
                        const w=result.worked[s.id]||0;
                        const c=result.candW[s.id]||0;
                        const pct=c>0?Math.round(w/c*100):0;
                        const avg=result.avgRate;
                        const dc=pct>avg?"#276749":pct<avg?"#c0392b":C.muted;
                        return(
                          <div key={s.id} style={{background:"#fdfaf6",borderRadius:12,padding:"10px 14px",textAlign:"center",border:`1px solid ${GRADE_COLOR[s.grade]}22`,minWidth:84}}>
                            <div style={{fontSize:10,fontWeight:700,color:GRADE_COLOR[s.grade]}}>{s.name}</div>
                            <div style={{fontSize:19,fontWeight:900,marginTop:4,color:C.text}}>{w}<span style={{fontSize:10,color:C.muted,fontWeight:400}}>/{c}</span></div>
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
                    const bc=totalS>0?"rgba(192,57,43,0.2)":warns.length?"rgba(184,134,11,0.2)":hol?"rgba(184,134,11,0.12)":dow===0?"rgba(192,57,43,0.1)":dow===6?"rgba(27,42,94,0.1)":"rgba(139,26,26,0.06)";
                    return(
                      <div key={d} style={{background:"#fff",borderRadius:14,border:`1px solid ${bc}`,padding:14,marginBottom:8,boxShadow:"0 1px 6px rgba(0,0,0,0.04)"}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8,flexWrap:"wrap"}}>
                          <span style={{fontWeight:900,fontSize:15,color:hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                            {month+1}/{d}（{DOW_JP[dow]}）{hol?"🎌":""}
                          </span>
                          {isSpec(year,month,d)&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(184,134,11,0.08)",color:"#b8860b",fontWeight:700,border:"1px solid rgba(184,134,11,0.2)"}}>特別夜</span>}
                          {totalS>0&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(192,57,43,0.08)",color:"#c0392b",fontWeight:700,border:"1px solid rgba(192,57,43,0.2)"}}>⚠ 不足{totalS}名</span>}
                          {warns.length>0&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(184,134,11,0.06)",color:"#b8860b",fontWeight:700,border:"1px solid rgba(184,134,11,0.18)"}}>⚡ 例外あり</span>}
                        </div>
                        {warns.length>0&&(
                          <div style={{marginBottom:8,padding:"8px 12px",background:"rgba(184,134,11,0.04)",borderRadius:10,border:"1px solid rgba(184,134,11,0.12)"}}>
                            {warns.map((w,i)=><div key={i} style={{fontSize:10,color:"#b8860b"}}>⚡ {w}</div>)}
                          </div>
                        )}
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          <SRow label="朝" time="7:00〜11:00" color="#b07d12"
                            people={day.morning.map(id=>staffMap[id]).filter(Boolean)} shortage={sh.morning||0}
                            candidates={staff.filter(s=>avail[s.id]?.[`${d}_morning`]&&!day.morning.includes(s.id))}/>
                          <SRow label="朝仕込" time="8:30〜16:00" color="#276749"
                            people={day.prep.map(id=>staffMap[id]).filter(Boolean)} shortage={sh.prep||0}
                            candidates={staff.filter(s=>avail[s.id]?.[`${d}_prep`]&&!day.prep.includes(s.id))}/>
                          {slots.map(t=>{
                            const p=day.night[t];
                            const nightCands=staff.filter(s=>s.id!==p&&NIGHT_TIMES.some(nt=>avail[s.id]?.[`${d}_night_${nt}`]&&nightCompat(nt,t)));
                            return <SRow key={t} label={`夜 ${t}〜`} time="" color={NIGHT_TC[t]} people={p?[staffMap[p]].filter(Boolean):[]} shortage={sh.night?.[t]||0} candidates={nightCands}/>;
                          })}
                          {aiOn&&<SRow label="アイサニ" time="ヘルプ" color={C.accent}
                            people={day.aisani?[staffMap[day.aisani]].filter(Boolean):[]} shortage={sh.aisani||0}
                            candidates={staff.filter(s=>s.aisaniOK&&avail[s.id]?.[`${d}_aisani`]&&s.id!==day.aisani)}/>}
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

function SRow({label,time,color,people,shortage=0,candidates=[]}){
  return(
    <div style={{display:"flex",flexDirection:"column",gap:3}}>
      <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
        <div style={{minWidth:70,fontSize:10,fontWeight:700,color,background:color+"18",borderRadius:999,padding:"3px 10px",textAlign:"center",flexShrink:0,border:`1px solid ${color}30`}}>{label}</div>
        {time&&<div style={{fontSize:9,color:"#8c7b6b",minWidth:76,flexShrink:0}}>{time}</div>}
        <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
          {people.map(s=>(
            <span key={s.id} style={{fontSize:12,padding:"4px 14px",borderRadius:999,background:"rgba(139,26,26,0.05)",color:"#1a0a00",fontWeight:700,border:"1px solid rgba(139,26,26,0.12)"}}>
              {s.name}
            </span>
          ))}
          {shortage>0&&(
            <span style={{fontSize:10,padding:"3px 10px",borderRadius:999,background:"rgba(192,57,43,0.08)",color:"#c0392b",fontWeight:700,border:"1px solid rgba(192,57,43,0.2)"}}>
              あと{shortage}名不足
            </span>
          )}
          {people.length===0&&shortage===0&&<span style={{fontSize:11,color:"rgba(139,26,26,0.15)"}}>—</span>}
        </div>
      </div>
      {candidates.length>0&&(
        <div style={{display:"flex",alignItems:"center",gap:5,paddingLeft:77,flexWrap:"wrap"}}>
          <span style={{fontSize:9,color:"#b0a090",flexShrink:0}}>候補：</span>
          {candidates.map(s=>(
            <span key={s.id} style={{fontSize:10,padding:"2px 10px",borderRadius:999,background:"rgba(139,26,26,0.03)",color:"#8c7b6b",border:"1px dashed rgba(139,26,26,0.15)"}}>
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
