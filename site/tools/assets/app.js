// Progressive enhancement of crawlable static tool pages. File processing lives in each tool.
import { GROUPS, STAGES, TOOLS, DETAILS } from './catalog-data.js';
import { ART } from './catalog-icons.js';
const $ = (id) => document.getElementById(id);
const search = $('search'), dialog = $('tool-dialog'), select = $('group-select');
const groupName = Object.fromEntries(GROUPS.map((g) => [g.id,g.name]));
const byName = new Map(TOOLS.map((t) => [t.name,t]));
const isRoadmap = document.body.dataset.page === 'roadmap';
const entries = [...$('cards').querySelectorAll('[data-tool]')];
for(const el of entries) el.tool=byName.get(el.dataset.tool);
const status = (t) => t.stage ? `Planned · ${STAGES[t.stage]}${t.beta ? ' · Beta' : ''}` : 'Available';
const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
function openDialog(tool){
 $('dialog-status').textContent=`${groupName[tool.group]} · ${status(tool)}`;
 $('dialog-title').textContent=tool.name;
 $('dialog-copy').textContent=tool.copy;
 dialog.showModal();
}
for(const el of entries) if(!el.tool.href) el.addEventListener('click',()=>openDialog(el.tool));
function result(tool){
 const el=node(tool.href?'a':'button','cat-row');el.tool=tool;
 if(tool.href)el.href=tool.href;else{el.type='button';el.setAttribute('aria-haspopup','dialog');el.addEventListener('click',()=>openDialog(tool));}
 const icon=node('span',`app-icon tone-${tool.art}`);icon.setAttribute('aria-hidden','true');
 icon.innerHTML=`<svg viewBox="0 0 64 64" fill="none" stroke-linecap="round" stroke-linejoin="round">${ART[tool.art]??ART.files}</svg>`;
 const body=node('span','cat-row-body'),top=node('span','cat-row-top');
 top.append(node('span','cat-row-title',tool.name),node('span','cat-tag',status(tool)));
 body.append(top,node('span','cat-row-copy',tool.copy));el.append(icon,body);return el;
}
const results=TOOLS.map(result);$('result-rows').append(...results);
function render(){
 const query=search.value.trim().toLowerCase(), group=select.value;
 const current=query?results:entries;let count=0;
 for(const el of current){const t=el.tool;const text=[t.name,t.copy,DETAILS[t.name]??'',groupName[t.group],status(t)].join(' ').toLowerCase();el.hidden=(group!=='all'&&t.group!==group)||(query&&!text.includes(query));if(!el.hidden)count++;}
 $('available').hidden=Boolean(query);$('results').hidden=!query;
 $('available-note').textContent=`${count} ${query?(count===1?'match':'matches'):isRoadmap?'planned':'available'}`;
 $('results-note').textContent=count?`${count} ${count===1?'tool':'tools'} found`:'No tools found. Try another search or category.';
 $('catalog-empty').hidden=Boolean(query)||count>0;
 const teaser=$('cards').querySelector('.cat-teaser');if(teaser)teaser.hidden=group!=='all';
 $('clear').hidden=!query;$('search-status').textContent=`${count} ${count===1?'tool':'tools'} ${query?'found':isRoadmap?'planned':'available'}`;
}
function toListTop(){const top=$('bar-sentinel').getBoundingClientRect().top;if(top<0)window.scrollTo(0,top+window.scrollY);}
// Hero links always reveal the requested tool, even after filtering or searching.
document.addEventListener('click',(event)=>{if(event.target.closest('.app-shelf a, a[href="#available"]')){search.value='';select.value='all';render();}});
select.addEventListener('change',()=>{render();toListTop();});
search.addEventListener('input',()=>{render();toListTop();});
$('clear').addEventListener('click',()=>{search.value='';render();search.focus();});
search.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&search.value){event.preventDefault();search.value='';render();}});
document.addEventListener('keydown',(event)=>{const active=document.activeElement;const typing=['INPUT','TEXTAREA','SELECT'].includes(active?.tagName)||active?.isContentEditable;if(event.key==='/'&&!dialog.open&&!typing&&!event.metaKey&&!event.ctrlKey&&!event.altKey){event.preventDefault();search.focus();}});
new IntersectionObserver(([entry])=>{$('bar').classList.toggle('stuck',!entry.isIntersecting&&entry.boundingClientRect.top<0);}).observe($('bar-sentinel'));
render();
