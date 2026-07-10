import puppeteer from "puppeteer-core";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [,, htmlPath, outPath] = process.argv;
const b=await puppeteer.launch({executablePath:CHROME,headless:"new",
  args:["--enable-unsafe-swiftshader","--use-gl=angle","--use-angle=swiftshader","--ignore-gpu-blocklist","--no-sandbox","--window-size=1440,900"]});
const p=await b.newPage();
await p.setViewport({width:1440,height:900});
const errs=[];
p.on("console",m=>{ if(m.type()==="error") errs.push(m.text()); });
p.on("pageerror",e=>errs.push("PAGEERROR: "+e.message));
await p.goto("file://"+htmlPath,{waitUntil:"networkidle2",timeout:30000}).catch(e=>console.log("goto:",e.message));
// wait for the map idle flag (up to 20s), else screenshot whatever's there
const ready = await p.waitForFunction("window.__ready===true",{timeout:20000}).then(()=>true).catch(()=>false);
await new Promise(r=>setTimeout(r,800));
await p.screenshot({path:outPath});
console.log("READY:", ready, "| console errors:", errs.length);
errs.slice(0,6).forEach(e=>console.log("  ERR:", e.slice(0,120)));
await b.close();
