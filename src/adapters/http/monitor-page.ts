export const monitorPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Nano-researcher · Run Monitor</title>
  <style>
    :root{color-scheme:dark;--bg:#111416;--surface:#191d20;--surface-2:#202529;--line:#343b40;--text:#edf1f2;--muted:#9ca8ad;--mint:#6ed3b2;--amber:#e7b76b;--red:#ed8585;--blue:#80b6e8;--focus:#f2d28b}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif}
    main{width:min(1440px,100%);margin:0 auto;padding:28px clamp(16px,3vw,44px) 48px}
    a{color:var(--blue)}
    a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
    .topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding-bottom:22px;border-bottom:1px solid var(--line)}
    .brand{display:flex;align-items:flex-start;gap:12px;min-width:0}
    .mark{width:10px;height:42px;background:var(--mint);margin-top:5px;flex:none}
    .eyebrow{margin:0 0 3px;color:var(--mint);font-size:11px;font-weight:700;letter-spacing:0;text-transform:uppercase}
    h1{margin:0;font-size:24px;line-height:1.2;letter-spacing:0}
    h2{margin:0;font-size:15px;line-height:1.3;letter-spacing:0}
    .question{margin:8px 0 0;color:var(--muted);max-width:720px;overflow-wrap:anywhere}
    .connector{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .connector label{display:block;width:100%;color:var(--muted);font-size:12px}
    input,button{font:inherit;color:var(--text);border:1px solid var(--line);border-radius:4px;background:var(--surface-2);padding:9px 11px}
    input{width:min(360px,42vw);min-width:180px}
    button{cursor:pointer;font-weight:650}
    button:hover,a.run-link:hover{border-color:var(--blue);color:var(--text)}
    .primary{background:#2d514a;border-color:#477d70}
    .quiet{background:transparent}
    .back{display:inline-flex;align-items:center;gap:6px;margin-bottom:18px;text-decoration:none;color:var(--muted)}
    .back::before{content:"←";font-size:16px}
    .section{margin-top:24px}
    .section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:10px}
    .section-note{color:var(--muted);font-size:12px}
    .run-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:10px}
    .run-link{display:block;color:var(--text);text-decoration:none;border:1px solid var(--line);border-radius:5px;background:var(--surface);padding:14px;min-width:0}
    .run-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .run-id{font:12px ui-monospace,SFMono-Regular,monospace;color:var(--muted);overflow-wrap:anywhere}
    .run-question{display:block;margin-top:9px;min-height:44px;overflow-wrap:anywhere}
    .run-meta{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;color:var(--muted);font-size:12px}
    .status{font-weight:700;text-transform:capitalize}
    .status.completed{color:var(--mint)}.status.running{color:var(--blue)}.status.failed{color:var(--red)}.status.cancelled,.status.cancelling,.status.queued{color:var(--amber)}
    .panel{border:1px solid var(--line);border-radius:5px;background:var(--surface);padding:16px;min-width:0}
    .summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:start}
    .summary-state{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--muted)}
    .stats{display:grid;grid-template-columns:repeat(5,minmax(82px,1fr));gap:8px}
    .stat{padding:9px 10px;border-left:3px solid var(--blue);background:var(--surface-2);min-width:0}
    .stat b{display:block;font-size:21px;line-height:1.2}.stat span{display:block;margin-top:3px;color:var(--muted);font-size:11px;white-space:nowrap}
    .detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,1.15fr);gap:12px;margin-top:12px}
    .answer{white-space:pre-wrap;overflow-wrap:anywhere;max-height:500px;overflow:auto;color:#d9e7e1}
    .answer.empty,.empty{color:var(--muted)}
    .links{display:grid;gap:7px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
    .links a{overflow-wrap:anywhere}
    .event-list{height:560px;overflow:auto;display:flex;flex-direction:column;gap:7px}
    .event{border-left:2px solid var(--line);background:var(--surface-2);padding:8px 10px;min-width:0}
    .event.search{border-left-color:var(--blue)}.event.fetch{border-left-color:var(--mint)}.event.error{border-left-color:var(--red)}
    .event time{color:var(--muted);font-size:11px;margin-right:8px}.event b{font-size:12px;overflow-wrap:anywhere}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0 0;color:#c5d0d3;font:12px/1.45 ui-monospace,SFMono-Regular,monospace}
    .sr-status{min-height:22px;color:var(--muted);font-size:12px}
    [hidden]{display:none!important}
    @media(max-width:960px){.topbar{align-items:flex-start;flex-direction:column}.connector{width:100%;justify-content:flex-start}.connector label{width:auto}.summary{grid-template-columns:1fr}.stats{grid-template-columns:repeat(5,1fr)}.detail-grid{grid-template-columns:1fr}}
    @media(max-width:560px){main{padding:18px 12px 34px}.topbar{gap:18px}h1{font-size:21px}.connector{display:grid;grid-template-columns:1fr auto}.connector label{grid-column:1/-1}.connector input{width:100%;min-width:0}.run-list{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.stat:last-child{grid-column:span 2}.event-list{height:460px}.panel{padding:13px}}
    @media(max-width:340px){main{padding-inline:10px}h1{font-size:19px}.stats{gap:6px}.stat{padding-inline:7px}.stat b{font-size:18px}.stat span{font-size:10px}}
  </style>
</head>
<body>
  <main>
    <header class="topbar">
      <div class="brand">
        <div class="mark" aria-hidden="true"></div>
        <div><p class="eyebrow">Nano-researcher</p><h1>Research Run Monitor</h1><p id="question" class="question">当前没有选中的运行</p></div>
      </div>
      <form id="form" class="connector">
        <label for="run">按 Run ID 打开</label>
        <input id="run" name="run" autocomplete="off" placeholder="run_...">
        <button class="primary" type="submit">打开</button>
      </form>
    </header>

    <section id="listView" class="section" aria-labelledby="listTitle">
      <div class="section-head"><h2 id="listTitle">当前运行</h2><div id="listStatus" class="sr-status" role="status" aria-live="polite"></div></div>
      <div id="runList" class="run-list"></div>
    </section>

    <section id="detailView" class="section" hidden aria-labelledby="detailTitle">
      <a id="backLink" class="back" href="/monitor">返回运行列表</a>
      <div class="panel summary">
        <div><h2 id="detailTitle">运行状态</h2><div class="summary-state"><div id="status" class="status" role="status" aria-live="polite" aria-atomic="true">未连接</div><span id="statusNote" class="section-note"></span></div></div>
        <div class="stats" aria-label="运行统计"><div class="stat"><b id="searches">0</b><span>搜索结果</span></div><div class="stat"><b id="fetches">0</b><span>抓取页面</span></div><div class="stat"><b id="events">0</b><span>事件</span></div><div class="stat"><b id="errors">0</b><span>协议错误</span></div><div class="stat"><b id="iterations">0</b><span>迭代</span></div></div>
      </div>

      <div class="detail-grid">
        <section class="panel" aria-labelledby="answerTitle"><h2 id="answerTitle">最终答案</h2><div id="answer" class="answer empty" aria-live="polite">尚未生成</div><div id="links" class="links" aria-label="报告文件"></div></section>
        <section class="panel" aria-labelledby="eventsTitle"><div class="section-head"><h2 id="eventsTitle">实时事件</h2><button id="retry" class="quiet" type="button" hidden>重试</button></div><div id="eventStatus" class="sr-status" role="status" aria-live="polite"></div><div id="eventList" class="event-list" role="log" aria-live="polite" aria-busy="false"></div></section>
      </div>
    </section>
  </main>
  <script>
    const POLL_INTERVAL_MS=1500,LIST_INTERVAL_MS=2000,MAX_RENDERED_EVENTS=500,AUTH_STORAGE_KEY='researchHttpAuthToken';
    const $=id=>document.getElementById(id);let runId='',timer,listTimer,generation=0,afterSequence=0,retainedEvents=[],lastRun;
    function text(value){if(value===undefined||value===null)return '';return typeof value==='string'?value:JSON.stringify(value,null,2)}
    function element(tag,className,value){const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=String(value);return node}
    function empty(node,message){node.replaceChildren(element('div','empty',message))}
    function statusClass(status){return ['completed','running','failed','cancelled','cancelling','queued','interrupted'].includes(status)?status:''}
    function pathRunId(){const match=location.pathname.match(/^\\/monitor\\/([^/]+)\\/?$/);if(!match)return '';try{return decodeURIComponent(match[1])}catch{return ''}}
    function queryRunId(){return new URLSearchParams(location.search).get('runId')||''}
    function loadAuthToken(){const fragment=new URLSearchParams(location.hash.slice(1)),has=fragment.has('token'),value=fragment.get('token')||'';let token=value;try{if(has){if(value)sessionStorage.setItem(AUTH_STORAGE_KEY,value);else sessionStorage.removeItem(AUTH_STORAGE_KEY)}token=sessionStorage.getItem(AUTH_STORAGE_KEY)||value}catch{}if(has)history.replaceState(null,'',location.pathname+location.search);return token}
    const authToken=loadAuthToken();
    function apiFetch(url){return authToken?fetch(url,{headers:{Authorization:'Bearer '+authToken}}):fetch(url)}
    function canonicalPath(id){return id?'/monitor/'+encodeURIComponent(id):'/monitor'}
    function setView(){const detail=Boolean(runId);$('listView').hidden=detail;$('detailView').hidden=!detail;$('run').value=runId;if(detail){$('backLink').href='/monitor';$('question').textContent=lastRun?.question||lastRun?.task?.question||'正在加载运行'}else{$('question').textContent='选择一个运行查看实时状态';}}
    function runCounts(run){if(run.counts)return run.counts;const state=run.result?.state||{};return {events:Array.isArray(run.events)?run.events.length:0,iterations:state.currentIteration??0,searchResults:Array.isArray(state.searchResults)?state.searchResults.length:0,fetchedPages:Array.isArray(state.fetchedPages)?state.fetchedPages.length:0,protocolErrors:0}}
    function renderList(runs){const box=$('runList');if(!runs.length){empty(box,'当前没有运行');return}const fragment=document.createDocumentFragment();for(const run of runs){const id=typeof run?.runId==='string'?run.runId:'';if(!id)continue;const counts=runCounts(run),link=element('a','run-link');link.href=canonicalPath(id);const row=element('div','run-row');row.append(element('span','status '+statusClass(run.status),run.status||'unknown'),element('span','run-id',id));const question=element('span','run-question',run.question||run.task?.question||'');const meta=element('div','run-meta');const created=element('time','',run.createdAt?new Date(run.createdAt).toLocaleString():'');meta.append(element('span','',String(counts.searchResults??0)+' 搜索'),element('span','',String(counts.fetchedPages??0)+' 抓取'),created);link.append(row,question,meta);fragment.append(link)}box.replaceChildren(fragment)}
    function renderRun(run,full){lastRun=run;$('question').textContent=run.question||run.task?.question||'未提供问题';const state=typeof run.status==='string'?run.status:'unknown';$('status').textContent=state;$('status').className='status '+statusClass(state);$('statusNote').textContent=run.reportStatus==='pending'?'报告生成中':run.reportError?.message||'';const counts=runCounts(run);$('searches').textContent=String(counts.searchResults??0);$('fetches').textContent=String(counts.fetchedPages??0);$('events').textContent=String(counts.events??0);$('errors').textContent=String(counts.protocolErrors??0);$('iterations').textContent=String(counts.iterations??0);const answer=full?.result?.state?.finalAnswer??run.result?.state?.finalAnswer;if(typeof answer==='string'&&answer.trim()){$('answer').textContent=answer;$('answer').className='answer'}else{$('answer').textContent=run.answerAvailable?'答案数据加载中':'尚未生成';$('answer').className='answer empty'}renderReport(run.report)}
    function publicArtifactPath(value){if(typeof value!=='string'||!value)return '';const normalized=value.replaceAll('\\\\','/');if(normalized.startsWith('/v1/research/'))return normalized;if(normalized.startsWith('/')){const marker='/artifacts/';const index=normalized.indexOf(marker);return index>=0?normalized.slice(index):''}if(normalized.startsWith('artifacts/'))return '/'+normalized;return normalized.includes('..')?'':'/artifacts/'+normalized.replace(/^\\/+/, '')}
    function renderReport(report){const links=$('links');links.replaceChildren();if(!report){links.className='links';links.append(element('div','empty','报告尚未生成'));return}links.className='links';for(const key of ['jsonPath','markdownPath','htmlPath']){const href=publicArtifactPath(report[key]);if(!href)continue;const link=element('a','',key.replace('Path','')+' · 打开');link.href=href;link.target='_blank';link.rel='noopener noreferrer';links.append(link)}if(!links.childElementCount)links.append(element('div','empty','报告文件暂不可访问'))}
    function eventKey(event){const sequence=Number(event?.sequence);return Number.isFinite(sequence)?'sequence:'+sequence:'legacy:'+String(event?.timestamp||'')+'\\u0000'+String(event?.type||'')+'\\u0000'+text(event?.payload)}
    function mergeEvents(incoming){const list=Array.isArray(incoming)?incoming:[],merged=new Map();for(const event of retainedEvents.concat(list))merged.set(eventKey(event),event);retainedEvents=[...merged.values()].sort((a,b)=>Number(a?.sequence||0)-Number(b?.sequence||0)).slice(-MAX_RENDERED_EVENTS);for(const event of list){const sequence=Number(event?.sequence);if(Number.isFinite(sequence))afterSequence=Math.max(afterSequence,sequence)}}
    function renderEvents(events){const box=$('eventList');if(!events.length){empty(box,'暂无事件');return}const fragment=document.createDocumentFragment();for(const event of events){const type=typeof event?.type==='string'?event.type:'unknown',kind=type.includes('error')?'error':type.startsWith('search')?'search':type.startsWith('fetch')?'fetch':'';const item=element('div','event '+kind);const timestamp=event?.timestamp?new Date(event.timestamp):new Date(NaN);const time=element('time','',Number.isNaN(timestamp.getTime())?'':timestamp.toLocaleTimeString());time.dateTime=typeof event?.timestamp==='string'?event.timestamp:'';item.append(time,element('b','',type),element('pre','',text(event?.payload)));fragment.append(item)}box.replaceChildren(fragment);box.scrollTop=box.scrollHeight}
    function clearTimers(){clearTimeout(timer);clearTimeout(listTimer);timer=undefined;listTimer=undefined}
    async function loadList(expected){try{$('listStatus').textContent='更新中';const response=await apiFetch('/v1/research');if(!response.ok)throw Error('列表加载失败');const body=await response.json();if(expected!==generation||runId)return;renderList(Array.isArray(body.runs)?body.runs:[]);$('listStatus').textContent='已更新'}catch(error){if(expected!==generation||runId)return;renderList([]);$('listStatus').textContent=error instanceof Error?error.message:String(error)}finally{if(expected===generation&&!runId)listTimer=setTimeout(()=>loadList(expected),LIST_INTERVAL_MS)}}
    async function fetchFullIfNeeded(run){if(!run.answerAvailable)return null;const response=await apiFetch('/v1/research/'+encodeURIComponent(run.runId)+'?include=full');if(!response.ok)throw Error('答案加载失败');return await response.json()}
    async function poll(expected){if(!runId||expected!==generation)return;let keepPolling=false;$('eventList').setAttribute('aria-busy','true');$('retry').hidden=true;try{const base='/v1/research/'+encodeURIComponent(runId),responses=await Promise.all([apiFetch(base),apiFetch(base+'/events?afterSequence='+encodeURIComponent(afterSequence))]);if(!responses[0].ok)throw Error('运行不存在');if(!responses[1].ok)throw Error('事件加载失败');const run=await responses[0].json(),eventBatch=await responses[1].json(),full=await fetchFullIfNeeded(run);if(expected!==generation)return;renderRun(run,full);mergeEvents(eventBatch.events);renderEvents(retainedEvents);$('eventStatus').textContent='实时连接';const terminal=['completed','interrupted','failed','cancelled'].includes(run.status);keepPolling=!(terminal&&run.reportStatus!=='pending')}catch(error){if(expected!==generation)return;$('eventStatus').textContent=error instanceof Error?error.message:String(error);$('status').textContent='连接失败';$('status').className='status failed';$('retry').hidden=false;keepPolling=false}finally{$('eventList').setAttribute('aria-busy','false');if(expected===generation&&runId&&keepPolling)timer=setTimeout(()=>poll(expected),POLL_INTERVAL_MS)}}
    function connect(next,replace=false){generation+=1;clearTimers();runId=typeof next==='string'?next.trim():'';afterSequence=0;retainedEvents=[];lastRun=undefined;const path=canonicalPath(runId);if(location.pathname+location.search!==path)(replace?history.replaceState:history.pushState).call(history,null,'',path);setView();if(runId){$('eventList').replaceChildren();void poll(generation)}else{renderList([]);void loadList(generation)}}
    $('form').addEventListener('submit',event=>{event.preventDefault();connect($('run').value)});$('retry').addEventListener('click',()=>{if(runId)void poll(generation)});window.addEventListener('popstate',()=>connect(pathRunId()||queryRunId(),true));
    const initial=pathRunId()||queryRunId();if(initial&&!pathRunId())connect(initial,true);else{runId=initial;setView();if(runId)void poll(generation);else void loadList(generation)}
  </script>
</body>
</html>`;
