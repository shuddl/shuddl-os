// Headless render driver: waits for the app to set window.__ready (map 'idle'), then screenshots.
// Token (if any) is injected from env MAPBOX_TOKEN — never hardcoded, never committed.
import puppeteer from "puppeteer-core";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [,, url, outPath] = process.argv;
const TOKEN=process.env.MAPBOX_TOKEN;
const b=await puppeteer.launch({executablePath:CHROME,headless:"new",
  args:["--enable-unsafe-swiftshader","--use-gl=angle","--use-angle=swiftshader","--ignore-gpu-blocklist","--no-sandbox","--window-size=1440,900"]});
const p=await b.newPage(); await p.setViewport({width:1440,height:900});
if(TOKEN) await p.evaluateOnNewDocument(t=>{window.__TOKEN__=t;}, TOKEN);
const errs=[]; p.on("console",m=>{if(m.type()==="error")errs.push(m.text());}); p.on("pageerror",e=>errs.push("PAGEERROR: "+e.message));
await p.goto(url,{waitUntil:"networkidle2",timeout:30000}).catch(e=>console.log("goto:",e.message));
let ready=false;
for(let i=0;i<30;i++){ ready=await p.evaluate(()=>!!window.__ready).catch(()=>false); if(ready)break; await new Promise(r=>setTimeout(r,700)); }
await new Promise(r=>setTimeout(r,1500));
await p.screenshot({path:outPath});
console.log("ready:",ready,"| console errors:",errs.length);
errs.slice(0,8).forEach(e=>console.log("  ERR:",e.slice(0,160)));
await b.close();
