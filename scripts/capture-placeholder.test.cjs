const {test}=require('node:test'),assert=require('node:assert/strict'),{buildSync}=require('esbuild'),Module=require('node:module');
const filename=require('node:path').resolve('src/capture-placeholder.ts'),m=new Module(filename,module);
m._compile(buildSync({entryPoints:[filename],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text,filename);
const {CapturePlaceholder,advancePlaceholder,initialPlaceholderState,CAPTURE_PLACEHOLDER_TIMING}=m.exports;
function fixture({reduced=false,pool=['你好','记下这一刻']}={}){
 let now=0,id=0;const timers=new Map(),events=new Map(),preference={matches:reduced,addEventListener:(k,fn)=>preference.change=fn,removeEventListener:()=>delete preference.change};
 const win={matchMedia:()=>preference,setTimeout:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id},clearTimeout:i=>timers.delete(i)};
 const doc={defaultView:win,visibilityState:'visible',activeElement:null,addEventListener:(k,fn)=>events.set(k,fn),removeEventListener:k=>events.delete(k)};
 function node(){const listeners=new Map(),classes=new Set();return {ownerDocument:doc,value:'',placeholder:pool[0],children:[],hidden:false,attrs:{},
  classList:{add:k=>classes.add(k),remove:k=>classes.delete(k)},setAttribute(k,v){this.attrs[k]=v},appendChild(c){this.children.push(c);return c},remove(){this.removed=true},
  getBoundingClientRect:()=>({width:320,height:65}),addEventListener:(k,fn)=>listeners.set(k,fn),removeEventListener:k=>listeners.delete(k),
  fire(k){if(k==='focus')doc.activeElement=this;if(k==='blur')doc.activeElement=null;listeners.get(k)?.()},listeners};}
 doc.createElement=node;const textarea=node(),wrapper=node();let allowed=true;
 const controller=new CapturePlaceholder(textarea,wrapper,()=>pool,()=>allowed);
 const advance=ms=>{const end=now+ms;while(timers.size){const [key,t]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(t.at>end)break;now=t.at;timers.delete(key);t.fn()}now=end};
 return {controller,textarea,layer:wrapper.children[0],doc,events,preference,timers,advance,setPool:x=>pool=x,setAllowed:x=>allowed=x};
}
test('typewriter uses Remix Desk typing/hold/delete/gap timings and wraps the pool',()=>{
 assert.deepEqual(CAPTURE_PLACEHOLDER_TIMING,{typeMs:42,deleteMs:22,holdMs:1900,pauseMs:320});
 let s=initialPlaceholderState();let step=advancePlaceholder(s,2,2);assert.equal(step.delay,42);assert.equal(step.state.count,1);
 step=advancePlaceholder({...s,count:2},2,2);assert.equal(step.delay,1900);assert.equal(step.state.phase,'holding');
 step=advancePlaceholder({index:1,count:0,phase:'deleting'},2,2);assert.equal(step.delay,320);
 step=advancePlaceholder(step.state,2,2);assert.equal(step.state.index,0);
});
test('only ghost text types and rotates, without modifying textarea contents or whole native hint',()=>{
 const f=fixture();assert.equal(f.layer.attrs['aria-hidden'],'true');assert.equal(f.layer.children[0].textContent,'');
 f.advance(42);assert.equal(f.layer.children[0].textContent,'你');assert.equal(f.textarea.placeholder,'你好');assert.equal(f.textarea.value,'');
 f.advance(42);assert.equal(f.layer.children[0].textContent,'你好');f.advance(1900);assert.equal(f.layer.children[0].textContent,'你好');
 f.advance(600);assert.equal(f.textarea.placeholder,'记下这一刻');assert.ok(f.timers.size<=1);f.controller.dispose();
});
test('focus and composition hide/stop animation; empty blur resumes, typed content never overlaps',()=>{
 const f=fixture();f.advance(42);f.textarea.fire('focus');assert.equal(f.layer.hidden,true);assert.equal(f.timers.size,0);
 f.textarea.value='中文草稿';f.textarea.fire('compositionstart');f.advance(5000);assert.equal(f.textarea.value,'中文草稿');
 f.textarea.fire('compositionend');f.textarea.fire('blur');assert.equal(f.layer.hidden,true);
 f.textarea.value='';f.textarea.fire('input');assert.equal(f.layer.hidden,false);assert.equal(f.timers.size,1);f.controller.dispose();
});
test('hidden document, offscreen pane and disallowed editing pause all timers',()=>{
 const f=fixture();f.doc.visibilityState='hidden';f.events.get('visibilitychange')();assert.equal(f.timers.size,0);assert.equal(f.layer.hidden,true);
 f.doc.visibilityState='visible';f.events.get('visibilitychange')();assert.equal(f.timers.size,1);
 f.setAllowed(false);f.controller.sync();assert.equal(f.timers.size,0);f.setAllowed(true);f.controller.sync();assert.equal(f.timers.size,1);
 f.textarea.getBoundingClientRect=()=>({width:0,height:0});f.controller.sync();assert.equal(f.timers.size,0);f.controller.dispose();
});
test('reduced motion displays full sentences and swaps without character animation',()=>{
 const f=fixture({reduced:true});assert.equal(f.layer.children[0].textContent,'你好');f.advance(1899);assert.equal(f.layer.children[0].textContent,'你好');
 f.advance(1);assert.equal(f.layer.children[0].textContent,'记下这一刻');f.preference.matches=false;f.preference.change();f.controller.dispose();
});
test('save reset, language changes, empty pools and surrogate pairs remain safe',()=>{
 const f=fixture({pool:['😀你好','再见']});f.advance(42);assert.equal(f.layer.children[0].textContent,'😀');
 f.textarea.placeholder='再见';f.controller.reset();assert.equal(f.textarea.placeholder,'再见');assert.equal(f.layer.children[0].textContent,'');
 f.setPool(['Hello','Hi']);f.controller.sync();assert.equal(f.textarea.placeholder,'Hello');
 f.setPool([]);f.controller.sync();assert.equal(f.layer.hidden,true);assert.equal(f.timers.size,0);f.controller.dispose();
});
test('closing removes listeners, overlay and outstanding timer',()=>{
 const f=fixture();f.controller.dispose();assert.equal(f.timers.size,0);assert.equal(f.textarea.listeners.size,0);assert.equal(f.events.size,0);assert.equal(f.layer.removed,true);
 f.controller.sync();assert.equal(f.timers.size,0);
});
