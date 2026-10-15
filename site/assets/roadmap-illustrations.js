// Same 128px tile system as released tools. Each symbol describes its planned tool.
const path=(d,color='#fff',width=5)=>`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
const rect=(x,y,w,h,fill='#f5f8fc',r=5)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
const circle=(x,y,r,fill)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
const check=path('m72 90 10 10 20-25','#d4ffe1',7);
const sheet=rect(25,20,76,88)+path('M38 39h50M38 51h37M38 63h46','#abbdd0',4);
const landscape=rect(21,24,86,76)+rect(27,30,74,64,'#8cd4f4')+circle(83,43,8,'#fff1ba')+'<path d="m27 83 24-31 20 27 13-16 17 20v11H27z" fill="#438a7e"/><path d="m42 64 9-12 10 14-10-5z" fill="#f8fbff"/>';
const lock=path('M48 62V46a16 16 0 0 1 32 0v16','#f7edbf',7)+rect(39,57,50,43,'#f8d67c',8)+circle(64,76,5,'#836c4c')+path('M64 79v9','#836c4c',4);
const qr=rect(22,22,84,84)+[ [29,29],[74,29],[29,74] ].map(([x,y])=>rect(x,y,25,25,'#364d65',2)+rect(x+6,y+6,13,13,'#f5f8fc',1)+rect(x+9,y+9,7,7,'#364d65',0)).join('')+path('M65 63h10v10h15v25M63 84h10v14m15-37h10M61 98h9','#364d65',6);
export const ROADMAP_COLORS={photo:['#f3a5b4','#b64b82'],wave:['#bea6f6','#6655b3'],office:['#86b9f9','#3c70bb'],qr:['#a9bbc9','#526b82'],imgredact:['#f6b193','#c36b51'],lock:['#8dc9bb','#397e78'],cutout:['#a2dcd8','#469292'],table:['#9dc8ad','#4c8667'],code:['#99b5e7','#526999'],key:['#f7d68c','#c38d38'],pgp:['#b7c7f4','#6878b4'],otp:['#b3d5a8','#608955'],ocr:['#adc5f5','#5d7fbd'],resume:['#efc4a4','#b78362'],converter:['#a0d9d1','#418f91'],hash:['#a9b8ce','#566c8a'],clock:['#f3c5a2','#bb8757'],mail:['#b8cfe8','#5e87b0'],link:['#b5c7d9','#5a7b9a'],hex:['#b6cdbd','#5c8070'],artifacts:['#9fbae2','#547aa9'],network:['#98d5dd','#42869f'],certificate:['#d1bce8','#8c68b0'],lens:['#bfc8d1','#687f94']};
export const ROADMAP_ART={
 photo:landscape+path('m75 100 27-27','#f4cf7b',12)+path('m74 102 5-13 8 8z','#fff0d5',4),
 wave:rect(20,27,88,73,'#ece8fa',9)+path('M31 63h7m5-16v32m10-43v54m11-34v15m10-27v38m10-48v54m10-27v15','#8c6bba',5)+path('M67 24v80','#ed9db0',3),
 office:rect(21,19,60,78,'#e5eef9')+path('M31 35h38M31 46h38M31 57h25','#7796bb',4)+rect(53,49,55,57,'#f8fbfc')+rect(59,55,43,10,'#70a78d',2)+path('M59 77h43M59 88h43M73 66v34M87 66v34','#a4c8b8',3),
 qr,
 imgredact:landscape+rect(34,45,54,18,'#26374c',2)+rect(44,72,49,11,'#26374c',2),
 lock,
 cutout:'<path d="M23 23h82v81H23z" fill="#d1ebea"/>'+path('M24 24h80v80H24z','#fff',3)+circle(64,49,17,'#6a8f92')+'<path d="M35 100q0-33 29-33t29 33z" fill="#6a8f92"/>'+path('M98 24 24 104','#fff',4)+circle(98,24,6,'#fff4c8'),
 table:rect(20,25,88,78)+rect(25,30,78,15,'#82ad95',2)+path('M25 62h78M25 80h78M47 45v53','#b4c8bb',3)+rect(56,50,36,7,'#728e7d',2)+rect(56,68,29,7,'#728e7d',2)+rect(56,86,39,7,'#728e7d',2),
 code:rect(18,25,92,78,'#27364e',8)+rect(18,25,92,17,'#d8e2f4',6)+circle(28,33,3,'#c7899b')+circle(38,33,3,'#d2b474')+circle(48,33,3,'#84bca4')+path('m45 55-14 16 14 15m38-31 14 16-14 15m-13-37-12 45','#b9d9fa',5),
 key:circle(47,56,24,'#f9dfa2')+circle(47,56,11,'#ab853f')+path('m64 73 29 29m-8-8 10-10m-1 19 10-10','#f9dfa2',13),
 pgp:rect(20,34,88,62,'#f0f3fb',7)+path('m23 39 41 31 41-31','#9baac6',4)+circle(88,91,22,'#849dc4')+path('m77 90 8 9 17-20','#fff',5),
 otp:rect(37,17,56,96,'#344a50',10)+rect(42,25,46,72,'#edf6e8',4)+path('M56 105h18','#b8c9ba',3)+path('M50 49h9m10 0h10M50 60h9m10 0h10','#699268',5)+path('M50 81h29','#a7c7a4',4),
 ocr:sheet+path('M19 42V20h20m50 0h20v22M19 88v22h20m50 0h20V88','#d3e6ff',5)+path('M38 79h52','#4d76b0',4),
 resume:sheet+circle(44,39,8,'#c29e87')+path('M35 53q9-12 18 0','#c29e87',4)+path('M64 37h23M64 47h20M38 70h45M38 82h32','#afbecc',4)+circle(91,94,19,'#7aab90')+check,
 converter:landscape+path('M26 15h62l-9-8m9 8-9 8M102 113H40l9-8m-9 8 9 8','#f4fbff',5),
 hash:sheet+path('m58 73-5 31m22-31-5 31M44 82h39m-41 13h39','#6c87a6',5),
 clock:circle(64,64,43,'#f9f1e6')+circle(64,64,36,'#e7d9c9')+circle(64,64,32,'#fffaf4')+path('M64 37v28l18 12','#9d774f',5)+path('M64 26v5m0 66v5M26 64h5m66 0h5','#c4a37f',3)+circle(64,64,4,'#9d774f'),
 mail:rect(20,32,88,63,'#eef5fc',7)+path('m23 37 41 31 41-31','#a0b9d0',4)+path('M35 81h29m-29-9h16','#8ea8c2',3)+path('M78 92h28m-9-9 9 9-9 9','#537996',5),
 link:qr+rect(54,68,56,35,'#7998af',9)+path('m69 94 8-9m5 0 8-9M79 95l-4 4a8 8 0 0 1-11-11l5-5m14-2 5-5a8 8 0 0 1 11 11l-5 5','#fff',4),
 hex:rect(19,25,90,79,'#eaf2ec',7)+rect(25,31,78,13,'#a3bcae',2)+path('M30 55h9m9 0h9m9 0h9m9 0h12M30 69h9m9 0h9m9 0h9m9 0h12M30 83h9m9 0h9m9 0h9m9 0h12M30 96h9m9 0h9','#6b8c7a',4)+rect(44,62,17,14,'#e5c88a',2),
 artifacts:rect(18,27,92,73,'#f2f6fc',7)+rect(18,27,92,17,'#7399c4',6)+'<path d="M31 54h21v17H31zm25 0h21v17H56zM31 75h21v17H31zm25 0h21v17H56z" fill="#8baad1"/>'+circle(94,91,18,'#b9c9de')+path('M94 80v12l8 5','#536d8f',4),
 network:path('M34 36 91 37 64 93 34 36m0 0 62 52M91 37 29 87M29 87h67','#def7fa',5)+[[34,36],[91,37],[64,93],[29,87],[96,88]].map(([x,y])=>circle(x,y,12,'#e9f8fa')+circle(x,y,6,'#74afbf')).join(''),
 certificate:sheet+path('M39 78h28M39 88h18','#a6b9cc',3)+'<path d="m77 89-6 24 13-6 10 7 3-25" fill="#b99bda"/>'+circle(87,79,18,'#d9c3ef')+path('m78 79 6 6 12-14','#8c67ae',4),
 lens:landscape+'<circle cx="79" cy="79" r="28" fill="#c9d6df" stroke="#526d82" stroke-width="4"/><circle cx="79" cy="79" r="20" fill="#a8d0e3"/>'+path('M79 60v38M60 79h38','#e2f3fb',2)+path('m99 99 12 12','#344f64',10)+circle(79,79,7,'#698fa5'),
};
