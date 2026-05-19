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
const GRADE_SORT = {GM:0,SM:1,M:2,L:3,J:4};
const sortByGrade = arr=>[...arr].sort((a,b)=>(GRADE_SORT[a.grade]??5)-(GRADE_SORT[b.grade]??5));
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
const slotDisplayTime=k=>k.replace(/_\d+$/,'');
const nightCompat=(cand,slot)=>{const s=slotDisplayTime(slot);const si=NIGHT_ORDER.indexOf(s);return si>=0?NIGHT_ORDER.indexOf(cand)<=si:cand<=s;};

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
function generateShifts(staff, year, month, avail, nightSlotConfig, aisaniConfig, kitchenConfig, dayTypeConfig={}) {
  const days = daysIn(year, month);
  const result  = {};
  const worked  = {};
  const workedMorning = {}; // 朝/夜バランス用
  const workedNight   = {};
  const workedDays    = {}; // 日数ベース達成率用
  const candDays      = {}; // 候補数
  staff.forEach(s=>{ worked[s.id]=0; workedMorning[s.id]=0; workedNight[s.id]=0; workedDays[s.id]=new Set(); candDays[s.id]=0; });

  const isAvail = (sid,key) => !!avail[sid]?.[key];

  // 事前に候補数を集計
  // 朝仕込み(_prep, または朝+仕込み両チェック)=2
  // 朝/夜/アイサニ/キッチン/仕込み夜など有効なシフトあり=1
  // 仕込みのみ・前日夜→翌朝のみ=0
  staff.forEach(s=>{
    for(let d=1;d<=days;d++){
      const hasPrep=isAvail(s.id,`${d}_prep`);
      const hasMorning=isAvail(s.id,`${d}_morning`);
      const hasShimikomi=isAvail(s.id,`${d}_shimikomi`);
      const hasNight=NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`));
      const hasAisani=s.aisaniOK&&isAvail(s.id,`${d}_aisani`);
      const hasKitchen=s.kitchenOK&&isAvail(s.id,`${d}_kitchen`);
      if(!hasMorning&&!hasPrep&&!hasShimikomi&&!hasNight&&!hasAisani&&!hasKitchen) continue;
      if(hasPrep||(hasMorning&&hasShimikomi)){
        candDays[s.id]+=2; // 朝仕込み=2
      } else {
        const hadPrevNight=d>1&&NIGHT_TIMES.some(t=>isAvail(s.id,`${d-1}_night_${t}`));
        const activeMorning=hasMorning&&!hadPrevNight; // 前日夜がある場合、朝は0（夜朝カウント済み）
        // アイサニ/キッチン/夜/朝(有効)のいずれかがあれば+1、仕込みのみや夜朝の朝のみは0
        if(activeMorning||hasNight||hasAisani||hasKitchen) candDays[s.id]+=1;
      }
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
      // 夜はGM最優先→SM→M→L→J、それ以外はSM/GM同等
      const lo = balanceMode==='night' ? {GM:0,SM:1,M:2,L:3,J:4} : {J:3,L:2,M:1,SM:0,GM:0};
      return (lo[a.grade]??5)-(lo[b.grade]??5);
    });
    const res=[]; let nb=0;
    for(const s of sorted){
      if(res.length>=count) break;
      if(isJunior(s.grade)&&nb>=maxJunior) continue;
      res.push(s); if(isJunior(s.grade)) nb++;
    }
    if(needSeniorIfJunior&&res.some(s=>isJunior(s.grade))&&!res.some(s=>isSenior(s.grade))){
      // GM優先、次にSM
      const vet=candidates.find(s=>s.grade==='GM'&&!res.includes(s))||candidates.find(s=>s.grade==='SM'&&!res.includes(s));
      if(vet){ const ri=res.findLastIndex(s=>isMid(s.grade)); if(ri>=0) res[ri]=vet; else{ res.pop(); res.push(vet); } }
    }
    return res.slice(0,count);
  };

  const addWorked=(s,d,type)=>{ worked[s.id]++; workedDays[s.id].add(d); if(type==='morning') workedMorning[s.id]++; else if(type==='night') workedNight[s.id]++; };

  const shortage={}; const warnings={};

  const morningRisk=(d)=>{
    if(d>days||isClosed(year,month,d)||dayTypeConfig[d]==="closed") return false;
    const mc=staff.filter(s=>isAvail(s.id,`${d}_morning`)||isAvail(s.id,`${d}_prep`)).length;
    const pc=staff.filter(s=>isAvail(s.id,`${d}_prep`)||isAvail(s.id,`${d}_shimikomi`)).length;
    return mc<2||pc<1;
  };

  for(let d=1;d<=days;d++){
    const manualClosed=dayTypeConfig[d]==="closed";
    const morningClosed=dayTypeConfig[d]==="morning_closed";

    if(isClosed(year,month,d)||manualClosed){
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

    // 朝営業休み: 仕込み1人 + 夜のみ
    if(morningClosed){
      const dayR={morning:[],prep:[],night:{},aisani:null,kitchen:null};
      const dayS={morning:0,prep:0,night:{},aisani:0,kitchen:0};
      const dayW=[];
      const slots=nightSlotConfig[d]||[];
      const prevNight=new Set(d>1?Object.values(result[d-1]?.night||{}).filter(Boolean):[]);

      const shimCandsStrict=staff.filter(s=>(isAvail(s.id,`${d}_shimikomi`)||isAvail(s.id,`${d}_prep`))&&!prevNight.has(s.id));
      const shimCandsAll=staff.filter(s=>isAvail(s.id,`${d}_shimikomi`)||isAvail(s.id,`${d}_prep`));
      const sPick=pick(shimCandsStrict.length>=1?shimCandsStrict:shimCandsAll,1);
      dayR.prep=sPick.map(s=>s.id);
      sPick.forEach(s=>addWorked(s,d,'prep'));
      dayS.prep=Math.max(0,1-sPick.length);

      const prepW=new Set(dayR.prep);
      const assignedNight=new Set();
      slots.forEach(slotTime=>{
        const nCands=staff.filter(s=>{
          if(prepW.has(s.id)) return false;
          if(assignedNight.has(s.id)) return false;
          return NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`)&&nightCompat(t,slotTime));
        });
        const nPick=pick(nCands,1,{balanceMode:'night'});
        if(nPick[0]){
          addWorked(nPick[0],d,'night');
          assignedNight.add(nPick[0].id);
          dayR.night[slotTime]=nPick[0].id;
        } else {
          dayS.night[slotTime]=1;
        }
      });
      result[d]=dayR;
      shortage[d]=dayS;
      warnings[d]=dayW;
      continue;
    }
    const spec=isSpec(year,month,d);
    const dayR={morning:[],prep:[],night:{},aisani:null,kitchen:null};
    const dayS={morning:0,prep:0,night:{},aisani:0,kitchen:0};
    const dayW=[];
    const slots=nightSlotConfig[d]||[];

    const prevNight=new Set(d>1?Object.values(result[d-1]?.night||{}).filter(Boolean):[]);
    const nextDayRisk=morningRisk(d+1);

    // ── 仕込みスロット: 朝仕込み > 朝+仕込み > 仕込みのみ の優先で埋める
    const prepStrict=staff.filter(s=>isAvail(s.id,`${d}_prep`)&&!prevNight.has(s.id));
    const prepAll=staff.filter(s=>isAvail(s.id,`${d}_prep`));
    const shimikomiStrict=staff.filter(s=>isAvail(s.id,`${d}_shimikomi`)&&!prevNight.has(s.id));
    const shimikomiAll=staff.filter(s=>isAvail(s.id,`${d}_shimikomi`));
    // 朝+仕込み両方チェック: 朝のみ or 朝仕込みどちらにも割り当て可能（通常扱い・morningTarget=2）
    const shimikomiMorningAll=shimikomiAll.filter(s=>isAvail(s.id,`${d}_morning`));
    const shimikomiMorningStrict=shimikomiStrict.filter(s=>isAvail(s.id,`${d}_morning`));
    // 仕込みのみ: 朝も朝仕込みも持たない → 朝仕込み候補が誰もいない場合のみ例外（朝3人）
    const shimikomiPureAll=shimikomiAll.filter(s=>!isAvail(s.id,`${d}_morning`)&&!isAvail(s.id,`${d}_prep`));
    const shimikomiPureStrict=shimikomiStrict.filter(s=>!isAvail(s.id,`${d}_morning`)&&!isAvail(s.id,`${d}_prep`));

    let pPick=[];
    let morningTarget=2;
    let prepMode="none";

    if(prepAll.length>0){
      pPick=pick(prepStrict.length>=1?prepStrict:prepAll,1);
      morningTarget=2; prepMode="prep";
    } else if(shimikomiMorningAll.length>0){
      // 朝+仕込み両方チェック → 仕込みスロットに割り当て（morningTarget=2）
      pPick=pick(shimikomiMorningStrict.length>=1?shimikomiMorningStrict:shimikomiMorningAll,1);
      morningTarget=2; prepMode="shimikomiMorning";
    } else if(shimikomiPureAll.length>0){
      // 例外：朝・朝仕込み候補が誰もいない場合のみ朝3人+仕込み1人
      pPick=pick(shimikomiPureStrict.length>=1?shimikomiPureStrict:shimikomiPureAll,1);
      morningTarget=3; prepMode="shimikomiOnly";
    } else {
      morningTarget=2; prepMode="none";
    }

    if(pPick[0]&&prevNight.has(pPick[0].id)) dayW.push(`${pPick[0].name}：前日夜→仕込み（人手不足）`);
    dayR.prep=pPick.map(s=>s.id);
    pPick.forEach(s=>addWorked(s,d,'prep'));
    dayS.prep=Math.max(0,1-pPick.length);

    // ── 朝（morningTarget人）: 朝のみ選択者（または朝+仕込み両方選択者）が対象
    const mStrict=staff.filter(s=>
      isAvail(s.id,`${d}_morning`)&&
      !dayR.prep.includes(s.id)&&!prevNight.has(s.id)
    );
    const mAll=staff.filter(s=>isAvail(s.id,`${d}_morning`)&&!dayR.prep.includes(s.id));
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
    const shimikomiCanDoNight=prepMode==="shimikomiOnly"&&pPick[0]&&NIGHT_TIMES.some(t=>isAvail(pPick[0].id,`${d}_night_${t}`))&&mCands.length>=3;
    const prepW=shimikomiCanDoNight?new Set():new Set(dayR.prep);
    const morningW=new Set(dayR.morning);
    const kitchenW=new Set(dayR.kitchen?[dayR.kitchen]:[]);
    const assignedNight=new Set();
    const nightPickResults=[];

    const tomorrowMorningConfirmed=new Set();
    if(nextDayRisk&&d<days&&!isClosed(year,month,d+1)&&dayTypeConfig[d+1]!=="closed"){
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

  // 勤務実績カウント: 朝仕込み(_prep avail)=2, 朝=1, 仕込みのみ=1, 夜=1, アイサニ/キッチン=1
  // 組み合わせは各1を加算（朝夜=1+1=2, 仕込み夜=1+1=2）
  const workedCounts={};
  staff.forEach(s=>{ workedCounts[s.id]=0; });
  for(let d=1;d<=days;d++){
    const dayR=result[d];
    if(!dayR) continue;
    staff.forEach(s=>{
      const inPrep=(dayR.prep||[]).includes(s.id);
      const inMorning=(dayR.morning||[]).includes(s.id);
      const inNight=Object.values(dayR.night||{}).some(id=>id===s.id);
      const inAisani=dayR.aisani===s.id;
      const inKitchen=dayR.kitchen===s.id;
      if(inPrep){
        // 朝仕込み判定: _prep avail または (朝+仕込み両チェック=shimikomiMorning)
        const is2Count=isAvail(s.id,`${d}_prep`)||(isAvail(s.id,`${d}_morning`)&&isAvail(s.id,`${d}_shimikomi`));
        workedCounts[s.id]+=is2Count?2:1;
      }
      if(inMorning) workedCounts[s.id]+=1;
      if(inNight) workedCounts[s.id]+=1;
      if(inAisani||inKitchen) workedCounts[s.id]+=1;
    });
  }
  const totalW=staff.reduce((a,s)=>a+workedCounts[s.id],0);
  const totalC=staff.reduce((a,s)=>a+candDays[s.id],0);
  const avgRate=totalC>0?Math.round(totalW/totalC*100):0;

  return {shifts:result,worked:workedCounts,candW:candDays,shortage,warnings,avgRate,workedDays};
}

function staffById_local(staffArr,id){ return staffArr.find(s=>s.id===id); }

// 勤務実績数をシフト結果から動的計算
// 朝仕込み(_prep avail)=2, 朝=1, 仕込みのみ=1, 夜=1, アイサニ/キッチン=1（各加算）
function calcWorkedCount(sid, shifts, avail){
  let count=0;
  Object.entries(shifts||{}).forEach(([dStr,dayR])=>{
    if(!dayR) return;
    const d=parseInt(dStr);
    const inPrep=(dayR.prep||[]).includes(sid);
    const inMorning=(dayR.morning||[]).includes(sid);
    const inNight=Object.values(dayR.night||{}).some(id=>id===sid);
    const inAisani=dayR.aisani===sid;
    const inKitchen=dayR.kitchen===sid;
    if(inPrep){
      // 朝仕込み判定: _prep avail または (朝+仕込み両チェック=shimikomiMorning)
      const is2Count=avail[sid]?.[`${d}_prep`]||(avail[sid]?.[`${d}_morning`]&&avail[sid]?.[`${d}_shimikomi`]);
      count+=is2Count?2:1;
    }
    if(inMorning) count+=1;
    if(inNight) count+=1;
    if(inAisani||inKitchen) count+=1;
  });
  return count;
}

// 候補数をavailから動的計算
// 朝仕込み(_prep)=2, 朝=1, 夜=1, アイサニ=+1, キッチン=+1
// 仕込みのみ(_shimikomi)=0, 朝夜/仕込み夜/夜朝=1, 前日夜→翌朝は夜側でカウント済み
function calcCandCount(s, avail, year, month){
  const days=daysIn(year,month);
  let count=0;
  for(let d=1;d<=days;d++){
    const hasPrep=!!avail[s.id]?.[`${d}_prep`];
    const hasMorning=!!avail[s.id]?.[`${d}_morning`];
    const hasShimikomi=!!avail[s.id]?.[`${d}_shimikomi`];
    const hasNight=NIGHT_TIMES.some(t=>!!avail[s.id]?.[`${d}_night_${t}`]);
    const hasAisani=s.aisaniOK&&!!avail[s.id]?.[`${d}_aisani`];
    const hasKitchen=s.kitchenOK&&!!avail[s.id]?.[`${d}_kitchen`];
    if(!hasMorning&&!hasPrep&&!hasShimikomi&&!hasNight&&!hasAisani&&!hasKitchen) continue;
    if(hasPrep||(hasMorning&&hasShimikomi)){
      count+=2; // 朝仕込み=2
    } else {
      const hadPrevNight=d>1&&NIGHT_TIMES.some(t=>!!avail[s.id]?.[`${d-1}_night_${t}`]);
      const activeMorning=hasMorning&&!hadPrevNight;
      if(activeMorning||hasNight||hasAisani||hasKitchen) count+=1;
    }
  }
  return count;
}

// result をFirebase保存用にシリアライズ（Sets除去、空配列を_EMPTYマーカー化）
function serializeResult(r){
  if(!r) return null;
  const shifts={};
  Object.entries(r.shifts||{}).forEach(([d,day])=>{
    if(!day){shifts[d]=day;return;}
    const nightSer={};
    Object.entries(day.night||{}).forEach(([t,id])=>{nightSer[t]=(id===null||id===undefined)?'_NULL_':id;});
    shifts[d]={
      ...day,
      morning:(day.morning&&day.morning.length)?day.morning:['_EMPTY_'],
      prep:(day.prep&&day.prep.length)?day.prep:['_EMPTY_'],
      night:nightSer,
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
      const nightRaw=(day.night&&typeof day.night==='object')?day.night:{};
      const nightDeser={};
      Object.entries(nightRaw).forEach(([t,id])=>{nightDeser[t]=(id==='_NULL_')?null:id;});
      shifts[d]={
        morning:Array.isArray(day.morning)?day.morning.filter(x=>x!=='_EMPTY_'):[],
        prep:Array.isArray(day.prep)?day.prep.filter(x=>x!=='_EMPTY_'):[],
        night:nightDeser,
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
      savedAt:r.savedAt||0,
      ...(r.year!==undefined?{year:r.year,month:r.month}:{}),
    };
  }catch(_){ return null; }
}

// ── localStorage へ result を保存/復元
// ── 確定シフト serialize/deserialize（Firebase 空配列対策）
function serializeConfirmedShift(result, year, month, aisaniConfig={}, kitchenConfig={}, nightSlotConfig={}, dayTypeConfig={}) {
  if (!result) return null;
  const shifts = {};
  Object.entries(result.shifts || {}).forEach(([d, day]) => {
    if (!day) { shifts[d] = null; return; }
    const dn = parseInt(d);
    const morningClosed = dayTypeConfig[dn] === "morning_closed";
    const configuredSlots = nightSlotConfig[dn] || [];
    const filteredNight = {};
    Object.entries(day.night || {}).forEach(([t, id]) => {
      const effectiveId=(id==='_NULL_')?null:id;
      // 設定済みスロット + カスタム追加スロット（両方を確定シフトに含める）
      if (configuredSlots.includes(t) || effectiveId != null) filteredNight[t] = effectiveId;
    });
    shifts[d] = {
      morning: morningClosed ? ['_EMPTY_'] : ((day.morning && day.morning.length) ? day.morning : ['_EMPTY_']),
      prep:    (day.prep    && day.prep.length)    ? day.prep    : ['_EMPTY_'],
      night:   filteredNight,
      aisani:  aisaniConfig[dn]?.enabled  ? (day.aisani  ?? null) : null,
      kitchen: kitchenConfig[dn]?.enabled ? (day.kitchen ?? null) : null,
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

const LS_KEY = (ym) => `imari_result_${ym}`;
function saveResultLS(r, ym) {
  try { localStorage.setItem(LS_KEY(ym), JSON.stringify(serializeResult(r))); } catch(_) {}
}
function loadResultLS(ym) {
  try {
    const s = localStorage.getItem(LS_KEY(ym));
    if (s) return deserializeResult(JSON.parse(s));
  } catch(_) {}
  return null;
}

// 月別設定をlocalStorageに即時保存/ロード（月切替時にFirebase待ちなしで即座に復元するため）
const LS_CFG = (key) => `imari_cfg_${key}`;
function saveCfgLS(key, val) {
  try { localStorage.setItem(LS_CFG(key), JSON.stringify(val)); } catch(_) {}
}
function loadCfgLS(key) {
  try { const s = localStorage.getItem(LS_CFG(key)); return s ? JSON.parse(s) : null; } catch(_) { return null; } }

// ══════════════════════════════════════════════════════
const AUTO_SWITCH_DAY=20;
const getJSTDate=()=>new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
const getAutoMonth=()=>{
  const jst=getJSTDate();
  const d=jst.getDate(),m=jst.getMonth(),y=jst.getFullYear();
  if(d>=AUTO_SWITCH_DAY) return{y:m===11?y+1:y,m:m===11?0:m+1};
  return{y,m};
};
const getJSTCalendarMonth=()=>{const jst=getJSTDate();return{y:jst.getFullYear(),m:jst.getMonth()};};
// GMの月をlocalStorageに永続保存（セッションをまたいで前回月を復元）
const saveGMMonth=(y,m)=>{try{localStorage.setItem('imari_gm_ym',JSON.stringify({y,m}));}catch(_){}};
const loadGMMonth=()=>{try{const s=localStorage.getItem('imari_gm_ym');return s?JSON.parse(s):null;}catch(_){return null;}};
export default function App(){
  // アプリはスタッフモードで起動するため、初期月はスタッフ用のauto-month
  const {y:initY,m:initM}=getAutoMonth();
  const [year,setYear]=useState(initY);
  const [month,setMonth]=useState(initM);
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
  const [dayTypeConfig,setDayTypeConfig]=useState({});
  const [result,_setResultRaw]=useState(null);
  const resultRef=useRef(null);
  // setResult: resultRefを同期更新してからReact stateを更新（updaterの非同期問題を回避）
  const setResult=(valOrFn)=>{
    const next=typeof valOrFn==='function'?valOrFn(resultRef.current):valOrFn;
    resultRef.current=next;
    _setResultRaw(next);
  };
  const [confirmedShift,setConfirmedShift]=useState(null);
  const [dayComments,setDayComments]=useState({});
  const [starOverrides,setStarOverrides]=useState({}); // {[d]:{morning:sid|"none",night:sid|"none"}}
  const [view,setView]=useState("slots"); // slots|avail|result
  const [gmMode,setGmMode]=useState(false);
  const [loginStaff,setLoginStaff]=useState(null);
  const [staffTab,setStaffTab]=useState("avail"); // avail|shift
  // スタッフのシフト閲覧専用の月（候補入力やGMのstateとは独立）
  const [staffShiftViewY,setStaffShiftViewY]=useState(()=>getJSTCalendarMonth().y);
  const [staffShiftViewM,setStaffShiftViewM]=useState(()=>getJSTCalendarMonth().m);
  const [newStaff,setNewStaff]=useState({name:"",grade:"L",aisaniOK:false,kitchenOK:false,password:""});
  const [staffPwModal,setStaffPwModal]=useState(null); // パスワード確認中のスタッフ
  const [staffPwInput,setStaffPwInput]=useState("");
  const [staffPwError,setStaffPwError]=useState(false);
  const [staffPanelOpen,setStaffPanelOpen]=useState(false);
  const [shiftPreviewModal,setShiftPreviewModal]=useState(false);
  const [shiftPreviewPwInput,setShiftPreviewPwInput]=useState("");
  const [shiftPreviewPwError,setShiftPreviewPwError]=useState(false);
  const [shiftPreviewOpen,setShiftPreviewOpen]=useState(false);
  const [addSlotState,setAddSlotState]=useState(null); // {d, time} | null
  const [generating,setGenerating]=useState(false);
  const [resultStaffFilter,setResultStaffFilter]=useState(null);
  const [exporting,setExporting]=useState(false);
  const shiftRef=useRef(null);

  const days=daysIn(year,month);
  const firstDow=getDow(year,month,1);
  const staffMap=useMemo(()=>{const m={};staff.forEach(s=>m[s.id]=s);return m;},[staff]);

  const prevMonth=()=>{const [y,m]=month===0?[year-1,11]:[year,month-1];updateYearMonth(y,m);};
  const nextMonth=()=>{const [y,m]=month===11?[year+1,0]:[year,month+1];updateYearMonth(y,m);};

  const toggleNightSlot=(d,time)=>{
    const cur=nightSlotConfig[d]||[];
    const next=cur.includes(time)?cur.filter(t=>t!==time):[...cur,time].sort();
    updateNightSlot({...nightSlotConfig,[d]:next});
  };
  const toggleAisani=(d)=>updateAisaniCfg({...aisaniConfig,[d]:{enabled:!aisaniConfig[d]?.enabled}});
  const toggleKitchen=(d)=>updateKitchenCfg({...kitchenConfig,[d]:{enabled:!kitchenConfig[d]?.enabled}});
  const toggleDayType=(d,type)=>{
    const cur=dayTypeConfig[d];
    const next=cur===type?undefined:type;
    const newCfg={...dayTypeConfig};
    if(next===undefined) delete newCfg[d]; else newCfg[d]=next;
    updateDayTypeCfg(newCfg);
  };

  // 候補入力（GM: 任意のスタッフ, スタッフ: 自分のみ）
  const targetSid=gmMode?null:(loginStaff?.id);

  const toggleAvail=(sid,key)=>updateAvail({...avail,[sid]:{...(avail[sid]||{}),[key]:!avail[sid]?.[key]}},sid);
  // 朝・朝仕込み・仕込みは排他選択: 1つをONにすると他2つをOFF
  const MORNING_TYPES=['morning','prep','shimikomi'];
  const toggleMorningTypeAvail=(sid,d,type)=>{
    const cur=avail[sid]||{};
    const key=`${d}_${type}`;
    const newVal=!cur[key];
    const next={...cur,[key]:newVal};
    if(newVal){
      if(type==="prep"){MORNING_TYPES.forEach(t=>{if(t!==type) next[`${d}_${t}`]=false;});}
      else{next[`${d}_prep`]=false;}
    }
    updateAvail({...avail,[sid]:next},sid);
  };
  const setAllMorningTypeAvail=(sid,type)=>{
    const cur=avail[sid]||{};const next={...cur};
    for(let d=1;d<=days;d++){
      if(isClosed(year,month,d)) continue;
      next[`${d}_${type}`]=true;
      if(type==="prep"){MORNING_TYPES.forEach(t=>{if(t!==type) next[`${d}_${t}`]=false;});}
      else{next[`${d}_prep`]=false;}
    }
    updateAvail({...avail,[sid]:next},sid);
  };
  const toggleNightAvail=(sid,d,time)=>{
    const cur=avail[sid]||{};
    const next={...cur};
    NIGHT_TIMES.forEach(t=>{next[`${d}_night_${t}`]=false;});
    if(!cur[`${d}_night_${time}`]) next[`${d}_night_${time}`]=true;
    updateAvail({...avail,[sid]:next},sid);
  };
  const setAllAvail=(sid,type,val)=>{
    const cur=avail[sid]||{};const next={...cur};
    for(let d=1;d<=days;d++) if(!isClosed(year,month,d)) next[`${d}_${type}`]=val;
    updateAvail({...avail,[sid]:next},sid);
  };

  const swapShiftAssignment=useCallback((d,slotType,slotTime,newId,removeId=null,force=false)=>{
    const prev=resultRef.current;
    if(!prev) return;
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
        if(newId&&dayShift.morning.includes(newId)) return;
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
    if(!force&&!removeId&&oldId===newId) return;
    newShifts[d]=dayShift;
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
    const newShortage={...prev.shortage,[d]:{...(prev.shortage[d]||{})}};
    if(slotType==='night') newShortage[d]={...newShortage[d],night:{...(newShortage[d]?.night||{}),[slotTime]:(newId&&!removeId)?0:1}};
    else if(slotType==='aisani') newShortage[d]={...newShortage[d],aisani:(newId&&!removeId)?0:1};
    else if(slotType==='kitchen') newShortage[d]={...newShortage[d],kitchen:(newId&&!removeId)?0:1};
    else if(slotType==='prep') newShortage[d]={...newShortage[d],prep:(dayShift.prep.length>0)?0:1};
    else if(slotType==='morning') newShortage[d]={...newShortage[d],morning:Math.max(0,(prev.shortage[d]?.morning||0)+(removeId?1:0)-(newId&&!removeId?1:0))};
    const totalW=staff.reduce((a,s)=>a+wd[s.id].size,0);
    const totalC=staff.reduce((a,s)=>a+(prev.candW[s.id]||0),0);
    const newAvgRate=totalC>0?Math.round(totalW/totalC*100):0;
    const next={...prev,shifts:newShifts,worked:newWorked,workedDays:wd,shortage:newShortage,avgRate:newAvgRate,savedAt:Date.now()};
    setResult(next);
    saveResultLS(next,ymRef.current);
    debounceSave(`resultBackup_${ymRef.current}`,serializeResult(next));
  },[staff]);

  const removeCustomNightSlot=useCallback((d,t)=>{
    const prev=resultRef.current;if(!prev)return;
    const newShifts={...prev.shifts,[d]:{...prev.shifts[d],night:{...(prev.shifts[d]?.night||{})}}};
    delete newShifts[d].night[t];
    const wd={};staff.forEach(s=>{wd[s.id]=new Set();});
    Object.entries(newShifts).forEach(([ds,sh])=>{const dd=Number(ds);[...(sh.morning||[]),...(sh.prep||[])].forEach(id=>{if(wd[id])wd[id].add(dd);});Object.values(sh.night||{}).filter(Boolean).forEach(id=>{if(wd[id])wd[id].add(dd);});if(sh.aisani&&wd[sh.aisani])wd[sh.aisani].add(dd);if(sh.kitchen&&wd[sh.kitchen])wd[sh.kitchen].add(dd);});
    const newWorked={};staff.forEach(s=>{newWorked[s.id]=wd[s.id].size;});
    const newShortage={...prev.shortage,[d]:{...prev.shortage[d],night:{...(prev.shortage[d]?.night||{})}}};
    delete newShortage[d].night[t];
    const totalW=staff.reduce((a,s)=>a+wd[s.id].size,0);const totalC=staff.reduce((a,s)=>a+(prev.candW[s.id]||0),0);
    const next={...prev,shifts:newShifts,worked:newWorked,workedDays:wd,shortage:newShortage,avgRate:totalC>0?Math.round(totalW/totalC*100):0,savedAt:Date.now()};
    setResult(next);saveResultLS(next,ymRef.current);debounceSave(`resultBackup_${ymRef.current}`,serializeResult(next));
  },[staff]);

  const handleGenerate=()=>{
    const genYm=`${year}_${month}`;
    setGenerating(true);
    setTimeout(()=>{
      const r={...generateShifts(staff,year,month,avail,nightSlotConfig,aisaniConfig,kitchenConfig,dayTypeConfig),year,month,savedAt:Date.now()};
      setResult(r);saveResultLS(r,genYm);setView("result");setGenerating(false);
      const rbKey=`resultBackup_${genYm}`;
      pendingKeys.current.add(rbKey);
      saveKey(rbKey,serializeResult(r)).catch(()=>{}).finally(()=>{pendingKeys.current.delete(rbKey);});
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
  const staffModeStaff=staff;
  const resetStaffShiftView=()=>{setStaffShiftViewY(year);setStaffShiftViewM(month);};
  const handleStaffSelect=(s)=>{
    resetStaffShiftView();
    if(s.password){setStaffPwModal(s);setStaffPwInput("");setStaffPwError(false);}
    else setLoginStaff(s);
  };
  const handleStaffPwLogin=()=>{
    if(staffPwInput===staffPwModal.password){setLoginStaff(staffPwModal);setStaffPwModal(null);setStaffPwInput("");setStaffPwError(false);}
    else{setStaffPwError(true);setStaffPwInput("");}
  };

  // GMパスワード
  const GM_PASSWORD="20030625";
  const SHIFT_PREVIEW_PASSWORD="0125";
  const [pwModal,setPwModal]=useState(false);
  const [pwInput,setPwInput]=useState("");
  const [pwError,setPwError]=useState(false);
  const [loading,setLoading]=useState(true);
  const [loadingFading,setLoadingFading]=useState(false);
  const initialLoadDone=useRef(false);
  const startLoadingFadeOut=useCallback(()=>{
    if(initialLoadDone.current) return;
    initialLoadDone.current=true;
    setLoadingFading(true);
    setTimeout(()=>{setLoading(false);setLoadingFading(false);},650);
  },[]);
  const [syncing,setSyncing]=useState(false);
  const saveTimers=useRef({});
  const pendingKeys=useRef(new Set());
  const availStartupTsRef=useRef(0);
  const startupAvailPending=useRef(false); // 起動時のavail比較が完了したかどうか
  const ymRef=useRef(`${year}_${month}`);
  ymRef.current=`${year}_${month}`;
  // pendingYmRef: updateYearMonth呼び出し時に即座に更新（レンダー前でも正しい月を反映）
  const pendingYmRef=useRef(`${year}_${month}`);
  pendingYmRef.current=`${year}_${month}`;
  // localMonthSet: ユーザーが手動で月を変えたか。trueの後はFirebaseのyearMonthでローカル月を上書きしない
  const localMonthSet=useRef(false);
  // gmMonthRef: GMが最後にいた月（スタッフモードから戻ったとき復元するため）
  const gmMonthRef=useRef({y:year,m:month});
  // gmModeRef: Firebase購読コールバック内でgmModeを参照するため（クロージャの古い値問題を回避）
  const gmModeRef=useRef(false);
  gmModeRef.current=gmMode;
  // allDataRef: Firebaseの最新スナップショット全体を保持（スタッフの過去シフト参照用）
  const allDataRef=useRef({});

  // ── Firebase 起動時クリーンアップ + リアルタイム購読
  useEffect(()=>{
    cleanupStaleKeys();
    const unsub=subscribeAll((data)=>{
      allDataRef.current=data;
      if(data.staff&&Array.isArray(data.staff)&&!pendingKeys.current.has('staff')) setStaff(sortByGrade(data.staff));
      // yearMonth: GMとスタッフの月は独立管理のためFirebase同期しない
      // fbYmは常にローカルのpendingYmRef（現在表示中の月）を使う
      const fbYm=pendingYmRef.current;
      const avKey=`avail_${fbYm}`;
      const aiKey=`aisaniConfig_${fbYm}`;
      const kitKey=`kitchenConfig_${fbYm}`;
      const nsKey=`nightSlotConfig_${fbYm}`;
      const dcKey=`dayComments_${fbYm}`;
      const soKey=`starOverrides_${fbYm}`;
      const dtKey=`dayTypeConfig_${fbYm}`;
      const csKey=`confirmedShift_${fbYm}`;
      // 初回ロード中かどうか（初回はモードに関わらず全データをFirebaseから復元する）
      const isFirst=!initialLoadDone.current;
      // availはデータがある場合のみ更新（空データで上書きしない）
      // Firebaseから受け取ったデータはlocalStorageにも同時保存し、次回起動で即座に表示できるようにする
      if(pendingKeys.current.has(avKey)&&startupAvailPending.current){
        // 起動時のみ: タイムスタンプを比較してローカルとFirebaseのどちらが新しいか判定
        startupAvailPending.current=false;
        const {_ts:fbTs,...fbData}=data[avKey]||{};
        const localTs=availStartupTsRef.current;
        if(data[avKey]&&localTs<=(fbTs||0)){
          // Firebaseが新しい（GMの編集を反映）→ Firebaseを使用
          setAvail(fbData);saveCfgLS(avKey,data[avKey]);pendingKeys.current.delete(avKey);
        } else {
          // ローカルが新しい（未送信の編集あり）→ ローカルをFirebaseに書き込む
          const localRaw=loadCfgLS(avKey);
          if(localRaw) saveKey(avKey,localRaw).catch(()=>{}).finally(()=>pendingKeys.current.delete(avKey));
          else pendingKeys.current.delete(avKey);
        }
      } else if(!pendingKeys.current.has(avKey)&&data[avKey]){
        const {_ts:fbTs,...clean}=data[avKey];
        const localTs=(loadCfgLS(avKey)||{})._ts||0;
        // Firebaseが厳密に新しい場合のみ反映（GMの月変更だけでは上書きしない）
        if((fbTs||0)>localTs){setAvail(clean);saveCfgLS(avKey,data[avKey]);}
      }
      // GM専用ステート: 初回ロード時 or GMモード時のみFirebaseから更新
      // スタッフが月切替しても、GMの設定が消えないようにする
      const loadGm=isFirst||gmModeRef.current;
      if(loadGm){
        if(!pendingKeys.current.has(aiKey)&&data[aiKey]){setAisaniConfig(data[aiKey]);saveCfgLS(aiKey,data[aiKey]);}
        if(!pendingKeys.current.has(kitKey)&&data[kitKey]){setKitchenConfig(data[kitKey]);saveCfgLS(kitKey,data[kitKey]);}
        if(!pendingKeys.current.has(nsKey)&&data[nsKey]){setNightSlotConfig(data[nsKey]);saveCfgLS(nsKey,data[nsKey]);}
        if(!pendingKeys.current.has(dtKey)&&data[dtKey]){setDayTypeConfig(data[dtKey]);saveCfgLS(dtKey,data[dtKey]);}
      }
      if(!pendingKeys.current.has(dcKey)&&data[dcKey]){setDayComments(data[dcKey]);saveCfgLS(dcKey,data[dcKey]);}
      if(!pendingKeys.current.has(soKey)&&data[soKey]){setStarOverrides(data[soKey]);saveCfgLS(soKey,data[soKey]);}
      if(!pendingKeys.current.has(csKey)){
        const cs=deserializeConfirmedShift(data[csKey]);
        if(cs){setConfirmedShift(cs);saveCfgLS(csKey,data[csKey]);}
      }
      if(loadGm){
        const rbKey=`resultBackup_${fbYm}`;
        if(!pendingKeys.current.has(rbKey)&&data[rbKey]){
          const restored=deserializeResult(data[rbKey]);
          // ローカル未取得またはFirebaseが新しい場合のみ上書き
          if(restored&&(!resultRef.current||(restored.savedAt||0)>(resultRef.current?.savedAt||0))){
            setResult(restored);saveResultLS(restored,fbYm);
          }
        }
      }
      setTimeout(()=>startLoadingFadeOut(),500);
    });
    const t=setTimeout(()=>startLoadingFadeOut(),5000);
    return()=>{unsub();clearTimeout(t);};
  },[startLoadingFadeOut]);

  // ── スタッフモード専用: 開いたまま25日を迎えたら自動で翌月に切替（1分ごとにチェック）
  useEffect(()=>{
    if(gmModeRef.current) return;
    const id=setInterval(()=>{
      if(gmModeRef.current) return;
      const {y,m}=getAutoMonth();
      setYear(v=>v!==y?y:v);
      setMonth(v=>{
        if(v!==m){pendingYmRef.current=`${y}_${m}`;return m;}
        return v;
      });
    },60000);
    return()=>clearInterval(id);
  },[gmMode]);

  // ── localStorage から result / avail を起動時に復元（Firebase到達前に即表示）
  const prevAvailRef=useRef({});
  useEffect(()=>{
    const r=loadResultLS(ymRef.current);
    if(r) setResult(r);
    const avKey=`avail_${ymRef.current}`;
    const savedRaw=loadCfgLS(avKey);
    if(savedRaw){
      const {_ts:localTs,...savedAvail}=savedRaw;
      setAvail(savedAvail);
      availStartupTsRef.current=localTs||0;
      startupAvailPending.current=true;
      pendingKeys.current.add(avKey);
    }
  },[]);

  // ── avail変更時にシフト結果を同期（候補消去→除去、候補追加→不足補充）
  // 補充は「新たに追加された候補」のみ対象（クリア時の連鎖バグ防止）
  useEffect(()=>{
    // prevAvailRefは常に更新（early returnより前に）
    const prevAvail=prevAvailRef.current;
    prevAvailRef.current=avail;

    if(!initialLoadDone.current) return;

    // 初回ロード（prevAvailが空）はスキップ：结果とavailは保存時点で整合済み
    if(Object.keys(prevAvail).length===0) return;

    // availの中身が実質変化していなければスキップ（Firebase再送などの誤発火防止）
    const allSids=new Set([...Object.keys(prevAvail),...Object.keys(avail)]);
    let reallyChanged=false;
    outer: for(const sid of allSids){
      const pA=prevAvail[sid]||{};const nA=avail[sid]||{};
      const allKeys=new Set([...Object.keys(pA),...Object.keys(nA)]);
      for(const k of allKeys){if(!!pA[k]!==!!nA[k]){reallyChanged=true;break outer;}}
    }
    if(!reallyChanged) return;

    const prev=resultRef.current;
    if(!prev) return;
    // resultが現在月のものでなければスキップ（月切替直後の誤発火防止）
    if(prev.year!==undefined&&`${prev.year}_${prev.month}`!==pendingYmRef.current) return;

    // 新たにONになったavailキーを記録
    const newlyAdded=(sid,key)=>!!avail[sid]?.[key]&&!prevAvail[sid]?.[key];

    let anyChanged=false;
    const newShifts={...prev.shifts};
    const newShortage={...prev.shortage};

    Object.entries(prev.shifts||{}).forEach(([dStr,day])=>{
      const d=parseInt(dStr);
      if(!day) return;
      const dayShortage={...(prev.shortage[d]||{morning:0,prep:0,night:{},aisani:0,kitchen:0})};
      dayShortage.night={...(dayShortage.night||{})};
      let dayChanged=false;
      let newDay={...day,night:{...(day.night||{})}};

      // 朝: availがなくなった人を除去
      const validMorning=(day.morning||[]).filter(id=>!!avail[id]?.[`${d}_morning`]);
      const removedM=(day.morning||[]).length-validMorning.length;
      if(removedM>0){dayShortage.morning=(dayShortage.morning||0)+removedM;newDay.morning=validMorning;dayChanged=true;}

      // 朝仕込み: availがなくなった人を除去
      const validPrep=(day.prep||[]).filter(id=>!!avail[id]?.[`${d}_prep`]||!!avail[id]?.[`${d}_shimikomi`]);
      const removedP=(day.prep||[]).length-validPrep.length;
      if(removedP>0){dayShortage.prep=(dayShortage.prep||0)+removedP;newDay.prep=validPrep;dayChanged=true;}

      // 夜: availがなくなった人を除去（nightCompatで割り当てられた可能性があるため互換性チェック）
      Object.entries(day.night||{}).forEach(([t,id])=>{
        if(id){
          const hasCompatNight=NIGHT_TIMES.some(nt=>!!avail[id]?.[`${d}_night_${nt}`]&&nightCompat(nt,t));
          if(!hasCompatNight){
            delete newDay.night[t];
            dayShortage.night[t]=(dayShortage.night[t]||0)+1;
            dayChanged=true;
          }
        }
      });

      // アイサニ: availがなくなった人を除去
      if(day.aisani&&!avail[day.aisani]?.[`${d}_aisani`]&&!NIGHT_TIMES.some(t=>!!avail[day.aisani]?.[`${d}_night_${t}`])){
        newDay.aisani=null;dayShortage.aisani=(dayShortage.aisani||0)+1;dayChanged=true;
      }

      // キッチン: availがなくなった人を除去
      if(day.kitchen&&!avail[day.kitchen]?.[`${d}_kitchen`]){
        newDay.kitchen=null;dayShortage.kitchen=(dayShortage.kitchen||0)+1;dayChanged=true;
      }

      // 不足補充: 朝（朝が2人未満なら新規追加候補で補充）
      const morningNeed=Math.max(0,2-newDay.morning.length);
      if(morningNeed>0){
        const alreadyDay=new Set([...newDay.morning,...newDay.prep,...Object.values(newDay.night).filter(Boolean)]);
        const cands=staff.filter(s=>newlyAdded(s.id,`${d}_morning`)&&!alreadyDay.has(s.id));
        const fill=cands.slice(0,morningNeed);
        if(fill.length>0){newDay.morning=[...newDay.morning,...fill.map(s=>s.id)];dayShortage.morning=Math.max(0,(dayShortage.morning||0)-fill.length);dayChanged=true;}
      }

      // 不足補充: 朝仕込み（prepが0人なら新規追加候補で補充）
      if(newDay.prep.length===0){
        const alreadyDay=new Set([...newDay.morning,...Object.values(newDay.night).filter(Boolean)]);
        const cands=staff.filter(s=>(newlyAdded(s.id,`${d}_prep`)||newlyAdded(s.id,`${d}_shimikomi`))&&!alreadyDay.has(s.id));
        if(cands.length>0){newDay.prep=[cands[0].id];dayShortage.prep=0;dayChanged=true;}
      }

      // 不足補充: 夜（設定された時間帯が空なら新規追加候補で補充）
      (nightSlotConfig[d]||[]).forEach(t=>{
        if(!newDay.night[t]){
          const alreadyDay=new Set([...newDay.morning,...newDay.prep,...Object.values(newDay.night).filter(Boolean)]);
          const cands=staff.filter(s=>!alreadyDay.has(s.id)&&NIGHT_TIMES.some(nt=>newlyAdded(s.id,`${d}_night_${nt}`)&&nightCompat(nt,t)));
          if(cands.length>0){newDay.night[t]=cands[0].id;if(dayShortage.night[t]!==undefined)dayShortage.night[t]=0;dayChanged=true;}
        }
      });

      // 不足補充: アイサニ（設定あり・未割当なら補充）
      if(!newDay.aisani&&aisaniConfig[d]?.enabled){
        const alreadyDay=new Set([...newDay.morning,...newDay.prep,...Object.values(newDay.night).filter(Boolean)]);
        const cands=staff.filter(s=>s.aisaniOK&&newlyAdded(s.id,`${d}_aisani`)&&!alreadyDay.has(s.id));
        if(cands.length>0){newDay.aisani=cands[0].id;dayShortage.aisani=0;dayChanged=true;}
      }

      // 不足補充: キッチン（設定あり・未割当なら補充）
      if(!newDay.kitchen&&kitchenConfig[d]?.enabled){
        const alreadyDay=new Set([...newDay.morning,...newDay.prep,...Object.values(newDay.night).filter(Boolean)]);
        if(newDay.aisani) alreadyDay.add(newDay.aisani);
        const cands=staff.filter(s=>s.kitchenOK&&newlyAdded(s.id,`${d}_kitchen`)&&!alreadyDay.has(s.id));
        if(cands.length>0){newDay.kitchen=cands[0].id;dayShortage.kitchen=0;dayChanged=true;}
      }

      if(dayChanged){anyChanged=true;newShifts[d]=newDay;newShortage[d]=dayShortage;}
    });

    if(!anyChanged) return;
    const next={...prev,shifts:newShifts,shortage:newShortage,savedAt:Date.now()};
    setResult(next);
    saveResultLS(next,ymRef.current);
    debounceSave(`resultBackup_${ymRef.current}`,serializeResult(next));
  },[avail]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── 状態変更 → localStorage即時保存 + Firebase保存（debounce）
  const updateStaff=val=>{const s=sortByGrade(val);setStaff(s);debounceSave('staff',s);};
  const updateAvail=(val,changedSid)=>{
    const ts=Date.now();
    setAvail(val);
    const avKey=`avail_${ymRef.current}`;
    // allDataRefの最新Firebaseスナップショットとマージしてローカルストレージに保存
    // avail状態が空のうちに保存しても他スタッフのデータが消えない
    const fbSnap=allDataRef.current[avKey];
    const fbOthers=(fbSnap&&typeof fbSnap==='object')
      ?Object.fromEntries(Object.entries(fbSnap).filter(([k])=>k!=='_ts'))
      :{};
    const toSave={...fbOthers,...val,_ts:ts};
    saveCfgLS(avKey,toSave);
    if(changedSid){
      // 変更したスタッフのサブパスのみFirebaseに書き込む（他スタッフのエントリを絶対に上書きしない）
      clearTimeout(saveTimers.current[avKey]);
      setSyncing(true);
      pendingKeys.current.add(avKey);
      saveTimers.current[avKey]=setTimeout(async()=>{
        try{
          await Promise.all([
            saveKey(`${avKey}/${changedSid}`,val[changedSid]||null),
            saveKey(`${avKey}/_ts`,ts),
          ]);
        }catch(e){console.warn('save error',e);}
        pendingKeys.current.delete(avKey);
        setSyncing(pendingKeys.current.size>0);
      },600);
    } else {
      debounceSave(avKey,toSave);
    }
  };
  const updateNightSlot=val=>{
    setNightSlotConfig(val);
    saveCfgLS(`nightSlotConfig_${ymRef.current}`,val);
    debounceSave(`nightSlotConfig_${ymRef.current}`,val);
  };
  const updateAisaniCfg=val=>{setAisaniConfig(val);saveCfgLS(`aisaniConfig_${ymRef.current}`,val);debounceSave(`aisaniConfig_${ymRef.current}`,val);};
  const updateKitchenCfg=val=>{setKitchenConfig(val);saveCfgLS(`kitchenConfig_${ymRef.current}`,val);debounceSave(`kitchenConfig_${ymRef.current}`,val);};
  const updateDayTypeCfg=val=>{setDayTypeConfig(val);saveCfgLS(`dayTypeConfig_${ymRef.current}`,val);debounceSave(`dayTypeConfig_${ymRef.current}`,val);};
  const updateYearMonth=(y,m)=>{
    // pendingYmRefを即座に新しい月に更新（レンダー前にFirebase購読が発火しても正しい月を参照できる）
    pendingYmRef.current=`${y}_${m}`;
    // 手動で月を変えた印をつける（以後FirebaseのyearMonth変更でローカル月を上書きしない）
    localMonthSet.current=true;
    // 月切替前に現在月のresultをFirebaseへ即時フラッシュ（600msデバウンスをキャンセルして即保存）
    const curYm=ymRef.current;
    const rbKey=`resultBackup_${curYm}`;
    clearTimeout(saveTimers.current[rbKey]);
    delete saveTimers.current[rbKey];
    pendingKeys.current.delete(rbKey);
    if(resultRef.current){
      const r=resultRef.current;
      // resultが現在月のものであることを確認（月切替前の誤フラッシュ防止）
      if(r.year===undefined||`${r.year}_${r.month}`===curYm){
        saveKey(rbKey,serializeResult(r)).catch(e=>console.warn('flush save error',e));
      }
    }
    gmMonthRef.current={y,m};
    saveGMMonth(y,m);
    setYear(y);setMonth(m);
    // yearMonthをFirebaseへ即時書き込み（debounceSaveでなくsaveKey直呼び）
    // これにより購読コールバックが即座に再発火し、新しい月のデータがFirebaseから読み込まれる
    // 600msのデバウンス待ちをなくすことでページ再読み込み直後でも即時反映される
    saveKey('yearMonth',{y,m}).catch(e=>console.warn('yearMonth save error',e));
    // 新しい月のデータをlocalStorageから即座にロード（Firebaseのネットワーク待ちなしで表示）
    const newYm=`${y}_${m}`;
    setNightSlotConfig(loadCfgLS(`nightSlotConfig_${newYm}`)||{});
    setAisaniConfig(loadCfgLS(`aisaniConfig_${newYm}`)||{});
    setKitchenConfig(loadCfgLS(`kitchenConfig_${newYm}`)||{});
    setDayComments(loadCfgLS(`dayComments_${newYm}`)||{});
    setDayTypeConfig(loadCfgLS(`dayTypeConfig_${newYm}`)||{});
    setStarOverrides(loadCfgLS(`starOverrides_${newYm}`)||{});
    const {_ts:__ts,...rawAvail}=loadCfgLS(`avail_${newYm}`)||{};setAvail(rawAvail);
    const rawCS=loadCfgLS(`confirmedShift_${newYm}`);
    setConfirmedShift(rawCS?deserializeConfirmedShift(rawCS):null);
    prevAvailRef.current={};
    setResult(loadResultLS(newYm)||null);
  };
  const updateDayComments=val=>{
    setDayComments(val);
    saveCfgLS(`dayComments_${ymRef.current}`,val);
    debounceSave(`dayComments_${ymRef.current}`,val);
  };
  const updateStarOverrides=val=>{
    setStarOverrides(val);
    saveCfgLS(`starOverrides_${ymRef.current}`,val);
    debounceSave(`starOverrides_${ymRef.current}`,val);
  };
  const toggleStar=(d,type,sid)=>{
    const cur=(starOverrides[d]||{})[type];
    const next=cur===sid?"none":sid;
    updateStarOverrides({...starOverrides,[d]:{...(starOverrides[d]||{}),[type]:next}});
  };
  const dismissShortage=useCallback((d,slotType,slotTime=null)=>{
    const prev=resultRef.current;
    if(!prev) return;
    const newShortage={...prev.shortage,[d]:{...(prev.shortage[d]||{})}};
    if(slotType==='night') newShortage[d]={...newShortage[d],night:{...(newShortage[d]?.night||{}),[slotTime]:0}};
    else newShortage[d]={...newShortage[d],[slotType]:0};
    const next={...prev,shortage:newShortage,savedAt:Date.now()};
    setResult(next);
    saveResultLS(next,ymRef.current);
    debounceSave(`resultBackup_${ymRef.current}`,serializeResult(next));
  },[]);
  const handleGmLogin=()=>{
    if(pwInput===GM_PASSWORD){
      setGmMode(true);setView("slots");
      setPwModal(false);setPwInput("");setPwError(false);
      const saved=loadGMMonth()||getJSTCalendarMonth();
      updateYearMonth(saved.y,saved.m);
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

  // スタッフのシフト閲覧専用: allDataRefから対象月のconfirmedShiftを取得
  const staffShiftViewYm=`${staffShiftViewY}_${staffShiftViewM}`;
  const staffViewCS=deserializeConfirmedShift(allDataRef.current[`confirmedShift_${staffShiftViewYm}`])||null;
  // コメントも表示月に合わせてallDataRef経由で取得（GMが別月に切り替えても消えないように）
  const staffViewDayComments=allDataRef.current[`dayComments_${staffShiftViewYm}`]||loadCfgLS(`dayComments_${staffShiftViewYm}`)||{};
  const staffShiftViewPrev=()=>{const [y,m]=staffShiftViewM===0?[staffShiftViewY-1,11]:[staffShiftViewY,staffShiftViewM-1];setStaffShiftViewY(y);setStaffShiftViewM(m);};
  const staffShiftViewNext=()=>{const [y,m]=staffShiftViewM===11?[staffShiftViewY+1,0]:[staffShiftViewY,staffShiftViewM+1];setStaffShiftViewY(y);setStaffShiftViewM(m);};
  // JSTカレンダー月が変わった瞬間にシフト表示も切り替え（候補日入力の20日ルールとは独立）
  const staffShiftAutoRef=useRef(getJSTCalendarMonth());
  useEffect(()=>{
    const id=setInterval(()=>{
      const cur=getJSTCalendarMonth();
      const prev=staffShiftAutoRef.current;
      if(cur.y!==prev.y||cur.m!==prev.m){
        staffShiftAutoRef.current=cur;
        setStaffShiftViewY(cur.y);
        setStaffShiftViewM(cur.m);
      }
    },60000);
    return()=>clearInterval(id);
  },[]);


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
        @keyframes loadIn{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:none}}
        @keyframes loadOut{from{opacity:1;transform:none}to{opacity:0;transform:scale(1.06)}}
        .main-content{animation:mainIn .5s cubic-bezier(.22,1,.36,1)}
        @keyframes mainIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        .sth{position:sticky;top:0;background:rgba(253,250,246,0.97);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:5}
        .avail-row:hover td{background:rgba(139,26,26,0.03)!important}
        .inp{outline:none;transition:border-color .2s,box-shadow .2s}
        .inp:focus{border-color:#8b1a1a!important;box-shadow:0 0 0 3px rgba(139,26,26,0.12)!important}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:rgba(139,26,26,0.2);border-radius:4px}
      `}</style>

      {/* ── ローディングオーバーレイ */}
      {(loading||loadingFading)&&(
        <div style={{position:"fixed",inset:0,zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",
          animation:loadingFading?"loadOut .65s cubic-bezier(.4,0,1,1) forwards":"none",
          pointerEvents:loadingFading?"none":"auto"}}>
          <div style={{position:"absolute",inset:0,backgroundImage:"url(/imari.jpeg)",backgroundSize:"cover",backgroundPosition:"center top",backgroundRepeat:"no-repeat"}}/>
          <div style={{position:"absolute",inset:0,background:"rgba(255,255,255,0.18)"}}/>
          <div style={{position:"absolute",bottom:"12vh",left:0,right:0,zIndex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
            <div style={{background:"rgba(255,255,255,0.85)",borderRadius:999,padding:"10px 36px",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",boxShadow:"0 4px 24px rgba(139,26,26,0.12)"}}>
              <div style={{fontSize:13,letterSpacing:6,color:C.accent,fontWeight:700,fontFamily:"serif",textAlign:"center"}}>読み込み中...</div>
            </div>
            <div style={{fontSize:11,letterSpacing:4,color:"rgba(139,26,26,0.55)",fontFamily:"sans-serif",fontWeight:600}}>Loading...</div>
          </div>
        </div>
      )}

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

      {/* シフトプレビューパスワードモーダル */}
      {shiftPreviewModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={e=>{if(e.target===e.currentTarget){setShiftPreviewModal(false);setShiftPreviewPwInput("");setShiftPreviewPwError(false);}}}>
          <div className="fi" style={{...card,padding:"32px 28px",width:300,boxShadow:"0 24px 64px rgba(0,0,0,0.18)"}}>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{width:52,height:52,borderRadius:26,background:"linear-gradient(135deg,#8b1a1a,#b8860b)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:12,boxShadow:"0 0 20px rgba(139,26,26,0.25)"}}>📆</div>
              <div style={{fontSize:15,fontWeight:900,color:C.text}}>全体シフト確認</div>
              <div style={{fontSize:11,color:C.muted,marginTop:4}}>パスワードを入力してください</div>
            </div>
            <input className="inp" type="password" inputMode="numeric" maxLength={4} value={shiftPreviewPwInput}
              onChange={e=>{setShiftPreviewPwInput(e.target.value.replace(/\D/g,"").slice(0,4));setShiftPreviewPwError(false);}}
              onKeyDown={e=>{if(e.key==="Enter"){if(shiftPreviewPwInput===SHIFT_PREVIEW_PASSWORD){setShiftPreviewOpen(true);setShiftPreviewModal(false);setShiftPreviewPwInput("");}else{setShiftPreviewPwError(true);setShiftPreviewPwInput("");}}}}
              placeholder="••••" autoFocus
              style={{width:"100%",padding:"14px 16px",borderRadius:12,border:`1.5px solid ${shiftPreviewPwError?"#ef4444":"rgba(139,26,26,0.15)"}`,
                background:"#fdfaf6",color:C.text,fontSize:22,textAlign:"center",letterSpacing:8,marginBottom:8}}/>
            {shiftPreviewPwError&&<div style={{fontSize:11,color:"#ef4444",marginBottom:10,textAlign:"center"}}>パスワードが違います</div>}
            <div style={{display:"flex",gap:8,marginTop:8}}>
              <button onClick={()=>{setShiftPreviewModal(false);setShiftPreviewPwInput("");setShiftPreviewPwError(false);}}
                style={{...btn(false),flex:1,padding:"11px",borderRadius:12,fontSize:13}}>戻る</button>
              <button onClick={()=>{if(shiftPreviewPwInput===SHIFT_PREVIEW_PASSWORD){setShiftPreviewOpen(true);setShiftPreviewModal(false);setShiftPreviewPwInput("");}else{setShiftPreviewPwError(true);setShiftPreviewPwInput("");}}}
                style={{flex:1,padding:"11px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#8b1a1a,#b8860b)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:800,boxShadow:"0 4px 16px rgba(139,26,26,0.3)"}}>
                確認
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ヘッダー */}
      <div className="main-content" style={{background:"rgba(253,250,246,0.95)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",borderBottom:"1px solid rgba(139,26,26,0.12)",padding:"12px 16px",position:"sticky",top:0,zIndex:30}}>
        <div style={{maxWidth:900,margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:(gmMode||(!gmMode&&loginStaff)||(!gmMode&&!loginStaff))?10:0}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:38,height:38,borderRadius:11,background:"linear-gradient(135deg,#8b1a1a,#b8860b)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:19,boxShadow:"0 2px 12px rgba(139,26,26,0.25)",flexShrink:0}}>🍶</div>
              <div>
                <div style={{fontSize:8,letterSpacing:5,fontWeight:800,textTransform:"uppercase",color:C.gold}}>旬菜 いまり</div>
                <div style={{fontSize:18,fontWeight:900,lineHeight:1.15,color:C.text}}>{year}年{month+1}月</div>
              </div>
              {gmMode&&<div style={{display:"flex",gap:3,marginLeft:2}}>
                <button onClick={prevMonth} style={{...btn(false),padding:"5px 12px",fontSize:16,borderRadius:10}}>‹</button>
                <button onClick={nextMonth} style={{...btn(false),padding:"5px 12px",fontSize:16,borderRadius:10}}>›</button>
              </div>}
            </div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <div style={{display:"flex",background:"rgba(139,26,26,0.05)",borderRadius:999,padding:3,gap:2,border:"1px solid rgba(139,26,26,0.1)"}}>
                <button onClick={()=>{if(gmMode)return;setPwModal(true);}} style={{...btn(gmMode,"linear-gradient(135deg,#8b1a1a,#b8860b)"),fontSize:11,padding:"5px 14px",borderRadius:999}}>管理者</button>
                <button onClick={()=>{gmMonthRef.current={y:year,m:month};saveGMMonth(year,month);setGmMode(false);setView("avail");setLoginStaff(null);const a=getAutoMonth();setYear(a.y);setMonth(a.m);pendingYmRef.current=`${a.y}_${a.m}`;const sYm=`${a.y}_${a.m}`;setNightSlotConfig(loadCfgLS(`nightSlotConfig_${sYm}`)||{});setAisaniConfig(loadCfgLS(`aisaniConfig_${sYm}`)||{});setKitchenConfig(loadCfgLS(`kitchenConfig_${sYm}`)||{});setDayTypeConfig(loadCfgLS(`dayTypeConfig_${sYm}`)||{});prevAvailRef.current={};const{_ts:_,...staffAvail}=loadCfgLS(`avail_${sYm}`)||{};setAvail(staffAvail);}} style={{...btn(!gmMode,"linear-gradient(135deg,#1b2a5e,#2d4a9e)"),fontSize:11,padding:"5px 14px",borderRadius:999}}>スタッフ</button>
              </div>
              {gmMode&&<button onClick={()=>setStaffPanelOpen(v=>!v)} style={{...btn(staffPanelOpen,"rgba(139,26,26,0.15)"),fontSize:11,padding:"7px 14px",border:staffPanelOpen?"none":`1px solid rgba(139,26,26,0.15)`}}>👥 スタッフ</button>}
            </div>
          </div>

          {!gmMode&&!loginStaff&&(
            <div style={{paddingBottom:6}}>
              {shiftPreviewOpen?(
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <div style={{fontSize:11,color:C.muted,fontWeight:700}}>📆 全体シフト確認中</div>
                  <button onClick={()=>setShiftPreviewOpen(false)}
                    style={{...btn(false),fontSize:10,padding:"4px 12px",borderRadius:999,border:"1px solid rgba(139,26,26,0.2)"}}>
                    ✕ 閉じる
                  </button>
                </div>
              ):(
                <>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontSize:11,color:C.muted}}>名前を選んでください</div>
                    <button onClick={()=>{setShiftPreviewModal(true);setShiftPreviewPwInput("");setShiftPreviewPwError(false);}}
                      style={{...btn(false),fontSize:10,padding:"4px 12px",borderRadius:999,border:"1px solid rgba(139,26,26,0.2)"}}>
                      📆 シフト確認
                    </button>
                  </div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {staffModeStaff.map(s=>(
                      <button key={s.id} onClick={()=>handleStaffSelect(s)} style={{...btn(false),fontSize:12,padding:"8px 18px",borderRadius:999}}>
                        {s.name}{s.password?<span style={{fontSize:9,marginLeft:4,opacity:.5}}>🔒</span>:""}
                      </button>
                    ))}
                  </div>
                </>
              )}
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
                  {s.grade==='J'&&(
                    <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:s.showClover!==false?"#22c55e":C.muted,cursor:"pointer"}}>
                      <input type="checkbox" checked={s.showClover!==false} onChange={e=>updateStaff(staff.map(x=>x.id===s.id?{...x,showClover:e.target.checked}:x))}/>🍀表示
                    </label>
                  )}
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
                const manualClosed=dayTypeConfig[d]==="closed";
                const morningClosed=dayTypeConfig[d]==="morning_closed";
                const slots=nightSlotConfig[d]||[];
                const aiOn=aisaniConfig[d]?.enabled;
                const kitOn=kitchenConfig[d]?.enabled;
                const allClosed=closed||manualClosed;
                const active=slots.length>0||aiOn||kitOn||morningClosed;
                return(
                  <div key={d} style={{borderRadius:12,padding:"5px 3px",transition:"all .2s",
                    background:allClosed?(aiOn?"rgba(139,26,26,0.05)":"#f5f0eb"):morningClosed?"rgba(251,146,60,0.06)":active?"rgba(139,26,26,0.05)":"#fff",
                    border:`1px solid ${allClosed?(aiOn?"rgba(139,26,26,0.25)":"rgba(139,26,26,0.06)"):morningClosed?"rgba(251,146,60,0.4)":active?"rgba(139,26,26,0.25)":hol?"rgba(184,134,11,0.2)":dow===0?"rgba(192,57,43,0.18)":dow===6?"rgba(27,42,94,0.15)":"rgba(139,26,26,0.08)"}`,
                    minHeight:80,opacity:allClosed&&!aiOn?0.35:1,
                    boxShadow:active||aiOn?"0 2px 10px rgba(139,26,26,0.1)":"0 1px 4px rgba(0,0,0,0.04)"}}>
                    <div style={{textAlign:"center",fontSize:11,fontWeight:800,marginBottom:3,
                      color:allClosed?"#b0a090":morningClosed?"#ea580c":hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                      {d}{hol?"🎌":""}{allClosed?"🔒":""}
                    </div>
                    {!allClosed&&morningClosed&&(
                      <div style={{textAlign:"center",fontSize:7,fontWeight:800,color:"#ea580c",marginBottom:3,padding:"1px 4px",background:"rgba(251,146,60,0.12)",borderRadius:4}}>朝営業休み</div>
                    )}
                    {!allClosed&&!morningClosed&&(
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
                    {!allClosed&&morningClosed&&(
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
                    <div style={{display:"flex",gap:2,justifyContent:"center",marginBottom:2}}>
                      <button onClick={()=>toggleAisani(d)}
                        style={{padding:"2px 5px",borderRadius:5,border:"none",cursor:"pointer",fontSize:7,fontWeight:800,
                          background:aiOn?"#8b1a1a":"rgba(139,26,26,0.07)",color:aiOn?"#fff":"#8c7b6b",
                          transition:"all .15s"}}>
                        アイサニ
                      </button>
                      {!allClosed&&(
                        <button onClick={()=>toggleKitchen(d)}
                          style={{padding:"2px 5px",borderRadius:5,border:"none",cursor:"pointer",fontSize:7,fontWeight:800,
                            background:kitOn?"#276749":"rgba(39,103,73,0.08)",color:kitOn?"#fff":"#8c7b6b",
                            transition:"all .15s"}}>
                          キッチン
                        </button>
                      )}
                    </div>
                    {!closed&&(
                      <div style={{display:"flex",gap:2,justifyContent:"center"}}>
                        <button onClick={()=>toggleDayType(d,"morning_closed")}
                          style={{padding:"2px 4px",borderRadius:5,border:"none",cursor:"pointer",fontSize:7,fontWeight:800,
                            background:morningClosed?"#ea580c":"rgba(234,88,12,0.08)",color:morningClosed?"#fff":"#ea580c",
                            transition:"all .15s"}}>
                          朝休
                        </button>
                        <button onClick={()=>toggleDayType(d,"closed")}
                          style={{padding:"2px 4px",borderRadius:5,border:"none",cursor:"pointer",fontSize:7,fontWeight:800,
                            background:manualClosed?"#64748b":"rgba(100,116,139,0.1)",color:manualClosed?"#fff":"#64748b",
                            transition:"all .15s"}}>
                          休業
                        </button>
                      </div>
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
        {(gmMode?view==="avail":(!gmMode&&loginStaff&&staffTab==="avail"))&&(
          <div className="fi">
            {gmMode&&(
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:14}}>
                {staff.map(s=>{
                  const isSelected=(selectedStaffTab===s.id)||(selectedStaffTab===null&&s.id===staff[0]?.id);
                  const hasAvail=Object.values(avail[s.id]||{}).some(Boolean);
                  return(
                    <button key={s.id} onClick={()=>setSelectedStaffTab(s.id)}
                      style={{...btn(isSelected,GRADE_COLOR[s.grade]),fontSize:12,padding:"7px 16px",borderRadius:999,
                        color:isSelected?"#fff":hasAvail?C.muted:"#ef4444",
                        border:isSelected?"none":hasAvail?`1px solid ${GRADE_COLOR[s.grade]}30`:"1px solid #ef444440",
                      }}>
                      {s.name}
                    </button>
                  );
                })}
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
                          const manualClosed=dayTypeConfig[d]==="closed";
                          const morningClosed=dayTypeConfig[d]==="morning_closed";
                          const allClosed=closed||manualClosed;
                          const slots=nightSlotConfig[d]||[];
                          const rowBg=allClosed?"#f5f0eb":morningClosed?"rgba(251,146,60,0.04)":hol?"rgba(184,134,11,0.04)":dow===0?"rgba(192,57,43,0.03)":dow===6?"rgba(27,42,94,0.03)":"#fff";
                          return(
                            <tr key={d} className="avail-row" style={{borderBottom:"1px solid rgba(139,26,26,0.06)"}}>
                              <td style={{background:rowBg,textAlign:"center",fontSize:12,fontWeight:800,padding:"5px 2px",opacity:allClosed?0.4:1,
                                color:allClosed?"#b0a090":morningClosed?"#ea580c":hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                                {d}{hol?"🎌":""}{allClosed?"🔒":morningClosed?"☀":""}
                              </td>
                              <td style={{background:rowBg,textAlign:"center",fontSize:10,opacity:allClosed?0.4:1,color:allClosed?"#b0a090":C.muted}}>{DOW_JP[dow]}</td>
                              {allClosed?(
                                <>
                                  <td colSpan={3+NIGHT_TIMES.length} style={{background:rowBg,textAlign:"center",fontSize:10,color:"#b0a090",padding:"6px",opacity:0.4}}>{manualClosed?"休業日":"定休日"}</td>
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
                                      <div style={{width:34,height:28,borderRadius:8,background:"rgba(139,26,26,0.02)",margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                        <span style={{fontSize:9,color:"rgba(139,26,26,0.15)"}}>—</span>
                                      </div>
                                    </td>
                                  )}
                                </>
                              ):(
                                <>
                                  {(()=>{
                                    const prepOn=!!a[`${d}_prep`];
                                    const morningOn=!!a[`${d}_morning`];
                                    const shimikomiOn=!!a[`${d}_shimikomi`];
                                    return MORNING_TYPES.map(type=>{
                                      const on=!!a[`${d}_${type}`];
                                      const mcLocked=morningClosed&&(type==="morning"||type==="prep");
                                      const locked=mcLocked||(type==="prep"?(morningOn||shimikomiOn)&&!on:prepOn&&!on);
                                      const col=type==="morning"?"#b07d12":type==="prep"?"#276749":"#5b7fa6";
                                      return(
                                        <td key={type} style={{background:rowBg,textAlign:"center",padding:"3px 5px"}}>
                                          <button onClick={()=>!locked&&toggleMorningTypeAvail(sid,d,type)}
                                            style={{width:34,height:28,borderRadius:8,
                                              border:on?"none":`1px solid ${col}90`,
                                              cursor:locked?"not-allowed":"pointer",fontSize:13,fontWeight:800,
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
          const shiftNavHeader=(
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginTop:16,marginBottom:4}}>
              <button onClick={staffShiftViewPrev} style={{...btn(false),padding:"4px 14px",fontSize:16,borderRadius:10}}>‹</button>
              <span style={{fontWeight:900,fontSize:16}}>{staffShiftViewY}年{staffShiftViewM+1}月</span>
              <button onClick={staffShiftViewNext} style={{...btn(false),padding:"4px 14px",fontSize:16,borderRadius:10}}>›</button>
            </div>
          );
          if(!staffViewCS) return(
            <>{shiftNavHeader}
            <div style={{...card,marginTop:8,textAlign:"center",padding:"48px 20px"}}>
              <div style={{fontSize:36,marginBottom:14}}>📋</div>
              <div style={{fontSize:14,color:C.muted}}>シフトが公開されていません</div>
              <div style={{fontSize:11,color:C.muted,marginTop:6,opacity:.7}}>管理者がシフトを公開すると表示されます</div>
            </div></>
          );
          const sid=loginStaff.id;
          const csYear=staffViewCS.year;
          const csMonth=staffViewCS.month;
          const myDays=[];
          const csdays=daysIn(csYear,csMonth);
          for(let d=1;d<=csdays;d++){
            const day=staffViewCS.shifts[d];
            if(!day) continue;
            const inMorning=day.morning?.includes(sid)||day.morning?.includes(Number(sid));
            const inPrep=day.prep?.includes(sid)||day.prep?.includes(Number(sid));
            const inNight=day.night&&Object.values(day.night).some(id=>id===sid||Number(id)===sid);
            const inAisani=day.aisani===sid||Number(day.aisani)===sid;
            const inKitchen=day.kitchen===sid||Number(day.kitchen)===sid;
            if(!inMorning&&!inPrep&&!inNight&&!inAisani&&!inKitchen) continue;
            // 🌟計算
            const myMP=(day.morning||[]).map(id=>staffMap[id]||staffMap[Number(id)]).filter(Boolean);
            const myMAT=myMP.length?myMP.reduce((b,s)=>GRADE_SORT[s.grade]<GRADE_SORT[b.grade]?s:b):null;
            const myMOv=(starOverrides[d]||{}).morning;
            const myMStar=myMOv==="none"?null:(myMOv??myMAT?.id??null);
            let myNStar=null;
            for(const nt of NIGHT_ORDER){const pid=day.night?.[nt];if(!pid)continue;const ps=staffMap[pid]||staffMap[Number(pid)];if(ps?.grade!=='J'){myNStar=pid;break;}}
            const myNOv=(starOverrides[d]||{}).night;
            if(myNOv==="none")myNStar=null;else if(myNOv)myNStar=myNOv;
            const groups=[];
            if(inMorning||inPrep){
              const morningMembers=[];
              (day.morning||[]).forEach(id=>{const s=staffMap[id]||staffMap[Number(id)];if(s) morningMembers.push({person:s,time:"朝（7:00〜11:00）",isStar:(id===myMStar||Number(id)===myMStar),isJ:s.grade==='J'&&s.showClover!==false});});
              (day.prep||[]).forEach(id=>{const s=staffMap[id]||staffMap[Number(id)];if(s) morningMembers.push({person:s,time:"朝仕込み（8:30〜16:00）",isStar:false,isJ:s.grade==='J'&&s.showClover!==false});});
              groups.push({label:"朝・朝仕込み",color:"#f97316",night:true,members:morningMembers});
            }
            if(inNight){
              const nightMembers=[];
              NIGHT_ORDER.forEach(t=>{const id=day.night[t];if(id!=null){const s=staffMap[id]||staffMap[Number(id)];if(s) nightMembers.push({person:s,time:t,isStar:(id===myNStar||Number(id)===myNStar),isJ:s.grade==='J'});}});
              // カスタム夜枠（NIGHT_ORDERにない時間）も含める
              Object.keys(day.night||{}).filter(t=>!NIGHT_ORDER.includes(t)).sort((a,b)=>{const da=slotDisplayTime(a),db=slotDisplayTime(b);return da<db?-1:da>db?1:a<b?-1:1}).forEach(t=>{const id=day.night[t];if(id!=null){const s=staffMap[id]||staffMap[Number(id)];if(s) nightMembers.push({person:s,time:slotDisplayTime(t),isStar:false,isJ:s.grade==='J'});}});
              groups.push({label:"夜",color:"#3b82f6",night:true,members:nightMembers});
            }
            if(inAisani){const s=staffMap[day.aisani]||staffMap[Number(day.aisani)];groups.push({label:"アイサニ",color:"#10b981",members:s?[s]:[]});}
            if(inKitchen){const s=staffMap[day.kitchen]||staffMap[Number(day.kitchen)];groups.push({label:"キッチン",color:"#276749",members:s?[s]:[]});}
            myDays.push({d,dow:getDow(csYear,csMonth,d),groups});
          }
          return(
            <>{shiftNavHeader}
            <div style={{...card,marginTop:8}}>
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
                                ? g.members.map(({person,time,isStar,isJ},i)=>(
                                    <span key={i} style={{fontSize:12,fontWeight:700,padding:"4px 11px",borderRadius:999,
                                      background:(person.id===sid||Number(person.id)===sid)?g.color:"rgba(59,130,246,0.08)",
                                      color:(person.id===sid||Number(person.id)===sid)?"#fff":C.text,
                                      border:`1px solid ${g.color}${(person.id===sid||Number(person.id)===sid)?"":"30"}`}}>
                                      {time} {isStar?'🌟':''}{isJ?'🍀':''}{person.name}
                                    </span>
                                  ))
                                : g.members.map((person,i)=>(
                                    <span key={i} style={{fontSize:12,fontWeight:700,padding:"4px 11px",borderRadius:999,
                                      background:(person.id===sid||Number(person.id)===sid)?g.color:"rgba(0,0,0,0.04)",
                                      color:(person.id===sid||Number(person.id)===sid)?"#fff":C.text,
                                      border:`1px solid ${g.color}${(person.id===sid||Number(person.id)===sid)?"":"20"}`}}>
                                      {person.grade==='J'&&person.showClover!==false?'🍀':''}{person.name}
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
            </>
          );
        })()}

        {/* ── スタッフ 全体シフト表示 */}
        {!gmMode&&loginStaff&&staffTab==="full"&&(()=>{
          const shiftNavHeader=(
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginTop:16,marginBottom:4}}>
              <button onClick={staffShiftViewPrev} style={{...btn(false),padding:"4px 14px",fontSize:16,borderRadius:10}}>‹</button>
              <span style={{fontWeight:900,fontSize:16}}>{staffShiftViewY}年{staffShiftViewM+1}月</span>
              <button onClick={staffShiftViewNext} style={{...btn(false),padding:"4px 14px",fontSize:16,borderRadius:10}}>›</button>
            </div>
          );
          if(!staffViewCS) return(
            <>{shiftNavHeader}
            <div style={{...card,marginTop:8,textAlign:"center",padding:"48px 20px"}}>
              <div style={{fontSize:36,marginBottom:14}}>📆</div>
              <div style={{fontSize:14,color:C.muted}}>シフトが公開されていません</div>
              <div style={{fontSize:11,color:C.muted,marginTop:6,opacity:.7}}>管理者がシフトを公開すると表示されます</div>
            </div></>
          );
          const csYear=staffViewCS.year;
          const csMonth=staffViewCS.month;
          const csdays=daysIn(csYear,csMonth);
          const sid=loginStaff.id;
          return(
            <>{shiftNavHeader}
            <div style={{marginTop:8}}>
              <div style={{textAlign:"center",marginBottom:14}}>
                <div style={{fontSize:10,letterSpacing:6,fontWeight:700,color:C.gold,marginBottom:4}}>🍶 旬菜いまり</div>
                <div style={{fontSize:20,fontWeight:900,color:C.text}}>{csYear}年{csMonth+1}月 シフト表</div>
              </div>
              {Array.from({length:csdays},(_,i)=>i+1).map(d=>{
                const dow=getDow(csYear,csMonth,d),hol=isHol(csYear,csMonth,d);
                const closed=isClosed(csYear,csMonth,d);
                const day=staffViewCS.shifts[d];
                if(!day&&closed) return null;
                const nightEntries=day?Object.entries(day.night||{}).filter(([,id])=>id!=null).sort(([a],[b])=>{const da=slotDisplayTime(a),db=slotDisplayTime(b);const ai=NIGHT_ORDER.indexOf(da),bi=NIGHT_ORDER.indexOf(db);return(ai>=0&&bi>=0)?ai!==bi?ai-bi:a<b?-1:a>b?1:0:da<db?-1:da>db?1:a<b?-1:1;}):[];
                const hasAisani=day&&day.aisani!=null;
                const hasKitchen=day&&day.kitchen!=null;
                if(!day&&!closed) return null;
                const myDay=day&&([...(day.morning||[]),...(day.prep||[])].some(id=>id===sid||Number(id)===sid)||
                  Object.values(day.night||{}).some(id=>id===sid||Number(id)===sid)||
                  day.aisani===sid||Number(day.aisani)===sid||day.kitchen===sid||Number(day.kitchen)===sid);
                const bc=myDay?"rgba(139,26,26,0.12)":hol?"rgba(184,134,11,0.08)":dow===0?"rgba(192,57,43,0.06)":dow===6?"rgba(27,42,94,0.06)":"rgba(139,26,26,0.04)";
                const borderCol=myDay?C.accent:hol?"#b8860b40":dow===0?"#c0392b30":dow===6?"#1b2a5e30":"rgba(139,26,26,0.1)";
                // 🌟計算（confirmedShift用）
                const csMP=(day?.morning||[]).map(id=>staffMap[id]||staffMap[Number(id)]).filter(Boolean);
                const csMAT=csMP.length?csMP.reduce((b,s)=>GRADE_SORT[s.grade]<GRADE_SORT[b.grade]?s:b):null;
                const csMOv=(starOverrides[d]||{}).morning;
                const csMStar=csMOv==="none"?null:(csMOv??csMAT?.id??null);
                let csNStar=null;
                for(const nt of NIGHT_ORDER){const pid=day?.night?.[nt];if(!pid)continue;const ps=staffMap[pid]||staffMap[Number(pid)];if(ps?.grade!=='J'){csNStar=pid;break;}}
                const csNOv=(starOverrides[d]||{}).night;
                if(csNOv==="none")csNStar=null;else if(csNOv)csNStar=csNOv;
                return(
                  <div key={d} style={{background:"#fff",borderRadius:14,border:`1.5px solid ${borderCol}`,padding:"12px 14px",marginBottom:8,boxShadow:myDay?"0 2px 10px rgba(139,26,26,0.1)":"0 1px 4px rgba(0,0,0,0.03)"}}>
                    <div style={{marginBottom:(hasAisani||hasKitchen||!closed)?10:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
                        <span style={{fontWeight:900,fontSize:15,color:hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                          {csMonth+1}/{d}（{DOW_JP[dow]}）{hol?"🎌":""}
                        </span>
                        {closed&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(139,26,26,0.06)",color:C.muted,fontWeight:700,border:"1px solid rgba(139,26,26,0.12)"}}>定休日</span>}
                        {myDay&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(139,26,26,0.08)",color:C.accent,fontWeight:700,border:`1px solid ${C.accent}30`}}>出勤</span>}
                      </div>
                      {staffViewDayComments[d]&&<div style={{marginTop:5,fontSize:13,color:"#7a5c00",background:"rgba(184,134,11,0.07)",border:"1px solid rgba(184,134,11,0.18)",borderRadius:8,padding:"5px 10px",fontWeight:600,lineHeight:1.5}}>{staffViewDayComments[d]}</div>}
                    </div>
                    {day&&(
                      <div style={{display:"flex",flexDirection:"column",gap:5}}>
                        {!closed&&(day.morning||[]).length>0&&(
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:700,color:"#b07d12",background:"#b07d1218",borderRadius:999,padding:"3px 10px",border:"1px solid #b07d1230",minWidth:60,textAlign:"center",flexShrink:0}}>朝</span>
                            <span style={{fontSize:9,color:C.muted,flexShrink:0}}>7:00〜11:00</span>
                            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                              {(day.morning||[]).map(id=>{const s=staffMap[id]||staffMap[Number(id)];return s?(
                                <span key={id} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                                  background:(id===sid||Number(id)===sid)?C.accent:"rgba(176,125,18,0.08)",
                                  color:(id===sid||Number(id)===sid)?"#fff":"#b07d12",
                                  border:`1px solid ${(id===sid||Number(id)===sid)?C.accent:"#b07d1230"}`}}>{(id===csMStar||Number(id)===csMStar)?'🌟':''}{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                              ):null;})}
                            </div>
                          </div>
                        )}
                        {!closed&&(day.prep||[]).length>0&&(
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:700,color:"#276749",background:"#27674918",borderRadius:999,padding:"3px 10px",border:"1px solid #27674930",minWidth:60,textAlign:"center",flexShrink:0}}>朝仕込み</span>
                            <span style={{fontSize:9,color:C.muted,flexShrink:0}}>8:30〜16:00</span>
                            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                              {(day.prep||[]).map(id=>{const s=staffMap[id]||staffMap[Number(id)];return s?(
                                <span key={id} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                                  background:(id===sid||Number(id)===sid)?C.accent:"rgba(39,103,73,0.08)",
                                  color:(id===sid||Number(id)===sid)?"#fff":"#276749",
                                  border:`1px solid ${(id===sid||Number(id)===sid)?C.accent:"#27674930"}`}}>{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                              ):null;})}
                            </div>
                          </div>
                        )}
                        {hasKitchen&&(()=>{const s=staffMap[day.kitchen]||staffMap[Number(day.kitchen)];return s?(
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontSize:10,fontWeight:700,color:"#276749",background:"#27674918",borderRadius:999,padding:"3px 10px",border:"1px solid #27674930",minWidth:60,textAlign:"center",flexShrink:0}}>キッチン</span>
                            <span style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                              background:(day.kitchen===sid||Number(day.kitchen)===sid)?"#276749":"rgba(39,103,73,0.06)",
                              color:(day.kitchen===sid||Number(day.kitchen)===sid)?"#fff":C.text,
                              border:`1px solid ${(day.kitchen===sid||Number(day.kitchen)===sid)?"#276749":"#27674930"}`}}>{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                          </div>
                        ):null;})()}
                        {!closed&&nightEntries.map(([t,id])=>{const s=staffMap[id]||staffMap[Number(id)];const dt=slotDisplayTime(t);const nc=NIGHT_TC[dt]||"#64748b";return s?(
                          <div key={t} style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:700,color:nc,background:nc+"18",borderRadius:999,padding:"3px 10px",border:`1px solid ${nc}30`,minWidth:60,textAlign:"center",flexShrink:0}}>夜 {dt}</span>
                            <span key={id} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                              background:(id===sid||Number(id)===sid)?nc:"rgba(0,0,0,0.04)",
                              color:(id===sid||Number(id)===sid)?"#fff":C.text,
                              border:`1px solid ${(id===sid||Number(id)===sid)?nc:"rgba(0,0,0,0.1)"}`}}>{(id===csNStar||Number(id)===csNStar)?'🌟':''}{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                          </div>
                        ):null;})}
                        {hasAisani&&(()=>{const s=staffMap[day.aisani]||staffMap[Number(day.aisani)];return s?(
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontSize:10,fontWeight:700,color:C.accent,background:C.accent+"18",borderRadius:999,padding:"3px 10px",border:`1px solid ${C.accent}30`,minWidth:60,textAlign:"center",flexShrink:0}}>アイサニ</span>
                            <span style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,
                              background:(day.aisani===sid||Number(day.aisani)===sid)?C.accent:"rgba(139,26,26,0.06)",
                              color:(day.aisani===sid||Number(day.aisani)===sid)?"#fff":C.text,
                              border:`1px solid ${(day.aisani===sid||Number(day.aisani)===sid)?C.accent:"rgba(139,26,26,0.15)"}`}}>{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                          </div>
                        ):null;})()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            </>
          );
        })()}

        {/* ── 名前選択前シフトプレビュー */}
        {!gmMode&&!loginStaff&&shiftPreviewOpen&&(()=>{
          const shiftNavHeader=(
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginTop:16,marginBottom:4}}>
              <button onClick={staffShiftViewPrev} style={{...btn(false),padding:"4px 14px",fontSize:16,borderRadius:10}}>‹</button>
              <span style={{fontWeight:900,fontSize:16}}>{staffShiftViewY}年{staffShiftViewM+1}月</span>
              <button onClick={staffShiftViewNext} style={{...btn(false),padding:"4px 14px",fontSize:16,borderRadius:10}}>›</button>
            </div>
          );
          if(!staffViewCS) return(
            <>{shiftNavHeader}
            <div style={{...card,marginTop:8,textAlign:"center",padding:"48px 20px"}}>
              <div style={{fontSize:36,marginBottom:14}}>📆</div>
              <div style={{fontSize:14,color:C.muted}}>シフトが公開されていません</div>
              <div style={{fontSize:11,color:C.muted,marginTop:6,opacity:.7}}>管理者がシフトを公開すると表示されます</div>
            </div></>
          );
          const csYear=staffViewCS.year;
          const csMonth=staffViewCS.month;
          const csdays=daysIn(csYear,csMonth);
          return(
            <>{shiftNavHeader}
            <div style={{marginTop:8}}>
              <div style={{textAlign:"center",marginBottom:14}}>
                <div style={{fontSize:10,letterSpacing:6,fontWeight:700,color:C.gold,marginBottom:4}}>🍶 旬菜いまり</div>
                <div style={{fontSize:20,fontWeight:900,color:C.text}}>{csYear}年{csMonth+1}月 シフト表</div>
              </div>
              {Array.from({length:csdays},(_,i)=>i+1).map(d=>{
                const dow=getDow(csYear,csMonth,d),hol=isHol(csYear,csMonth,d);
                const closed=isClosed(csYear,csMonth,d);
                const day=staffViewCS.shifts[d];
                if(!day&&closed) return null;
                const nightEntries=day?Object.entries(day.night||{}).filter(([,id])=>id!=null).sort(([a],[b])=>{const da=slotDisplayTime(a),db=slotDisplayTime(b);const ai=NIGHT_ORDER.indexOf(da),bi=NIGHT_ORDER.indexOf(db);return(ai>=0&&bi>=0)?ai!==bi?ai-bi:a<b?-1:a>b?1:0:da<db?-1:da>db?1:a<b?-1:1;}):[];
                const hasAisani=day&&day.aisani!=null;
                const hasKitchen=day&&day.kitchen!=null;
                if(!day&&!closed) return null;
                const bc=hol?"rgba(184,134,11,0.08)":dow===0?"rgba(192,57,43,0.06)":dow===6?"rgba(27,42,94,0.06)":"rgba(139,26,26,0.04)";
                const borderCol=hol?"#b8860b40":dow===0?"#c0392b30":dow===6?"#1b2a5e30":"rgba(139,26,26,0.1)";
                const csMP=(day?.morning||[]).map(id=>staffMap[id]||staffMap[Number(id)]).filter(Boolean);
                const csMAT=csMP.length?csMP.reduce((b,s)=>GRADE_SORT[s.grade]<GRADE_SORT[b.grade]?s:b):null;
                const csMOv=(starOverrides[d]||{}).morning;
                const csMStar=csMOv==="none"?null:(csMOv??csMAT?.id??null);
                let csNStar=null;
                for(const nt of NIGHT_ORDER){const pid=day?.night?.[nt];if(!pid)continue;const ps=staffMap[pid]||staffMap[Number(pid)];if(ps?.grade!=='J'){csNStar=pid;break;}}
                const csNOv=(starOverrides[d]||{}).night;
                if(csNOv==="none")csNStar=null;else if(csNOv)csNStar=csNOv;
                return(
                  <div key={d} style={{background:"#fff",borderRadius:14,border:`1.5px solid ${borderCol}`,padding:"12px 14px",marginBottom:8,boxShadow:"0 1px 4px rgba(0,0,0,0.03)"}}>
                    <div style={{marginBottom:(hasAisani||hasKitchen||!closed)?10:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
                        <span style={{fontWeight:900,fontSize:15,color:hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                          {csMonth+1}/{d}（{DOW_JP[dow]}）{hol?"🎌":""}
                        </span>
                        {closed&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(139,26,26,0.06)",color:C.muted,fontWeight:700,border:"1px solid rgba(139,26,26,0.12)"}}>定休日</span>}
                      </div>
                      {staffViewDayComments[d]&&<div style={{marginTop:5,fontSize:13,color:"#7a5c00",background:"rgba(184,134,11,0.07)",border:"1px solid rgba(184,134,11,0.18)",borderRadius:8,padding:"5px 10px",fontWeight:600,lineHeight:1.5}}>{staffViewDayComments[d]}</div>}
                    </div>
                    {day&&(
                      <div style={{display:"flex",flexDirection:"column",gap:5}}>
                        {!closed&&(day.morning||[]).length>0&&(
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:700,color:"#b07d12",background:"#b07d1218",borderRadius:999,padding:"3px 10px",border:"1px solid #b07d1230",minWidth:60,textAlign:"center",flexShrink:0}}>朝</span>
                            <span style={{fontSize:9,color:C.muted,flexShrink:0}}>7:00〜11:00</span>
                            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                              {(day.morning||[]).map(id=>{const s=staffMap[id]||staffMap[Number(id)];return s?(
                                <span key={id} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,background:"rgba(176,125,18,0.08)",color:"#b07d12",border:"1px solid #b07d1230"}}>{(id===csMStar||Number(id)===csMStar)?'🌟':''}{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                              ):null;})}
                            </div>
                          </div>
                        )}
                        {!closed&&(day.prep||[]).length>0&&(
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:700,color:"#276749",background:"#27674918",borderRadius:999,padding:"3px 10px",border:"1px solid #27674930",minWidth:60,textAlign:"center",flexShrink:0}}>朝仕込み</span>
                            <span style={{fontSize:9,color:C.muted,flexShrink:0}}>8:30〜16:00</span>
                            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                              {(day.prep||[]).map(id=>{const s=staffMap[id]||staffMap[Number(id)];return s?(
                                <span key={id} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,background:"rgba(39,103,73,0.08)",color:"#276749",border:"1px solid #27674930"}}>{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                              ):null;})}
                            </div>
                          </div>
                        )}
                        {hasKitchen&&(()=>{const s=staffMap[day.kitchen]||staffMap[Number(day.kitchen)];return s?(
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontSize:10,fontWeight:700,color:"#276749",background:"#27674918",borderRadius:999,padding:"3px 10px",border:"1px solid #27674930",minWidth:60,textAlign:"center",flexShrink:0}}>キッチン</span>
                            <span style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,background:"rgba(39,103,73,0.06)",color:C.text,border:"1px solid #27674930"}}>{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                          </div>
                        ):null;})()}
                        {!closed&&nightEntries.map(([t,id])=>{const s=staffMap[id]||staffMap[Number(id)];const dt=slotDisplayTime(t);const nc=NIGHT_TC[dt]||"#64748b";return s?(
                          <div key={t} style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:700,color:nc,background:nc+"18",borderRadius:999,padding:"3px 10px",border:`1px solid ${nc}30`,minWidth:60,textAlign:"center",flexShrink:0}}>夜 {dt}</span>
                            <span key={id} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,background:"rgba(0,0,0,0.04)",color:C.text,border:"1px solid rgba(0,0,0,0.1)"}}>{(id===csNStar||Number(id)===csNStar)?'🌟':''}{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                          </div>
                        ):null;})}
                        {hasAisani&&(()=>{const s=staffMap[day.aisani]||staffMap[Number(day.aisani)];return s?(
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontSize:10,fontWeight:700,color:C.accent,background:C.accent+"18",borderRadius:999,padding:"3px 10px",border:`1px solid ${C.accent}30`,minWidth:60,textAlign:"center",flexShrink:0}}>アイサニ</span>
                            <span style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:999,background:"rgba(139,26,26,0.06)",color:C.text,border:"1px solid rgba(139,26,26,0.15)"}}>{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}</span>
                          </div>
                        ):null;})()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            </>
          );
        })()}

        {!gmMode&&!loginStaff&&!shiftPreviewOpen&&(
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
                    const cs=serializeConfirmedShift(result,year,month,aisaniConfig,kitchenConfig,nightSlotConfig,dayTypeConfig);
                    if(cs){const csKey=`confirmedShift_${ymRef.current}`;saveKey(csKey,cs);saveCfgLS(csKey,cs);setConfirmedShift(deserializeConfirmedShift(cs));alert(`${year}年${month+1}月のシフトを公開しました`);}
                  }} style={{flex:1,padding:"13px",borderRadius:12,border:"none",cursor:"pointer",fontSize:13,fontWeight:900,background:"linear-gradient(135deg,#276749,#1a4731)",color:"#fff",boxShadow:"0 4px 14px rgba(39,103,73,0.3)"}}>
                    ✅ シフトを公開
                  </button>
                  {confirmedShift&&(
                    <button onClick={()=>{
                      if(window.confirm("公開中のシフトを取り消しますか？スタッフ側から非表示になります。")){
                        const csKey=`confirmedShift_${ymRef.current}`;saveKey(csKey,null);saveCfgLS(csKey,null);setConfirmedShift(null);
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
                      <div style={{fontSize:11,fontWeight:700,color:C.accent}}>勤務実績 / 候補数（達成率）</div>
                      {resultStaffFilter&&<button onClick={()=>setResultStaffFilter(null)} style={{...btn(false),fontSize:10,padding:"4px 12px"}}>全員表示</button>}
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                      {(()=>{
                        const totalW=staff.reduce((a,s)=>a+calcWorkedCount(s.id,result.shifts,avail),0);
                        const totalC=staff.reduce((a,s)=>a+calcCandCount(s,avail,year,month),0);
                        const dynAvgRate=totalC>0?Math.round(totalW/totalC*100):0;
                        return staff.map(s=>{
                        const w=calcWorkedCount(s.id,result.shifts,avail);
                        const c=calcCandCount(s,avail,year,month);
                        const pct=c>0?Math.round(w/c*100):0;
                        const dc=pct>=70?"#1a6bbf":pct>=60?"#276749":pct>=40?"#b07d12":"#c0392b";
                        const sel=resultStaffFilter===s.id;
                        return(
                          <div key={s.id} onClick={()=>setResultStaffFilter(sel?null:s.id)}
                            style={{background:sel?"rgba(139,26,26,0.08)":"#fdfaf6",borderRadius:12,padding:"10px 14px",textAlign:"center",
                              border:`1.5px solid ${sel?C.accent:GRADE_COLOR[s.grade]+"22"}`,minWidth:84,cursor:"pointer",transition:"all .15s",
                              boxShadow:sel?"0 2px 12px rgba(139,26,26,0.18)":"none"}}>
                            <div style={{fontSize:10,fontWeight:700,color:GRADE_COLOR[s.grade]}}>{s.name}</div>
                            <div style={{fontSize:19,fontWeight:900,marginTop:4,color:C.text}}>{w}<span style={{fontSize:10,color:C.muted,fontWeight:400}}>/{c}</span></div>
                            <div style={{fontSize:12,fontWeight:800,color:dc}}>{pct}%</div>
                            <div style={{fontSize:8,color:C.muted,opacity:.6,marginTop:2}}>実績/候補数</div>
                          </div>
                        );
                      });
                      })()}
                    </div>
                    <div style={{fontSize:10,color:C.muted,marginTop:10,opacity:.6}}>
                      {(()=>{const totalW2=staff.reduce((a,s)=>a+calcWorkedCount(s.id,result.shifts,avail),0);const totalC2=staff.reduce((a,s)=>a+calcCandCount(s,avail,year,month),0);const r=totalC2>0?Math.round(totalW2/totalC2*100):0;return `平均達成率：${r}%`;})()}　{resultStaffFilter?"（名前タップで全員表示）":"（名前タップで個別確認）"}
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
                    const manualClosed=dayTypeConfig[d]==="closed";
                    const morningClosed=dayTypeConfig[d]==="morning_closed";
                    const allClosed=closed||manualClosed;
                    const aiOn=aisaniConfig[d]?.enabled;
                    if(allClosed&&!aiOn){
                      if(resultStaffFilter) return null;
                      const bc2=dow===0?"rgba(192,57,43,0.06)":dow===6?"rgba(27,42,94,0.06)":"rgba(139,26,26,0.04)";
                      return(
                        <div key={d} style={{background:"#fdfaf6",borderRadius:14,border:`1px solid ${bc2}`,padding:"10px 14px",marginBottom:8}}>
                          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8,opacity:0.55}}>
                            <span style={{fontWeight:900,fontSize:15,color:hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                              {month+1}/{d}（{DOW_JP[dow]}）{hol?"🎌":""}
                            </span>
                            <span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(139,26,26,0.06)",color:"#8c7b6b",fontWeight:700,border:"1px solid rgba(139,26,26,0.12)"}}>{manualClosed?"休業日":"定休日"}</span>
                          </div>
                          <input type="text" placeholder="📝 この日のコメントを追加（任意）"
                            value={dayComments[d]||""}
                            onChange={e=>updateDayComments({...dayComments,[d]:e.target.value})}
                            style={{width:"100%",boxSizing:"border-box",padding:"7px 12px",borderRadius:8,border:"1px solid rgba(139,26,26,0.15)",background:"rgba(139,26,26,0.02)",fontSize:11,color:"#1a0a00",outline:"none",fontFamily:"inherit"}}
                          />
                        </div>
                      );
                    }
                    const day=result.shifts[d];
                    if(!day) return null;
                    // 朝: day.morningのみ最高等級者1人に🌟（朝仕込みは除外）、手動override対応
                    const mPeople=(day.morning||[]).map(id=>staffMap[id]).filter(Boolean);
                    const mAutoTop=mPeople.length?mPeople.reduce((b,s)=>GRADE_SORT[s.grade]<GRADE_SORT[b.grade]?s:b):null;
                    const mOverride=(starOverrides[d]||{}).morning;
                    const mStarId=mOverride==="none"?null:mOverride??mAutoTop?.id??null;
                    const mTopIds=mStarId?new Set([mStarId]):null;
                    // 夜: NIGHT_TIMES順で最も早い枠のJ以外の人に🌟、手動override対応
                    let nAutoTopId=null;
                    for(const nt of NIGHT_TIMES){
                      if(!(nightSlotConfig[d]||[]).includes(nt)) continue;
                      const pid=(day.night||{})[nt];
                      if(!pid) continue;
                      if(staffMap[pid]?.grade!=='J'){nAutoTopId=pid;break;}
                    }
                    const nOverride=(starOverrides[d]||{}).night;
                    const nStarId=nOverride==="none"?null:nOverride??nAutoTopId;
                    const nTopIds=nStarId?new Set([nStarId]):null;
                    // 個別フィルター: 選択スタッフが入っている日のみ表示
                    if(resultStaffFilter){
                      const sid=resultStaffFilter;
                      const inShift=day.morning.includes(sid)||day.prep.includes(sid)||
                        Object.values(day.night).includes(sid)||day.aisani===sid||day.kitchen===sid;
                      if(!inShift) return null;
                    }
                    const slots=nightSlotConfig[d]||[];
                    const customNightSlots=Object.keys(day.night||{}).filter(t=>!slots.includes(t)).sort((a,b)=>{const da=slotDisplayTime(a),db=slotDisplayTime(b);return da<db?-1:da>db?1:a<b?-1:1});
                    const sh=(result.shortage&&result.shortage[d])||{};
                    const warns=(result.warnings&&result.warnings[d])||[];
                    const kitOn=kitchenConfig[d]?.enabled;
                    const totalS=(morningClosed?0:(sh.morning||0))+(sh.prep||0)+slots.reduce((s,t)=>s+(sh.night?.[t]||0),0)+customNightSlots.reduce((s,t)=>s+(sh.night?.[t]||0),0)+(aiOn?sh.aisani||0:0)+(kitOn?sh.kitchen||0:0);
                    const bc=totalS>0?"rgba(192,57,43,0.2)":warns.length?"rgba(184,134,11,0.2)":hol?"rgba(184,134,11,0.12)":dow===0?"rgba(192,57,43,0.1)":dow===6?"rgba(27,42,94,0.1)":"rgba(139,26,26,0.06)";
                    return(
                      <div key={d} style={{background:"#fff",borderRadius:14,border:`1px solid ${bc}`,padding:14,marginBottom:8,boxShadow:"0 1px 6px rgba(0,0,0,0.04)"}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8,flexWrap:"wrap"}}>
                          <span style={{fontWeight:900,fontSize:15,color:hol?"#b8860b":dow===0?"#c0392b":dow===6?"#1b2a5e":C.text}}>
                            {month+1}/{d}（{DOW_JP[dow]}）{hol?"🎌":""}
                          </span>
                          {allClosed&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(139,26,26,0.06)",color:"#8c7b6b",fontWeight:700,border:"1px solid rgba(139,26,26,0.12)"}}>{manualClosed?"休業日":"定休日"}</span>}
                          {morningClosed&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(234,88,12,0.08)",color:"#ea580c",fontWeight:700,border:"1px solid rgba(234,88,12,0.2)"}}>朝営業休み</span>}
                          {!allClosed&&!morningClosed&&isSpec(year,month,d)&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(184,134,11,0.08)",color:"#b8860b",fontWeight:700,border:"1px solid rgba(184,134,11,0.2)"}}>特別夜</span>}
                          {totalS>0&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(192,57,43,0.08)",color:"#c0392b",fontWeight:700,border:"1px solid rgba(192,57,43,0.2)"}}>⚠ 不足{totalS}名</span>}
                          {warns.length>0&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:999,background:"rgba(184,134,11,0.06)",color:"#b8860b",fontWeight:700,border:"1px solid rgba(184,134,11,0.18)"}}>⚡ 例外あり</span>}
                        </div>
                        {warns.length>0&&(
                          <div style={{marginBottom:8,padding:"8px 12px",background:"rgba(184,134,11,0.04)",borderRadius:10,border:"1px solid rgba(184,134,11,0.12)"}}>
                            {warns.map((w,i)=><div key={i} style={{fontSize:10,color:"#b8860b"}}>⚡ {w}</div>)}
                          </div>
                        )}
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          {!allClosed&&!morningClosed&&<SRow label="朝" time="7:00〜11:00" color="#b07d12"
                            people={(day.morning||[]).map(id=>staffMap[id]).filter(Boolean)} shortage={sh.morning||0}
                            candidates={staff.filter(s=>avail[s.id]?.[`${d}_morning`]&&!(day.morning||[]).includes(s.id))}
                            onSwap={newId=>swapShiftAssignment(d,'morning',null,newId)}
                            onRemove={id=>swapShiftAssignment(d,'morning',null,null,id)}
                            onDismissShortage={(sh.morning||0)>0?()=>dismissShortage(d,'morning'):null}
                            topIds={mTopIds} onStarToggle={sid=>toggleStar(d,'morning',sid)}/>}
                          {!allClosed&&<SRow label={morningClosed?"仕込み":"朝仕込"} time={morningClosed?"":"8:30〜16:00"} color="#276749"
                            people={(day.prep||[]).map(id=>staffMap[id]).filter(Boolean)} shortage={sh.prep||0}
                            candidates={staff.filter(s=>(morningClosed?avail[s.id]?.[`${d}_shimikomi`]||avail[s.id]?.[`${d}_prep`]:avail[s.id]?.[`${d}_prep`]||(avail[s.id]?.[`${d}_morning`]&&avail[s.id]?.[`${d}_shimikomi`]))&&!(day.prep||[]).includes(s.id))}
                            onSwap={newId=>swapShiftAssignment(d,'prep',null,newId)}
                            onRemove={id=>swapShiftAssignment(d,'prep',null,null,id)}
                            onDismissShortage={(sh.prep||0)>0?()=>dismissShortage(d,'prep'):null}/>}
                          {!closed&&kitOn&&<SRow label="厨房" time="キッチン" color="#276749"
                            people={day.kitchen?[staffMap[day.kitchen]].filter(Boolean):[]} shortage={sh.kitchen||0}
                            candidates={staff.filter(s=>s.kitchenOK&&avail[s.id]?.[`${d}_kitchen`]&&s.id!==day.kitchen)}
                            onSwap={newId=>swapShiftAssignment(d,'kitchen',null,newId)}
                            onRemove={()=>swapShiftAssignment(d,'kitchen',null,null)}
                            onDismissShortage={(sh.kitchen||0)>0?()=>dismissShortage(d,'kitchen'):null}/>}
                          {!allClosed&&slots.map(t=>{
                            const p=(day.night||{})[t];
                            const nightCands=staff.filter(s=>s.id!==p&&NIGHT_TIMES.some(nt=>avail[s.id]?.[`${d}_night_${nt}`]&&nightCompat(nt,t)));
                            return <SRow key={t} label={`夜 ${t}〜`} time="" color={NIGHT_TC[t]} people={p?[staffMap[p]].filter(Boolean):[]} shortage={sh.night?.[t]||0} candidates={nightCands}
                              topIds={nTopIds} onStarToggle={p?sid=>toggleStar(d,'night',sid):null}
                              onSwap={newId=>swapShiftAssignment(d,'night',t,newId)}
                              onRemove={p?()=>swapShiftAssignment(d,'night',t,null):null}
                              onDeleteSlot={()=>{const next=(nightSlotConfig[d]||[]).filter(nt=>nt!==t);updateNightSlot({...nightSlotConfig,[d]:next});removeCustomNightSlot(d,t);}}
                              onDismissShortage={(sh.night?.[t]||0)>0?()=>dismissShortage(d,'night',t):null}/>;
                          })}
                          {!allClosed&&customNightSlots.map(t=>{
                            const p=(day.night||{})[t];
                            const nightCands=staff.filter(s=>s.id!==p&&NIGHT_TIMES.some(nt=>avail[s.id]?.[`${d}_night_${nt}`]&&nightCompat(nt,t)));
                            return <SRow key={`custom_${t}`} label={`夜 ${slotDisplayTime(t)}〜`} time="追加" color="#64748b" people={p?[staffMap[p]].filter(Boolean):[]} shortage={sh.night?.[t]||0} candidates={nightCands}
                              onSwap={newId=>swapShiftAssignment(d,'night',t,newId)}
                              onRemove={p?()=>swapShiftAssignment(d,'night',t,null):null}
                              onDeleteSlot={()=>removeCustomNightSlot(d,t)}
                              onDismissShortage={(sh.night?.[t]||0)>0?()=>dismissShortage(d,'night',t):null}/>;
                          })}
                          {!allClosed&&(addSlotState?.d===d?(
                            <div style={{display:"flex",flexDirection:"column",gap:4,padding:"4px 0"}}>
                              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                                <input type="time" value={addSlotState.time}
                                  onChange={e=>setAddSlotState(s=>({...s,time:e.target.value,error:null}))}
                                  style={{padding:"5px 8px",borderRadius:8,border:`1px solid ${addSlotState.error?"#c0392b":"rgba(139,26,26,0.25)"}`,fontSize:12,fontFamily:"inherit",outline:"none",color:C.text}}
                                />
                                <button onClick={()=>{
                                  const t=addSlotState.time;
                                  if(!t){setAddSlotState(s=>({...s,error:"時間を選択してください"}));return;}
                                  const existing=Object.keys(resultRef.current?.shifts?.[d]?.night||{});
                                  let key=t;if(existing.includes(key)){let i=2;while(existing.includes(`${t}_${i}`))i++;key=`${t}_${i}`;}
                                  swapShiftAssignment(d,'night',key,null,null,true);
                                  setAddSlotState(null);
                                }} style={{padding:"5px 14px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#8b1a1a,#b8860b)",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer"}}>追加</button>
                                <button onClick={()=>setAddSlotState(null)} style={{padding:"5px 10px",borderRadius:8,border:"1px solid rgba(139,26,26,0.2)",background:"transparent",fontSize:11,cursor:"pointer",color:C.muted,fontWeight:600}}>キャンセル</button>
                              </div>
                              {addSlotState.error&&<div style={{fontSize:10,color:"#c0392b",paddingLeft:2}}>{addSlotState.error}</div>}
                            </div>
                          ):(
                            <button onClick={()=>setAddSlotState({d,time:"",error:null})} style={{padding:"4px 12px",borderRadius:8,border:"1px dashed rgba(100,116,139,0.4)",background:"rgba(100,116,139,0.04)",fontSize:11,cursor:"pointer",color:"#64748b",fontWeight:600}}>＋ 夜枠追加</button>
                          ))}
                          {aiOn&&<SRow label="アイサニ" time="ヘルプ" color={C.accent}
                            people={day.aisani?[staffMap[day.aisani]].filter(Boolean):[]} shortage={sh.aisani||0}
                            candidates={staff.filter(s=>s.aisaniOK&&s.id!==day.aisani&&(avail[s.id]?.[`${d}_aisani`]||NIGHT_TIMES.some(t=>avail[s.id]?.[`${d}_night_${t}`])))}
                            onSwap={newId=>swapShiftAssignment(d,'aisani',null,newId)}
                            onRemove={()=>swapShiftAssignment(d,'aisani',null,null)}
                            onDismissShortage={(sh.aisani||0)>0?()=>dismissShortage(d,'aisani'):null}/>}
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

function SRow({label,time,color,people,shortage=0,candidates=[],onSwap=null,onRemove=null,onDeleteSlot=null,onDismissShortage=null,topIds=null,onStarToggle=null}){
  return(
    <div style={{display:"flex",flexDirection:"column",gap:3}}>
      <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
        <div style={{minWidth:70,fontSize:10,fontWeight:700,color,background:color+"18",borderRadius:999,padding:"3px 10px",textAlign:"center",flexShrink:0,border:`1px solid ${color}30`}}>{label}</div>
        {onDeleteSlot&&<button onClick={onDeleteSlot} title="この枠を削除" style={{background:"none",border:"none",cursor:"pointer",color:"#94a3b8",fontWeight:900,fontSize:13,padding:"0 2px",lineHeight:1}}>×</button>}
        {time&&<div style={{fontSize:9,color:"#8c7b6b",minWidth:76,flexShrink:0}}>{time}</div>}
        <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
          {people.map(s=>{
            const isTop=topIds?.has(s.id);
            const nameEl=onRemove
              ? <button key={s.id} onClick={()=>onRemove(s.id)} title="タップで削除" style={{fontSize:12,padding:"4px 12px",borderRadius:999,background:"rgba(139,26,26,0.05)",color:"#1a0a00",fontWeight:700,border:"1px solid rgba(139,26,26,0.12)",cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:4}}>
                  {!onStarToggle&&isTop?'🌟':''}{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}<span style={{fontSize:9,color:"#c0392b",fontWeight:900}}>×</span>
                </button>
              : <span key={s.id} style={{fontSize:12,padding:"4px 14px",borderRadius:999,background:"rgba(139,26,26,0.05)",color:"#1a0a00",fontWeight:700,border:"1px solid rgba(139,26,26,0.12)"}}>
                  {!onStarToggle&&isTop?'🌟':''}{s.grade==='J'&&s.showClover!==false?'🍀':''}{s.name}
                </span>;
            return onStarToggle?(
              <div key={s.id} style={{display:"flex",alignItems:"center",gap:2}}>
                <button onClick={()=>onStarToggle(s.id)} title={isTop?"🌟を外す":"🌟をつける"} style={{background:"none",border:"none",cursor:"pointer",fontSize:14,padding:"0 1px",lineHeight:1,opacity:isTop?1:0.25,transition:"opacity .15s"}}>
                  🌟
                </button>
                {nameEl}
              </div>
            ):nameEl;
          })}
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
