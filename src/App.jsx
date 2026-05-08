import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { subscribeAll, saveKey, cleanupStaleKeys } from './firebase.js'

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
function generateShifts(staff, year, month, avail, nightSlotConfig, aisaniConfig, kitchenConfig) {
  const days = daysIn(year, month);
  const result  = {};
  const worked  = {};
  const workedMorning = {}; // 朝/夜バランス用
  const workedNight   = {};
  const workedDays    = {}; // 日数ベース達成率用
  const candDays      = {}; // 候補日数
  staff.forEach(s=>{ worked[s.id]=0; workedMorning[s.id]=0; workedNight[s.id]=0; workedDays[s.id]=new Set(); candDays[s.id]=0; });

  const isAvail = (sid,key) => !!avail[sid]?.[key];

  // 事前に候補日数を集計
  staff.forEach(s=>{
    for(let d=1;d<=days;d++){
      const hasAny=isAvail(s.id,`${d}_morning`)||isAvail(s.id,`${d}_prep`)||isAvail(s.id,`${d}_shimikomi`)||
        NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`))||
        (s.aisaniOK&&isAvail(s.id,`${d}_aisani`))||(s.kitchenOK&&isAvail(s.id,`${d}_kitchen`));
      if(hasAny) candDays[s.id]++;
    }
  });

  const pick = (candidates, count, opts={}) => {
    const { maxJunior=99, needSeniorIfJunior=false, balanceMode=null } = opts;
    const sorted = [...candidates].sort((a,b)=>{
      const wd = worked[a.id]-worked[b.id]; if(wd!==0) return wd;
      // 朝/夜バランス: 朝選出時は夜多め優先、夜選出時は朝多め優先
      if(balanceMode==='morning'){
        const da=(workedMorning[a.id]-workedNight[a.id]),db=(workedMorning[b.id]-workedNight[b.id]);
        if(da!==db) return da-db;
      } else if(balanceMode==='night'){
        const da=(workedNight[a.id]-workedMorning[a.id]),db=(workedNight[b.id]-workedMorning[b.id]);
        if(da!==db) return da-db;
      }
      const lo = {J:3,L:2,M:1,SM:0,GM:0}; return lo[a.grade]-lo[b.grade];
    });
    const res=[]; let nb=0;
    for(const s of sorted){
      if(res.length>=count) break;
      if(isJunior(s.grade)&&nb>=maxJunior) continue;
      res.push(s); if(isJunior(s.grade)) nb++;
    }
    if(needSeniorIfJunior&&res.some(s=>isJunior(s.grade))&&!res.some(s=>isSenior(s.grade))){
      const vet=candidates.find(s=>isSenior(s.grade)&&!res.includes(s));
      if(vet){ const ri=res.findLastIndex(s=>isMid(s.grade)); if(ri>=0) res[ri]=vet; else{ res.pop(); res.push(vet); } }
    }
    return res.slice(0,count);
  };

  const addWorked=(s,d,type)=>{ worked[s.id]++; workedDays[s.id].add(d); if(type==='morning') workedMorning[s.id]++; else if(type==='night') workedNight[s.id]++; };

  const shortage={}; const warnings={};

  const morningRisk=(d)=>{
    if(d>days||isClosed(year,month,d)) return false;
    const mc=staff.filter(s=>isAvail(s.id,`${d}_morning`)||isAvail(s.id,`${d}_prep`)).length;
    const pc=staff.filter(s=>isAvail(s.id,`${d}_prep`)||isAvail(s.id,`${d}_shimikomi`)).length;
    return mc<2||pc<1;
  };

  for(let d=1;d<=days;d++){
    if(isClosed(year,month,d)){
      const aiConf=aisaniConfig[d];
      let aisaniId=null,aisaniShortage=0;
      if(aiConf&&aiConf.enabled){
        const aiCands=staff.filter(s=>s.aisaniOK&&isAvail(s.id,`${d}_aisani`));
        const aiPick=pick(aiCands,1);
        aisaniId=aiPick[0]?.id||null;
        if(aiPick[0]) addWorked(aiPick[0],d,'aisani');
        aisaniShortage=aisaniId?0:1;
      }
      result[d]={morning:[],prep:[],night:{},aisani:aisaniId,kitchen:null};
      shortage[d]={morning:0,prep:0,night:{},aisani:aisaniShortage,kitchen:0};
      warnings[d]=[];
      continue;
    }
    const spec=isSpec(year,month,d);
    const dayR={morning:[],prep:[],night:{},aisani:null,kitchen:null};
    const dayS={morning:0,prep:0,night:{},aisani:0,kitchen:0};
    const dayW=[];
    const slots=nightSlotConfig[d]||[];

    const prevNight=new Set(d>1?Object.values(result[d-1]?.night||{}).filter(Boolean):[]);
    const nextDayRisk=morningRisk(d+1);

    // ── 仕込みスロット: 朝仕込み > 仕込みのみ > 仕込み夜 の優先で埋める
    const prepStrict=staff.filter(s=>isAvail(s.id,`${d}_prep`)&&!prevNight.has(s.id));
    const prepAll=staff.filter(s=>isAvail(s.id,`${d}_prep`));
    const shimikomiStrict=staff.filter(s=>isAvail(s.id,`${d}_shimikomi`)&&!prevNight.has(s.id));
    const shimikomiAll=staff.filter(s=>isAvail(s.id,`${d}_shimikomi`));
    const shimikomiOnlyAll=shimikomiAll.filter(s=>!NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`)));
    const shimikomiOnlyStrict=shimikomiStrict.filter(s=>!NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`)));
    const shimikomiNightAll=shimikomiAll.filter(s=>NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`)));
    const shimikomiNightStrict=shimikomiStrict.filter(s=>NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`)));

    let pPick=[];
    let morningTarget=3;
    let prepMode="none";

    if(prepAll.length>0){
      pPick=pick(prepStrict.length>=1?prepStrict:prepAll,1);
      morningTarget=2; prepMode="prep";
    } else if(shimikomiOnlyAll.length>0){
      pPick=pick(shimikomiOnlyStrict.length>=1?shimikomiOnlyStrict:shimikomiOnlyAll,1);
      morningTarget=3; prepMode="shimikomiOnly";
    } else if(shimikomiNightAll.length>0){
      pPick=pick(shimikomiNightStrict.length>=1?shimikomiNightStrict:shimikomiNightAll,1);
      morningTarget=3; prepMode="shimikomiNight";
    } else {
      morningTarget=3; prepMode="none";
    }

    if(pPick[0]&&prevNight.has(pPick[0].id)) dayW.push(`${pPick[0].name}：前日夜→仕込み（人手不足）`);
    dayR.prep=pPick.map(s=>s.id);
    pPick.forEach(s=>addWorked(s,d,'prep'));
    dayS.prep=Math.max(0,1-pPick.length);

    // ── 朝（morningTarget人）: 朝仕込み選択者も候補に含める
    const mStrict=staff.filter(s=>
      (isAvail(s.id,`${d}_morning`)||isAvail(s.id,`${d}_prep`))&&
      !dayR.prep.includes(s.id)&&!prevNight.has(s.id)
    );
    const mAll=staff.filter(s=>(isAvail(s.id,`${d}_morning`)||isAvail(s.id,`${d}_prep`))&&!dayR.prep.includes(s.id));
    const mCands=mStrict.length>=morningTarget?mStrict:mAll;
    const mPick=pick(mCands,morningTarget,{maxJunior:1,balanceMode:'morning'});
    mPick.forEach(s=>{ if(prevNight.has(s.id)) dayW.push(`${s.name}：前日夜→朝（人手不足）`); });
    dayR.morning=mPick.map(s=>s.id);
    mPick.forEach(s=>addWorked(s,d,'morning'));
    dayS.morning=Math.max(0,morningTarget-mPick.length);

    // ── キッチン（夜より先に確定・候補選択者のみ）
    const kitConf=kitchenConfig[d];
    if(kitConf&&kitConf.enabled){
      const alreadyMorning=new Set([...dayR.morning,...dayR.prep]);
      const kitCands=staff.filter(s=>s.kitchenOK&&isAvail(s.id,`${d}_kitchen`)&&!alreadyMorning.has(s.id));
      const kitPick=pick(kitCands,1);
      dayR.kitchen=kitPick[0]?.id||null;
      if(kitPick[0]) addWorked(kitPick[0],d,'kitchen');
      dayS.kitchen=kitPick[0]?0:1;
    }

    // ── 夜
    const shimikomiCanDoNight=prepMode==="shimikomiNight"&&mCands.length>=3;
    const prepW=shimikomiCanDoNight?new Set():new Set(dayR.prep);
    const morningW=new Set(dayR.morning);
    const kitchenW=new Set(dayR.kitchen?[dayR.kitchen]:[]);
    const assignedNight=new Set();
    const nightPickResults=[];

    const tomorrowMorningConfirmed=new Set();
    if(nextDayRisk&&d<days&&!isClosed(year,month,d+1)){
      staff.filter(s=>isAvail(s.id,`${d+1}_morning`)||isAvail(s.id,`${d+1}_prep`)||isAvail(s.id,`${d+1}_shimikomi`))
        .forEach(s=>tomorrowMorningConfirmed.add(s.id));
    }

    slots.forEach(slotTime=>{
      // 新人の低達成率判定（率≤40%の新人は特別夜もOK）
      const juniorLowRate=s=>isJunior(s.grade)&&candDays[s.id]>0&&(workedDays[s.id].size/candDays[s.id])<=0.4;

      const baseCands=(relaxJunior,relaxMorning)=>staff.filter(s=>{
        if(prepW.has(s.id)) return false;
        if(kitchenW.has(s.id)) return false;
        if(assignedNight.has(s.id)) return false;
        // SM/GMは翌日保護対象外（人手不足でも入れる）
        if(tomorrowMorningConfirmed.has(s.id)&&nextDayRisk&&!isSenior(s.grade)) return false;
        if(!relaxMorning&&morningW.has(s.id)) return false;
        // 朝夜連続は人手不足時のみ・M/SM/GM等級に限る（J・Lは不可）
        if(relaxMorning&&morningW.has(s.id)&&!(isMid(s.grade)||isSenior(s.grade))) return false;
        // 新人: 通常は特別夜NG、ただし達成率≤40%なら許可（ベテランと組ませるため）
        if(!relaxJunior&&isJunior(s.grade)&&spec&&!juniorLowRate(s)) return false;
        return NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`)&&nightCompat(t,slotTime));
      });

      const currentNightJuniors=[...assignedNight].filter(id=>isJunior(staffById_local(staff,id)?.grade));
      const nightHasJunior=currentNightJuniors.length>0;
      const maxJ=nightHasJunior?0:1;

      let nCands=baseCands(false,false);
      let relaxed="";
      if(!nCands.length){ nCands=baseCands(false,true); relaxed="朝夜連続"; }
      if(!nCands.length){ nCands=baseCands(true,false); relaxed="新人特別夜"; }
      if(!nCands.length){ nCands=baseCands(true,true); relaxed="朝夜連続+新人特別夜"; }

      const nPick=pick(nCands,1,{maxJunior:maxJ,needSeniorIfJunior:!nightHasJunior,balanceMode:'night'});
      if(nPick[0]){
        addWorked(nPick[0],d,'night');
        assignedNight.add(nPick[0].id);
        nightPickResults.push({slotTime,person:nPick[0],relaxed});
      } else {
        dayS.night[slotTime]=1;
      }
    });

    // 等級の高い順（GM>SM>M>L>J）に早い時間帯へ割り当て
    const sortedSlots=[...nightPickResults.map(r=>r.slotTime)].sort((a,b)=>NIGHT_ORDER.indexOf(a)-NIGHT_ORDER.indexOf(b));
    const sortedByGrade=[...nightPickResults].sort((a,b)=>GRADES.indexOf(b.person.grade)-GRADES.indexOf(a.person.grade));
    sortedSlots.forEach((slotTime,i)=>{
      const{person,relaxed}=sortedByGrade[i];
      dayR.night[slotTime]=person.id;
      dayS.night[slotTime]=0;
      if(relaxed){
        const r=[];
        if(morningW.has(person.id)) r.push("朝夜連続");
        if(isJunior(person.grade)&&spec) r.push("新人特別夜");
        if(r.length) dayW.push(`${person.name}：${r.join("・")}（人手不足）`);
      }
    });

    // ── アイサニ
    const aiConf=aisaniConfig[d];
    if(aiConf&&aiConf.enabled){
      const alreadyInNight=new Set(Object.values(dayR.night).filter(Boolean));
      const aiCands=staff.filter(s=>
        s.aisaniOK&&
        (isAvail(s.id,`${d}_aisani`)||NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`)))&&
        !dayR.morning.includes(s.id)&&!dayR.prep.includes(s.id)&&!alreadyInNight.has(s.id)
      );
      const aiPick=pick(aiCands,1);
      dayR.aisani=aiPick[0]?.id||null;
      if(aiPick[0]) addWorked(aiPick[0],d,'aisani');
      dayS.aisani=aiPick[0]?0:1;
    }

    result[d]=dayR;
    shortage[d]=dayS;
    warnings[d]=dayW;
  }

  // 日数ベース達成率
  const workedDaysCounts={};
  staff.forEach(s=>{ workedDaysCounts[s.id]=workedDays[s.id].size; });
  const totalW=staff.reduce((a,s)=>a+workedDays[s.id].size,0);
  const totalC=staff.reduce((a,s)=>a+candDays[s.id],0);
  const avgRate=totalC>0?Math.round(totalW/totalC*100):0;

  return {shifts:result,worked:workedDaysCounts,candW:candDays,shortage,warnings,avgRate,workedDays};
}

function staffById_local(staffArr,id){ return staffArr.find(s=>s.id===id); }

// result をFirebase保存用にシリアライズ（Sets除去、空配列を_EMPTYマーカー化）
function serializeResult(r){
  if(!r) return null;
  const shifts={};
  Object.entries(r.shifts||{}).forEach(([d,day])=>{
    if(!day){shifts[d]=day;return;}
    shifts[d]={
      ...day,
      morning:(day.morning&&day.morning.length)?day.morning:['_EMPTY_'],
      prep:(day.prep&&day.prep.length)?day.prep:['_EMPTY_'],
      night:day.night||{},
    };
  });
  const {workedDays,warnings,...rest}=r;
  return {...rest,shifts};
}
// Firebase/localStorage からロードした result を復元（全フィールドを保証）
function deserializeResult(r){
  try{
    if(!r||!r.shifts) return null;
    const shifts={};
    Object.entries(r.shifts).forEach(([d,day])=>{
      if(!day){shifts[d]=null;return;}
      shifts[d]={
        morning:Array.isArray(day.morning)?day.morning.filter(x=>x!=='_EMPTY_'):[],
        prep:Array.isArray(day.prep)?day.prep.filter(x=>x!=='_EMPTY_'):[],
        night:(day.night&&typeof day.night==='object')?day.night:{},
        aisani:day.aisani||null,
        kitchen:day.kitchen||null,
      };
    });
    return {
      shifts,
      worked:r.worked||{},
      candW:r.candW||{},
      shortage:r.shortage||{},
      warnings:r.warnings||{},
      avgRate:r.avgRate||0,
      workedDays:{},
    };
  }catch(_){ return null; }
}

// ── localStorage へ result を保存/復元
// ── 確定シフト serialize/deserialize（Firebase 空配列対策）
function serializeConfirmedShift(result, year, month) {
  if (!result) return null;
  const shifts = {};
  Object.entries(result.shifts || {}).forEach(([d, day]) => {
    if (!day) { shifts[d] = null; return; }
    shifts[d] = {
      morning: (day.morning && day.morning.length) ? day.morning : ['_EMPTY_'],
      prep:    (day.prep    && day.prep.length)    ? day.prep    : ['_EMPTY_'],
      night:   day.night || {},
      aisani:  day.aisani  ?? null,
      kitchen: day.kitchen ?? null,
    };
  });
  return { year, month, shifts };
}
function deserializeConfirmedShift(cs) {
  try {
    if (!cs || !cs.shifts) return null;
    const shifts = {};
    Object.entries(cs.shifts).forEach(([d, day]) => {
      if (!day) { shifts[d] = null; return; }
      shifts[d] = {
        morning: Array.isArray(day.morning) ? day.morning.filter(x => x !== '_EMPTY_') : [],
        prep:    Array.isArray(day.prep)    ? day.prep.filter(x => x !== '_EMPTY_')    : [],
        night:   (day.night && typeof day.night === 'object') ? day.night : {},
        aisani:  day.aisani  ?? null,
        kitchen: day.kitchen ?? null,
      };
    });
    return { year: cs.year, month: cs.month, shifts };
  } catch(_) { return null; }
}

const LS_KEY = 'imari_result';
function saveResultLS(r) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(serializeResult(r))); } catch(_) {}
}
function loadResultLS() {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) return deserializeResult(JSON.parse(s));
  } catch(_) {}
  return null;
}

// ══════════════════════════════════════════════════════
export default function App(){
  const now=new Date();
  const [year,setYear]=useState(now.getFullYear());
  const [month,setMonth]=useState(now.getMonth());
  const [staff,setStaff]=useState([
    {id:1,name:"田中 蓮",grade:"SM",aisaniOK:true,kitchenOK:false,password:""},
    {id:2,name:"佐藤 彩",grade:"SM",aisaniOK:true,kitchenOK:false,password:""},
    {id:3,name:"鈴木 翔",grade:"M",aisaniOK:false,kitchenOK:false,password:""},
    {id:4,name:"高橋 美咲",grade:"L",aisaniOK:false,kitchenOK:false,password:""},
    {id:5,name:"伊藤 大輝",grade:"J",aisaniOK:false,kitchenOK:false,password:""},
    {id:6,name:"渡辺 ひな",grade:"J",aisaniOK:false,kitchenOK:false,password:""},
  ]);
  const [avail,setAvail]=useState({});
  const [nightSlotConfig,setNightSlotConfig]=useState({});
  const [aisaniConfig,setAisaniConfig]=useState({});
  const [kitchenConfig,setKitchenConfig]=useState({});
  const [result,setResult]=useState(null);
  const [confirmedShift,setConfirmedShift]=useState(null);
  const [dayComments,setDayComments]=useState({});
  const [view,setView]=useState("slots"); // slots|avail|result
  const [gmMode,setGmMode]=useState(false);
  const [loginStaff,setLoginStaff]=useState(null);
  const [staffTab,setStaffTab]=useState("avail"); // avail|shift
  const [newStaff,setNewStaff]=useState({name:"",grade:"L",aisaniOK:false,kitchenOK:false,password:""});
  const [staffPwModal,setStaffPwModal]=useState(null); // パスワード確認中のスタッフ
  const [staffPwInput,setStaffPwInput]=useState("");
  const [staffPwError,setStaffPwError]=useState(false);
  const [staffPanelOpen,setStaffPanelOpen]=useState(false);
  const [generating,setGenerating]=useState(false);
  const [resultStaffFilter,setResultStaffFilter]=useState(null);
  const [exporting,setExporting]=useState(false);
  const shiftRef=useRef(null);

  const days=daysIn(year,month);
  const firstDow=getDow(year,month,1);
  const staffMap=useMemo(()=>{const m={};staff.forEach(s=>m[s.id]=s);return m;},[staff]);

  const prevMonth=()=>{if(month===0)updateYearMonth(year-1,11);else updateYearMonth(year,month-1);};
  const nextMonth=()=>{if(month===11)updateYearMonth(year+1,0);else updateYearMonth(year,month+1);};

  const toggleNightSlot=(d,time)=>{
    const cur=nightSlotConfig[d]||[];
    const next=cur.includes(time)?cur.filter(t=>t!==time):[...cur,time].sort();
    updateNightSlot({...nightSlotConfig,[d]:next});
  };
  const toggleAisani=(d)=>updateAisaniCfg({...aisaniConfig,[d]:{enabled:!aisaniConfig[d]?.enabled}});
  const toggleKitchen=(d)=>updateKitchenCfg({...kitchenConfig,[d]:{enabled:!kitchenConfig[d]?.enabled}});

  // 候補入力（GM: 任意のスタッフ, スタッフ: 自分のみ）
  const targetSid=gmMode?null:(loginStaff?.id);

  const toggleAvail=(sid,key)=>updateAvail({...avail,[sid]:{...(avail[sid]||{}),[key]:!avail[sid]?.[key]}});
  // 朝・朝仕込み・仕込みは排他選択: 1つをONにすると他2つをOFF
  const MORNING_TYPES=['morning','prep','shimikomi'];
  const toggleMorningTypeAvail=(sid,d,type)=>{
    const cur=avail[sid]||{};
    const key=`${d}_${type}`;
    const newVal=!cur[key];
    const next={...cur,[key]:newVal};
    if(newVal) MORNING_TYPES.forEach(t=>{if(t!==type) next[`${d}_${t}`]=false;});
    updateAvail({...avail,[sid]:next});
  };
  const setAllMorningTypeAvail=(sid,type)=>{
    const cur=avail[sid]||{};const next={...cur};
    for(let d=1;d<=days;d++){
      if(isClosed(year,month,d)) continue;
      next[`${d}_${type}`]=true;
      MORNING_TYPES.forEach(t=>{if(t!==type) next[`${d}_${t}`]=false;});
    }
    updateAvail({...avail,[sid]:next});
  };
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

  const swapShiftAssignment=useCallback((d,slotType,slotTime,newId,removeId=null)=>{
    let nextToSave=null;
    setResult(prev=>{
      if(!prev) return prev;
      const newShifts={...prev.shifts};
      const dayShift={...newShifts[d],night:{...(newShifts[d]?.night||{})}};
      let oldId=null;
      if(slotType==='night'){
        oldId=dayShift.night[slotTime]||null;
        dayShift.night[slotTime]=newId;
      } else if(slotType==='aisani'){
        oldId=dayShift.aisani; dayShift.aisani=newId;
      } else if(slotType==='kitchen'){
        oldId=dayShift.kitchen; dayShift.kitchen=newId;
      } else if(slotType==='prep'){
        if(removeId){
          oldId=removeId; dayShift.prep=[];
        } else {
          oldId=dayShift.prep[0]||null; dayShift.prep=newId?[newId]:[];
        }
      } else if(slotType==='morning'){
        if(removeId){
          oldId=removeId; dayShift.morning=dayShift.morning.filter(id=>id!==removeId);
        } else {
          if(newId&&dayShift.morning.includes(newId)) return prev;
          const arr=[...dayShift.morning];
          if(arr.length<3){
            if(newId) arr.push(newId);
          } else {
            const ri=arr.reduce((mi,id,i)=>(prev.worked[id]||0)>(prev.worked[arr[mi]]||0)?i:mi,0);
            oldId=arr[ri]; if(newId) arr[ri]=newId; else arr.splice(ri,1);
          }
          dayShift.morning=arr;
        }
      }
      if(!removeId&&oldId===newId) return prev;
      newShifts[d]=dayShift;
      // workedDaysを全シフトから再計算
      const wd={};
      staff.forEach(s=>{wd[s.id]=new Set();});
      Object.entries(newShifts).forEach(([ds,sh])=>{
        const dd=Number(ds);
        [...(sh.morning||[]),...(sh.prep||[])].forEach(id=>{if(wd[id]) wd[id].add(dd);});
        Object.values(sh.night||{}).filter(Boolean).forEach(id=>{if(wd[id]) wd[id].add(dd);});
        if(sh.aisani&&wd[sh.aisani]) wd[sh.aisani].add(dd);
        if(sh.kitchen&&wd[sh.kitchen]) wd[sh.kitchen].add(dd);
      });
      const newWorked={};
      staff.forEach(s=>{newWorked[s.id]=wd[s.id].size;});
      // shortageも更新
      const newShortage={...prev.shortage,[d]:{...(prev.shortage[d]||{})}};
      if(slotType==='night') newShortage[d]={...newShortage[d],night:{...(newShortage[d]?.night||{}),[slotTime]:(newId&&!removeId)?0:1}};
      else if(slotType==='aisani') newShortage[d]={...newShortage[d],aisani:(newId&&!removeId)?0:1};
      else if(slotType==='kitchen') newShortage[d]={...newShortage[d],kitchen:(newId&&!removeId)?0:1};
      else if(slotType==='prep') newShortage[d]={...newShortage[d],prep:(dayShift.prep.length>0)?0:1};
      else if(slotType==='morning') newShortage[d]={...newShortage[d],morning:Math.max(0,(prev.shortage[d]?.morning||0)+(removeId?1:0)-(newId&&!removeId?1:0))};
      const totalW=staff.reduce((a,s)=>a+wd[s.id].size,0);
      const totalC=staff.reduce((a,s)=>a+(prev.candW[s.id]||0),0);
      const newAvgRate=totalC>0?Math.round(totalW/totalC*100):0;
      const next={...prev,shifts:newShifts,worked:newWorked,workedDays:wd,shortage:newShortage,avgRate:newAvgRate};
      saveResultLS(next);
      nextToSave=next;
      return next;
    });
    if(nextToSave){
      const ser=serializeResult(nextToSave);
      clearTimeout(saveTimers.current['resultBackup']);
      saveTimers.current['resultBackup']=setTimeout(()=>saveKey('resultBackup',ser).catch(()=>{}),800);
    }
  },[staff]);

  const handleGenerate=()=>{
    setGenerating(true);
    setTimeout(()=>{
      const r=generateShifts(staff,year,month,avail,nightSlotConfig,aisaniConfig,kitchenConfig);
      setResult(r);saveResultLS(r);setView("result");setGenerating(false);
      saveKey('resultBackup',serializeResult(r)).catch(()=>{});
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
  const ymRef=useRef(`${year}_${month}`);
  ymRef.current=`${year}_${month}`;

  // ── Firebase 起動時クリーンアップ + リアルタイム購読
  useEffect(()=>{
    cleanupStaleKeys();
    const unsub=subscribeAll((data)=>{
      if(data.staff&&Array.isArray(data.staff)&&!pendingKeys.current.has('staff')) setStaff(data.staff);
      if(data.avail          &&!pendingKeys.current.has('avail'))          setAvail(data.avail);
      if(data.yearMonth      &&!pendingKeys.current.has('yearMonth'))      {setYear(data.yearMonth.y);setMonth(data.yearMonth.m);}
      // Firebase の yearMonth を基準に _ym チェック（setYear/setMonth は非同期なので ymRef は使わない）
      const fbYm=data.yearMonth?`${data.yearMonth.y}_${data.yearMonth.m}`:ymRef.current;
      if(data.aisaniConfig&&!pendingKeys.current.has('aisaniConfig')){
        const{_ym,...cfg}=data.aisaniConfig;
        if(_ym===fbYm) setAisaniConfig(cfg); else setAisaniConfig({});
      }
      if(data.kitchenConfig&&!pendingKeys.current.has('kitchenConfig')){
        const{_ym,...cfg}=data.kitchenConfig;
        if(_ym===fbYm) setKitchenConfig(cfg); else setKitchenConfig({});
      }
      if(data.nightSlotConfig&&!pendingKeys.current.has('nightSlotConfig')){
        const{_ym,...slots}=data.nightSlotConfig;
        if(_ym===fbYm) setNightSlotConfig(slots);
        else setNightSlotConfig({});
      }
      if(data.dayComments&&!pendingKeys.current.has('dayComments')){
        const{_ym,...comments}=data.dayComments;
        if(_ym===fbYm) setDayComments(comments);
        else setDayComments({});
      }
      if(data.confirmedShift){
        const cs=deserializeConfirmedShift(data.confirmedShift);
        setConfirmedShift(cs||null);
      } else {
        setConfirmedShift(null);
      }
      if(!resultLoadedRef.current&&data.resultBackup){
        const restored=deserializeResult(data.resultBackup);
        if(restored){setResult(restored);saveResultLS(restored);resultLoadedRef.current=true;}
      }
      setLoading(false);
    });
    const t=setTimeout(()=>setLoading(false),5000);
    return()=>{unsub();clearTimeout(t);};
  },[]);

  // ── localStorage から result を復元、空なら Firebase バックアップから取得
  const resultLoadedRef=useRef(false);
  useEffect(()=>{
    const r=loadResultLS();
    if(r){setResult(r);resultLoadedRef.current=true;}
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
  const updateNightSlot=val=>{
    setNightSlotConfig(val);
    debounceSave('nightSlotConfig',{_ym:ymRef.current,...val});
  };
  const updateAisaniCfg=val=>{setAisaniConfig(val);debounceSave('aisaniConfig',{_ym:ymRef.current,...val});};
  const updateKitchenCfg=val=>{setKitchenConfig(val);debounceSave('kitchenConfig',{_ym:ymRef.current,...val});};
  const updateYearMonth=(y,m)=>{
    setYear(y);setMonth(m);debounceSave('yearMonth',{y,m});
    setNightSlotConfig({});setDayComments({});setResult(null);
  };
  const updateDayComments=val=>{
    setDayComments(val);
    debounceSave('dayComments',{_ym:ymRef.current,...val});
  };
  const dismissShortage=useCallback((d,slotType,slotTime=null)=>{
    let nextToSave=null;
    setResult(prev=>{
      if(!prev) return prev;
      const newShortage={...prev.shortage,[d]:{...(prev.shortage[d]||{})}};
      if(slotType==='night') newShortage[d]={...newShortage[d],night:{...(newShortage[d]?.night||{}),[slotTime]:0}};
      else newShortage[d]={...newShortage[d],[slotType]:0};
      const next={...prev,shortage:newShortage};
      saveResultLS(next);
      nextToSave=next;
      return next;
    });
    if(nextToSave){
      const ser=serializeResult(nextToSave);
      clearTimeout(saveTimers.current['resultBackup']);
      saveTimers.current['resultBackup']=setTimeout(()=>saveKey('resultBackup',ser).catch(()=>{}),800);
    }
  },[]);
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
                <button onClick={()=>{if(gmMode)return;setPwModal(true);}} style={{...btn(gmMode,"linear-gradient(135deg,#8b1a1a,#b8860b)"),fontSize:11,padding:"5px 14px",borderRadius:999}}>管理者</button>
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
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8,paddingBottom:8}}>
                <div style={{width:7,height:7,borderRadius:4,background:C.accent,boxShadow:`0 0 6px ${C.accent}`}}/>
                <span style={{fontSize:11,color:C.muted}}>ログイン中：</span>
                <span style={{fontWeight:800,fontSize:13}}>{loginStaff.name}</span>
                <button onClick={()=>setLoginStaff(null)} style={{...btn(false),fontSize:10,padding:"3px 10px"}}>変更</button>
              </div>
              <div style={{display:"flex",gap:3,background:"rgba(139,26,26,0.04)",borderRadius:13,padding:3,border:"1px solid rgba(139,26,26,0.08)"}}>
                {[["avail","📅 候補日入力"],["shift","📋 自分のシフト"],["full","📆 全体シフト"]].map(([v,l])=>(
                  <button key={v} onClick={()=>setStaffTab(v)}
                    style={{flex:1,padding:"9px 4px",borderRadius:11,border:"none",cursor:"pointer",fontSize:12,fontWeight:700,transition:"all .2s",
                      background:staffTab===v?"linear-gradient(135deg,#8b1a1a,#b8860b)":"transparent",
                      color:staffTab===v?"#fff":C.muted,
                      boxShadow:staffTab===v?"0 2px 10px rgba(139,26,26,0.25)":"none"}}>
                    {l}
                  </button>
                ))}
              </div>
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
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:C.muted,cursor:"pointer"}}>
                <input type="checkbox" checked={newStaff.kitchenOK} onChange={e=>setNewStaff(p=>({...p,kitchenOK:e.target.checked}))}/>キッチンOK
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
                  <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:s.kitchenOK?"#276749":C.muted,cursor:"pointer"}}>
                    <input type="checkbox" checked={!!s.kitchenOK} onChange={e=>updateStaff(staff.map(x=>x.id===s.id?{...x,kitchenOK:e.target.checked}:x))}/>キッチン
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
                const kitOn=kitchenConfig[d]?.enabled;
                const active=slots.length>0||aiOn||kitOn;
                return(
                  <div key={d} style={{borderRadius:12,padding:"5px 3px",transition:"all .2s",
                    background:closed?(aiOn?"rgba(139,26,26,0.05)":"#f5f0eb"):active?"rgba(139,26,26,0.05)":"#fff",
                    border:`1px solid ${closed?(aiOn?"rgba(139,26,26,0.25)":"rgba(139,26,26,0.06)"):active?"rgba(139,26,26,0.25)":hol?"rgba(184,134,11,0.2)":dow===0?"rgba(192,57,43,0.18)":dow===6?"rgba(27,42,94,0.15)":"rgba(139,26,26,0.08)"}`,
                    minHeight:74,opacity:closed&&!aiOn?0.35:1,
                    boxShadow:active||aiOn?"0 2px 10px rgba(139,26,26,0.1)":"0 1px 4px rgba(0,0,0,0.04)"}}>
                    <div style={{textAlign:"center",fontSize:11,fontWeight:800,marginBottom:3,
                      color:closed?"#b0a090":hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                      {d}{hol?"🎌":""}{closed?"🔒":""}
                    </div>
                    {!closed&&(
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
                    )}
                    <div style={{display:"flex",gap:2,justifyContent:"center"}}>
                      <button onClick={()=>toggleAisani(d)}
                        style={{padding:"2px 5px",borderRadius:5,border:"none",cursor:"pointer",fontSize:7,fontWeight:800,
                          background:aiOn?"#8b1a1a":"rgba(139,26,26,0.07)",color:aiOn?"#fff":"#8c7b6b",
                          transition:"all .15s"}}>
                        アイサニ
                      </button>
                      {!closed&&(
                        <button onClick={()=>toggleKitchen(d)}
                          style={{padding:"2px 5px",borderRadius:5,border:"none",cursor:"pointer",fontSize:7,fontWeight:800,
                            background:kitOn?"#276749":"rgba(39,103,73,0.08)",color:kitOn?"#fff":"#8c7b6b",
                            transition:"all .15s"}}>
                          キッチン
                        </button>
                      )}
                    </div>
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
        {(gmMode?view==="avail":(!gmMode&&loginStaff&&staffTab==="avail"))&&(
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
                      {label:"朝 全ON",color:"#b07d12",onClick:()=>setAllMorningTypeAvail(sid,"morning")},
                      {label:"朝仕込 全ON",color:"#276749",onClick:()=>setAllMorningTypeAvail(sid,"prep")},
                      {label:"仕込み 全ON",color:"#5b7fa6",onClick:()=>setAllMorningTypeAvail(sid,"shimikomi")},
                      ...NIGHT_TIMES.map(t=>({label:`夜${t} 全ON`,color:NIGHT_TC[t],onClick:()=>setAllAvail(sid,`night_${t}`,true)})),
                      ...(availViewStaff.aisaniOK?[{label:"アイサニ 全ON",color:C.accent,onClick:()=>setAllAvail(sid,"aisani",true)}]:[]),
                      ...(availViewStaff.kitchenOK?[{label:"厨房 全ON",color:"#276749",onClick:()=>setAllAvail(sid,"kitchen",true)}]:[]),
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
                          <th className="sth" style={{fontSize:10,color:"#5b7fa6",fontWeight:700,padding:"9px 4px",textAlign:"center",background:"#fff"}}>仕込み</th>
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
                          {availViewStaff.kitchenOK&&(
                            <th className="sth" style={{fontSize:10,color:"#276749",fontWeight:700,padding:"9px 4px",textAlign:"center",background:"#fff"}}>
                              キッチン
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
                                <>
                                  <td colSpan={3+NIGHT_TIMES.length+(availViewStaff.kitchenOK?1:0)} style={{background:rowBg,textAlign:"center",fontSize:10,color:"#b0a090",padding:"6px"}}>定休日</td>
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
                              ):(
                                <>
                                  {(()=>{
                                    const anyMorningOn=MORNING_TYPES.some(t=>!!a[`${d}_${t}`]);
                                    return MORNING_TYPES.map(type=>{
                                      const on=!!a[`${d}_${type}`];
                                      const locked=anyMorningOn&&!on;
                                      const col=type==="morning"?"#b07d12":type==="prep"?"#276749":"#5b7fa6";
                                      return(
                                        <td key={type} style={{background:rowBg,textAlign:"center",padding:"3px 5px"}}>
                                          <button onClick={()=>toggleMorningTypeAvail(sid,d,type)}
                                            style={{width:34,height:28,borderRadius:8,
                                              border:on?"none":`1px solid ${col}90`,
                                              cursor:"pointer",fontSize:13,fontWeight:800,
                                              background:on?col:"rgba(139,26,26,0.03)",
                                              color:on?"#fff":col+"99",
                                              boxShadow:on?`0 2px 8px ${col}44`:"none",
                                              transition:"all .15s",opacity:locked?0.22:1}}>
                                            {on?"✓":""}
                                          </button>
                                        </td>
                                      );
                                    });
                                  })()}
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
                                  {availViewStaff.kitchenOK&&(
                                    <td style={{background:rowBg,textAlign:"center",padding:"3px 3px"}}>
                                      {kitchenConfig[d]?.enabled?(
                                        <button onClick={()=>toggleAvail(sid,`${d}_kitchen`)}
                                          style={{width:34,height:28,borderRadius:8,border:!!a[`${d}_kitchen`]?"none":"1px solid #27674990",cursor:"pointer",fontSize:13,fontWeight:800,transition:"all .15s",
                                            background:!!a[`${d}_kitchen`]?"#276749":"rgba(39,103,73,0.04)",
                                            color:!!a[`${d}_kitchen`]?"#fff":"#27674999",
                                            boxShadow:!!a[`${d}_kitchen`]?"0 2px 8px #27674944":"none"}}>
                                          {!!a[`${d}_kitchen`]?"✓":""}
                                        </button>
                                      ):(
                                        <div style={{width:34,height:28,borderRadius:8,background:"rgba(39,103,73,0.02)",margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                          <span style={{fontSize:9,color:"rgba(39,103,73,0.15)"}}>—</span>
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
                  <div style={{marginTop:8,fontSize:10,color:C.muted,opacity:.5}}>— は枠未設定 ／ 夜は1日1枠のみ選択可</div>
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

        {/* ── スタッフ 自分のシフト表示 */}
        {!gmMode&&loginStaff&&staffTab==="shift"&&(()=>{
          if(!confirmedShift) return(
            <div style={{...card,marginTop:16,textAlign:"center",padding:"48px 20px"}}>
              <div style={{fontSize:36,marginBottom:14}}>📋</div>
              <div style={{fontSize:14,color:C.muted}}>まだシフトが公開されていません</div>
              <div style={{fontSize:11,color:C.muted,marginTop:6,opacity:.7}}>管理者がシフトを公開すると表示されます</div>
            </div>
          );
          const sid=loginStaff.id;
          const csYear=confirmedShift.year;
          const csMonth=confirmedShift.month;
          const myDays=[];
          const csdays=daysIn(csYear,csMonth);
          for(let d=1;d<=csdays;d++){
            const day=confirmedShift.shifts[d];
            if(!day) continue;
            const inMorning=day.morning?.includes(sid)||day.morning?.includes(Number(sid));
            const inPrep=day.prep?.includes(sid)||day.prep?.includes(Number(sid));
            const inNight=day.night&&Object.values(day.night).some(id=>id===sid||Number(id)===sid);
            const inAisani=day.aisani===sid||Number(day.aisani)===sid;
            const inKitchen=day.kitchen===sid||Number(day.kitchen)===sid;
            if(!inMorning&&!inPrep&&!inNight&&!inAisani&&!inKitchen) continue;
            const groups=[];
            if(inMorning||inPrep){
              const morningMembers=[];
              (day.morning||[]).forEach(id=>{const s=staffMap[id]||staffMap[Number(id)];if(s) morningMembers.push({person:s,time:"朝（7:00〜11:00）"});});
              (day.prep||[]).forEach(id=>{const s=staffMap[id]||staffMap[Number(id)];if(s) morningMembers.push({person:s,time:"朝仕込み（8:30〜16:00）"});});
              groups.push({label:"朝・朝仕込み",color:"#f97316",night:true,members:morningMembers});
            }
            if(inNight){
              const nightMembers=[];
              NIGHT_ORDER.forEach(t=>{const id=day.night[t];if(id!=null){const s=staffMap[id]||staffMap[Number(id)];if(s) nightMembers.push({person:s,time:t});}});
              groups.push({label:"夜",color:"#3b82f6",night:true,members:nightMembers});
            }
            if(inAisani){const s=staffMap[day.aisani]||staffMap[Number(day.aisani)];groups.push({label:"アイサニ",color:"#10b981",members:s?[s]:[]});}
            if(inKitchen){const s=staffMap[day.kitchen]||staffMap[Number(day.kitchen)];groups.push({label:"キッチン",color:"#276749",members:s?[s]:[]});}
            myDays.push({d,dow:getDow(csYear,csMonth,d),groups});
          }
          return(
            <div style={{...card,marginTop:16}}>
              <div style={{fontWeight:900,fontSize:14,color:"#276749",marginBottom:12}}>
                📋 {csYear}年{csMonth+1}月 自分のシフト
              </div>
              {myDays.length===0?(
                <div style={{textAlign:"center",color:C.muted,fontSize:13,padding:"20px 0"}}>シフトが割り当てられていません</div>
              ):(
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {myDays.map(({d,dow,groups})=>(
                    <div key={d} style={{borderRadius:12,background:"#fdfaf6",border:"1px solid rgba(39,103,73,0.12)",overflow:"hidden"}}>
                      <div style={{padding:"8px 14px",background:"rgba(39,103,73,0.06)",borderBottom:"1px solid rgba(39,103,73,0.1)",fontWeight:900,fontSize:14,color:dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                        {d}日<span style={{fontSize:11,marginLeft:4,fontWeight:600,color:C.muted}}>({DOW_JP[dow]})</span>
                      </div>
                      <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:10}}>
                        {groups.map((g,gi)=>(
                          <div key={gi}>
                            <div style={{fontSize:10,fontWeight:700,color:g.color,marginBottom:5,letterSpacing:.5}}>{g.label}</div>
                            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                              {g.night
                                ? g.members.map(({person,time},i)=>(
                                    <span key={i} style={{fontSize:12,fontWeight:700,padding:"4px 11px",borderRadius:999,
                                      background:(person.id===sid||Number(person.id)===sid)?g.color:"rgba(59,130,246,0.08)",
                                      color:(person.id===sid||Number(person.id)===sid)?"#fff":C.text,
                                      border:`1px solid ${g.color}${(person.id===sid||Number(person.id)===sid)?"":"30"}`}}>
                                      {time} {person.name}
                                    </span>
                                  ))
                                : g.members.map((person,i)=>(
                                    <span key={i} style={{fontSize:12,fontWeight:700,padding:"4px 11px",borderRadius:999,
                                      background:(person.id===sid||Number(person.id)===sid)?g.color:"rgba(0,0,0,0.04)",
                                      color:(person.id===sid||Number(person.id)===sid)?"#fff":C.text,
                                      border:`1px solid ${g.color}${(person.id===sid||Number(person.id)===sid)?"":"20"}`}}>
                                      {person.name}
                                    </span>
                                  ))
                              }
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── スタッフ 全体シフト表示 */}
        {!gmMode&&loginStaff&&staffTab==="full"&&(()=>{
          if(!confirmedShift) return(
            <div style={{...card,marginTop:16,textAlign:"center",padding:"48px 20px"}}>
              <div style={{fontSize:36,marginBottom:14}}>📆</div>
              <div style={{fontSize:14,color:C.muted}}>まだシフトが公開されていません</div>
              <div style={{fontSize:11,color:C.muted,marginTop:6,opacity:.7}}>管理者がシフトを公開すると表示されます</div>
            </div>
          );
          const csYear=confirmedShift.year;
          const csMonth=confirmedShift.month;
          const csdays=daysIn(csYear,csMonth);
          const sid=loginStaff.id;
          return(
            <div style={{marginTop:16}}>
              <div style={{textAlign:"center",marginBottom:14}}>
                <div style={{fontSize:10,letterSpacing:6,fontWeight:700,color:C.gold,marginBottom:4}}>🍶 旬菜いまり</div>
                <div style={{fontSize:20,fontWeight:900,color:C.text}}>{csYear}年{csMonth+1}月 シフト表</div>
              </div>
              {Array.from({length:csdays},(_,i)=>i+1).map(d=>{
                const dow=getDow(csYear,csMonth,d),hol=isHol(csYear,csMonth,d);
                const closed=isClosed(csYear,csMonth,d);
                const day=confirmedShift.shifts[d];
                if(!day&&closed) return null;
                const nightEntries=day?Object.entries(day.night||{}).filter(([,id])=>id!=null).sort(([a],[b])=>NIGHT_ORDER.indexOf(a)-NIGHT_ORDER.indexOf(b)):[];
                const hasAisani=day&&day.aisani!=null;
                const hasKitchen=day&&day.kitchen!=null;
                if(!day&&!closed) return null;
                const myDay=day&&([...(day.morning||[]),...(day.prep||[])].some(id=>id===sid||Number(id)===sid)||
                  Object.values(day.night||{}).some(id=>id===sid||Number(id)===sid)||
                  day.aisani===sid||Number(day.aisani)===sid||day.kitchen===sid||Number(day.kitchen)===sid);
                const bc=myDay?"rgba(139,26,26,0.12)":hol?"rgba(184,134,11,0.08)":dow===0?"rgba(192,57,43,0.06)":dow===6?"rgba(27,42,94,0.06)":"rgba(139,26,26,0.04)";
                const borderCol=myDay?C.accent:hol?"#b8860b40":dow===0?"#c0392b30":dow===6?"#1b2a5e30":"rgba(139,26,26,0.1)";
                return(
                  <div key={d} style={{background:"#fff",borderRadius:14,border:`1.5px solid ${borderCol}`,padding:"12px 14px",marginBottom:8,boxShadow:myDay?"0 2px 10px rgba(139,26,26,0.1)":"0 1px 4px rgba(0,0,0,0.03)"}}>
                    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:closed?0:10,flexWrap:"wrap"}}>
                      <span style={{fontWeight:900,fontSize:15,color:hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                        {csMonth+1}/{d}（{DOW_JP[dow]}）{hol?"🎌":""}
                      </span>
                      {closed&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(139,26,26,0.06)",color:C.muted,fontWeight:700,border:"1px solid rgba(139,26,26,0.12)"}}>定休日</span>}
                      {myDay&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(139,26,26,0.08)",color:C.accent,fontWeight:700,border:`1px solid ${C.accent}30`}}>出勤</span>}
                      {dayComments[d]&&<span style={{fontSize:10,color:"#b8860b",marginLeft:4}}>📝 {dayComments[d]}</span>}
                    </div>
                    {!closed&&day&&(
                      <div style={{display:"flex",flexDirection:"column",gap:5}}>
                        {(day.morning||[]).length>0&&(
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:700,color:"#b07d12",background:"#b07d1218",borderRadius:999,padding:"3px 10px",border:"1px solid #b07d1230",minWidth:60,textAlign:"center",flexShrink:0}}>朝</span>
                            <span style={{fontSize:9,color:C.muted,flexShrink:0}}>7:00〜11:00</span>
                            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                              {(day.morning||[]).map(id=>{const s=staffMap[id]||staffMap[Number(id)];return s?(
                                <span key={id} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                                  background:(id===sid||Number(id)===sid)?C.accent:"rgba(176,125,18,0.08)",
                                  color:(id===sid||Number(id)===sid)?"#fff":"#b07d12",
                                  border:`1px solid ${(id===sid||Number(id)===sid)?C.accent:"#b07d1230"}`}}>{s.name}</span>
                              ):null;})}
                            </div>
                          </div>
                        )}
                        {(day.prep||[]).length>0&&(
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:700,color:"#276749",background:"#27674918",borderRadius:999,padding:"3px 10px",border:"1px solid #27674930",minWidth:60,textAlign:"center",flexShrink:0}}>朝仕込み</span>
                            <span style={{fontSize:9,color:C.muted,flexShrink:0}}>8:30〜16:00</span>
                            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                              {(day.prep||[]).map(id=>{const s=staffMap[id]||staffMap[Number(id)];return s?(
                                <span key={id} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                                  background:(id===sid||Number(id)===sid)?C.accent:"rgba(39,103,73,0.08)",
                                  color:(id===sid||Number(id)===sid)?"#fff":"#276749",
                                  border:`1px solid ${(id===sid||Number(id)===sid)?C.accent:"#27674930"}`}}>{s.name}</span>
                              ):null;})}
                            </div>
                          </div>
                        )}
                        {nightEntries.map(([t,id])=>{const s=staffMap[id]||staffMap[Number(id)];return s?(
                          <div key={t} style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:700,color:NIGHT_TC[t],background:NIGHT_TC[t]+"18",borderRadius:999,padding:"3px 10px",border:`1px solid ${NIGHT_TC[t]}30`,minWidth:60,textAlign:"center",flexShrink:0}}>夜 {t}</span>
                            <span key={id} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                              background:(id===sid||Number(id)===sid)?NIGHT_TC[t]:"rgba(0,0,0,0.04)",
                              color:(id===sid||Number(id)===sid)?"#fff":C.text,
                              border:`1px solid ${(id===sid||Number(id)===sid)?NIGHT_TC[t]:"rgba(0,0,0,0.1)"}`}}>{s.name}</span>
                          </div>
                        ):null;})}
                        {hasAisani&&(()=>{const s=staffMap[day.aisani]||staffMap[Number(day.aisani)];return s?(
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontSize:10,fontWeight:700,color:C.accent,background:C.accent+"18",borderRadius:999,padding:"3px 10px",border:`1px solid ${C.accent}30`,minWidth:60,textAlign:"center",flexShrink:0}}>アイサニ</span>
                            <span style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                              background:(day.aisani===sid||Number(day.aisani)===sid)?C.accent:"rgba(139,26,26,0.06)",
                              color:(day.aisani===sid||Number(day.aisani)===sid)?"#fff":C.text,
                              border:`1px solid ${(day.aisani===sid||Number(day.aisani)===sid)?C.accent:"rgba(139,26,26,0.15)"}`}}>{s.name}</span>
                          </div>
                        ):null;})()}
                        {hasKitchen&&(()=>{const s=staffMap[day.kitchen]||staffMap[Number(day.kitchen)];return s?(
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontSize:10,fontWeight:700,color:"#276749",background:"#27674918",borderRadius:999,padding:"3px 10px",border:"1px solid #27674930",minWidth:60,textAlign:"center",flexShrink:0}}>キッチン</span>
                            <span style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                              background:(day.kitchen===sid||Number(day.kitchen)===sid)?"#276749":"rgba(39,103,73,0.06)",
                              color:(day.kitchen===sid||Number(day.kitchen)===sid)?"#fff":C.text,
                              border:`1px solid ${(day.kitchen===sid||Number(day.kitchen)===sid)?"#276749":"#27674930"}`}}>{s.name}</span>
                          </div>
                        ):null;})()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

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
                <div style={{display:"flex",gap:8,marginBottom:16}}>
                  <button onClick={()=>{
                    const cs=serializeConfirmedShift(result,year,month);
                    if(cs){saveKey('confirmedShift',cs);setConfirmedShift(deserializeConfirmedShift(cs));alert(`${year}年${month+1}月のシフトを公開しました`);}
                  }} style={{flex:1,padding:"13px",borderRadius:12,border:"none",cursor:"pointer",fontSize:13,fontWeight:900,background:"linear-gradient(135deg,#276749,#1a4731)",color:"#fff",boxShadow:"0 4px 14px rgba(39,103,73,0.3)"}}>
                    ✅ シフトを公開
                  </button>
                  {confirmedShift&&(
                    <button onClick={()=>{
                      if(window.confirm("公開中のシフトを取り消しますか？スタッフ側から非表示になります。")){
                        saveKey('confirmedShift',null);setConfirmedShift(null);
                      }
                    }} style={{flex:1,padding:"13px",borderRadius:12,border:"1px solid rgba(192,57,43,0.3)",cursor:"pointer",fontSize:13,fontWeight:900,background:"rgba(192,57,43,0.06)",color:"#c0392b"}}>
                      ✕ 公開を取り消す
                    </button>
                  )}
                </div>

                <div ref={shiftRef} style={{background:C.bg,padding:16,borderRadius:18}}>
                  <div style={{textAlign:"center",marginBottom:18}}>
                    <div style={{fontSize:10,letterSpacing:6,fontWeight:700,color:C.gold,marginBottom:4}}>🍶 旬菜いまり</div>
                    <div style={{fontSize:22,fontWeight:900,color:C.text}}>{year}年{month+1}月 シフト表</div>
                  </div>

                  <div style={{...card,marginBottom:16}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:6}}>
                      <div style={{fontSize:11,fontWeight:700,color:C.accent}}>勤務実績 / 候補日数（達成率）</div>
                      {resultStaffFilter&&<button onClick={()=>setResultStaffFilter(null)} style={{...btn(false),fontSize:10,padding:"4px 12px"}}>全員表示</button>}
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                      {staff.map(s=>{
                        const w=result.worked[s.id]||0;
                        const c=result.candW[s.id]||0;
                        const pct=c>0?Math.round(w/c*100):0;
                        const avg=result.avgRate;
                        const dc=pct>avg?"#276749":pct<avg?"#c0392b":C.muted;
                        const sel=resultStaffFilter===s.id;
                        return(
                          <div key={s.id} onClick={()=>setResultStaffFilter(sel?null:s.id)}
                            style={{background:sel?"rgba(139,26,26,0.08)":"#fdfaf6",borderRadius:12,padding:"10px 14px",textAlign:"center",
                              border:`1.5px solid ${sel?C.accent:GRADE_COLOR[s.grade]+"22"}`,minWidth:84,cursor:"pointer",transition:"all .15s",
                              boxShadow:sel?"0 2px 12px rgba(139,26,26,0.18)":"none"}}>
                            <div style={{fontSize:10,fontWeight:700,color:GRADE_COLOR[s.grade]}}>{s.name}</div>
                            <div style={{fontSize:19,fontWeight:900,marginTop:4,color:C.text}}>{w}<span style={{fontSize:10,color:C.muted,fontWeight:400}}>/{c}日</span></div>
                            <div style={{fontSize:12,fontWeight:800,color:dc}}>{pct}%</div>
                            <div style={{fontSize:8,color:C.muted,opacity:.6,marginTop:2}}>実績/候補日数</div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{fontSize:10,color:C.muted,marginTop:10,opacity:.6}}>
                      平均達成率：{result.avgRate}%　{resultStaffFilter?"（名前タップで全員表示）":"（名前タップで個別確認）"}
                    </div>
                  </div>

                  {resultStaffFilter&&(
                    <div style={{marginBottom:10,padding:"8px 14px",borderRadius:10,background:"rgba(139,26,26,0.05)",border:"1px solid rgba(139,26,26,0.15)",fontSize:11,color:C.accent,fontWeight:700}}>
                      {staff.find(s=>s.id===resultStaffFilter)?.name} のシフト一覧
                    </div>
                  )}
                  {Array.from({length:days},(_,i)=>i+1).map(d=>{
                    const dow=getDow(year,month,d),hol=isHol(year,month,d);
                    const closed=isClosed(year,month,d);
                    const aiOn=aisaniConfig[d]?.enabled;
                    if(closed&&!aiOn) return null;
                    const day=result.shifts[d];
                    if(!day) return null;
                    // 個別フィルター: 選択スタッフが入っている日のみ表示
                    if(resultStaffFilter){
                      const sid=resultStaffFilter;
                      const inShift=day.morning.includes(sid)||day.prep.includes(sid)||
                        Object.values(day.night).includes(sid)||day.aisani===sid||day.kitchen===sid;
                      if(!inShift) return null;
                    }
                    const slots=nightSlotConfig[d]||[];
                    const sh=(result.shortage&&result.shortage[d])||{};
                    const warns=(result.warnings&&result.warnings[d])||[];
                    const kitOn=kitchenConfig[d]?.enabled;
                    const totalS=(sh.morning||0)+(sh.prep||0)+slots.reduce((s,t)=>s+(sh.night?.[t]||0),0)+(aiOn?sh.aisani||0:0)+(kitOn?sh.kitchen||0:0);
                    const bc=totalS>0?"rgba(192,57,43,0.2)":warns.length?"rgba(184,134,11,0.2)":hol?"rgba(184,134,11,0.12)":dow===0?"rgba(192,57,43,0.1)":dow===6?"rgba(27,42,94,0.1)":"rgba(139,26,26,0.06)";
                    return(
                      <div key={d} style={{background:"#fff",borderRadius:14,border:`1px solid ${bc}`,padding:14,marginBottom:8,boxShadow:"0 1px 6px rgba(0,0,0,0.04)"}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8,flexWrap:"wrap"}}>
                          <span style={{fontWeight:900,fontSize:15,color:hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                            {month+1}/{d}（{DOW_JP[dow]}）{hol?"🎌":""}
                          </span>
                          {closed&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(139,26,26,0.06)",color:"#8c7b6b",fontWeight:700,border:"1px solid rgba(139,26,26,0.12)"}}>定休日</span>}
                          {!closed&&isSpec(year,month,d)&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(184,134,11,0.08)",color:"#b8860b",fontWeight:700,border:"1px solid rgba(184,134,11,0.2)"}}>特別夜</span>}
                          {totalS>0&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(192,57,43,0.08)",color:"#c0392b",fontWeight:700,border:"1px solid rgba(192,57,43,0.2)"}}>⚠ 不足{totalS}名</span>}
                          {warns.length>0&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(184,134,11,0.06)",color:"#b8860b",fontWeight:700,border:"1px solid rgba(184,134,11,0.18)"}}>⚡ 例外あり</span>}
                        </div>
                        {warns.length>0&&(
                          <div style={{marginBottom:8,padding:"8px 12px",background:"rgba(184,134,11,0.04)",borderRadius:10,border:"1px solid rgba(184,134,11,0.12)"}}>
                            {warns.map((w,i)=><div key={i} style={{fontSize:10,color:"#b8860b"}}>⚡ {w}</div>)}
                          </div>
                        )}
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          {!closed&&<SRow label="朝" time="7:00〜11:00" color="#b07d12"
                            people={(day.morning||[]).map(id=>staffMap[id]).filter(Boolean)} shortage={sh.morning||0}
                            candidates={staff.filter(s=>avail[s.id]?.[`${d}_morning`]&&!(day.morning||[]).includes(s.id))}
                            onSwap={newId=>swapShiftAssignment(d,'morning',null,newId)}
                            onRemove={id=>swapShiftAssignment(d,'morning',null,null,id)}
                            onDismissShortage={(sh.morning||0)>0?()=>dismissShortage(d,'morning'):null}/>}
                          {!closed&&<SRow label="朝仕込" time="8:30〜16:00" color="#276749"
                            people={(day.prep||[]).map(id=>staffMap[id]).filter(Boolean)} shortage={sh.prep||0}
                            candidates={staff.filter(s=>avail[s.id]?.[`${d}_prep`]&&!(day.prep||[]).includes(s.id))}
                            onSwap={newId=>swapShiftAssignment(d,'prep',null,newId)}
                            onRemove={id=>swapShiftAssignment(d,'prep',null,null,id)}
                            onDismissShortage={(sh.prep||0)>0?()=>dismissShortage(d,'prep'):null}/>}
                          {!closed&&slots.map(t=>{
                            const p=(day.night||{})[t];
                            const nightCands=staff.filter(s=>s.id!==p&&NIGHT_TIMES.some(nt=>avail[s.id]?.[`${d}_night_${nt}`]&&nightCompat(nt,t)));
                            return <SRow key={t} label={`夜 ${t}〜`} time="" color={NIGHT_TC[t]} people={p?[staffMap[p]].filter(Boolean):[]} shortage={sh.night?.[t]||0} candidates={nightCands}
                              onSwap={newId=>swapShiftAssignment(d,'night',t,newId)}
                              onRemove={()=>swapShiftAssignment(d,'night',t,null)}
                              onDismissShortage={(sh.night?.[t]||0)>0?()=>dismissShortage(d,'night',t):null}/>;
                          })}
                          {aiOn&&<SRow label="アイサニ" time="ヘルプ" color={C.accent}
                            people={day.aisani?[staffMap[day.aisani]].filter(Boolean):[]} shortage={sh.aisani||0}
                            candidates={staff.filter(s=>s.aisaniOK&&s.id!==day.aisani&&(avail[s.id]?.[`${d}_aisani`]||NIGHT_TIMES.some(t=>avail[s.id]?.[`${d}_night_${t}`])))}
                            onSwap={newId=>swapShiftAssignment(d,'aisani',null,newId)}
                            onRemove={()=>swapShiftAssignment(d,'aisani',null,null)}
                            onDismissShortage={(sh.aisani||0)>0?()=>dismissShortage(d,'aisani'):null}/>}
                          {!closed&&kitOn&&<SRow label="厨房" time="キッチン" color="#276749"
                            people={day.kitchen?[staffMap[day.kitchen]].filter(Boolean):[]} shortage={sh.kitchen||0}
                            candidates={staff.filter(s=>s.kitchenOK&&avail[s.id]?.[`${d}_kitchen`]&&s.id!==day.kitchen)}
                            onSwap={newId=>swapShiftAssignment(d,'kitchen',null,newId)}
                            onRemove={()=>swapShiftAssignment(d,'kitchen',null,null)}
                            onDismissShortage={(sh.kitchen||0)>0?()=>dismissShortage(d,'kitchen'):null}/>}
                        </div>
                        <input type="text" placeholder="📝 この日のコメントを追加（任意）"
                          value={dayComments[d]||""}
                          onChange={e=>updateDayComments({...dayComments,[d]:e.target.value})}
                          style={{marginTop:8,width:"100%",boxSizing:"border-box",padding:"7px 12px",borderRadius:8,border:"1px solid rgba(139,26,26,0.15)",background:"rgba(139,26,26,0.02)",fontSize:11,color:"#1a0a00",outline:"none",fontFamily:"inherit"}}
                        />
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

function SRow({label,time,color,people,shortage=0,candidates=[],onSwap=null,onRemove=null,onDismissShortage=null}){
  return(
    <div style={{display:"flex",flexDirection:"column",gap:3}}>
      <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
        <div style={{minWidth:70,fontSize:10,fontWeight:700,color,background:color+"18",borderRadius:999,padding:"3px 10px",textAlign:"center",flexShrink:0,border:`1px solid ${color}30`}}>{label}</div>
        {time&&<div style={{fontSize:9,color:"#8c7b6b",minWidth:76,flexShrink:0}}>{time}</div>}
        <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
          {people.map(s=>(
            onRemove
              ? <button key={s.id} onClick={()=>onRemove(s.id)} title="タップで削除" style={{fontSize:12,padding:"4px 12px",borderRadius:999,background:"rgba(139,26,26,0.05)",color:"#1a0a00",fontWeight:700,border:"1px solid rgba(139,26,26,0.12)",cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:4}}>
                  {s.name}<span style={{fontSize:9,color:"#c0392b",fontWeight:900}}>×</span>
                </button>
              : <span key={s.id} style={{fontSize:12,padding:"4px 14px",borderRadius:999,background:"rgba(139,26,26,0.05)",color:"#1a0a00",fontWeight:700,border:"1px solid rgba(139,26,26,0.12)"}}>
                  {s.name}
                </span>
          ))}
          {shortage>0&&(
            <span style={{display:"flex",alignItems:"center",gap:4,fontSize:10,padding:"3px 10px",borderRadius:999,background:"rgba(192,57,43,0.08)",color:"#c0392b",fontWeight:700,border:"1px solid rgba(192,57,43,0.2)"}}>
              あと{shortage}名不足
              {onDismissShortage&&<button onClick={onDismissShortage} style={{background:"none",border:"none",cursor:"pointer",color:"#c0392b",fontWeight:900,fontSize:11,padding:"0 2px",lineHeight:1,fontFamily:"inherit"}}>×</button>}
            </span>
          )}
          {people.length===0&&shortage===0&&<span style={{fontSize:11,color:"rgba(139,26,26,0.15)"}}>—</span>}
        </div>
      </div>
      {candidates.length>0&&(
        <div style={{display:"flex",alignItems:"center",gap:5,paddingLeft:77,flexWrap:"wrap"}}>
          <span style={{fontSize:9,color:"#b0a090",flexShrink:0}}>候補：</span>
          {candidates.map(s=>(
            onSwap
              ? <button key={s.id} onClick={()=>onSwap(s.id)} style={{fontSize:10,padding:"2px 10px",borderRadius:999,background:"rgba(37,99,235,0.07)",color:"#1d4ed8",border:"1px dashed rgba(37,99,235,0.35)",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                  {s.name}
                </button>
              : <span key={s.id} style={{fontSize:10,padding:"2px 10px",borderRadius:999,background:"rgba(139,26,26,0.03)",color:"#8c7b6b",border:"1px dashed rgba(139,26,26,0.15)"}}>
                  {s.name}
                </span>
          ))}
        </div>
      )}
    </div>
  );
}
