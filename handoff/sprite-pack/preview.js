'use strict';
const manifest=window.SPRITE_MANIFEST;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let clock=0,last=performance.now(),paused=false,ready=false,demoStart=null,extraStart=0;
const controller=AgentSprites.createController(()=>clock);
const characters=AgentSprites.characters;
const providerNames={finn:'Claude',jake:'Antigravity',bmo:'Codex'};
const labels={rest:'Rest / huddle',idle:'Idle / waiting',chill:'Easy work',thinking:'Heavy thinking',retry:'Retry / error',strained:'Strained / wounded',encounter:'Ice King encounter',recover:'Recover',practice:'Action / practice',complete:'Work complete',walk_right:'Walk right',walk_left:'Walk left',run_right:'Run right',run_left:'Run left',views:'All views'};
const descriptions={finn:{chill:'Studying an adventure map.',practice:'Practising with his golden sword.',thinking:'A hand on his chin, a scratch of the hat.'},jake:{chill:'Making a sandwich at his own pace.',practice:'A playful elastic boxing routine.',thinking:'Stretching into a thought.'},bmo:{chill:'A little dance and a little music.',practice:'Playing a tiny controller.',thinking:'Concentrating, with thinking dots on screen.'}};
const common={rest:'Resting close to the others.',idle:'Awake and waiting patiently.',retry:'A recoverable mistake. Time to try again.',strained:'Repeated failures: comic exhaustion and a small bandage.',encounter:'A difficult-task metaphor: bracing against ice.',recover:'Shake it off, reset, and return to the task.',complete:'A short celebration, then back to rest.',views:'Front → right → back → left → front three-quarter → back three-quarter.'};
const images={},cardCanvases={},selects={};
for (const id of characters){
 const card=document.createElement('article');card.className='card';
 card.innerHTML=`<h2>${providerNames[id]}</h2><div class="role">${{finn:'Finn · The adventurer',jake:'Jake · The stretchy optimist',bmo:'BMO · The playful little console'}[id]}</div><canvas width="310" height="160" aria-label="${id} animation"></canvas><label for="state-${id}">Agent state</label><select id="state-${id}">${Object.entries(labels).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select><div class="desc" id="desc-${id}"></div>`;
 document.querySelector('#cards').append(card);cardCanvases[id]=card.querySelector('canvas');selects[id]=card.querySelector('select');
 selects[id].onchange=()=>{demoStart=null;setState(id,selects[id].value);};
}
function setState(id,state){controller.setState(id,state);selects[id].value=state;document.querySelector('#desc-'+id).textContent=descriptions[id][state]||common[state]||'A six-frame movement cycle.';}
for(const id of characters)setState(id,'rest');
function atlasFor(id,state){return ['chill','thinking','retry','strained','encounter','recover'].includes(state)?id+'-context':id+'-core';}
function draw(ctx,key,state,cx,baseline,height,elapsed,loopOverride=false){
 const atlas=manifest.atlases[key],seq=atlas.states[state],img=images[key];if(!img)return;
 const n=Math.floor(elapsed*seq.fps/1000),index=reduced.matches?0:(seq.loop||loopOverride?n%seq.frames.length:Math.min(n,seq.frames.length-1));
 const f=seq.frames[index],scale=height/atlas.referenceHeight;
 ctx.imageSmoothingEnabled=false;
 ctx.drawImage(img,f.x,f.y,f.w,f.h,Math.round(cx-f.anchorX*scale),Math.round(baseline-f.anchorY*scale),Math.round(f.w*scale),Math.round(f.h*scale));
}
function event(id,signal){const a=controller.setSignal(id,signal);setState(id,a.state);return a.state;}
window.setAgentSignal=event;
window.setAgentState=(id,state)=>{demoStart=null;setState(id,state);};
const story=[
 {at:0,states:['rest','rest','rest'],text:'The crew is resting.'},
 {at:3000,states:['chill','rest','rest'],text:'Finn starts a relaxed research task.'},
 {at:7000,states:['thinking','chill','rest'],text:'Finn thinks harder. Jake starts easy work.'},
 {at:11000,states:['retry','chill','chill'],text:'Finn retries. Jake and BMO are progressing calmly.'},
 {at:15000,states:['strained','complete','thinking'],text:'Repeated errors tire Finn. Jake finishes.'},
 {at:19500,states:['recover','rest','thinking'],text:'Finn recovers while BMO concentrates.'},
 {at:23500,states:['encounter','rest','complete'],text:'Finn tackles an icy challenge. BMO finishes.'},
 {at:28000,states:['complete','rest','rest'],text:'Finn finishes too.'},
 {at:33000,states:['rest','rest','rest'],text:'Everyone returns to the huddle.'}
];let storyIndex=-1;
document.querySelector('#demo').onclick=()=>{demoStart=clock;storyIndex=-1;paused=false;document.querySelector('#pause').textContent='Pause';};
document.querySelector('#rest').onclick=()=>{demoStart=null;characters.forEach(id=>setState(id,'rest'));};
document.querySelector('#pause').onclick=()=>{paused=!paused;document.querySelector('#pause').textContent=paused?'Resume':'Pause';};
document.querySelector('#theme').onclick=()=>document.body.classList.toggle('light');
document.querySelector('#extra').onchange=()=>extraStart=clock;
const stage=document.querySelector('#stage'),ctx=stage.getContext('2d');
function render(t){
 if(!paused)clock+=Math.min(t-last,100);last=t;
 if(ready){
  if(demoStart!==null){let index=story.findLastIndex(s=>clock-demoStart>=s.at);if(index!==storyIndex){storyIndex=index;story[index].states.forEach((s,i)=>setState(characters[i],s));}if(clock-demoStart>37000)demoStart=null;}
  for(const id of characters){const a=controller.agents[id];if(['complete','recover'].includes(a.state)){const seq=manifest.atlases[atlasFor(id,a.state)].states[a.state];if(clock-a.since>seq.frames.length/seq.fps*1000+1800)setState(id,a.state==='complete'?'rest':'chill');}}
  ctx.clearRect(0,0,stage.width,stage.height);
  const agents=controller.agents,allRest=characters.every(id=>agents[id].state==='rest');
  if(allRest)draw(ctx,'group','huddle',520,285,155,clock);
  else{
   const resting=characters.filter(id=>agents[id].state==='rest'),active=characters.filter(id=>agents[id].state!=='rest');
   resting.forEach((id,i)=>draw(ctx,id+'-core','rest',130+i*76,280,id==='bmo'?89:108,clock-agents[id].since));
   active.forEach((id,i)=>{const a=agents[id];draw(ctx,atlasFor(id,a.state),a.state,400+i*180,280,id==='bmo'?110:134,clock-a.since,a.state==='views');});
   if(active.some(id=>agents[id].state==='encounter'))draw(ctx,'ice-king','cast',940,280,120,clock);
  }
  for(const id of characters){const c=cardCanvases[id],cc=c.getContext('2d'),a=agents[id];cc.clearRect(0,0,c.width,c.height);draw(cc,atlasFor(id,a.state),a.state,155,148,id==='bmo'?95:112,clock-a.since,a.state==='views');}
  const extra=document.querySelector('#extra').value.split(':'),ec=document.querySelector('#extra-canvas'),ex=ec.getContext('2d');ex.clearRect(0,0,ec.width,ec.height);draw(ex,extra[0],extra[1],220,200,extra[0]==='group'?120:145,clock-extraStart,true);
  document.querySelector('#scene-title').textContent=allRest?'All quiet. Resting together.':characters.filter(id=>agents[id].state!=='rest').map(id=>providerNames[id]).join(', ')+' at work.';
  document.querySelector('#status').textContent=demoStart!==null?story[storyIndex].text:characters.map(id=>(providerNames[id])+': '+labels[agents[id].state]).join(' · ');
 }
 requestAnimationFrame(render);
}
Promise.all(Object.entries(manifest.atlases).map(([key,a])=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{images[key]=img;resolve();};img.onerror=()=>reject(new Error('Could not load '+a.file));img.src=window.EMBEDDED_SPRITES?.[key]||a.file;}))).then(()=>{ready=true;}).catch(e=>document.querySelector('#status').textContent=e.message);
requestAnimationFrame(render);
