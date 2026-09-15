import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";
import { readFileSync, realpathSync } from "node:fs";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const projectRequire = createRequire(new URL("../package.json", import.meta.url));
const { parseConfigFileTextToJson } = projectRequire("typescript");
const configResult = parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync(root + "/apps/worker/wrangler.jsonc", "utf8"),
);
if (configResult.error) throw new Error("INVALID_WRANGLER_CONFIG");
const workerConfig = configResult.config;
const require = createRequire(realpathSync(root + "/node_modules/wrangler/package.json"));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const migration = readFileSync(root + "/apps/worker/migrations/0001_repository_index.sql", "utf8");
const code = `import {RepositoryIndexer,D1RepositoryIndexStore,RepositoryRetriever,indexConfigSchema} from '${root}/packages/repository-index/src/index.ts';
const sha='a'.repeat(40),scope={installationId:1,repositoryId:2},text='export function verifyAuthentication() { return true; }';
export default {async fetch(request,env){
for(const statement of ${JSON.stringify(migration)}.replace(/--[^\\n]*/g,'').split(';').filter(s=>s.trim()))await env.INDEX_DB.prepare(statement).run();
const store=new D1RepositoryIndexStore(env.INDEX_DB.withSession('first-primary'));
const source={listFiles:async()=>[{path:'src/index.ts',blobSha:'b'.repeat(40),size:text.length}],readFile:async()=>text,isCurrentDefaultRevision:async()=>true};
const config=indexConfigSchema.parse({summaryLimit:0});
const build=await new RepositoryIndexer(store,source,{config}).build({...scope,owner:'owner',repo:'repo',commitSha:sha,trigger:'push',deliveryId:'smoke',indexId:'c'.repeat(64)});
const found=await new RepositoryRetriever(store,config).retrieve({...scope,headSha:sha,baseSha:sha,query:'src/index.ts',changedPaths:[]});
return Response.json({build,status:found.status,path:found.results[0]?.path,symbol:found.results[0]?.symbols[0]?.name});}};`;
const result = await build({
  stdin: { contents: code, resolveDir: root, loader: "ts" },
  tsconfig: root + "/tsconfig.json",
  bundle: true,
  define: workerConfig.define,
  format: "esm",
  platform: "neutral",
  mainFields: ["browser", "module", "main"],
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["node:*", "cloudflare:*"],
  alias: { fs: "node:fs", path: "node:path", os: "node:os", inspector: "node:inspector" },
  banner: { js: "import { createRequire } from 'node:module'; const require=createRequire('/');" },
  write: false,
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "smoke",
        modules: true,
        script: result.outputFiles[0].text,
        compatibilityDate: workerConfig.compatibility_date,
        compatibilityFlags: workerConfig.compatibility_flags,
        d1Databases: ["INDEX_DB"],
      },
    ],
  }),
);
try {
  const response = await mf.dispatchFetch("http://smoke/");
  const body = await response.json();
  console.log(JSON.stringify(body));
  if (
    body.build?.status !== "ready" ||
    body.status !== "exact" ||
    body.path !== "src/index.ts" ||
    body.symbol !== "verifyAuthentication"
  )
    process.exitCode = 1;
} finally {
  await mf.dispose();
}
