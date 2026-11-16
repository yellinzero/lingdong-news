import {copyFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(join(root,'package.json'));
const cli=join(dirname(require.resolve('@tauri-apps/cli')),'tauri.js'),out=mkdtempSync(join(tmpdir(),'lingdong-icons-'));
try{const result=spawnSync(process.execPath,[cli,'icon',join(root,'src-tauri/icons/icon.svg'),'--output',out],{cwd:root,stdio:'inherit'});if(result.status!==0)throw Error('Icon generation failed');const icons=join(root,'src-tauri/icons');mkdirSync(icons,{recursive:true});for(const name of ['32x32.png','64x64.png','128x128.png','128x128@2x.png','icon.png','icon.icns','icon.ico'])copyFileSync(join(out,name),join(icons,name));mkdirSync(join(root,'public'),{recursive:true});copyFileSync(join(root,'src-tauri/icons/icon.svg'),join(root,'public/icon.svg'));console.log('Desktop icons generated from src-tauri/icons/icon.svg');}finally{rmSync(out,{recursive:true,force:true});}
