const sharp=require('sharp');
const crypto=require('node:crypto');
const PROJECT='https://eldiuxxqqxjpwjtrxqfg.supabase.co';
const ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVsZGl1eHhxcXhqcHdqdHJ4cWZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODYwMjcsImV4cCI6MjA4OTE2MjAyN30.HX35eqm_x_Yz83gXEDZ9q8Bq9Qdwt1ZC2CgKh1NWLFA';
function endpoint(slug,mode,size,version){const q=new URLSearchParams({slug,mode});if(size)q.set('size',String(size));if(version)q.set('v',version);return '/api/tarjeta-pwa?'+q}
async function bounded(response,max){if(!response.ok)throw Error('Imagen no disponible');if(Number(response.headers.get('content-length'))>max)throw Error('Imagen demasiado grande');const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>max)throw Error('Imagen demasiado grande');chunks.push(chunk)}return Buffer.concat(chunks)}
async function imageBytes(raw){if(!raw)return null;const url=new URL(raw);if(url.protocol!=='https:'||url.hostname!=='eldiuxxqqxjpwjtrxqfg.supabase.co'||url.port||url.username||url.password||!url.pathname.startsWith('/storage/v1/object/public/'))return null;return bounded(await fetch(url,{signal:AbortSignal.timeout(8000),redirect:'error'}),12*1024*1024)}
module.exports=async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET'&&req.method!=='HEAD')return res.status(405).end();
 const {slug,mode='manifest'}=req.query;
 if(typeof slug!=='string'||!slug||slug.length>200||!['manifest','icon'].includes(mode))return res.status(400).json({error:'Solicitud inválida'});
 try{
 const query=new URLSearchParams({slug:'eq.'+slug,activa:'eq.true',select:'id,slug,nombre,logo_url,color',limit:'1'});
 const r=await fetch(PROJECT+'/rest/v1/tarjetas?'+query,{headers:{apikey:ANON,Authorization:'Bearer '+ANON},signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('No se pudo consultar');const [card]=await r.json();if(!card)return res.status(404).json({error:'Tarjeta no disponible'});
 const color=/^#[0-9a-f]{6}$/i.test(card.color||'')?card.color:'#7953f4';const version=crypto.createHash('sha256').update(card.logo_url||'sin-foto').digest('hex').slice(0,16);
 res.setHeader('Cache-Control','public, max-age=0, s-maxage=300, stale-while-revalidate=60');
 if(mode==='manifest'){
 const scope='/tarjetas/'+encodeURIComponent(card.slug)+'/';const start=scope+'inicio.html';
 res.setHeader('Content-Type','application/manifest+json; charset=utf-8');
 return res.status(200).send(JSON.stringify({id:start,name:card.nombre||'PresentAR',short_name:(card.nombre||'PresentAR').slice(0,40),start_url:start,scope,display:'standalone',background_color:'#fafaf9',theme_color:color,icons:[192,512].map(size=>({src:endpoint(card.slug,'icon',size,version),sizes:size+'x'+size,type:'image/png',purpose:'any'}))}));
 }
 const size=Number(req.query.size||180);if(![180,192,512].includes(size))return res.status(400).json({error:'Tamaño inválido'});
 let bytes;try{bytes=await imageBytes(card.logo_url)}catch{bytes=null}
 let output;
 if(bytes){try{output=await sharp(bytes,{limitInputPixels:40000000,animated:false}).rotate().resize(size,size,{fit:'contain',background:'#ffffff'}).flatten({background:'#ffffff'}).png().toBuffer()}catch{output=null}}
 if(!output){const initial=(card.nombre||'P').trim().slice(0,1).replace(/[<>&"']/g,'')||'P';const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${size*.5}" fill="white">${initial}</text></svg>`);output=await sharp(svg).png().toBuffer();res.setHeader('Cache-Control','public, max-age=0, s-maxage=60')}
 res.setHeader('Content-Type','image/png');return res.status(200).send(output);
 }catch{return res.status(503).json({error:'No se pudo preparar el acceso. Volvé a intentar.'})}
};
