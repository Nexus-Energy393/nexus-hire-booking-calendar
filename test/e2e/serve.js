const http=require("http"),fs=require("fs"),path=require("path");
const root=process.argv[2], port=Number(process.argv[3]||8099);
const TYPES={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".json":"application/json"};
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split("?")[0]);
  if(p==="/")p="/index.html";
  const f=path.join(root,p);
  if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);res.end("nf");return;}
  res.writeHead(200,{"Content-Type":TYPES[path.extname(f)]||"application/octet-stream"});
  fs.createReadStream(f).pipe(res);
}).listen(port,()=>console.log("serving "+root+" on "+port));
