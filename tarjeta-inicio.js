const fs=require('node:fs');
const path=require('node:path');
module.exports=async(req,res)=>{
 if(!['GET','HEAD'].includes(req.method)){res.status(405).end();return}
 const slug=req.query.slug;
 if(typeof slug!=='string'||!slug||slug.length>200||/[\x00-\x1f/\\]/.test(slug)){res.status(400).send('Tarjeta inválida');return}
 try{
 // Included explicitly in vercel.json. Each path serves the same maintained template.
 const template=fs.readFileSync(path.join(process.cwd(),'tarjeta.html'),'utf8');
 res.setHeader('Content-Type','text/html; charset=utf-8');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.status(200).send(template);
 }catch{res.status(503).send('No pudimos abrir la tarjeta. Volvé a intentar.')}
};
