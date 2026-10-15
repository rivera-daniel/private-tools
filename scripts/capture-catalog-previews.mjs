// Real, unmodified tool UI. Run against a static server serving this checkout.
// BASE=http://127.0.0.1:4198 PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node scripts/capture-catalog-previews.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fx from '../tests/fixtures/build.js';
import { docx } from '../tests/fixtures/documents.js';
import * as mupdf from '../site/tools/vendor/mupdf/mupdf.js';
import { writeZip } from '../site/tools/lib/zip/index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'site/tools/assets/previews');
const raw = process.env.CAPTURE_DIR ?? mkdtempSync(join(tmpdir(), 'private-tools-previews-'));
const base = process.env.BASE ?? 'http://127.0.0.1:4198';
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
mkdirSync(out, {recursive:true}); mkdirSync(raw, {recursive:true});
const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0,0,900,600], false);
const pixels=pix.getPixels(), stride=pix.getStride();
for(let y=0;y<600;y++)for(let x=0;x<900;x++) { const p=y*stride+x*3; const ridge=340+60*Math.sin(x/160)+35*Math.cos(x/70); const sky=y<ridge; pixels[p]=sky?Math.round(105+y*.1):Math.round(35+y*.06); pixels[p+1]=sky?Math.round(150+y*.1):Math.round(70+y*.05); pixels[p+2]=sky?210:Math.round(95+y*.04); }
const jpg=Buffer.from(pix.asJPEG(92));pix.destroy();
const exif=fx.exifSegment(fx.tiff([[0x010f,2,'Canon'],[0x0110,2,'Canon EOS R5'],[0x0132,2,'2026:10:01 10:30:00']],{gps:[[1,2,'N'],[2,5,fx.dms(30.26715)],[3,2,'W'],[4,5,fx.dms(97.74306)]]}));
const photo=Buffer.concat([jpg.subarray(0,2),exif,jpg.subarray(2)]);
writeFileSync(`${raw}/sample-landscape.jpg`,photo);
writeFileSync(`${raw}/project-brief.docx`,await docx());
writeFileSync(`${raw}/release-notes.txt`,'Private Tools sample release\nAll sample data is fictional.\n');
const doc=new mupdf.PDFDocument(), font=doc.addSimpleFont(new mupdf.Font('Helvetica')), bold=doc.addSimpleFont(new mupdf.Font('Helvetica-Bold'));
const res=doc.addObject({Font:{F1:font,F2:bold}});
for(let i=0;i<3;i++){
 const text=(s,x,y,size=12,b=false)=>`BT /${b?'F2':'F1'} ${size} Tf ${x} ${y} Td (${s}) Tj ET`;
 const stream=['0.97 0.97 0.96 rg 0 0 612 792 re f','0.75 0.18 0.16 rg 52 698 42 5 re f','0.12 0.13 0.15 rg',text('FIELD NOTES',52,724,10,true),text(['A quieter workspace.','Keep the essentials.','Ready to share.'][i],52,647,30,true),text('A fictional project brief / October 2026',52,620,11),'0.85 0.85 0.84 RG 52 596 m 560 596 l S',text('PROJECT OVERVIEW',52,565,10,true),text('Simple tools. Thoughtful defaults. Private by design.',52,538,12),text('This sample document contains synthetic demonstration content.',52,517,11),'0.91 0.92 0.91 rg 52 310 508 160 re f','0.18 0.28 0.29 rg 76 334 70 52 re f 176 334 70 80 re f 276 334 70 112 re f 376 334 70 95 re f','0.12 0.13 0.15 rg',text('Less friction, from the first file to the final export.',52,272,15,true),text('Built for the browser. Files stay on your device.',52,245,11),text(`PRIVATE TOOLS / SAMPLE DOCUMENT                                     ${i+1} / 3`,52,52,9)].join('\n');
 doc.insertPage(-1,doc.addPage([0,0,612,792],0,res,stream));
}
const buf=doc.saveToBuffer('compress'); writeFileSync(`${raw}/project-brief.pdf`,buf.asUint8Array());buf.destroy();doc.destroy();
writeFileSync(`${raw}/project-bundle.zip`,await writeZip(['project-brief.pdf','sample-landscape.jpg','release-notes.txt','project-brief.docx'].map(name=>({name,data:new Uint8Array(readFileSync(`${raw}/${name}`))}))));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/sbin/chromium'});
const evidence=[];
try{
for(const tool of ['image-inspector','file-inspector','metadata-cleaner','archiver','pdf-editor']){
 const page=await browser.newPage({viewport:{width:1100,height:900},colorScheme:'dark',deviceScaleFactor:1});
 await page.addInitScript(()=>localStorage.setItem('theme','dark'));
 await page.goto(`${base}/tools/${tool}/`,{waitUntil:'networkidle'});
 let selector;
 if(tool==='image-inspector'||tool==='file-inspector'){
  await page.setInputFiles('#file',`${raw}/${tool==='image-inspector'?'sample-landscape.jpg':'project-brief.docx'}`);
  await page.waitForSelector('#results:not([hidden])');await page.waitForFunction(()=>document.getElementById('busy').hidden);
  assert.equal(await page.getAttribute('#summary','data-level'),'exposed');selector='#results';
 }else if(tool==='metadata-cleaner'){
  await page.setInputFiles('#file',['sample-landscape.jpg','project-brief.docx','release-notes.txt'].map(n=>`${raw}/${n}`));
  await page.waitForFunction(()=>document.querySelectorAll('.job').length===3&&[...document.querySelectorAll('.job')].every(j=>j.dataset.state==='done'),null,{timeout:30000});selector='#queue';
 }else if(tool==='archiver'){
  await page.click('#tab-open');await page.setInputFiles('#open-file',`${raw}/project-bundle.zip`);
  await page.waitForSelector('#open-panel:not([hidden])');await page.waitForFunction(()=>document.querySelectorAll('#open-list tr').length===4);selector='#open-panel';
 }else{
  await page.setInputFiles('#file',`${raw}/project-brief.pdf`);await page.waitForSelector('#view-panel .vw-page');
  await page.waitForFunction(()=>[...document.querySelectorAll('#view-panel canvas')].some(c=>c.width>100));selector='#editor';
 }
 await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(500);
 await page.evaluate(()=>window.scrollTo(0,0));
 const candidate=page.locator(selector);let box=await candidate.count()?await candidate.boundingBox():null;
 if(!box)box=await page.locator('main').boundingBox();
 const clip={x:Math.max(0,box.x),y:Math.max(0,box.y),width:Math.min(box.width,1100-box.x),height:Math.min(box.height,740)};
 const path=`${raw}/${tool}.png`;await page.screenshot({path,clip});
 execFileSync(process.env.CONVERT??'convert',[path,'-quality','88',`${out}/${tool}.webp`]);
 const text=(await page.locator('main').innerText()).slice(0,3000);
 evidence.push({tool,clip,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),bytes:readFileSync(`${out}/${tool}.webp`).length,text});
 await page.close();
}
}finally{await browser.close();}
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
writeFileSync(`${raw}/evidence.json`,JSON.stringify({revision,base,evidence},null,2));
writeFileSync(`${out}/README.md`,`# Catalog screenshots\n\nReal Chromium screenshots of shipped tools, captured at source revision ${revision}. No UI text, results, or controls were reconstructed or replaced. PNG originals and machine-readable evidence are saved in CAPTURE_DIR (default: a fresh private-tools-previews- directory under the OS temporary directory). WebP conversion changes encoding only.\n\nRefresh with a static server for this checkout:\n\n\`BASE=http://127.0.0.1:4198 PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node scripts/capture-catalog-previews.mjs\`\n\nOptional: CHROMIUM, CONVERT, CAPTURE_DIR. Requires Node, Chromium, ImageMagick and Playwright Core.\n\nSamples are code-generated, public-safe fictional fixtures: abstract landscape JPEG with Canon/GPS tags pointing to central Austin (not a private residence), synthetic DOCX from existing test fixtures, fictional project PDF generated with MuPDF, plain release notes and a ZIP of those files. Device metadata is synthetic. Screens show actual inspection, completed cleaning, loaded archive listing, and rendered PDF state. These are demonstrations, not security certifications.\n\n1100 x 900 browser, dark system/saved theme. Main populated output is cropped to at most 740px high.\n\n| Asset | Raw PNG SHA-256 | WebP bytes |\n|---|---|---|\n${evidence.map(e=>`| ${e.tool}.webp | ${e.sha256} | ${e.bytes} |`).join('\n')}\n`);
console.log(JSON.stringify({revision,evidence},null,2));
