import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {homedir,tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
export function buildEnvironment(environment=process.env,workspace=root,home=homedir(),temporary=tmpdir()){
  const env={...environment};
  const flags=env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f')??(env.RUSTFLAGS??env.CARGO_BUILD_RUSTFLAGS??'').split(/\s+/).filter(Boolean);
  const mappings=[
    [home,'/build/home'],
    [temporary,'/build/tmp'],
    [env.CARGO_HOME??join(home,'.cargo'),'/build/cargo'],
    [env.RUSTUP_HOME??join(home,'.rustup'),'/build/rustup'],
    [workspace,'/workspace/lingdong-news'],
  ].sort((a,b)=>a[0].length-b[0].length);
  for(const [from,to] of mappings){
    flags.push(`--remap-path-prefix=${from}=${to}`);
    if(from.includes('\\'))flags.push(`--remap-path-prefix=${from.replaceAll('\\','/')}=${to}`);
  }
  env.CARGO_ENCODED_RUSTFLAGS=flags.join('\x1f');
  return env;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const require=createRequire(join(root,'package.json'));
  const cli=join(dirname(require.resolve('@tauri-apps/cli')),'tauri.js');
  const args=process.argv.slice(2);
  const result=spawnSync(process.execPath,[cli,...args],{cwd:root,stdio:'inherit',env:args[0]==='build'?buildEnvironment():process.env});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}
