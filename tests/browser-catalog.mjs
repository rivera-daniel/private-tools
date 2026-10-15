// Static content, illustrated cards and catalog navigation. No real user files or external requests.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { TOOLS, DETAILS } from '../site/assets/catalog-data.js';
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const live=TOOLS.filter(t=>!t.stage), planned=TOOLS.filter(t=>t.stage), featured=live.slice(0,5);
const slug=t=>t.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
const base=process.env.BASE ?? 'http://127.0.0.1:4176';
const shots=process.env.SHOTS ?? 'test-results/catalog';
await mkdir(shots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM ?? '/usr/sbin/chromium'});
try {
 const context=await browser.newContext({javaScriptEnabled:false});const page=await context.newPage();
 await page.goto(`${base}/`);
 assert.equal(await page.getByRole('heading',{name:'Toolkit',exact:true}).count(),1);
 assert.equal(await page.locator('#cards .tool-illustration').count(),TOOLS.filter(t=>!t.stage).length);
 assert.equal(await page.locator('#cards .tool-preview').count(),0);
 assert.equal(await page.locator('#cards .cat-card').count(),TOOLS.filter(t=>!t.stage).length);
 for(const t of TOOLS.filter(t=>!t.stage)) {const card=page.locator('#cards article').filter({has:page.getByRole('heading',{name:t.name,exact:true})});assert.ok((await card.textContent()).includes(t.copy));assert.ok((await card.textContent()).includes(DETAILS[t.name]));assert.equal(await card.locator('a').getAttribute('href'),t.href);}
 assert.ok(await page.getByRole('heading',{level:1}).isVisible());await context.close();
 console.log('No-JavaScript static descriptions, headings and tool destinations passed');
 for(const width of [320,390,820,1440]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});page.on('request',r=>{if(!r.url().startsWith(base)&&!r.url().startsWith('data:'))external.push(r.url());});
  await page.goto(`${base}/`,{waitUntil:'networkidle'});
  for(const colorScheme of ['light','dark']){
   await page.emulateMedia({colorScheme});
   await page.locator('.cat-card:last-of-type').scrollIntoViewIfNeeded();
   assert.equal(await page.locator('#cards .tool-illustration').count(),TOOLS.filter(t=>!t.stage).length);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width}/${colorScheme}`);
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.screenshot({path:`${shots}/${width}-${colorScheme}.jpg`,type:'jpeg',quality:80,fullPage:true});
  }
  assert.equal(await page.locator('.app-shelf a').count(),featured.length);
  assert.equal(await page.locator('.app-shelf .tool-illustration').count(),featured.length);
  assert.equal(await page.locator('.app-shelf .app-icon').count(),0);
  await page.locator('.app-shelf a').last().click();assert.equal(new URL(page.url()).hash,'#'+slug(featured.at(-1)));
  await page.locator('#search').fill('Office');assert.equal(await page.getByRole('button',{name:/Office Viewer/}).count(),1);assert.match(await page.getByRole('button',{name:/Office Viewer/}).locator('.cat-tag').textContent(),/Planned/);
  await page.getByRole('button',{name:/Office Viewer/}).click();assert.ok(await page.locator('#tool-dialog').isVisible());await page.keyboard.press('Escape');assert.equal(await page.locator('#tool-dialog').isVisible(),false);
  await page.locator('#search').fill('<img src=x onerror=alert(1)>');assert.match(await page.locator('#results-note').textContent(),/No tools found/);assert.equal(await page.locator('#results img').count(),0);
  await page.locator('#search').press('Escape');await page.locator('#group-select').selectOption('forensics');assert.ok(await page.locator('#catalog-empty').isVisible());assert.equal(await page.locator('.cat-card:visible').count(),0);
  await page.locator('.app-shelf a').first().click();assert.ok(await page.locator('#image-inspector').isVisible());assert.equal(await page.locator('#group-select').inputValue(),'all');await page.locator('body').click({position:{x:3,y:3}});await page.keyboard.press('/');assert.ok(await page.locator('#search').evaluate(e=>e===document.activeElement));
  await page.locator('.cat-teaser').click();await page.waitForURL(`${base}/roadmap/`);assert.equal(await page.locator('#cards .cat-row').count(),planned.length);
  assert.equal(await page.locator('#cards .cat-row .tool-illustration').count(),planned.length);
  assert.equal(await page.locator('#result-rows .tool-illustration').count(),TOOLS.length);
  assert.ok(await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return new Set(ids).size===ids.length;}),'unique SVG and page IDs');
  await page.screenshot({path:`${shots}/${width}-roadmap.jpg`,type:'jpeg',quality:80,fullPage:true});
  await page.locator('#group-select').selectOption('forensics');assert.equal(await page.locator('#cards .cat-row:visible').count(),planned.filter(t=>t.group==='forensics').length);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await context.close();console.log(`${width}px: light/dark, illustrated icons, search, filters, dialog, keyboard and roadmap passed`);
 }
}finally{await browser.close();}
