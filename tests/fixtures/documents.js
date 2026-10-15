// Builds document and archive fixtures in memory: DOCX, XLSX, PPTX, ODT, EPUB and plain ZIP files with
// the metadata the inspector looks for. Names, paths and addresses are made up and assembled here.
import { crc32 } from 'node:zlib';
import { writeZip } from '../../site/lib/zip/index.js';
import { base, jpegWith, exifSegment, tiff, dms } from './build.js';

const enc = new TextEncoder();
const xml = (s) => enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`);

export const PERSON = { name: 'Jane Doe', editor: 'John Roe', user: 'jdoe', email: ['jane.doe', 'example.com'].join('@') };
export const winPath = (...parts) => ['C:', 'Users', PERSON.user, ...parts].join('\\');
export const unixPath = (...parts) => ['', 'home', PERSON.user, ...parts].join('/');
export const TRACKER = 'https://tracker.example/pixel.png';
export const gpsJpeg = () => jpegWith(exifSegment(tiff([[0x010f, 2, 'Canon'], [0x0110, 2, 'Canon EOS R5']], { gps: [[0x0001, 2, 'N'], [0x0002, 5, dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, dms(97.74306)]] })));

// Windows printer settings: the printer name in UTF-16 at the start of a DEVMODE record.
export const devmode = (name) => { const out = new Uint8Array(220); out.set(Buffer.from(name, 'utf16le').subarray(0, 62)); return out; };

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  pkg: 'http://schemas.openxmlformats.org/package/2006/relationships',
};
const rels = (list) => xml(`<Relationships xmlns="${NS.pkg}">${list.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${NS.rel}/${type}`}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`);
const types = (defaults, overrides) => xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(defaults).map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join('')}${Object.entries(overrides).map(([p, t]) => `<Override PartName="/${p}" ContentType="${t}"/>`).join('')}</Types>`);
const CT = {
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  custom: 'application/vnd.openxmlformats-officedocument.custom-properties+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  docm: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  comments: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
  people: 'application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml',
  vba: 'application/vnd.ms-office.vbaProject',
  customXmlProps: 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  sheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  xlComments: 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml',
  vml: 'application/vnd.openxmlformats-officedocument.vmlDrawing',
  printer: 'application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings',
  externalLink: 'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml',
  connections: 'application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml',
  threaded: 'application/vnd.ms-excel.threadedcomments+xml',
  person: 'application/vnd.ms-excel.person+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  notes: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  commentAuthors: 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml',
  pptComments: 'application/vnd.openxmlformats-officedocument.presentationml.comments+xml',
  authors: 'application/vnd.ms-powerpoint.authors+xml',
  modernComments: 'application/vnd.ms-powerpoint.comments+xml',
  revisionInfo: 'application/vnd.ms-powerpoint.revisioninfo+xml',
};

const core = () => xml(`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Quarterly plan</dc:title><dc:creator>${PERSON.name}</dc:creator><cp:keywords>budget</cp:keywords><cp:lastModifiedBy>${PERSON.editor}</cp:lastModifiedBy><cp:revision>7</cp:revision><cp:lastPrinted>2025-03-01T10:00:00Z</cp:lastPrinted><dcterms:created xsi:type="dcterms:W3CDTF">2025-01-02T09:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2025-03-04T17:30:00Z</dcterms:modified></cp:coreProperties>`);
const app = (application, extra = '') => xml(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>${winPath('AppData', 'Roaming', 'Microsoft', 'Templates', 'Normal.dotm')}</Template><TotalTime>42</TotalTime><Application>${application}</Application><Company>Example Corp</Company><Manager>Mary Major</Manager><AppVersion>16.0000</AppVersion>${extra}</Properties>`);
const custom = () => xml(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Client"><vt:lpwstr>Acme Holdings</vt:lpwstr></property></Properties>`);

// options: tracked (tracked changes), macros (DOCM with a VBA project), remote (remote template, image and field).
export async function docx({ tracked = false, macros = false, remote = true } = {}) {
  const W = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"`;
  const picture = (attrs) => `<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="Picture"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip ${attrs}/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const changes = tracked ? `<w:p><w:ins w:id="10" w:author="${PERSON.editor}" w:date="2025-02-01T10:00:00Z"><w:r><w:t>added words</w:t></w:r></w:ins><w:del w:id="11" w:author="${PERSON.name}" w:date="2025-02-02T11:00:00Z"><w:r><w:delText>deleted secret</w:delText></w:r></w:del><w:r><w:rPr><w:b/><w:rPrChange w:id="12" w:author="${PERSON.name}" w:date="2025-02-03T09:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>bold now</w:t></w:r></w:p><w:p><w:pPr><w:rPr><w:del w:id="13" w:author="${PERSON.name}" w:date="2025-02-04T09:00:00Z"/></w:rPr></w:pPr><w:r><w:t>first half</w:t></w:r></w:p><w:p><w:r><w:t>second half</w:t></w:r></w:p>` : '';
  const field = remote ? `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> INCLUDEPICTURE "${TRACKER}" \\d </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>cached result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` : '';
  const doc = xml(`<w:document ${W}><w:body><w:p w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3" w14:paraId="1A2B3C4D" w14:textId="77777777"><w:commentRangeStart w:id="0"/><w:r w:rsidRPr="00D4E5F6"><w:t>Visible text</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r></w:p><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden note to self</w:t></w:r></w:p>${changes}${field}<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p><w:p>${picture('r:embed="rIdImg"')}</w:p>${remote ? `<w:p>${picture('r:link="rIdRemoteImg"')}</w:p>` : ''}<w:sectPr w:rsidR="00A1B2C3"/></w:body></w:document>`);
  const settings = xml(`<w:settings ${W} xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w:zoom w:percent="100"/>${remote ? '<w:attachedTemplate r:id="rIdTpl"/>' : ''}<w:defaultTabStop w:val="720"/><w:docVars><w:docVar w:name="ClientCode" w:val="ACME-7781"/></w:docVars><w:rsids><w:rsidRoot w:val="00A1B2C3"/><w:rsid w:val="00A1B2C3"/><w:rsid w:val="00D4E5F6"/></w:rsids><w14:docId w14:val="5F3A2B1C"/><w15:docId w15:val="{6E1D3C2B-1111-2222-3333-444455556666}"/></w:settings>`);
  const comments = xml(`<w:comments ${W}><w:comment w:id="0" w:author="${PERSON.name}" w:date="2025-02-05T08:00:00Z" w:initials="JD"><w:p><w:r><w:annotationRef/></w:r><w:r><w:t>Secret remark</w:t></w:r></w:p></w:comment></w:comments>`);
  const people = xml(`<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="${PERSON.name}"><w15:presenceInfo w15:providerId="AD" w15:userId="S::${PERSON.email}::0f1e2d3c"/></w15:person></w15:people>`);
  const styles = xml(`<w:styles ${W}><w:docDefaults/></w:styles>`);
  const docRels = [
    ['rIdStyles', 'styles', 'styles.xml'], ['rIdSettings', 'settings', 'settings.xml'], ['rIdComments', 'comments', 'comments.xml'],
    ['rIdPeople', 'http://schemas.microsoft.com/office/2011/relationships/people', 'people.xml'],
    ['rIdImg', 'image', 'media/image1.jpeg'], ['rIdLink', 'hyperlink', 'https://example.com/report', true],
    ['rIdXml', 'customXml', '../customXml/item1.xml'], ['rIdPrinter', 'printerSettings', 'printerSettings/printerSettings1.bin'],
  ];
  if (remote) docRels.push(['rIdRemoteImg', 'image', TRACKER, true]);
  if (macros) docRels.push(['rIdVba', 'http://schemas.microsoft.com/office/2006/relationships/vbaProject', 'vbaProject.bin']);
  const overrides = {
    'word/document.xml': macros ? CT.docm : CT.docx, 'word/styles.xml': CT.styles, 'word/settings.xml': CT.settings, 'word/comments.xml': CT.comments, 'word/people.xml': CT.people,
    'docProps/core.xml': CT.core, 'docProps/app.xml': CT.app, 'docProps/custom.xml': CT.custom, 'customXml/itemProps1.xml': CT.customXmlProps,
  };
  if (macros) overrides['word/vbaProject.bin'] = CT.vba;
  return writeZip([
    { name: '[Content_Types].xml', data: types({ jpeg: 'image/jpeg', bin: 'application/vnd.openxmlformats-officedocument.wordprocessingml.printerSettings' }, overrides) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'word/document.xml'], ['rId2', `${NS.pkg.replace('relationships', 'relationships/metadata')}/core-properties`, 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml'], ['rId4', 'custom-properties', 'docProps/custom.xml'], ['rId5', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail', 'docProps/thumbnail.jpeg']]) },
    { name: 'docProps/core.xml', data: core() }, { name: 'docProps/app.xml', data: app('Microsoft Office Word') }, { name: 'docProps/custom.xml', data: custom() },
    { name: 'docProps/thumbnail.jpeg', data: base.jpeg },
    { name: 'word/document.xml', data: doc }, { name: 'word/styles.xml', data: styles }, { name: 'word/settings.xml', data: settings },
    { name: 'word/comments.xml', data: comments }, { name: 'word/people.xml', data: people },
    { name: 'word/_rels/document.xml.rels', data: rels(docRels) },
    { name: 'word/_rels/settings.xml.rels', data: rels(remote ? [['rIdTpl', 'attachedTemplate', 'https://templates.example/corp.dotm', true]] : []) },
    { name: 'word/media/image1.jpeg', data: gpsJpeg() },
    { name: 'word/printerSettings/printerSettings1.bin', data: devmode('Floor3-Printer') },
    { name: 'customXml/item1.xml', data: xml(`<p:properties xmlns:p="http://schemas.microsoft.com/office/2006/metadata/properties"><documentManagement><Owner><DisplayName>${PERSON.name}</DisplayName></Owner></documentManagement></p:properties>`) },
    { name: 'customXml/itemProps1.xml', data: xml('<ds:datastoreItem ds:itemID="{11111111-2222-3333-4444-555555555555}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"/>') },
    { name: 'customXml/_rels/item1.xml.rels', data: rels([['rId1', 'customXmlProps', 'itemProps1.xml']]) },
    ...(macros ? [{ name: 'word/vbaProject.bin', data: enc.encode('VBA project placeholder') }] : []),
    { name: '[trash]/0001.dat', data: enc.encode('leftover from an earlier save') },
  ].map((e) => ({ ...e, modified: new Date(Date.UTC(2025, 2, 4, 17, 30, 0)) })));
}

// options: powerQuery (a Power Query definition stored as custom XML, which must stay).
export async function xlsx({ powerQuery = false } = {}) {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" mc:Ignorable="x15ac xr"';
  const workbook = xml(`<workbook ${S}><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr/><mc:AlternateContent><mc:Choice Requires="x15"><x15ac:absPath url="${winPath('Documents', 'Finance')}\\"/></mc:Choice></mc:AlternateContent><xr:revisionPtr revIDLastSave="0" documentId="8_{AAAABBBB-CCCC-DDDD-EEEE-FFFF00001111}" xr6:coauthVersionLast="47" xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2016/revision6"/><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Salaries" sheetId="2" state="veryHidden" r:id="rId2"/></sheets><externalReferences><externalReference r:id="rId3"/></externalReferences></workbook>`);
  const sheet = (rows) => xml(`<worksheet ${S} xr:uid="{12345678-1234-1234-1234-123456789ABC}"><sheetData>${rows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup orientation="portrait" r:id="rIdP"/><legacyDrawing r:id="rIdV"/></worksheet>`);
  const vml = enc.encode(`<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202"/><v:shape id="_x0000_s1025" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Row>0</x:Row><x:Column>0</x:Column></x:ClientData></v:shape></xml>`);
  return writeZip([
    { name: '[Content_Types].xml', data: types({ vml: CT.vml, bin: CT.printer }, { 'xl/workbook.xml': CT.xlsx, 'xl/worksheets/sheet1.xml': CT.sheet, 'xl/worksheets/sheet2.xml': CT.sheet, 'xl/comments1.xml': CT.xlComments, 'xl/externalLinks/externalLink1.xml': CT.externalLink, 'xl/connections.xml': CT.connections, 'xl/threadedComments/threadedComment1.xml': CT.threaded, 'xl/persons/person.xml': CT.person, 'docProps/core.xml': CT.core, 'docProps/app.xml': CT.app }) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'xl/workbook.xml'], ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]) },
    { name: 'docProps/core.xml', data: core() },
    { name: 'docProps/app.xml', data: app('Microsoft Excel', '<TitlesOfParts><vt:vector size="2" baseType="lpstr"><vt:lpstr>Summary</vt:lpstr><vt:lpstr>Salaries</vt:lpstr></vt:vector></TitlesOfParts>') },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'externalLink', 'externalLinks/externalLink1.xml'], ['rId4', 'connections', 'connections.xml'], ['rId5', 'http://schemas.microsoft.com/office/2017/10/relationships/person', 'persons/person.xml'], ...(powerQuery ? [['rId6', 'customXml', '../customXml/item1.xml']] : [])]) },
    ...(powerQuery ? [{ name: 'customXml/item1.xml', data: xml('<DataMashup xmlns="http://schemas.microsoft.com/DataMashup">AAAAAA==</DataMashup>') }] : []),
    { name: 'xl/worksheets/sheet1.xml', data: sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c></row><row r="2" hidden="1"><c r="A2"><v>5</v></c></row>') },
    { name: 'xl/worksheets/sheet2.xml', data: sheet('<row r="1"><c r="A1"><v>90000</v></c></row>') },
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels([['rIdC', 'comments', '../comments1.xml'], ['rIdV', 'vmlDrawing', '../drawings/vmlDrawing1.vml'], ['rIdP', 'printerSettings', '../printerSettings/printerSettings1.bin'], ['rIdT', 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment', '../threadedComments/threadedComment1.xml']]) },
    { name: 'xl/worksheets/_rels/sheet2.xml.rels', data: rels([['rIdP', 'printerSettings', '../printerSettings/printerSettings2.bin'], ['rIdV', 'vmlDrawing', '../drawings/vmlDrawing2.vml']]) },
    { name: 'xl/comments1.xml', data: xml(`<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>${PERSON.name}</author></authors><commentList><comment ref="A1" authorId="0"><text><t>Check this number</t></text></comment></commentList></comments>`) },
    { name: 'xl/threadedComments/threadedComment1.xml', data: xml('<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1" dT="2025-02-01T10:00:00.00" personId="{AAAA0000-0000-0000-0000-000000000001}" id="{BBBB0000-0000-0000-0000-000000000001}"><text>Check this number</text></threadedComment></ThreadedComments>') },
    { name: 'xl/persons/person.xml', data: xml(`<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person displayName="${PERSON.name}" id="{AAAA0000-0000-0000-0000-000000000001}" userId="${PERSON.email}" providerId="PeoplePicker"/></personList>`) },
    { name: 'xl/drawings/vmlDrawing1.vml', data: vml },
    { name: 'xl/drawings/vmlDrawing2.vml', data: enc.encode('<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shape id="b1"><x:ClientData ObjectType="Button"/></v:shape></xml>') },
    { name: 'xl/printerSettings/printerSettings1.bin', data: devmode('Floor3-Printer') },
    { name: 'xl/printerSettings/printerSettings2.bin', data: devmode('Floor3-Printer') },
    { name: 'xl/externalLinks/externalLink1.xml', data: xml('<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="rId1"><sheetNames><sheetName val="Data"/></sheetNames></externalBook></externalLink>') },
    { name: 'xl/externalLinks/_rels/externalLink1.xml.rels', data: rels([['rId1', 'externalLinkPath', `file:///${winPath('Documents', 'Budget.xlsx').replace(/\\/g, '/')}`, true]]) },
    { name: 'xl/connections.xml', data: xml('<connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><connection id="1" name="Sales" type="1" refreshOnLoad="1" refreshedVersion="6"><dbPr connection="DSN=Sales;SERVER=db.corp.example;UID=jdoe" command="SELECT * FROM sales"/></connection></connections>') },
  ]);
}

export async function pptx() {
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const slide = (attrs, ext = '') => xml(`<p:sld ${P}${attrs}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>${ext}</p:sld>`);
  const ext = '<p:extLst><p:ext uri="{6950BFC3-D8DA-4A85-94F7-54DA5524770B}"><p188:commentRel xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main" r:id="rIdMC"/></p:ext></p:extLst>';
  return writeZip([
    { name: '[Content_Types].xml', data: types({}, { 'ppt/presentation.xml': CT.pptx, 'ppt/slides/slide1.xml': CT.slide, 'ppt/slides/slide2.xml': CT.slide, 'ppt/notesSlides/notesSlide1.xml': CT.notes, 'ppt/commentAuthors.xml': CT.commentAuthors, 'ppt/comments/comment1.xml': CT.pptComments, 'ppt/authors.xml': CT.authors, 'ppt/comments/modernComment_1.xml': CT.modernComments, 'ppt/revisionInfo.xml': CT.revisionInfo, 'docProps/core.xml': CT.core, 'docProps/app.xml': CT.app }) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]) },
    { name: 'docProps/core.xml', data: core() }, { name: 'docProps/app.xml', data: app('Microsoft Office PowerPoint') },
    { name: 'ppt/presentation.xml', data: xml(`<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`) },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels([['rId1', 'slide', 'slides/slide1.xml'], ['rId2', 'slide', 'slides/slide2.xml'], ['rId3', 'commentAuthors', 'commentAuthors.xml'], ['rId4', 'http://schemas.microsoft.com/office/2018/10/relationships/authors', 'authors.xml'], ['rId5', 'http://schemas.microsoft.com/office/2015/10/relationships/revisionInfo', 'revisionInfo.xml']]) },
    { name: 'ppt/slides/slide1.xml', data: slide('', ext) },
    { name: 'ppt/slides/slide2.xml', data: slide(' show="0"') },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels([['rIdN', 'notesSlide', '../notesSlides/notesSlide1.xml'], ['rIdC', 'comments', '../comments/comment1.xml'], ['rIdMC', 'http://schemas.microsoft.com/office/2018/10/relationships/comments', '../comments/modernComment_1.xml']]) },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: xml(`<p:notes ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Do not mention the layoffs</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`) },
    { name: 'ppt/commentAuthors.xml', data: xml(`<p:cmAuthorLst ${P}><p:cmAuthor id="0" name="${PERSON.name}" initials="JD" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`) },
    { name: 'ppt/comments/comment1.xml', data: xml(`<p:cmLst ${P}><p:cm authorId="0" dt="2025-02-01T10:00:00.000" idx="1"><p:pos x="10" y="10"/><p:text>Reword this</p:text></p:cm></p:cmLst>`) },
    { name: 'ppt/authors.xml', data: xml(`<p188:authorLst xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"><p188:author id="{AAAA0000-0000-0000-0000-000000000002}" name="${PERSON.name}" initials="JD" userId="S::${PERSON.email}::1234" providerId="AD"/></p188:authorLst>`) },
    { name: 'ppt/comments/modernComment_1.xml', data: xml('<p188:cmLst xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p188:cm id="{CCCC0000-0000-0000-0000-000000000003}" authorId="{AAAA0000-0000-0000-0000-000000000002}" created="2025-02-01T10:00:00.000"><p188:txBody><a:p><a:r><a:t>Modern remark</a:t></a:r></a:p></p188:txBody></p188:cm></p188:cmLst>') },
    { name: 'ppt/revisionInfo.xml', data: xml('<p1510:revInfo xmlns:p1510="http://schemas.microsoft.com/office/powerpoint/2015/10/main"><p1510:revLst><p1510:client id="{DDDD0000-0000-0000-0000-000000000004}" v="1" dt="2025-02-01T10:00:00.000"/></p1510:revLst></p1510:revInfo>') },
  ]);
}

// Stored entries with hand-made extra fields, comments and data around the archive.
export function rawZip(entries, { prefix = new Uint8Array(), trailing = new Uint8Array(), comment = '' } = {}) {
  const locals = []; const centrals = []; let offset = prefix.length;
  for (const e of entries) {
    const name = enc.encode(e.name); const data = e.data; const extra = e.extra ?? new Uint8Array(); const note = enc.encode(e.comment ?? '');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length + extra.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(10, 4); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(e.time ?? 0x6000, 10); local.writeUInt16LE(e.date ?? 0x5a21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    local.set(name, 30); local.set(extra, 30 + name.length);
    const central = Buffer.alloc(46 + name.length + extra.length + note.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((e.host ?? 3) << 8 | 30, 4); central.writeUInt16LE(10, 6);
    central.writeUInt16LE(e.time ?? 0x6000, 12); central.writeUInt16LE(e.date ?? 0x5a21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30); central.writeUInt16LE(note.length, 32); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    central.set(name, 46); central.set(extra, 46 + name.length); central.set(note, 46 + name.length + extra.length);
    locals.push(local, data); centrals.push(central); offset += local.length + data.length;
  }
  const cd = Buffer.concat(centrals); const note = enc.encode(comment);
  const end = Buffer.alloc(22 + note.length);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(note.length, 20); end.set(note, 22);
  return Buffer.concat([prefix, ...locals, cd, end, trailing]);
}

// Extra fields: Info-ZIP Unix ids (0x7875), extended timestamp (0x5455) and NTFS times (0x000a).
export function unixExtra(uid, gid) { const b = Buffer.alloc(4 + 11); b.writeUInt16LE(0x7875, 0); b.writeUInt16LE(11, 2); b[4] = 1; b[5] = 4; b.writeUInt32LE(uid, 6); b[10] = 4; b.writeUInt32LE(gid, 11); return b; }
export function timeExtra(unixSeconds) { const b = Buffer.alloc(9); b.writeUInt16LE(0x5455, 0); b.writeUInt16LE(5, 2); b[4] = 1; b.writeUInt32LE(unixSeconds, 5); return b; }
export function ntfsExtra(ms) {
  const b = Buffer.alloc(4 + 32); b.writeUInt16LE(0x000a, 0); b.writeUInt16LE(32, 2); b.writeUInt16LE(1, 8); b.writeUInt16LE(24, 10);
  const ft = (BigInt(ms) + 11644473600000n) * 10000n; b.writeBigUInt64LE(ft, 12); b.writeBigUInt64LE(ft, 20); b.writeBigUInt64LE(ft, 28);
  return b;
}
// DOS date and time fields for a wall-clock time.
export const dos = (y, mo, d, h, mi, s) => ({ date: ((y - 1980) << 9) | (mo << 5) | d, time: (h << 11) | (mi << 5) | (s >> 1) });

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:officeooo="http://openoffice.org/2009/office" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0"';

// options: tracked (a tracked insertion and deletion), macros (a Basic module and an event handler).
export async function odt({ tracked = false, macros = false } = {}) {
  const changes = tracked ? `<text:tracked-changes><text:changed-region text:id="ct1"><text:insertion><office:change-info><dc:creator>${PERSON.editor}</dc:creator><dc:date>2025-02-01T10:00:00</dc:date></office:change-info></text:insertion></text:changed-region><text:changed-region text:id="ct2"><text:deletion><office:change-info><dc:creator>${PERSON.name}</dc:creator><dc:date>2025-02-02T10:00:00</dc:date></office:change-info><text:p>deleted secret</text:p></text:deletion></text:changed-region></text:tracked-changes>` : '';
  const marks = tracked ? '<text:p><text:change-start text:change-id="ct1"/>inserted words<text:change-end text:change-id="ct1"/> and <text:change text:change-id="ct2"/>rest</text:p>' : '';
  const events = macros ? '<office:event-listeners><script:event-listener script:language="ooo:script" script:event-name="dom:load" xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document"/></office:event-listeners>' : '';
  const content = xml(`<office:document-content ${ODF_NS} office:version="1.3"><office:scripts>${events}</office:scripts><office:automatic-styles><style:style style:name="T1" style:family="text"><style:text-properties officeooo:rsid="0012ab34"/></style:style><style:style style:name="P1" style:family="paragraph"><style:text-properties officeooo:paragraph-rsid="0012ab34"/></style:style></office:automatic-styles><office:body><office:text>${changes}<text:p text:style-name="P1">Visible <text:span text:style-name="T1">text</text:span><office:annotation><dc:creator>${PERSON.name}</dc:creator><dc:date>2025-02-05T08:00:00</dc:date><text:p>Secret remark</text:p></office:annotation></text:p>${marks}<text:p><text:hidden-text text:condition="ooow:1" text:string-value="hidden note to self"/></text:p><text:p><text:a xlink:type="simple" xlink:href="https://example.com/report">link</text:a></text:p><text:p><draw:frame draw:name="Remote" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="${TRACKER}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame><draw:frame draw:name="Photo" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="Pictures/photo.jpg" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p></office:text></office:body></office:document-content>`);
  const meta = xml(`<office:document-meta ${ODF_NS} office:version="1.3"><office:meta><meta:generator>LibreOffice/24.2$Linux_X86_64</meta:generator><meta:initial-creator>${PERSON.name}</meta:initial-creator><dc:creator>${PERSON.editor}</dc:creator><meta:creation-date>2025-01-02T09:00:00</meta:creation-date><dc:date>2025-03-04T17:30:00</dc:date><meta:editing-cycles>7</meta:editing-cycles><meta:editing-duration>PT42M</meta:editing-duration><meta:printed-by>${PERSON.name}</meta:printed-by><meta:template xlink:type="simple" xlink:actuate="onRequest" xlink:title="Corporate" xlink:href="${unixPath('Templates', 'corp.ott')}"/><meta:user-defined meta:name="Client">Acme Holdings</meta:user-defined><meta:document-statistic meta:page-count="1" meta:word-count="12"/></office:meta></office:document-meta>`);
  const settings = xml(`<office:document-settings ${ODF_NS}><office:settings><config:config-item-set config:name="ooo:configuration-settings"><config:config-item config:name="PrinterName" config:type="string">Floor3-Printer</config:config-item><config:config-item config:name="PrinterSetup" config:type="base64Binary">AAAA</config:config-item><config:config-item config:name="Rsid" config:type="int">1223476</config:config-item><config:config-item config:name="RsidRoot" config:type="int">1223476</config:config-item><config:config-item config:name="AddParaTableSpacing" config:type="boolean">true</config:config-item></config:config-item-set></office:settings></office:document-settings>`);
  const styles = xml(`<office:document-styles ${ODF_NS} office:version="1.3"><office:styles/></office:document-styles>`);
  const files = [['content.xml', 'text/xml'], ['styles.xml', 'text/xml'], ['meta.xml', 'text/xml'], ['settings.xml', 'text/xml'], ['Pictures/photo.jpg', 'image/jpeg'], ['Thumbnails/thumbnail.png', 'image/png']];
  if (macros) files.push(['Basic/', 'application/binary'], ['Basic/Standard/', 'application/binary'], ['Basic/Standard/Module1.xml', 'text/xml'], ['Basic/Standard/script-lb.xml', 'text/xml'], ['Basic/script-lc.xml', 'text/xml']);
  const manifest = xml(`<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/>${files.map(([p, t]) => `<manifest:file-entry manifest:full-path="${p}" manifest:media-type="${t}"/>`).join('')}</manifest:manifest>`);
  return writeZip([
    { name: 'mimetype', data: enc.encode('application/vnd.oasis.opendocument.text'), method: 0 },
    { name: 'content.xml', data: content }, { name: 'styles.xml', data: styles }, { name: 'meta.xml', data: meta }, { name: 'settings.xml', data: settings },
    { name: 'Pictures/photo.jpg', data: gpsJpeg() }, { name: 'Thumbnails/thumbnail.png', data: base.png },
    ...(macros ? [
      { name: 'Basic/Standard/Module1.xml', data: xml('<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">Sub Main\nEnd Sub</script:module>') },
      { name: 'Basic/Standard/script-lb.xml', data: xml('<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard"><library:element library:name="Module1"/></library:library>') },
      { name: 'Basic/script-lc.xml', data: xml('<library:libraries xmlns:library="http://openoffice.org/2000/library"><library:library library:name="Standard" library:link="false"/></library:libraries>') },
    ] : []),
    { name: 'META-INF/manifest.xml', data: manifest },
    { name: 'notes-left-behind.txt', data: enc.encode('not listed in the manifest') },
  ].map((e) => ({ ...e, modified: new Date(Date.UTC(2025, 2, 4, 17, 30, 0)) })));
}

export async function epub() {
  const opf = xml(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:12345678-90ab-cdef-1234-567890abcdef</dc:identifier><dc:identifier id="calibre_id">8812</dc:identifier><dc:title>Field Notes</dc:title><dc:language>en</dc:language><dc:creator id="author">${PERSON.name}</dc:creator><meta refines="#author" property="file-as">Doe, Jane</meta><meta refines="#author" property="role" scheme="marc:relators">aut</meta><dc:contributor>calibre (7.2.0) [https://calibre-ebook.com]</dc:contributor><dc:publisher>Example Press</dc:publisher><dc:date>2025-01-02</dc:date><meta property="dcterms:modified">2025-03-04T17:30:00Z</meta><meta name="calibre:timestamp" content="2025-03-04T17:30:00+00:00"/><meta name="cover" content="cover"/><meta property="rendition:layout">reflowable</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml" properties="remote-resources"/><item id="css" href="style.css" media-type="text/css"/><item id="cover" href="images/cover.jpg" media-type="image/jpeg"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="ch1"/></spine></package>`);
  const ch1 = xml(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title><link rel="stylesheet" href="../style.css"/><link rel="stylesheet" href="https://fonts.example/book.css"/></head><body><p>Chapter one&#160;starts.</p><p><img src="${TRACKER}" alt=""/><img src="../images/cover.jpg" alt="cover"/><a href="https://example.com/more">more</a></p></body></html>`);
  const nav = xml('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">One</a></li></ol></nav></body></html>');
  return writeZip([
    { name: 'mimetype', data: enc.encode('application/epub+zip'), method: 0 },
    { name: 'META-INF/container.xml', data: xml('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: xml(`<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:12345678-90ab-cdef-1234-567890abcdef"/><meta name="dtb:depth" content="1"/><meta name="dtb:generator" content="calibre (7.2.0)"/></head><docTitle><text>Field Notes</text></docTitle><docAuthor><text>${PERSON.name}</text></docAuthor><navMap><navPoint id="n1" playOrder="1"><navLabel><text>One</text></navLabel><content src="text/ch1.xhtml"/></navPoint></navMap></ncx>`) }, { name: 'OEBPS/nav.xhtml', data: nav }, { name: 'OEBPS/text/ch1.xhtml', data: ch1 },
    { name: 'OEBPS/style.css', data: enc.encode('@import url("https://fonts.example/a.css");\nbody { background: url(https://tracker.example/bg.png); color: black }\n') },
    { name: 'OEBPS/images/cover.jpg', data: gpsJpeg() },
    { name: 'iTunesMetadata.plist', data: enc.encode(`<?xml version="1.0"?><plist version="1.0"><dict><key>apple-id</key><string>${PERSON.email}</string></dict></plist>`) },
    { name: 'META-INF/calibre_bookmarks.txt', data: enc.encode('pos 12') },
  ]);
}
