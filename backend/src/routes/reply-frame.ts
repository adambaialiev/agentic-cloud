/**
 * The frame an agent's interactive HTML reply runs in (note #1186).
 *
 * An agent writes this HTML, and an agent reads mail and web pages a stranger
 * wrote — so the HTML is treated as a stranger's. Adam's line for it: it must
 * never reach the person's sign-in, the Workspace's own pages or its API; it
 * runs closed off from them, and its ONE way out is the message back to the
 * agent that wrote it.
 *
 * Two frames, one inside the other, and each is there for a reason:
 *
 *  - The OUTER frame is this document, served from our own origin with its
 *    own Content-Security-Policy, and framed by the chat with
 *    `sandbox="allow-scripts"` (no `allow-same-origin`). The policy's own
 *    `sandbox` directive holds even when someone opens this address directly.
 *    Its origin is opaque, so no cookie, no storage, no DOM of the Workspace.
 *    It is served rather than written into a `srcdoc` because a `srcdoc`
 *    inherits the Workspace's policy (`script-src 'self'`), which would
 *    refuse the agent's inline script outright.
 *
 *  - The INNER frame holds the agent's HTML, as a `srcdoc`, so it inherits
 *    THIS document's policy: no fetch, no XHR, no WebSocket, no beacon
 *    (`connect-src 'none'`), no picture, font or media from the network
 *    (`data:`/`blob:` only), no form posted anywhere (`form-action 'none'`),
 *    no nested page (`frame-src 'none'`). Its sandbox has no popups and no
 *    top navigation. And a frame can always navigate ITSELF — which is why
 *    there are two: a navigation of the inner frame is checked against its
 *    EMBEDDER's `frame-src`, and that embedder is this document, whose answer
 *    is 'none'. One frame, embedded straight in the Workspace (whose
 *    `frame-src` allows any https page, for PDFs), could send what a person
 *    typed to any address by setting its own `location`.
 *
 * Since note #1193 the WHOLE reply runs here whenever any part of it styles
 * itself, runs or asks: the Workspace no longer lifts the opening words out
 * and sets them itself. Nothing about the walls changed with that; there is
 * only more of the reply behind them. The frame also says, once, that the
 * person touched it (`{ t: 'touched' }`, a tap, a key or a change, and
 * nothing about which), so the Workspace knows not to let go of a frame
 * that holds something they typed when it is scrolled far away.
 *
 * The way out is `postMessage`, and only to the parent. The inner frame's
 * bridge turns a tap on a `data-reply` button, a submitted form, or a call to
 * `agentbuilt.reply(text)` into `{ t: 'reply', text }`; this document checks
 * the message came from ITS inner frame and passes it up; the Workspace
 * checks it came from THIS frame, and sends it to the agent as the person's
 * message, through the chat's own outbox, where the person sees it as their
 * bubble. A link is asked for the same way (`{ t: 'open', href }`), and the
 * Workspace opens it only if that exact address was in the HTML as the agent
 * wrote it — never one a script built after the person typed something.
 *
 * Nothing here is per-person or secret, so the document is cacheable.
 */

import { Router } from 'express';

/** Where the Workspace frames it from. Under /workspace, so the edge sends it
 *  to this backend like the API beside it. */
export const REPLY_FRAME_PATH = '/workspace/reply-frame';

/** The longest answer the frame will pass up — the chat's own message cap. */
export const REPLY_FRAME_ANSWER_MAX = 10_000;

/** The policy this document runs under, and — because a `srcdoc` inherits it
 *  — the policy the agent's HTML runs under. */
export const REPLY_FRAME_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts allow-forms',
].join('; ');

/**
 * What every reply's HTML starts with: the page's own reading type and
 * light paper (the Workspace's palette is fixed light, see
 * workspace-palette), controls that look like the Workspace's, and the
 * bridge. An agent's own `<style>` comes later in the document and wins.
 * The page is transparent over the card's white, and stays inside the card's
 * padding: a reply can colour itself, never the card's edge.
 */
const INNER_STYLE = `
:root{color-scheme:light;--text:#1f1e1d;--hint:#686762;--accent:#1a68d8;--card:#efefef;--border:rgba(104,103,98,.28)}
html{font:17px/1.45 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;color:var(--text);background:transparent;-webkit-text-size-adjust:100%}
body{margin:0;overflow-wrap:anywhere}
body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}
h1,h2,h3,h4{line-height:1.3;margin:0 0 8px;font-weight:500}
h1{font-size:1.2em}h2{font-size:1.12em}h3{font-size:1.06em}h4{font-size:1em}
p,ul,ol,blockquote,pre,table,form,fieldset{margin:0 0 9px}
a{color:var(--accent)}
img,svg,canvas,video{max-width:100%;height:auto}
pre{overflow:auto;background:var(--card);padding:8px 10px;border-radius:8px;font-size:.85em}
code{font-size:.9em}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}
th,td{border:1px solid var(--border);padding:4px 8px;text-align:left}
button,input,select,textarea{font:inherit;font-size:17px;color:inherit}
button,input[type=submit],input[type=button]{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;margin:0 6px 6px 0;cursor:pointer;-webkit-tap-highlight-color:transparent}
button:active{opacity:.65}
input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=range]),select,textarea{box-sizing:border-box;max-width:100%;border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:#fff}
input[type=radio],input[type=checkbox]{width:18px;height:18px;margin:0 8px 0 0;vertical-align:-3px;accent-color:var(--accent)}
fieldset{border:1px solid var(--border);border-radius:8px;padding:8px 12px}
:disabled{opacity:.5;cursor:default}
[data-reply-sent]::after{content:"\\00a0\\2713";font-weight:600}
html[data-reply-state=old] [data-reply]{cursor:default}
`.replace(/\n/g, '');

/**
 * Note #1197 (Adam, 19 Nov 2026, with a screenshot of buttons drawn as white
 * boxes with white words: "why buttons text is also white"). The base style
 * gives every button the accent with white text; a reply that restyles a
 * button's background and not its text colour kept that white. So the page
 * mends what it cannot read: after it draws, and whenever its content or a
 * style changes, every button and submit/button/reset input whose text has
 * less than WCAG's 4.5:1 contrast against the background it really shows
 * (every ancestor's background composited over the card's white, since the
 * page is transparent over it) gets the page's text colour #1f1e1d, or
 * white, whichever reads better, as an inline !important colour. An agent's
 * own colours stay whenever they are readable. A background image or a
 * colour the page cannot parse is left alone rather than guessed at. The
 * tapped-answer check mark (note #1194) inherits the colour, so it is mended
 * with the words. The page is light on every phone, so one rule serves
 * light and dark.
 */
export const REPLY_FRAME_MIN_CONTRAST = 4.5;
const LEGIBLE = String.raw`
function col(s){var m=/^rgba?\(([^)]+)\)$/.exec(s||''),k=1;if(!m){m=/^color\(srgb ([^)]+)\)$/.exec(s||'');k=255}if(!m)return null;var p=m[1].split(/[\s,\/]+/).filter(Boolean),out=[];for(var i=0;i<p.length;i++){var v=parseFloat(p[i]);if(isNaN(v))return null;if(p[i].charAt(p[i].length-1)==='%')v=i<3?v*2.55:v/100;else if(i<3)v=v*k;out.push(v)}if(out.length<3)return null;if(out.length<4)out.push(1);return out}
function over(t,b){var a=t[3];return [t[0]*a+b[0]*(1-a),t[1]*a+b[1]*(1-a),t[2]*a+b[2]*(1-a),1]}
function lum(c){function ch(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*ch(c[0])+0.7152*ch(c[1])+0.0722*ch(c[2])}
function ratio(a,b){var x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)}
function shown(el){var chain=[];for(var n=el;n&&n.nodeType===1;n=n.parentElement)chain.push(n);var c=[255,255,255,1];for(var i=chain.length-1;i>=0;i--){var cs=getComputedStyle(chain[i]);if(cs.backgroundImage&&cs.backgroundImage!=='none')return null;var b=col(cs.backgroundColor);if(!b)return null;if(b[3]>0)c=over(b,c)}return c}
var INK=[31,30,29,1],PAPER=[255,255,255,1];
function legible(){var all=document.querySelectorAll('button,input[type=submit],input[type=button],input[type=reset]');for(var i=0;i<all.length;i++){var el=all[i],bg=shown(el);if(!bg)continue;var fg=col(getComputedStyle(el).color);if(!fg)continue;if(ratio(over(fg,bg),bg)>=MIN)continue;el.style.setProperty('color',ratio(INK,bg)>=ratio(PAPER,bg)?'#1f1e1d':'#fff','important');el.setAttribute('data-agentbuilt-legible','')}}
var watch=null,queued=false;function mend(){if(queued)return;queued=true;setTimeout(function(){queued=false;try{legible()}catch(e){}if(watch)watch.takeRecords()},0)}
addEventListener('DOMContentLoaded',function(){try{legible()}catch(e){}if(window.MutationObserver){watch=new MutationObserver(mend);watch.observe(root,{subtree:true,childList:true,characterData:false,attributes:true,attributeFilter:['style','class']})}});
addEventListener('load',mend);
`;

/**
 * The bridge, inside the agent's page. Runs before the agent's own script,
 * which may replace any of it — that costs nothing, because nothing here is a
 * privilege: the frame can only post to its parent, and every check that
 * matters is made by the parent and by the Workspace above it.
 */
const INNER_BRIDGE = `(function(){
var P=parent,root=document.documentElement,state=root.getAttribute('data-reply-state')||'live',MAX=${REPLY_FRAME_ANSWER_MAX},sent=[];
function post(m){try{P.postMessage(m,'*')}catch(e){}}
function lock(){var all=document.querySelectorAll('button,input,select,textarea,fieldset');for(var i=0;i<all.length;i++){all[i].disabled=true}}
function had(t){for(var i=0;i<sent.length;i++){if(sent[i]===t)return true}return false}
function headHad(h){for(var i=0;i<sent.length;i++){if(sent[i].split('\\n')[0]===h)return true}return false}
function isSubmit(el){return Boolean(el.form)&&(el.type==='submit'||el.type==='image')}
function marks(){if(document.readyState==='loading')return;var all=document.querySelectorAll('[data-reply]:not(form),form button,form input[type=submit]');
for(var i=0;i<all.length;i++){var el=all[i],hit;if(isSubmit(el)){var h=((el.getAttribute('data-reply')||el.form.getAttribute('data-reply')||'')+'').trim();hit=Boolean(h)&&headHad(h)}else{hit=el.hasAttribute('data-reply')&&had(((el.getAttribute('data-reply')||el.textContent||'')+'').trim())}
if(hit)el.setAttribute('data-reply-sent','')}}
function set(s){state=s;root.setAttribute('data-reply-state',s);if(s==='old')lock();try{dispatchEvent(new CustomEvent('agentbuilt:state',{detail:s}))}catch(e){}}
function reply(text,el){if(state==='old')return false;text=String(text==null?'':text).trim().slice(0,MAX);if(!text)return false;if(el&&el.setAttribute)el.setAttribute('data-reply-sent','');if(had(text))return false;sent.push(text);post({t:'reply',text:text});if(state==='live')set('answered');return true}
window.agentbuilt={reply:function(t){return reply(t)},state:function(){return state}};
addEventListener('message',function(e){var d=e.data;if(e.source!==P||!d||d.t!=='state')return;
if(d.sent&&d.sent.length!==undefined){for(var i=0;i<d.sent.length&&i<200;i++){var t=String(d.sent[i]).trim();if(t&&!had(t))sent.push(t)}marks()}
if(d.state==='answered'||d.state==='old'||d.state==='live')set(d.state)});
document.addEventListener('click',function(e){if(e.defaultPrevented||!e.target||!e.target.closest)return;
var a=e.target.closest('a[href]');
if(a){var raw=a.getAttribute('href')||'';e.preventDefault();if(raw.charAt(0)==='#'){var at=document.getElementById(decodeURIComponent(raw.slice(1)));if(at)at.scrollIntoView();return}post({t:'open',href:a.href});return}
var b=e.target.closest('[data-reply]');if(!b||b.tagName==='FORM')return;
var c=e.target.closest('input,select,textarea,label,form');if(c&&c!==b&&b.contains(c))return;
if(b.form&&(b.type==='submit'||b.type==='image'))return;
e.preventDefault();reply(b.getAttribute('data-reply')||b.textContent,b)});
document.addEventListener('submit',function(e){if(e.defaultPrevented)return;e.preventDefault();var f=e.target,s=e.submitter||null,lines=[];
var head=(s&&s.getAttribute&&s.getAttribute('data-reply'))||f.getAttribute('data-reply')||'';if(head)lines.push(head);
var fd;try{fd=new FormData(f,s)}catch(x){fd=new FormData(f)}var seen={},order=[];
fd.forEach(function(v,k){if(typeof v!=='string')return;if(head&&s&&s.name&&k===s.name)return;if(!(k in seen)){seen[k]=[];order.push(k)}seen[k].push(v)});
for(var i=0;i<order.length;i++)lines.push(order[i]+': '+seen[order[i]].join(', '));
if(!lines.length)lines.push(((s&&(s.value||s.textContent))||'Submitted').trim());
reply(lines.join('\\n'),s||f.querySelector('button:not([type=button]):not([type=reset]),input[type=submit]'))});
function measure(){post({t:'h',h:Math.ceil(root.getBoundingClientRect().height)})}
if(window.ResizeObserver)new ResizeObserver(measure).observe(root);
document.addEventListener('DOMContentLoaded',measure);addEventListener('load',measure);setTimeout(measure,0);
addEventListener('DOMContentLoaded',function(){marks();if(state==='old')lock()});
var MIN=${REPLY_FRAME_MIN_CONTRAST};${LEGIBLE}
var touched=false;function touch(){if(touched)return;touched=true;post({t:'touched'})}
['pointerdown','keydown','input','change'].forEach(function(n){document.addEventListener(n,touch,true)});
})();`;

/** The outer document. It has no words of its own: it waits for the
 *  Workspace to hand it the reply, builds the inner frame, and relays.
 *
 *  Note #1192 (Adam, 18 Nov 2026: "it was just blank black and then buttons
 *  appeared after 10 seconds"): the inner frame starts as tall as this one,
 *  never at zero. A frame of no size from another origin is one a phone's
 *  browser may treat as invisible and put to sleep — its timers and its
 *  drawing held back — and that frame was the one whose height report the
 *  whole reply waited on. The page measures itself as soon as it is parsed,
 *  not only on a timer, and both documents say they are light, so nothing
 *  between them is drawn in a dark backdrop. */
function outerDocument(): string {
  const inner = JSON.stringify({ style: INNER_STYLE, bridge: INNER_BRIDGE });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><style>:root{color-scheme:light}html,body{margin:0;padding:0;background:transparent;overflow:hidden}iframe{display:block;border:0;width:100%;height:100vh}</style>
</head><body><script>(function(){
var P=parent,K=${inner.replace(/</g, '\\u003c')},frame=null,MAX=${REPLY_FRAME_ANSWER_MAX};
function up(m){try{P.postMessage(m,'*')}catch(e){}}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}
function sentOf(v){var out=[];if(v&&v.length!==undefined){for(var i=0;i<v.length&&i<200;i++){if(typeof v[i]==='string')out.push(v[i].slice(0,MAX))}}return out}
addEventListener('message',function(e){var d=e.data;if(!d||typeof d!=='object')return;
if(e.source===P){
if(d.t==='show'&&!frame&&typeof d.html==='string'){var st=d.state==='answered'||d.state==='old'?d.state:'live',said={t:'state',state:st,sent:sentOf(d.sent)};
frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts allow-forms');frame.setAttribute('title',typeof d.title==='string'?d.title:'Reply');
frame.srcdoc='<!doctype html><html data-reply-state="'+st+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_self"><style>'+K.style+'</style><script>'+K.bridge+'<\\/script></head><body>'+d.html+'</body></html>';
frame.addEventListener('load',function(){if(frame.contentWindow)frame.contentWindow.postMessage(said,'*')});
document.body.appendChild(frame)}
else if(d.t==='state'&&frame&&frame.contentWindow){frame.contentWindow.postMessage({t:'state',state:d.state,sent:sentOf(d.sent)},'*')}
return}
if(!frame||e.source!==frame.contentWindow)return;
if(d.t==='h'&&typeof d.h==='number'&&d.h>=0){var h=Math.min(20000,Math.ceil(d.h));frame.style.height=h+'px';up({t:'h',h:h})}
else if(d.t==='reply'&&typeof d.text==='string'){up({t:'reply',text:d.text.slice(0,MAX)})}
else if(d.t==='open'&&typeof d.href==='string'){up({t:'open',href:d.href.slice(0,4000)})}
else if(d.t==='touched'){up({t:'touched'})}});
up({t:'ready'});void esc;
})();</script></body></html>`;
}

/**
 * Note #1192: what a slow or failed frame reports, so the next "it took ten
 * seconds" has an answer in the log rather than a guess. Numbers only —
 * milliseconds since the frame was put on the page, and the frame
 * document's own fetch as the browser timed it — plus the browser's name.
 * Nothing the reply said and nobody's name.
 */
const TIMING_FIELDS = ['loaded', 'ready', 'shown', 'fetch', 'transfer', 'attempt'] as const;
const TIMING_PER_MINUTE = 30;
let timingWindow = { at: 0, count: 0 };

export function replyFrameTimingLine(body: unknown, userAgent: string, now = Date.now()): string | null {
  if (now - timingWindow.at > 60_000) timingWindow = { at: now, count: 0 };
  if (timingWindow.count >= TIMING_PER_MINUTE) return null;
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const parts: string[] = [];
  for (const field of TIMING_FIELDS) {
    const value = input[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) parts.push(`${field}=${Math.min(Math.round(value), 3_600_000)}`);
  }
  const outcome = input.outcome === 'failed' ? 'failed' : input.outcome === 'slow' ? 'slow' : null;
  if (!outcome || !parts.length) return null;
  const browser = userAgent.replace(/[^\x20-\x7e]/g, '').slice(0, 200);
  timingWindow.count += 1;
  return `[reply-frame] ${outcome}: ${parts.join(' ')} ua=${JSON.stringify(browser)}`;
}

let cached: string | null = null;

export function replyFrameDocument(): string {
  cached ??= outerDocument();
  return cached;
}

export function replyFrameRoutes(): Router {
  const router = Router();
  router.get('/reply-frame', (_req, res) => {
    res.setHeader('Content-Security-Policy', REPLY_FRAME_CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Framed only by the Workspace itself.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('html').send(replyFrameDocument());
  });
  return router;
}
