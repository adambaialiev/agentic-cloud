// Capture real Codex and Claude requests against a local fake provider, for
// the two runs the Workspace Agent's machine hosts. The briefing summarizer
// must offer the model no shell; the agent's own acting turn must offer it a
// shell and no more than that — Claude: exactly the Bash tool; Codex: the
// exec tools, with sub-agents, image reads and web search off (Codex keeps
// `apply_patch`, which has no switch, and its goal bookkeeping). No
// subscription is used.
//
// Codex is probed with gpt-5.5, not the platform's gpt-5.6 names: against a
// custom provider this Codex build sends NO tools and no instructions for a
// 5.6 model whatever the flags (their tool profile comes from the ChatGPT
// backend), so a 5.6 probe would pass the summary and fail the agent for the
// wrong reason. Measured 2026-09-08 on codex-cli 0.153.4.
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { buildWorkspaceAgentCommand, buildWorkspaceAssistantCommand } from '../backend/dist/services/workspace-recap-runtime.js';
let requests=0; let toolNames=[];
const server=createServer(async(req,res)=>{
 const chunks=[]; for await(const c of req)chunks.push(c);
 const raw=Buffer.concat(chunks).toString();
 if (req.url.includes('count_tokens')) { res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"input_tokens":5}'); return; }
 if (!req.url.includes('responses') && !req.url.includes('messages')) { res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return; }
 const body=JSON.parse(raw); requests++;
 toolNames.push(...(body.tools??[]).map(t=>t.name??t.type));
 if(req.url.includes('messages')){
  const events=[{type:'message_start',message:{id:'msg_probe',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Ready.'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}];
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));return;
 }
 const response={id:'resp_probe',object:'response',status:'completed',output:[{id:'msg_probe',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Ready.',annotations:[]}]}],usage:{input_tokens:5,output_tokens:5,total_tokens:10}};
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const events=[{type:'response.output_item.done',output_index:0,item:response.output[0]},{type:'response.completed',response}];
 res.end(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const directory=await mkdtemp(join(tmpdir(),'workspace-recap-probe-'));
const port=server.address().port;
const codexEnv={PATH:process.env.PATH,CODEX_HOME:directory,RECAP_PROBE_KEY:'fake-local-probe'};
const claudeEnv={PATH:process.env.PATH,CLAUDE_CONFIG_DIR:directory,ANTHROPIC_API_KEY:'fake-local-probe',ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
async function probe(label,command,env){
 // The agent command begins by making sure the CLI is installed; the probe
 // machine has no ~/.boot.d, and the guard tolerates that.
 const child=spawn('bash',['-c',command],{env,stdio:['ignore','pipe','pipe']});
 let stdout='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.resume();
 const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
 const exit=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timer);
 assert.equal(exit,0,`${label} exited ${exit}`);
 assert.match(stdout,/Ready/,`${label} printed no reply`);
 const seen=[...new Set(toolNames)]; toolNames=[];
 return seen;
}
const shell=name=>/^(exec_command|write_stdin|shell|local_shell|unified_exec)$/i.test(name);
const beyond=name=>/web_search|view_image|multi_agent|js_repl|apps|browser|computer_use|image_generation/i.test(name);
try{
 await writeFile(join(directory,'config.toml'),`model_provider="probe"\n[features]\nenable_request_compression=false\n[model_providers.probe]\nname="Probe"\nbase_url="http://127.0.0.1:${port}"\nwire_api="responses"\nenv_key="RECAP_PROBE_KEY"\n`);
 const codex={cli:'codex',model:'gpt-5.5',effort:'medium'}, claude={cli:'claude',model:'sonnet',effort:'high'};
 const prompt='Reply with exactly: Ready.';
 const codexSummary=await probe('codex summary',buildWorkspaceAssistantCommand(prompt,codex),codexEnv);
 assert.ok(!codexSummary.some(shell),`codex summary offered a shell: ${codexSummary.join(', ')}`);
 assert.ok(!codexSummary.some(beyond),`codex summary offered more than the desk: ${codexSummary.join(', ')}`);
 const claudeSummary=await probe('claude summary',buildWorkspaceAssistantCommand(prompt,claude),claudeEnv);
 assert.deepEqual(claudeSummary,[]);
 const codexAgent=await probe('codex agent',buildWorkspaceAgentCommand(prompt,codex),codexEnv);
 assert.ok(codexAgent.some(shell),`codex agent offered no shell: ${codexAgent.join(', ')}`);
 assert.ok(!codexAgent.some(beyond),`codex agent offered more than the shell: ${codexAgent.join(', ')}`);
 const claudeAgent=await probe('claude agent',buildWorkspaceAgentCommand(prompt,claude),claudeEnv);
 assert.deepEqual(claudeAgent,['Bash'],`claude agent tools: ${claudeAgent.join(', ')}`);
 console.log(JSON.stringify({requests,summary:{codex:codexSummary,claude:claudeSummary},agent:{codex:codexAgent,claude:claudeAgent},answer:'Ready.',passed:true}));
}finally{server.close();await rm(directory,{recursive:true,force:true});}
