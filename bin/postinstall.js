#!/usr/bin/env node
// Runs once right after: npm install @trimwares/trace

const g = '\x1b[32m', y = '\x1b[33m', c = '\x1b[36m', dim = '\x1b[90m', b = '\x1b[1m', r = '\x1b[0m';

console.log('');
console.log(`  ${g}${b}⚡ Trimwares Trace v1.5.4${r}`);
console.log(`  ${dim}─────────────────────────────────────────────────────${r}`);
console.log('');
console.log(`  ${b}1${r}  Wrap your LLM client`);
console.log(`       ${dim}import { trimwares } from '@trimwares/trace'${r}`);
console.log(`       ${y}const openai = trimwares.openai(new OpenAI({ ... }))${r}`);
console.log('');
console.log(`  ${b}2${r}  Run your app, then open the dashboard`);
console.log(`       ${y}npx trimwares serve${r}  →  ${c}http://localhost:7778${r}`);
console.log('');
console.log(`  ${dim}No proxy · no cloud · no account — your data stays on your machine.${r}`);
console.log('');
console.log(`  ${dim}What's new in 1.5.4:${r}`);
console.log(`  ${dim}· Lighter install — 2 packages, 0 production audit findings${r}`);
console.log(`  ${dim}· Semantic embeddings now an optional extra (npm install @huggingface/transformers)${r}`);
console.log('');
console.log(`  ${dim}CI / scripting: npx trimwares add <path>  ·  npx trimwares analyze${r}`);
console.log(`  ${dim}Docs & changelog: ${r}${c}https://www.trimwares.com/trace${r}`);
console.log('');
console.log(`  ${dim}Built by one person — tell me what Trace got wrong: ${r}${c}hello@trimwares.com${r}`);
console.log('');
