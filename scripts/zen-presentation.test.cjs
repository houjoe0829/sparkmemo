const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const Module=require('node:module');
const filename=require('node:path').resolve('src/zen-presentation.ts');
const m=new Module(filename,module);
m._compile(buildSync({entryPoints:[filename],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text,filename);
const {ZenBackdrop,zenMapLayout,runZenTransition,ZEN_DRIFT_PX_PER_SECOND}=m.exports;
function node(doc,tag='div'){
 const attrs=new Map(), classes=new Set();
 const n={ownerDocument:doc,tag,children:[],inert:false,scrollLeft:0,scrollTop:0,
  classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},
  getAttribute:k=>attrs.get(k)??null,setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),
  appendChild(c){this.children.push(c);return c},replaceChildren(){this.children=[]},remove(){this.removed=true},
  getBoundingClientRect(){return this.rect??{left:0,top:0,width:360,height:720}},
  style:{setProperty:(k,v)=>attrs.set(k,v)},animate(frames,options){
   let resolve;const a={frames,options,finished:new Promise(r=>resolve=r),pause(){this.playState='paused'},play(){this.playState='running'},currentTime:0,cancel(){this.cancelled=true;resolve()},finish:()=>resolve()};
   (this.animations??=[]).push(a);return a;
  }};return n;
}
function fixture(reduced=false){
 const events={}; const doc={events,visibilityState:'visible',addEventListener:(k,v)=>events[k]=v,removeEventListener:k=>delete events[k],defaultView:{matchMedia:()=>({matches:reduced}),getComputedStyle:el=>({display:el.hidden?'none':'flex',opacity:'1'})}};
 doc.createElement=tag=>node(doc,tag);doc.createElementNS=(_,tag)=>node(doc,tag);
 return {doc,root:node(doc),card:node(doc),chrome:node(doc)};
}
test('map layout handles empty, invalid, duplicate locations and arbitrary aspect ratios',()=>{
 for(const [w,h] of [[360,720],[1200,200],[1,0]]){
  const empty=zenMapLayout([],w,h);assert.equal(empty.clusters.length,0);assert.ok(Number.isFinite(empty.left));assert.ok(empty.viewWidth>0);
 }
 const layout=zenMapLayout([{latitude:31,longitude:121},{latitude:31,longitude:121},{latitude:NaN,longitude:5}],360,720);
 assert.equal(layout.clusters.length,1);assert.equal(layout.clusters[0].count,2);
});
test('backdrop is decorative, supports empty basemap and location updates, and disposes',()=>{
 const {root}=fixture();const layer=new ZenBackdrop(root);layer.setActive(true);
 const svg=root.children[0].children[0];
 assert.equal(root.children[0].getAttribute('aria-hidden'),'true');assert.equal(svg.getAttribute('focusable'),'false');
 assert.equal(svg.children[0].children[0].children[0].tag,'path');
 layer.setLocations([{latitude:31,longitude:121}]);
 const nodes=svg.children[0].children[0].children;assert.deepEqual(nodes.map(n=>n.tag),['path','circle']);
 assert.equal(nodes.some(n=>['text','title','a'].includes(n.tag)),false);
 const id=svg.children[0].children[0].getAttribute('id');
 const other=new ZenBackdrop(root);other.setActive(true);assert.notEqual(root.children[1].children[0].children[0].children[0].getAttribute('id'),id);
 layer.dispose();assert.equal(root.children[0].removed,true);
});
test('reduced motion switches immediately and cancels old transition',()=>{
 const {root,card,chrome}=fixture(true);let updates=0,cancels=0;
 runZenTransition(root,card,[chrome],true,()=>updates++,()=>cancels++);
 assert.equal(updates,1);assert.equal(cancels,1);assert.equal(card.animations,undefined);
});
test('motion preserves card size and restores hidden chrome/inert after finish',async()=>{
 const {root,card,chrome}=fixture();card.rect={left:12,top:60,width:336,height:143};
 const cancel=runZenTransition(root,card,[chrome],true,()=>{card.rect={left:12,top:288,width:336,height:143}},null);
 assert.deepEqual(card.animations[0].frames,[{transform:'translate(0px, -228px)'},{transform:'translate(0px, 0px)'}]);
 assert.equal(card.animations[0].options.duration,400);assert.equal(chrome.inert,true);
 card.animations[0].finish();chrome.animations[0].finish();await new Promise(r=>setImmediate(r));
 assert.equal(chrome.inert,false);assert.equal(chrome.getAttribute('style'),null);assert.equal(card.classList.contains('jp-zen-moving'),false);cancel();
});
test('rapid reversal cancels previous effects and starts at current painted position',()=>{
 const {root,card,chrome}=fixture();card.rect={left:12,top:60,width:336,height:143};
 const first=runZenTransition(root,card,[chrome],true,()=>{card.rect={left:12,top:288,width:336,height:143}},null);
 card.rect={left:12,top:170,width:336,height:143};
 const second=runZenTransition(root,card,[chrome],false,()=>{card.rect={left:12,top:60,width:336,height:143}},first);
 assert.equal(card.animations[0].cancelled,true);assert.equal(card.animations[1].frames[0].transform,'translate(0px, 110px)');
 second();assert.equal(chrome.inert,false);assert.equal(card.classList.contains('jp-zen-moving'),false);
});
test('background drifts left at two pixels per second and resumes phase after updates/resizing',()=>{
 const {root}=fixture();const layer=new ZenBackdrop(root);layer.setActive(true);
 const svg=root.children[0].children[0],first=svg.animations[0];
 assert.equal(first.playState,'running');assert.equal(first.options.iterations,Infinity);assert.equal(first.options.easing,'linear');
 const distance=-Number(first.frames[1].transform.match(/translateX\((.+)px\)/)[1]);
 assert.equal(distance/(first.options.duration/1000),ZEN_DRIFT_PX_PER_SECOND);
 first.currentTime=first.options.duration*.35;
 layer.setLocations([{latitude:30,longitude:120}]);
 const second=svg.animations[1];assert.equal(first.cancelled,true);assert.ok(Math.abs(second.currentTime/second.options.duration-.35)<1e-9);
 root.rect={width:600,height:400,left:0,top:0};layer.draw();const third=svg.animations[2];
 assert.ok(Math.abs(third.currentTime/third.options.duration-.35)<1e-9);assert.ok(parseFloat(svg.style.width)>600);
 layer.setActive(false);assert.equal(third.playState,'paused');layer.setActive(true);
 assert.equal(svg.animations.at(-1).playState,'running');layer.dispose();assert.equal(svg.animations.at(-1).cancelled,true);
});
test('document hidden and live reduced-motion preference pause and resume background',()=>{
 const {root,doc}=fixture();const preference={matches:false,addEventListener:(k,v)=>preference.changed=v,removeEventListener:()=>preference.removed=true};
 doc.defaultView.matchMedia=()=>preference;const layer=new ZenBackdrop(root);layer.setActive(true);
 const animation=root.children[0].children[0].animations[0];
 doc.visibilityState='hidden';doc.events.visibilitychange();assert.equal(animation.playState,'paused');
 doc.visibilityState='visible';doc.events.visibilitychange();assert.equal(animation.playState,'running');
 preference.matches=true;preference.changed();assert.equal(animation.playState,'paused');
 preference.matches=false;preference.changed();assert.equal(animation.playState,'running');
 root.rect={width:0,height:0,left:0,top:0};layer.draw();assert.equal(animation.playState,'paused');
 layer.dispose();assert.equal(doc.events.visibilitychange,undefined);assert.equal(preference.removed,true);
});
test('offscreen pane pauses drift and intersection observer is disconnected on close',()=>{
 const old=global.IntersectionObserver;let callback,disconnected=false;
 global.IntersectionObserver=class{constructor(fn){callback=fn}observe(){}disconnect(){disconnected=true}};
 try{
  const {root}=fixture();const layer=new ZenBackdrop(root);layer.setActive(true);const animation=root.children[0].children[0].animations[0];
  callback([{target:root,isIntersecting:false}]);assert.equal(animation.playState,'paused');
  callback([{target:root,isIntersecting:true}]);assert.equal(animation.playState,'running');layer.dispose();assert.equal(disconnected,true);
 }finally{global.IntersectionObserver=old;}
});
